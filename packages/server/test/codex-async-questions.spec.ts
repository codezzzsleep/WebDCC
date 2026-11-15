import { CodexAdapter } from '@webdcc/adapter-codex';
import { codexAsyncQuestionId, formatCodexAsyncReply, parseCodexAsyncReplies, type EventData, type UserInput } from '@webdcc/protocol';
import { expect, it } from 'vitest';
import { createTestApp } from './helpers.js';

async function fixture() {
  const ctx = await createTestApp();
  const workspace = ctx.store.createWorkspace('async questions', ctx.dataDir);
  const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' });
  ctx.store.updateSession(session.id, { nativeId: 'native' });
  const native = CodexAdapter.replay(session.id, 'native');
  let frame = 0; let turn = 0;
  const inputs: UserInput[] = [];
  const feed = (value: unknown) => native.feed({ i: ++frame, t: frame, dir: 'in', ch: 'rpc', frame: value });
  native.adapter.resume = async () => undefined;
  native.adapter.dispose = async () => undefined;
  native.adapter.send = async (_id, input) => {
    inputs.push(input);
    feed({ method: 'turn/started', params: { threadId: 'native', turn: { id: `native-${++turn}`, status: 'inProgress', items: [] } } });
  };
  native.adapter.steer = async (_id, input) => { inputs.push(input); };
  ctx.manager.registerAdapter(native.adapter);
  await ctx.manager.send(session.id, { text: 'start' });
  const ask = (itemId = 'async', nativeTurnId = 'native-1') => feed({ method: 'item/completed', params: { threadId: 'native', turnId: nativeTurnId, item: {
    id: itemId, type: 'agentMessage', delivery: 'async', phase: 'final_answer', text: 'questions',
    questions: [{ title: '选择语言', options: ['中文', 'English'] }, { title: '补充说明', options: null }],
  } } });
  const latest = (index = 0, itemId = 'async') => ctx.store.allEvents(session.id).findLast(event => event.kind === 'question' && (event.data as EventData['question']).questionId === codexAsyncQuestionId(itemId, index))!.data as EventData['question'];
  const echo = (input: UserInput, nativeTurnId = 'native-1', clientId: string | undefined = input.nativeRequestId) => feed({ method: 'item/completed', params: { threadId: 'native', turnId: nativeTurnId,
    item: { type: 'userMessage', id: `receipt-${frame}`, clientId, content: [{ type: 'text', text: input.text }] } } });
  const command = (id: string, answer: unknown, index = 0, intent?: 'queue' | 'steer' | 'send', expectedTurnId?: string) => ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: {
    command: { op: 'answer', clientCommandId: id, sessionId: session.id, questionId: codexAsyncQuestionId('async', index), answer, ...(intent ? { intent } : {}), ...(expectedTurnId ? { expectedTurnId } : {}) },
  } });
  return { ...ctx, sessionId: session.id, native, inputs, feed, ask, latest, echo, command };
}

it('projects Default async multi-question identities without pausing native execution or inventing a final answer', async () => {
  const ctx = await fixture();
  try {
    ctx.ask(); ctx.ask();
    const questions = ctx.store.allEvents(ctx.sessionId).filter(event => event.kind === 'question');
    expect(questions).toHaveLength(2);
    expect(questions.map(event => event.data)).toMatchObject([
      { questionId: codexAsyncQuestionId('async', 0), isBlocking: false, options: [{ id: '中文', label: '中文' }, { id: 'English', label: 'English' }] },
      { questionId: codexAsyncQuestionId('async', 1), isBlocking: false, allowsFreeText: true },
    ]);
    expect(ctx.store.getSession(ctx.sessionId)?.status).toBe('running');
    expect(ctx.store.allEvents(ctx.sessionId).find(event => event.kind === 'assistant.message')?.data).toMatchObject({ phase: 'interim' });
  } finally { await ctx.close(); }
});

