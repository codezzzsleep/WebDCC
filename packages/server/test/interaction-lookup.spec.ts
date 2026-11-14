import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import type { ServerMessage } from '@webdcc/protocol';
import { createTestApp } from './helpers.js';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';

it('returns only the latest actual scoped interaction event, never a manufactured resolution from the index', async () => {
  const ctx = await createTestApp();
  try {
    const workspace = ctx.store.createWorkspace('lookup', ctx.dataDir); const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' }); const other = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' }); const id = 'native:request/question-中文';
    const pending = ctx.store.appendEvent({ sessionId: session.id, turnId: null, itemKey: 'question', kind: 'question', data: { questionId: id, prompt: 'actual question' } });
    const claim = ctx.store.interactions.claim(session.id, 'answer', id, 'index-only'); ctx.store.interactions.finish(claim);
    const url = `/api/sessions/${session.id}/interactions/answer?${new URLSearchParams({ interactionId: id })}`;
    expect((await ctx.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url, headers: { cookie: ctx.cookie } })).json()).toEqual({ event: pending, throughSeq: pending.seq });
    const resolved = ctx.store.appendEvent({ sessionId: session.id, turnId: null, itemKey: 'question-resolved', kind: 'question', data: { questionId: id, prompt: 'actual question', status: 'answered' } });
    ctx.store.appendEvent({ sessionId: other.id, turnId: null, itemKey: 'other', kind: 'question', data: { questionId: id, prompt: 'other question' } });
    expect((await ctx.app.inject({ method: 'GET', url, headers: { cookie: ctx.cookie } })).json()).toEqual({ event: resolved, throughSeq: resolved.seq });
    expect((await ctx.app.inject({ method: 'GET', url: `/api/sessions/${session.id}/interactions/answer?interactionId=missing`, headers: { cookie: ctx.cookie } })).json()).toEqual({ event: null, throughSeq: resolved.seq });
    const approval = ctx.store.appendEvent({ sessionId: session.id, turnId: null, itemKey: 'approval', kind: 'approval.request', data: { approvalId: id, title: 'actual approval', detail: '', options: [] } });
    const approvalResolved = ctx.store.appendEvent({ sessionId: session.id, turnId: null, itemKey: 'approval-resolved', kind: 'approval.resolved', data: { approvalId: id, optionId: 'deny', by: 'other' } });
    expect(approval.seq).toBeLessThan(approvalResolved.seq);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/sessions/${session.id}/interactions/approve?${new URLSearchParams({ interactionId: id })}`, headers: { cookie: ctx.cookie } })).json()).toEqual({ event: approvalResolved, throughSeq: approvalResolved.seq });
    expect((await ctx.app.inject({ method: 'GET', url: `/api/sessions/${session.id}/interactions/unknown?${new URLSearchParams({ interactionId: id })}`, headers: { cookie: ctx.cookie } })).statusCode).toBe(400);
    expect(ctx.manager.getRuntime(session.id)).toBeUndefined();
  } finally { await ctx.close(); }
});

it('pins latest interaction and throughSeq to one SQLite read snapshot across an actual second writer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-interaction-read-')); const file = join(directory, 'state.sqlite'); const db = openDb(file); const writer = openDb(file);
  try {
    const store = new Store(db); const workspace = store.createWorkspace('read-window', directory); const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' }); const pending = store.appendEvent({ sessionId: session.id, turnId: null, itemKey: 'q', kind: 'question', data: { questionId: 'q', prompt: 'old' } });
    const getSession = store.getSession.bind(store); let updated = false;
    const spy = vi.spyOn(store, 'getSession').mockImplementation(id => {
      const value = getSession(id);
      if (!updated) {
        updated = true;
        writer.transaction(() => {
          writer.prepare('INSERT INTO events (session_id, seq, turn_id, item_key, kind, data, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(session.id, pending.seq + 1, '', 'q-resolved', 'question', JSON.stringify({ questionId: 'q', prompt: 'old', status: 'answered' }), new Date().toISOString());
          writer.prepare('UPDATE sessions SET last_seq = ? WHERE id = ?').run(pending.seq + 1, session.id);
        })();
      }
      return value;
    });
    expect(store.latestInteractionEvent(session.id, 'answer', 'q')).toEqual({ event: pending, throughSeq: pending.seq }); spy.mockRestore();
    expect(store.latestInteractionEvent(session.id, 'answer', 'q')).toMatchObject({ event: { seq: pending.seq + 1, data: { status: 'answered' } }, throughSeq: pending.seq + 1 });
  } finally { writer.close(); db.close(); await rm(directory, { recursive: true, force: true }); }
});

it('preserves long and reserved characters in an opaque native interaction identity', async () => {
  const ctx = await createTestApp();
  try {
    const workspace = ctx.store.createWorkspace('opaque identities', ctx.dataDir);
    const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    for (const id of ['native-request-'.repeat(32), ' 原始/?#&%+[]{}交互 '.repeat(32)]) {
      const event = ctx.store.appendEvent({ sessionId: session.id, turnId: null, itemKey: id, kind: 'question', data: { questionId: id, prompt: 'opaque question' } });
      const response = await ctx.app.inject({ method: 'GET', url: `/api/sessions/${session.id}/interactions/answer?${new URLSearchParams({ interactionId: id })}`, headers: { cookie: ctx.cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ event, throughSeq: event.seq });
    }
    for (const query of ['', '?interactionId=', `?interactionId=${'x'.repeat(2049)}`, '?interactionId=one&interactionId=two']) {
      expect((await ctx.app.inject({ method: 'GET', url: `/api/sessions/${session.id}/interactions/answer${query}`, headers: { cookie: ctx.cookie } })).statusCode).toBe(400);
    }
  } finally { await ctx.close(); }
});

it('reports the stored cursor actually replayed before a WebSocket snapshot, including a future client cursor clamp', async () => {
  const ctx = await createTestApp();
  try {
    const workspace = ctx.store.createWorkspace('snapshot', ctx.dataDir); const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    ctx.store.appendEvent({ sessionId: session.id, turnId: null, itemKey: 'first', kind: 'notice', data: { text: 'first', level: 'info' } }); const last = ctx.store.appendEvent({ sessionId: session.id, turnId: null, itemKey: 'last', kind: 'notice', data: { text: 'last', level: 'info' } });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const read = async (afterSeq: number) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/ws`, { headers: { cookie: ctx.cookie } }); const messages: ServerMessage[] = [];
      try {
        const snapshot = new Promise<Extract<ServerMessage, { op: 'snapshot' }>>((resolve, reject) => {
          socket.on('message', value => { const message = JSON.parse(String(value)) as ServerMessage; messages.push(message); if (message.op === 'snapshot') resolve(message); }); socket.once('error', reject);
        });
        await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }); socket.send(JSON.stringify({ op: 'hello', clientId: 'read-boundary', feedAfter: 0, subscribe: [{ sessionId: session.id, afterSeq }] }));
        return { snapshot: await snapshot, seqs: messages.flatMap(message => message.op === 'event' ? [message.event.seq] : []) };
      } finally { await new Promise<void>(resolve => { socket.once('close', resolve); socket.close(); }); }
    };
    expect(await read(0)).toMatchObject({ snapshot: { throughSeq: last.seq }, seqs: [1, 2] }); expect(await read(999)).toMatchObject({ snapshot: { throughSeq: last.seq }, seqs: [] });
  } finally { await ctx.close(); }
});
