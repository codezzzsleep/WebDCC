/** Source HTTP/journal/SQLite with controlled native group failure and re-delivery. */
import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DshQuestionAnswer, DshQuestionRecoveryView, DshQuestionRetry } from '@webdcc/protocol';
import { createTestApp } from './helpers.js';
import { bindDshQuestionOriginalRetry } from './fixtures/dsh-question-original-retry.js';

const first = { selected: ['Keep'], custom: '  exact first\r\n  ' };
const second = { selected: ['Second'], custom: 'exact second\n' };
async function pending(options: { capture?: boolean; secret?: boolean; timed?: boolean; dbPath?: string } = {}) {
  const ctx = await createTestApp({}, undefined, {}, { dbPath: options.dbPath });
  const group = bindDshQuestionOriginalRetry(ctx, options);
  const prepare = group.native.adapter.prepareDshQuestionAnswer;
  if (options.capture === false) group.native.adapter.prepareDshQuestionAnswer = async () => undefined;
  const post = (commandId: string, questionId: string, answer: unknown, retryOf?: DshQuestionRetry) => ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command: {
    op: 'answer', clientCommandId: commandId, sessionId: group.session.id, questionId, answer, ...(retryOf === undefined ? {} : { retryOf }),
  } } });
  expect((await post('original-one', group.ids[0]!, first)).json()).toMatchObject({ ok: true, value: { submitted: false } });
  expect((await post('original-two', group.ids[1]!, second)).json()).toMatchObject({ ok: false, code: 'uncertain' });
  group.native.adapter.prepareDshQuestionAnswer = prepare; group.reoffer();
  const recovery = async (): Promise<DshQuestionRecoveryView> => {
    const response = await ctx.app.inject({ method: 'GET', url: `/api/sessions/${group.session.id}/dsh/question-recovery?${new URLSearchParams({ questionId: group.ids[1]! })}`, headers: { cookie: ctx.cookie } });
    expect(response.statusCode).toBe(200); return response.json() as DshQuestionRecoveryView;
  };
  const settled = (answers?: DshQuestionAnswer[]) => group.record('tool/result', { message: { toolCallId: group.callId, isError: false,
    content: [{ type: 'text', text: JSON.stringify({ answers: answers ?? [{ id: 'one', ...first }, { id: 'two', ...second }] }) }] } });
  return { ...ctx, ...group, post, recovery, settled };
}
async function available(ctx: Awaited<ReturnType<typeof pending>>) {
  const view = await ctx.recovery(); expect(view.status).toBe('available');
  if (view.status !== 'available') throw new Error(view.reason);
  return view;
}
const batch = (view: Extract<DshQuestionRecoveryView, { status: 'available' }>) => ({ answers: view.items.map(({ id, selected, custom }) => ({ id, selected, ...(custom === undefined ? {} : { custom }) })) });

it('offers the complete original batch after its last RPC failed and the same native question is reoffered', async () => {
  const ctx = await pending();
  try {
    expect(await available(ctx)).toMatchObject({ questionId: ctx.ids[1], retryOf: { commandId: 'original-two' },
      items: [{ id: 'one', prompt: 'Original first choice', ...first }, { id: 'two', prompt: 'Original second choice', ...second }] });
    expect(ctx.store.interactions.dshQuestionOriginal(ctx.store.interactions.get(ctx.session.id, 'answer', ctx.ids[1]!)!)).toMatchObject({
      commandId: 'original-two', sent: false, delivery: { nativeId: 'native-question-root', agentId: 'native-question-root', callId: ctx.callId,
        eventId: ctx.eventId, itemIds: ['one', 'two'], clientId: 'current-client', hostFingerprint: 'e'.repeat(64) },
      answers: [{ id: 'one', ...first }, { id: 'two', ...second }],
    });
    expect(ctx.replies).toHaveLength(1); expect(ctx.store.journal.get('original-two')?.state).toBe('uncertain');
  } finally { await ctx.close(); }
});

