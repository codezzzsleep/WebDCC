import { expect, it } from 'vitest';
import { CodexAdapter } from '@webdcc/adapter-codex';
import { reduceTurn, type EventData } from '@webdcc/protocol';
import { createTestApp } from './helpers.js';

async function fixture() {
  const ctx = await createTestApp(); const workspace = ctx.store.createWorkspace('native questions', ctx.dataDir); const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' }); ctx.store.updateSession(session.id, { nativeId: 'native' });
  const native = CodexAdapter.replay(session.id, 'native'); let frame = 0; let turns = 0;
  const feed = (message: unknown) => native.feed({ i: ++frame, t: frame, dir: 'in', ch: 'rpc', frame: message });
  native.adapter.resume = async () => undefined; native.adapter.dispose = async () => undefined;
  native.adapter.send = async () => { feed({ method: 'turn/started', params: { threadId: 'native', turn: { id: `native-${++turns}`, status: 'inProgress', items: [] } } }); };
  ctx.manager.registerAdapter(native.adapter);
  const ask = (id: string, turnId: string, isBlocking?: boolean) => feed({ id, method: 'item/tool/requestUserInput', params: { threadId: 'native', turnId, itemId: `tool-${id}`, ...(isBlocking === undefined ? {} : { isBlocking }), autoResolutionMs: 1, questions: [{ id: 'q', question: id }] } });
  const status = (activeFlags: string[]) => feed({ method: 'thread/status/changed', params: { threadId: 'native', status: { type: 'active', activeFlags } } });
  const question = (prompt: string) => ctx.store.allEvents(session.id).find(event => event.kind === 'question' && (event.data as EventData['question']).prompt === prompt)!;
  return { ...ctx, sessionId: session.id, native, feed, ask, status, question };
}

it('Issue41 keeps nonblocking questions answerable and preserves actual native thread waiting until a clear update', async () => {
  const ctx = await fixture();
  try {
    const sent = await ctx.manager.send(ctx.sessionId, { text: 'first' }); ctx.ask('nonblocking', 'native-1', false);
    const question = ctx.question('nonblocking'); expect(question.turnId).toBe(sent.turnId); expect(question.data).toMatchObject({ isBlocking: false }); expect(ctx.store.getSession(ctx.sessionId)?.status).toBe('running');
    ctx.status(['waitingOnUserInput']); expect(ctx.store.getSession(ctx.sessionId)?.status).toBe('waiting');
    expect(await ctx.manager.answer(ctx.sessionId, (question.data as EventData['question']).questionId, { custom: ' exact answer\r\n' })).toMatchObject({ submitted: true, confirmed: false });
    expect(ctx.store.getSession(ctx.sessionId)?.status).toBe('waiting'); expect(ctx.native.replies).toEqual([{ id: 'nonblocking', result: { answers: { q: { answers: [' exact answer\r\n'] } } } }]);
    ctx.feed({ method: 'serverRequest/resolved', params: { threadId: 'native', requestId: 'nonblocking' } }); expect(ctx.store.getSession(ctx.sessionId)?.status).toBe('waiting');
    expect(ctx.store.allEvents(ctx.sessionId).findLast(event => event.kind === 'question')?.data).toMatchObject({ isBlocking: false, status: 'answered' });
    ctx.status([]); expect(ctx.store.getSession(ctx.sessionId)?.status).toBe('running');
    ctx.feed({ method: 'thread/status/changed', params: { threadId: 'foreign', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } } }); expect(ctx.store.getSession(ctx.sessionId)?.status).toBe('running');
  } finally { await ctx.close(); }
});

it('Issue41 old-turn requests/resolutions retain their original identity and cannot pause the next turn', async () => {
  const ctx = await fixture();
  try {
    const first = await ctx.manager.send(ctx.sessionId, { text: 'first' }); ctx.ask('old-blocking', 'native-1', true); expect(ctx.store.getSession(ctx.sessionId)?.status).toBe('waiting');
    ctx.feed({ method: 'turn/completed', params: { threadId: 'native', turn: { id: 'native-1', status: 'interrupted', items: [] } } }); const second = await ctx.manager.send(ctx.sessionId, { text: 'second' }); ctx.status([]); expect(ctx.store.getSession(ctx.sessionId)?.status).toBe('running');
    ctx.ask('late-old', 'native-1', true); const old = ctx.question('late-old'); expect(old).toMatchObject({ turnId: first.turnId, late: true, data: { isBlocking: true } }); expect(ctx.store.getSession(ctx.sessionId)?.status).toBe('running');
    const pending = ctx.question('old-blocking'); await ctx.manager.answer(ctx.sessionId, (pending.data as EventData['question']).questionId, { custom: 'late answer' }); expect(ctx.store.getSession(ctx.sessionId)?.status).toBe('running');
    ctx.feed({ method: 'serverRequest/resolved', params: { threadId: 'native', requestId: 'old-blocking' } }); expect(ctx.store.getSession(ctx.sessionId)?.status).toBe('running');
    expect(ctx.store.allEvents(ctx.sessionId).findLast(event => event.kind === 'question' && (event.data as EventData['question']).prompt === 'old-blocking')).toMatchObject({ turnId: first.turnId, data: { isBlocking: true, status: 'answered' } });
    const current = reduceTurn(ctx.store.allEvents(ctx.sessionId).filter(event => event.turnId === second.turnId)); expect(current.state).toBe('running'); expect(current.activity?.kind).not.toBe('waiting');
  } finally { await ctx.close(); }
});

it('Issue41 session-scoped legacy blocking requests still wait without creating a fabricated turn', async () => {
  const ctx = await fixture();
  try {
    const sent = await ctx.manager.send(ctx.sessionId, { text: 'first' });
    ctx.feed({ id: 'session-form', method: 'mcpServer/elicitation/request', params: { threadId: 'native', turnId: null, serverName: 'test', mode: 'openai/form', _meta: null, message: 'global question', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } } });
    const question = ctx.question('global question'); expect(question.turnId).toBeNull(); expect(ctx.store.getSession(ctx.sessionId)?.status).toBe('waiting');
    const events = ctx.store.allEvents(ctx.sessionId); expect(events.filter(event => event.kind === 'turn.started')).toHaveLength(1); const current = reduceTurn(events.filter(event => event.turnId === sent.turnId), [], events.filter(event => event.turnId === null)); expect(current.state).toBe('waiting'); expect(current.steps.some(event => event.kind === 'question')).toBe(false);
    ctx.feed({ method: 'serverRequest/resolved', params: { threadId: 'native', requestId: 'session-form' } }); expect(ctx.store.getSession(ctx.sessionId)?.status).toBe('running');
  } finally { await ctx.close(); }
});