it('persists the exact async reply as steer input, deduplicates commands and waits for native receipt', async () => {
  const ctx = await fixture();
  try {
    ctx.ask();
    const answer = { selected: [], custom: ' 答案\r\n保留字节 ' };
    const result = await ctx.command('ANSWER', answer, 1);
    expect(result.json()).toMatchObject({ ok: true, value: { submitted: true, confirmed: false, queued: false } });
    expect(ctx.latest(1)).toMatchObject({ submission: 'sent' });
    expect(ctx.latest(1).status).toBeUndefined();
    expect(ctx.native.replies).toHaveLength(0);
    expect(parseCodexAsyncReplies(ctx.inputs[1]!.text)).toEqual([{ questionItemId: codexAsyncQuestionId('async', 1), question: '补充说明', answer: answer.custom }]);
    await ctx.command('ANSWER', answer, 1);
    expect((await ctx.command('DUPLICATE', answer, 1)).json()).toMatchObject({ ok: false });
    expect(ctx.inputs).toHaveLength(2);
    ctx.echo(ctx.inputs[1]!);
    expect(ctx.latest(1)).toMatchObject({ status: 'answered', resolution: 'native-acknowledged' });
    expect(ctx.store.journal.get('ANSWER')?.state).toBe('completed');
    ctx.ask();
    expect(ctx.latest(1).status).toBe('answered');
  } finally { await ctx.close(); }
});

it('allows cancelling queued async replies and resubmitting without pretending they arrived', async () => {
  const ctx = await fixture();
  try {
    ctx.ask();
    expect((await ctx.command('QUEUED', { selected: ['中文'] }, 0, 'queue')).json()).toMatchObject({ ok: true, value: { queued: true, confirmed: false } });
    expect(ctx.latest()).toMatchObject({ submission: 'queued' });
    expect(ctx.inputs).toHaveLength(1);
    expect((await ctx.command('DUPLICATE', { selected: ['中文'] }, 0, 'queue')).json()).toMatchObject({ ok: false });
    ctx.store.journal.cancel(ctx.sessionId, 'QUEUED'); ctx.manager.queueChanged(ctx.sessionId);
    expect(ctx.latest()).toMatchObject({ submission: 'failed' });
    expect((await ctx.command('RETRY', { selected: ['中文'] })).json()).toMatchObject({ ok: true });
    expect(ctx.inputs).toHaveLength(2);
    ctx.echo(ctx.inputs[1]!);
    expect(ctx.latest()).toMatchObject({ status: 'answered', resolution: 'native-acknowledged' });
  } finally { await ctx.close(); }
});

it('preserves uncertain submissions, blocks replay and accepts a later exact receipt', async () => {
  const ctx = await fixture();
  try {
    ctx.ask();
    ctx.native.adapter.steer = async (_id, input) => { ctx.inputs.push(input); throw new Error('transport disconnected'); };
    expect((await ctx.command('UNCERTAIN', { custom: '答案' })).json()).toMatchObject({ ok: false, code: 'uncertain' });
    expect(ctx.latest()).toMatchObject({ submission: 'uncertain' });
    expect((await ctx.command('REPLAY', { custom: '答案' })).json()).toMatchObject({ ok: false });
    expect(ctx.inputs).toHaveLength(2);
    ctx.echo(ctx.inputs[1]!);
    expect(ctx.latest()).toMatchObject({ status: 'answered', resolution: 'native-acknowledged' });
    expect(ctx.store.journal.get('UNCERTAIN')?.state).toBe('completed');
  } finally { await ctx.close(); }
});

it('does not accept mismatched native input bytes as delivery evidence', async () => {
  const ctx = await fixture();
  try {
    ctx.ask(); await ctx.command('ANSWER', { custom: 'original' });
    ctx.echo({ ...ctx.inputs[1]!, text: formatCodexAsyncReply(ctx.latest(), 'different') });
    expect(ctx.latest().status).toBeUndefined();
    expect(ctx.store.journal.get('ANSWER')?.state).toBe('uncertain');
  } finally { await ctx.close(); }
});

it('resolves external native replies and rejects invalid options without dispatching an input', async () => {
  const ctx = await fixture();
  try {
    ctx.ask();
    expect((await ctx.command('BAD', { selected: ['invented'] })).json()).toMatchObject({ ok: false });
    expect(ctx.inputs).toHaveLength(1);
    ctx.echo({ text: formatCodexAsyncReply(ctx.latest(), { selected: ['English'] }) });
    expect(ctx.latest()).toMatchObject({ status: 'answered', resolution: 'external' });
    ctx.ask(); expect(ctx.latest().status).toBe('answered');
    expect((await ctx.command('TOO-LATE', { custom: 'late' })).json()).toMatchObject({ ok: false });
    expect(ctx.inputs).toHaveLength(1);
  } finally { await ctx.close(); }
});