it('retries the exact batch once per stable command, leaving void ACK acceptance separate from the native answer', async () => {
  const ctx = await pending();
  try {
    const view = await available(ctx); const answer = batch(view);
    expect((await ctx.post('explicit-original-retry', ctx.ids[1]!, answer, view.retryOf)).json()).toMatchObject({ ok: true, value: { confirmed: false, submitted: true } });
    expect((await ctx.post('explicit-original-retry', ctx.ids[1]!, answer, view.retryOf)).json()).toMatchObject({ ok: true });
    expect(ctx.replies).toEqual([{ clientId: 'current-client', eventId: ctx.eventId, outcome: { kind: 'result', value: answer } },
      { clientId: 'replacement-question-client', eventId: ctx.eventId, outcome: { kind: 'result', value: answer } }]);
    expect(await ctx.recovery()).toMatchObject({ status: 'unavailable' }); ctx.settled();
    for (const id of ctx.ids) expect(ctx.store.latestInteractionEvent(ctx.session.id, 'answer', id).event?.data).toMatchObject({ status: 'answered', resolution: 'native-resolved' });
    expect(ctx.store.journal.get('original-two')?.state).toBe('uncertain'); expect(ctx.store.journal.get('explicit-original-retry')?.state).toBe('uncertain');
    expect(ctx.replies).toHaveLength(2);
  } finally { await ctx.close(); }
});

it('keeps ordinary answers fenced and rejects edits to any answer or whitespace through a recovery token', async () => {
  const ctx = await pending();
  try {
    const view = await available(ctx);
    expect((await ctx.post('ordinary-again', ctx.ids[1]!, second)).json()).toMatchObject({ ok: false, code: 'uncertain' });
    for (const [index, changed] of [{ answers: [{ id: 'one', ...first }, { id: 'two', selected: ['Other'] }] },
      { answers: [{ id: 'one', ...first, custom: first.custom.trim() }, { id: 'two', ...second }] }].entries())
      expect((await ctx.post(`edited-retry-${index}`, ctx.ids[1]!, changed, view.retryOf)).json()).toMatchObject({ ok: false });
    expect(ctx.replies).toHaveLength(1); expect(ctx.store.interactions.get(ctx.session.id, 'answer', ctx.ids[1]!)?.command_id).toBe('original-two');
  } finally { await ctx.close(); }
});

for (const changed of ['host', 'agent', 'call', 'event', 'item', 'schema', 'secret'] as const) it(`refuses a cached retry after native ${changed} identity changes`, async () => {
  const ctx = await pending();
  try {
    const view = await available(ctx);
    if (changed === 'host') { const identity = ctx.native.adapter.hostIdentity; ctx.native.adapter.hostIdentity = async () => ({ ...await identity(), fingerprint: 'f'.repeat(64) }); }
    else if (changed === 'agent') ctx.store.updateSession(ctx.session.id, { nativeId: 'another-agent' });
    else if (changed === 'call') ctx.ask({ callId: 'another-call' });
    else if (changed === 'event') { ctx.feed({ type: 'cancel', eventId: ctx.eventId }); ctx.ask({ eventId: 'another-event' }); }
    else ctx.ask({ questions: ctx.questions.map((question, index) => index === 0 ? { ...question,
      ...(changed === 'item' ? { id: 'another-item' } : changed === 'secret' ? { isSecret: true } : { question: 'Changed native schema' }) } : question) });
    expect(await ctx.recovery()).toMatchObject({ status: 'unavailable' });
    expect((await ctx.post(`foreign-${changed}`, ctx.ids[1]!, batch(view), view.retryOf)).json()).toMatchObject({ ok: false });
    expect(ctx.replies).toHaveLength(1);
  } finally { await ctx.close(); }
});

