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
    expect(native.replies).toEqual([{ id: 'opaque:request', result: { answers: { language: { answers: [custom] } } } }]);
  } finally { await ctx.close(); }
});