it('withdraws an unsubmitted queued answer when an external native answer arrives', async () => {
  const ctx = await fixture();
  try {
    ctx.ask(); await ctx.command('OLD', { selected: ['English'] }, 0, 'queue');
    ctx.echo({ text: formatCodexAsyncReply(ctx.latest(), { selected: ['中文'] }) });
    expect(ctx.store.journal.get('OLD')?.state).toBe('cancelled');
    expect(ctx.store.journal.queue(ctx.sessionId).some(input => input.commandId === 'OLD')).toBe(false);
    ctx.feed({ method: 'turn/completed', params: { threadId: 'native', turn: { id: 'native-1', status: 'interrupted', items: [] } } });
    await ctx.manager.send(ctx.sessionId, { text: 'next' });
    expect(ctx.inputs.map(input => input.text)).toEqual(['start', 'next']);
    expect(ctx.latest()).toMatchObject({ status: 'answered', resolution: 'external' });
  } finally { await ctx.close(); }
});

it('allows retry after a definite rejection before the answer was enqueued', async () => {
  const ctx = await fixture();
  try {
    ctx.ask();
    expect((await ctx.command('WRONG', { custom: 'answer' }, 0, 'steer', 'wrong-turn')).json()).toMatchObject({ ok: false });
    expect(ctx.store.journal.get('WRONG')).toMatchObject({ state: 'failed', turnId: null });
    expect(ctx.latest()).toMatchObject({ submission: 'failed' });
    expect(ctx.inputs).toHaveLength(1);
    expect((await ctx.command('RETRY', { custom: 'answer' })).json()).toMatchObject({ ok: true });
    ctx.echo(ctx.inputs[1]!);
    expect(ctx.latest()).toMatchObject({ status: 'answered', resolution: 'native-acknowledged' });
  } finally { await ctx.close(); }
});

it('keeps this command uncertain if an external answer precedes a lost local RPC response', async () => {
  const ctx = await fixture();
  try {
    ctx.ask();
    ctx.native.adapter.steer = async (_id, input) => {
      ctx.inputs.push(input);
      ctx.echo({ text: formatCodexAsyncReply(ctx.latest(), { selected: ['中文'] }) });
      throw new Error('transport disconnected');
    };
    expect((await ctx.command('LOCAL', { selected: ['English'] })).json()).toMatchObject({ ok: false, code: 'uncertain' });
    expect(ctx.latest()).toMatchObject({ status: 'answered', resolution: 'external' });
    expect(ctx.store.journal.get('LOCAL')?.state).toBe('uncertain');
    expect(ctx.store.journal.queue(ctx.sessionId).find(input => input.commandId === 'LOCAL')?.state).toBe('uncertain');
    // An actual later native receipt can still confirm precisely this input.
    ctx.echo(ctx.inputs[1]!);
    expect(ctx.latest()).toMatchObject({ status: 'answered', resolution: 'native-acknowledged' });
    expect(ctx.store.journal.get('LOCAL')?.state).toBe('completed');
    expect(ctx.store.journal.queue(ctx.sessionId).find(input => input.commandId === 'LOCAL')).toBeUndefined();
  } finally { await ctx.close(); }
});

it('does not replace a missing answer receipt with the parent native turn completion', async () => {
  const ctx = await fixture();
  try {
    ctx.ask(); await ctx.command('LOCAL', { custom: 'answer' });
    ctx.feed({ method: 'turn/completed', params: { threadId: 'native', turn: { id: 'native-1', status: 'interrupted', items: [] } } });
    expect(ctx.store.journal.get('LOCAL')?.state).not.toBe('completed');
    expect(ctx.latest().status).toBeUndefined();
  } finally { await ctx.close(); }
});

it('releases an uncertain completed ordinary-answer input only when its late native receipt arrives', async () => {
  const ctx = await fixture();
  try {
    ctx.ask();
    ctx.feed({ method: 'turn/completed', params: { threadId: 'native', turn: { id: 'native-1', status: 'interrupted', items: [] } } });
    await ctx.command('IDLE', { custom: 'answer' });
    const input = ctx.inputs[1]!;
    ctx.feed({ method: 'turn/completed', params: { threadId: 'native', turn: { id: 'native-2', status: 'interrupted', items: [] } } });
    expect(ctx.latest().status).toBeUndefined();
    expect(ctx.store.journal.queue(ctx.sessionId).find(row => row.commandId === 'IDLE')?.state).toBe('uncertain');
    ctx.echo(input, 'native-2');
    expect(ctx.latest()).toMatchObject({ status: 'answered', resolution: 'native-acknowledged' });
    expect(ctx.store.journal.queue(ctx.sessionId).find(row => row.commandId === 'IDLE')).toBeUndefined();
  } finally { await ctx.close(); }
});