it('requires a fresh token after Client re-delivery and preserves an undispatched retry as a separate failure', async () => {
  const ctx = await pending();
  try {
    const stale = await available(ctx); ctx.feed({ type: 'ready', clientId: 'third-client' }); ctx.ask();
    expect((await ctx.post('stale-token', ctx.ids[1]!, batch(stale), stale.retryOf)).json()).toMatchObject({ ok: false });
    const fresh = await available(ctx); const retry = ctx.native.adapter.retryDshQuestion;
    ctx.native.adapter.retryDshQuestion = async (...args) => { ctx.feed({ type: 'ready', clientId: 'changed-before-dispatch' }); ctx.ask(); return retry.apply(ctx.native.adapter, args); };
    expect((await ctx.post('not-dispatched-retry', ctx.ids[1]!, batch(fresh), fresh.retryOf)).json()).toMatchObject({ ok: false });
    expect(ctx.replies).toHaveLength(1); expect(ctx.store.journal.get('not-dispatched-retry')?.state).toBe('failed');
    expect(ctx.store.interactions.get(ctx.session.id, 'answer', ctx.ids[1]!)).toMatchObject({ state: 'uncertain', command_id: 'original-two' });
    ctx.native.adapter.retryDshQuestion = retry;
    const newest = await available(ctx); expect((await ctx.post('fresh-retry', ctx.ids[1]!, batch(newest), newest.retryOf)).json()).toMatchObject({ ok: true });
    expect(ctx.replies).toHaveLength(2);
  } finally { await ctx.close(); }
});

for (const option of ['missing', 'secret'] as const) it(`does not reconstruct a ${option} original batch from the latest question`, async () => {
  const ctx = await pending({ capture: option !== 'missing', secret: option === 'secret' });
  try {
    expect(await ctx.recovery()).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('未留存') });
    for (const id of ctx.ids) expect(ctx.store.interactions.dshQuestionOriginal(ctx.store.interactions.get(ctx.session.id, 'answer', id)!)).toBeUndefined();
    if (option === 'secret') expect(ctx.store.journal.get('original-one')?.payload).toMatchObject({ answer: { omitted: 'sensitive-answer' } });
    expect(ctx.replies).toHaveLength(1);
  } finally { await ctx.close(); }
});

it('admits only one competing retry and permits a new explicit check after that retry is itself unknown', async () => {
  const ctx = await pending(); let release!: () => void;
  try {
    const view = await available(ctx); const rpc = ctx.client.rpc;
    ctx.client.rpc = async <T>(endpoint: string, args: Record<string, unknown>) => {
      if (endpoint === '$events/result') { await new Promise<void>(resolve => { release = resolve; }); throw Object.assign(new Error('second uncertain reply'), { code: 'uncertain' }); }
      return rpc<T>(endpoint, args);
    };
    const one = ctx.post('competitor-one', ctx.ids[1]!, batch(view), view.retryOf);
    await expect.poll(() => typeof release).toBe('function');
    expect((await ctx.post('competitor-two', ctx.ids[1]!, batch(view), view.retryOf)).json()).toMatchObject({ ok: false });
    release(); expect((await one).json()).toMatchObject({ ok: false, code: 'uncertain' });
    ctx.client.rpc = rpc; ctx.reoffer(); const fresh = await available(ctx);
    expect(fresh.retryOf.commandId).toBe('competitor-one');
    expect((await ctx.post('retry-after-unknown', ctx.ids[1]!, batch(fresh), fresh.retryOf)).json()).toMatchObject({ ok: true });
    expect(ctx.store.journal.get('original-two')?.state).toBe('uncertain'); expect(ctx.store.journal.get('competitor-one')?.state).toBe('uncertain');
  } finally { release?.(); await ctx.close(); }
});

it('a native terminal result received during recovery preflight prevents dispatch', async () => {
  const ctx = await pending(); let release!: () => void;
  try {
    const identity = ctx.native.adapter.hostIdentity;
    ctx.native.adapter.hostIdentity = async () => { await new Promise<void>(resolve => { release = resolve; }); return identity(); };
    const query = ctx.recovery(); await expect.poll(() => typeof release).toBe('function');
    ctx.settled([{ id: 'one', selected: ['Native other answer'] }, { id: 'two', selected: [] }]); release();
    expect(await query).toMatchObject({ status: 'unavailable' }); expect(ctx.replies).toHaveLength(1);
    expect(ctx.store.latestInteractionEvent(ctx.session.id, 'answer', ctx.ids[1]!).event?.data).toMatchObject({ status: 'answered', resolution: 'native-resolved' });
  } finally { release?.(); await ctx.close(); }
});

