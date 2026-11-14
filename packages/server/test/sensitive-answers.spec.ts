import { expect, it } from 'vitest';
import { CodexAdapter } from '@webdcc/adapter-codex';
import type { EventData } from '@webdcc/protocol';
import { createTestApp } from './helpers.js';

it('NP-06/14 sensitive answers reach native unchanged, leave only a durable receipt and cannot be replayed or leaked through errors', async () => {
  const ctx = await createTestApp();
  try {
    const workspace = ctx.store.createWorkspace('secret', ctx.dataDir);
    const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    ctx.store.updateSession(session.id, { nativeId: 'native' });
    const native = CodexAdapter.replay(session.id, 'native');
    native.adapter.resume = async () => undefined; native.adapter.dispose = async () => undefined;
    native.adapter.send = async () => { native.feed({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { id: 'secret-request', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'password', question: 'Enter secret', isSecret: true, isOther: false, options: null }] } } }); };
    ctx.manager.registerAdapter(native.adapter); await ctx.manager.send(session.id, { text: 'ask secret' });
    const question = ctx.store.allEvents(session.id).find(event => event.kind === 'question')!.data as EventData['question'];
    expect(question).toMatchObject({ isSecret: true, allowsFreeText: true });
    const custom = '  任意口令 without-token-prefix  ';
    const command = { op: 'answer', clientCommandId: 'secret-answer', sessionId: session.id, questionId: question.questionId, answer: { selected: [], custom } };
    const post = (value: unknown) => ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command: value } });
    expect((await post(command)).json()).toMatchObject({ ok: true });
    expect(native.replies).toEqual([{ id: 'secret-request', result: { answers: { password: { answers: [custom] } } } }]);
    expect(ctx.store.journal.get(command.clientCommandId)?.payload).toMatchObject({ answer: { omitted: 'sensitive-answer' } });
    expect(JSON.stringify(ctx.store.journal.get(command.clientCommandId))).not.toContain(custom);
    expect((await post(command)).json()).toMatchObject({ ok: true }); expect(native.replies).toHaveLength(1);
    expect((await post({ ...command, answer: 'different' })).json()).toMatchObject({ ok: false, code: 'command-conflict' });
    ctx.store.appendEvent({ sessionId: session.id, turnId: null, itemKey: 'echo', kind: 'assistant.message', data: { text: `native echoed ${custom}` }, native: { text: custom } });
    expect(JSON.stringify(ctx.store.allEvents(session.id))).not.toContain(custom);
    const receipt = ctx.store.nativeEvents.frame({ sessionId: session.id, agent: 'codex', nativeId: 'native' }, { i: 2, t: 0, dir: 'out', ch: 'rpc', frame: native.replies[0] }, true);
    expect(JSON.stringify(ctx.store.nativeEvents.get(receipt))).not.toContain(custom);
  } finally { await ctx.close(); }
});

it('NP-06 a secret equal to a lifecycle enum cannot corrupt native confirmation or request identity', async () => {
  const ctx = await createTestApp();
  try {
    const workspace = ctx.store.createWorkspace('short secret', ctx.dataDir); const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    ctx.store.updateSession(session.id, { nativeId: 'native' });
    const native = CodexAdapter.replay(session.id, 'native'); native.adapter.resume = async () => undefined; native.adapter.dispose = async () => undefined;
    native.adapter.send = async () => { native.feed({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { id: 'q', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'secret', question: 'Enter secret', isSecret: true }] } } }); };
    ctx.manager.registerAdapter(native.adapter); await ctx.manager.send(session.id, { text: 'ask' });
    const question = ctx.store.allEvents(session.id).find(event => event.kind === 'question')!.data as EventData['question'];
    const response = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command: { op: 'answer', clientCommandId: 'enum-secret', sessionId: session.id, questionId: question.questionId, answer: 'answered' } } });
    expect(response.json()).toMatchObject({ ok: true });
    native.feed({ i: 2, t: 0, dir: 'in', ch: 'rpc', frame: { method: 'serverRequest/resolved', params: { threadId: 'native', requestId: 'q' } } });
    expect(ctx.store.allEvents(session.id).findLast(event => event.kind === 'question')?.data).toMatchObject({ status: 'answered', questionId: question.questionId, groupId: question.groupId });
    expect(ctx.store.journal.get('enum-secret')?.state).toBe('completed');
    const goal = ctx.store.appendEvent({ sessionId: session.id, turnId: null, itemKey: 'goal', kind: 'goal', data: { objective: 'answered', status: 'paused', goalId: 'native:1' } });
    expect(goal.data).toMatchObject({ objective: '********', status: 'paused', goalId: 'native:1' });
  } finally { await ctx.close(); }
});
