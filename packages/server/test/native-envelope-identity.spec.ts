import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { createTestApp } from './helpers.js';

const identity = { ownerId: 'web-owner', generation: 3, hostId: 'host' };
const cases = [
  { name: 'Codex child thread opening', agent: 'codex', nativeId: 'parent', actorId: 'child', observedId: 'child',
    frame: { method: 'thread/started', params: { thread: { id: 'child', source: { subAgent: { thread_spawn: { parent_thread_id: 'parent' } } } } } } },
  { name: 'Codex child item notification', agent: 'codex', nativeId: 'parent', actorId: 'child', observedId: 'child',
    frame: { method: 'item/started', params: { threadId: 'child', turnId: 'turn', startedAtMs: 1, item: { id: 'item', type: 'agentMessage', text: '' } } } },
  { name: 'Codex collaboration subject differs from scope', agent: 'codex', nativeId: 'parent', actorId: 'parent', observedId: 'parent',
    frame: { method: 'item/started', params: { threadId: 'parent', turnId: 'turn', startedAtMs: 1, item: { type: 'collabAgentToolCall', agentThreadId: 'peer', receiverThreadIds: ['peer'] } } } },
  { name: 'DSH global waterfall Agent scope', agent: 'dsh', nativeId: undefined, actorId: 'dsh-agent', observedId: 'dsh-agent',
    frame: { type: 'stream-frame', streamId: 'events', value: { type: 'waterfall', agentId: 'dsh-agent', eventId: 'waterfall', event: 'approval/request', request: { callId: 'tool-call' } } } },
  { name: 'Claude explicit Agent and parent tool', agent: 'claude-code', nativeId: 'parent', actorId: 'claude-agent', observedId: 'claude-session',
    frame: { frame: { type: 'assistant', session_id: 'claude-session', agent_id: 'claude-agent', parent_tool_use_id: 'parent-tool', message: { id: 'message', content: [] } } } },
];

it.each(cases)('$name preserves the explicit scope without replacing owner/generation', async item => {
  const db = openDb(':memory:'); const store = new Store(db);
  try {
    const context = { sessionId: 'web-or-host', agent: item.agent, nativeId: item.nativeId, identity };
    const id = store.nativeEvents.frame(context, { i: 1, t: 0, dir: 'in', ch: 'controlled-scope', frame: item.frame }, false);
    const record = store.nativeEvents.get(id)!;
    const evidence = process.env['WDCC_NATIVE_ACTOR_EVIDENCE_DIR'];
    if (evidence !== undefined) await writeFile(join(evidence, `${item.agent}-${cases.indexOf(item)}.json`), JSON.stringify({ input: item, record }, null, 2));
    expect(record).toMatchObject({ sessionId: 'web-or-host', nativeId: item.observedId, actorId: item.actorId,
      ownerId: identity.ownerId, generation: 3, disposition: 'stale-owner', payload: item.frame });
  } finally { db.close(); }
});

it.each([
  { agent: 'codex', frame: { id: 0, result: { thread: { id: 'returned-thread' } } }, nativeId: 'returned-thread' },
  { agent: 'codex', frame: { id: '0', result: { agentThreadId: 'subject' } }, nativeId: 'parent' },
  { agent: 'codex', frame: { method: 'unknown', params: { item: { agentThreadId: 'subject', actorId: 'payload-only' } } }, nativeId: 'parent' },
  { agent: 'codex', frame: { method: 'unknown', params: { threadId: 7, thread: { id: {} } } }, nativeId: 'parent' },
  { agent: 'dsh', frame: { type: 'stream-frame', value: { type: 'emit', args: [{ agentId: 'payload-only' }] } }, nativeId: 'parent' },
  { agent: 'dsh', frame: { type: 'stream-frame', value: { type: 'cancel', eventId: 'waterfall' } }, nativeId: 'parent' },
  { agent: 'dsh', frame: { id: 'rpc', args: { agentId: 'addressed-agent' } }, nativeId: 'parent' },
  { agent: 'claude-code', frame: { type: 'assistant', session_id: 'claude-session', parent_tool_use_id: 'tool' }, nativeId: 'claude-session' },
  { agent: 'claude-code', frame: { type: 'tool_progress', parent_tool_use_id: 'tool', subagent_retry: { agent_id: 'retry-subject' } }, nativeId: 'parent' },
  { agent: 'claude-code', frame: { type: 'stream-frame', value: { type: 'waterfall', agentId: 'wrong-protocol' } }, nativeId: 'parent' },
  { agent: 'dsh', frame: { method: 'item/started', params: { threadId: 'wrong-protocol' } }, nativeId: 'parent' },
])('unproven $agent actor remains absent even when payload mentions a subject', item => {
  const db = openDb(':memory:'); const store = new Store(db);
  try {
    const id = store.nativeEvents.frame({ sessionId: 's', agent: item.agent, nativeId: 'parent' },
      { i: 1, t: 0, dir: 'in', ch: 'controlled-negative', frame: item.frame }, true);
    expect(store.nativeEvents.get(id)).toMatchObject({ nativeId: item.nativeId, actorId: null, payload: item.frame });
  } finally { db.close(); }
});

it('the public native inspector reads the same global actor without inventing a Web session', async () => {
  const ctx = await createTestApp();
  try {
    const item = cases[3]!;
    const id = ctx.store.nativeEvents.frame({ sessionId: '@native-host:dsh:scope', agent: 'dsh' },
      { i: 1, t: 0, dir: 'in', ch: 'mux:$events', frame: item.frame }, true);
    const list = await ctx.app.inject({ url: '/api/native-events', headers: { cookie: ctx.cookie } });
    expect(list.statusCode).toBe(200); expect(list.json().records).toContainEqual(expect.objectContaining({ id, nativeId: 'dsh-agent', actorId: 'dsh-agent', ownerId: null, generation: null }));
    const detail = await ctx.app.inject({ url: `/api/native-events/${id}`, headers: { cookie: ctx.cookie } });
    expect(detail.json()).toMatchObject({ id, payload: item.frame, actorId: 'dsh-agent' });
    expect(ctx.store.getSession('@native-host:dsh:scope')).toBeUndefined();
  } finally { await ctx.close(); }
});

it('committed actor and parent-tool metadata survive a disk database reopen with typed requests intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wdcc-native-actor-')); const path = join(dir, 'db.sqlite');
  let db = openDb(path);
  try {
    let store = new Store(db);
    const original = cases.map((item, index) => {
      const raw = 'frame' in item.frame ? item.frame.frame : item.frame;
      const frame = { native: { ...raw, id: index === 0 ? 0 : String(index) } };
      const id = store.nativeEvents.frame({ sessionId: `s-${index}`, agent: item.agent, nativeId: item.nativeId, identity },
        { i: index + 1, t: 0, dir: 'in', ch: 'controlled-scope', frame }, true);
      return store.nativeEvents.get(id)!;
    });
    db.close(); db = openDb(path); store = new Store(db);
    expect(original.map(record => store.nativeEvents.get(record.id))).toEqual(original);
    expect(original.map(record => record.actorId)).toEqual(cases.map(item => item.actorId));
    expect(original[0]!.nativeRequestId).toBe(0); expect(original[1]!.nativeRequestId).toBe('1');
    expect(original[4]!.parentToolUseId).toBe('parent-tool');
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