it('keeps a native terminal state when it precedes the retried void ACK', async () => {
  const ctx = await pending();
  try {
    const view = await available(ctx); const rpc = ctx.client.rpc;
    ctx.client.rpc = async <T>(endpoint: string, args: Record<string, unknown>) => { const receipt = await rpc<T>(endpoint, args); if (endpoint === '$events/result') ctx.settled(); return receipt; };
    expect((await ctx.post('terminal-before-retry-ack', ctx.ids[1]!, batch(view), view.retryOf)).json()).toMatchObject({ ok: false, code: 'uncertain' });
    expect(ctx.store.latestInteractionEvent(ctx.session.id, 'answer', ctx.ids[1]!).event?.data).toMatchObject({ status: 'answered', resolution: 'native-resolved' });
    expect(ctx.store.journal.get('terminal-before-retry-ack')?.state).toBe('uncertain'); expect(ctx.replies).toHaveLength(2);
  } finally { await ctx.close(); }
});

it('does not turn a continued native question into a foreground original-answer retry', async () => {
  const ctx = await pending({ timed: true });
  try {
    const view = await available(ctx);
    ctx.record('tool/result', { message: { toolCallId: ctx.callId, isError: false, content: [{ type: 'text', text: JSON.stringify({ pending: true, callId: ctx.callId }) }] } });
    expect(await ctx.recovery()).toMatchObject({ status: 'unavailable' });
    expect((await ctx.post('continued-is-not-retry', ctx.ids[1]!, batch(view), view.retryOf)).json()).toMatchObject({ ok: false });
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.store.latestInteractionEvent(ctx.session.id, 'answer', ctx.ids[1]!).event?.data).toMatchObject({ dshQuestion: { phase: 'continued' } });
  } finally { await ctx.close(); }
});

it('preserves answer order when the user completes the last native item first', async () => {
  const ctx = await createTestApp(); const group = bindDshQuestionOriginalRetry(ctx);
  const post = (commandId: string, questionId: string, answer: unknown, retryOf?: DshQuestionRetry) => ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command: {
    op: 'answer', clientCommandId: commandId, sessionId: group.session.id, questionId, answer, retryOf,
  } } });
  try {
    expect((await post('second-item-first', group.ids[1]!, second)).json()).toMatchObject({ ok: true, value: { submitted: false } });
    expect((await post('first-item-last', group.ids[0]!, first)).json()).toMatchObject({ ok: false, code: 'uncertain' }); group.reoffer();
    const response = await ctx.app.inject({ method: 'GET', url: `/api/sessions/${group.session.id}/dsh/question-recovery?${new URLSearchParams({ questionId: group.ids[0]! })}`, headers: { cookie: ctx.cookie } });
    const view = response.json() as DshQuestionRecoveryView;
    expect(view.status).toBe('available'); if (view.status !== 'available') throw new Error(view.reason);
    expect(batch(view).answers).toEqual([{ id: 'two', ...second }, { id: 'one', ...first }]);
    expect((await post('retry-reverse-order', group.ids[0]!, batch(view), view.retryOf)).json()).toMatchObject({ ok: true });
    expect(group.replies[1]).toEqual({ ...group.replies[0], clientId: 'replacement-question-client' });
  } finally { await ctx.close(); }
});

it('does not send a complete batch whose pre-dispatch durable capture fails', async () => {
  const ctx = await createTestApp(); const group = bindDshQuestionOriginalRetry(ctx);
  try {
    const post = (commandId: string, questionId: string, answer: unknown) => ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command: {
      op: 'answer', clientCommandId: commandId, sessionId: group.session.id, questionId, answer,
    } } });
    expect((await post('capture-first', group.ids[0]!, first)).json()).toMatchObject({ ok: true });
    ctx.store.interactions.bindDshQuestion = () => { throw new Error('controlled durable group capture failure'); };
    expect((await post('capture-final', group.ids[1]!, second)).json()).toMatchObject({ ok: false });
    expect(group.replies).toHaveLength(0); expect(ctx.store.journal.get('capture-final')?.state).toBe('uncertain');
  } finally { await ctx.close(); }
});

it('does not infer original command identity when its persisted payload digest is missing', async () => {
  const ctx = await pending(); const get = ctx.store.journal.get.bind(ctx.store.journal);
  try {
    ctx.store.journal.get = commandId => { const value = get(commandId); return commandId === 'original-two' && value !== undefined ? { ...value, payloadHash: null } : value; };
    expect(await ctx.recovery()).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('身份未留存') });
    expect(ctx.replies).toHaveLength(1);
  } finally { ctx.store.journal.get = get; await ctx.close(); }
});

