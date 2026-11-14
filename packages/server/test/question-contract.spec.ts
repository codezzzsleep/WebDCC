import { CodexAdapter } from '@webdcc/adapter-codex';
import type { EventData } from '@webdcc/protocol';
import { expect, it } from 'vitest';
import { createTestApp } from './helpers.js';

it('NP-06 browser-shaped free text passes through HTTP, manager and the Codex native response', async () => {
  const ctx = await createTestApp();
  try {
    const workspace = ctx.store.createWorkspace('question', ctx.dataDir);
    const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    ctx.store.updateSession(session.id, { nativeId: 'native' });
    const native = CodexAdapter.replay(session.id);
    native.adapter.resume = async () => undefined;
    native.adapter.send = async () => { native.feed({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { id: 'opaque:request', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'language', question: '语言' }] } } }); };
    native.adapter.dispose = async () => undefined;
    ctx.manager.registerAdapter(native.adapter);
    await ctx.manager.send(session.id, { text: 'ask' });
    const event = ctx.store.allEvents(session.id).find(event => event.kind === 'question');
    const questionId = (event?.data as EventData['question']).questionId;
    const custom = '自由答案\r\n字节保留';
    const result = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command: { op: 'answer', clientCommandId: 'ANSWER', sessionId: session.id, questionId, answer: { selected: [], custom } } } });
    expect(result.json()).toMatchObject({ ok: true });
    expect(ctx.store.journal.get('ANSWER')?.state).toBe('dispatching');
    expect(native.replies).toEqual([{ id: 'opaque:request', result: { answers: { language: { answers: [custom] } } } }]);
    native.feed({ i: 2, t: 0, dir: 'in', ch: 'rpc', frame: { method: 'serverRequest/resolved', params: { threadId: '', requestId: 'opaque:request' } } });
    expect(ctx.store.journal.get('ANSWER')?.state).toBe('completed');
  } finally { await ctx.close(); }
});

it('NP-06 keeps a submitted batch pending until the native request resolution arrives', async () => {
  const ctx = await createTestApp();
  try {
    const workspace = ctx.store.createWorkspace('batch', ctx.dataDir);
    const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    ctx.store.updateSession(session.id, { nativeId: 'native' });
    const native = CodexAdapter.replay(session.id, 'native');
    native.adapter.resume = async () => undefined;
    native.adapter.send = async () => { native.feed({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { id: 'batch', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'first', question: 'first' }, { id: 'second', question: 'second' }] } } }); };
    native.adapter.dispose = async () => undefined;
    ctx.manager.registerAdapter(native.adapter);
    await ctx.manager.send(session.id, { text: 'ask' });
    const ids = ctx.store.allEvents(session.id).filter(event => event.kind === 'question').map(event => (event.data as EventData['question']).questionId);
    expect(await ctx.manager.answer(session.id, ids[0]!, { custom: 'first' })).toEqual({ submitted: false });
    expect(ctx.store.allEvents(session.id).filter(event => event.kind === 'question' && (event.data as EventData['question']).status === 'answered')).toHaveLength(0);
    expect(ctx.manager.getRuntime(session.id)?.status).toBe('waiting');
    await ctx.manager.answer(session.id, ids[1]!, { custom: 'second' });
    expect(ctx.store.allEvents(session.id).filter(event => event.kind === 'question' && (event.data as EventData['question']).status === 'answered')).toHaveLength(0);
    expect(ctx.store.interactions.get(session.id, 'answer', ids[0]!)?.state).toBe('sent');
    await expect(ctx.manager.answer(session.id, ids[0]!, { custom: 'duplicate' })).rejects.toMatchObject({ statusCode: 409 });
    native.feed({ i: 2, t: 0, dir: 'in', ch: 'rpc', frame: { method: 'serverRequest/resolved', params: { threadId: 'native', requestId: 'batch' } } });
    expect(ctx.store.allEvents(session.id).filter(event => event.kind === 'question' && (event.data as EventData['question']).status === 'answered')).toHaveLength(2);
    expect(native.replies).toHaveLength(1);
  } finally { await ctx.close(); }
});