for (const code of ['ASK_CANCELLED', 'CONTROLLED_UNKNOWN_FAILURE']) it(`a native ${code} outcome ends both questions without confirming or retrying the unknown original`, async () => {
  const ctx = await pending();
  try {
    const view = await available(ctx);
    ctx.record('tool/result', { message: { toolCallId: ctx.callId, isError: true, content: [] }, error: { code } });
    for (const id of ctx.ids) expect(ctx.store.latestInteractionEvent(ctx.session.id, 'answer', id).event?.data).toMatchObject({ status: 'skipped' });
    expect(await ctx.recovery()).toMatchObject({ status: 'unavailable' });
    expect((await ctx.post(`closed-${code}`, ctx.ids[1]!, batch(view), view.retryOf)).json()).toMatchObject({ ok: false });
    expect(ctx.replies).toHaveLength(1); expect(ctx.store.journal.get('original-two')?.state).toBe('uncertain');
  } finally { await ctx.close(); }
});

it('a late retry failure cannot overwrite a new continued answer after the native foreground has ended', async () => {
  const ctx = await pending({ timed: true }); let release!: () => void;
  try {
    const view = await available(ctx); const rpc = ctx.client.rpc;
    ctx.client.rpc = async <T>(endpoint: string, args: Record<string, unknown>) => {
      if (endpoint === 'userQuestions/answer') return true as T;
      if (endpoint === '$events/result') { await new Promise<void>(resolve => { release = resolve; }); throw new Error('late old reply loss'); }
      return rpc<T>(endpoint, args);
    };
    const old = ctx.post('old-held-retry', ctx.ids[1]!, batch(view), view.retryOf); await expect.poll(() => typeof release).toBe('function');
    ctx.record('tool/result', { message: { toolCallId: ctx.callId, isError: false, content: [{ type: 'text', text: JSON.stringify({ pending: true, callId: ctx.callId }) }] } });
    expect((await ctx.post('explicit-new-continued', ctx.ids[1]!, { selected: ['Second'], custom: 'new late answer' })).json()).toMatchObject({ ok: true });
    release(); expect((await old).json()).toMatchObject({ ok: false });
    expect(ctx.store.interactions.get(ctx.session.id, 'answer', ctx.ids[1]!)).toMatchObject({ state: 'sent', command_id: 'explicit-new-continued' });
    expect(ctx.store.journal.get('old-held-retry')?.state).toBe('failed'); expect(await ctx.recovery()).toMatchObject({ status: 'unavailable' });
  } finally { release?.(); await ctx.close(); }
});

for (const sent of [false, true]) it(`reopens persisted ${sent ? 'sent' : 'uncertain'} batches without automatically resending or losing the sent boundary`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-question-original-')); const dbPath = join(directory, 'db.sqlite');
  let ctx: Awaited<ReturnType<typeof pending>> | undefined; let reopened: Awaited<ReturnType<typeof createTestApp>> | undefined;
  try {
    ctx = await pending({ dbPath }); const session = ctx.session;
    if (sent) { const view = await available(ctx); expect((await ctx.post('known-sent-retry', ctx.ids[1]!, batch(view), view.retryOf)).json()).toMatchObject({ ok: true }); }
    const ids = ctx.ids; await ctx.close(); ctx = undefined;
    reopened = await createTestApp({}, undefined, {}, { dbPath });
    const delivery = bindDshQuestionOriginalRetry(reopened, { existing: reopened.store.getSession(session.id)! });
    const response = await reopened.app.inject({ method: 'GET', url: `/api/sessions/${session.id}/dsh/question-recovery?${new URLSearchParams({ questionId: ids[1]! })}`, headers: { cookie: reopened.cookie } });
    expect(response.json()).toMatchObject({ status: sent ? 'unavailable' : 'available' });
    expect(delivery.replies).toHaveLength(0); expect(reopened.store.journal.get('original-two')?.state).toBe('uncertain');
  } finally { await ctx?.close(); await reopened?.close(); await rm(directory, { recursive: true, force: true }); }
});
