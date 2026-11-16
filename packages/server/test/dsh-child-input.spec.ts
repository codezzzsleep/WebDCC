import { expect, it } from 'vitest';
import { createTestApp } from './helpers.js';
import { bindDshSubagentFixture, createDshSubagentFixture, childRecord } from '../../adapters/dsh/test/subagent-fixture.js';

async function setup() {
  const ctx = await createTestApp(); const workspace = ctx.store.createWorkspace('DSH child input', ctx.dataDir);
  const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'dsh' });
  const native = await createDshSubagentFixture(session.id); ctx.store.updateSession(session.id, { nativeId: native.parentId });
  bindDshSubagentFixture(ctx.manager, ctx.store.getSession(session.id)!, workspace.path, native.adapter, native.parentId);
  await ctx.manager.listSubagents(session.id);
  const post = (commandId: string, text: string, delivery = 'queue') => ctx.app.inject({ method: 'POST',
    url: `/api/sessions/${session.id}/subagents/reviewer/prompt`, headers: { cookie: ctx.cookie }, payload: { commandId, text, delivery, clientTimeZone: 'Asia/Shanghai' } });
  return { ctx, session, native, post, close: async () => { await ctx.close(); await native.close(); } };
}

const receiptPath = (sessionId: string, commandId: string) => `/api/sessions/${sessionId}/subagents/reviewer/prompts/${commandId}`;

it('a browser retry after discarding an accepted child input reply cannot create a second native message', async () => {
  const { ctx, session, native, post, close } = await setup();
  try {
    const first = await post('child-message-001', '  exact child input\r\n  '); expect(first.statusCode).toBe(200);
    // The browser lost the first response after native acceptance. Its exact retry retains the command identity.
    const retry = await post('child-message-001', '  exact child input\r\n  '); expect(retry.statusCode).toBe(200);
    const writes = native.calls.filter(call => call.method === 'subagents/prompt'); expect(writes).toHaveLength(1);
    expect(first.json()).toMatchObject({ receipt: { state: 'completed', reference: { dshChild: { childSessionId: 'reviewer', nativeRequestId: 'child-message-001' } } }, result: { accepted: true } });
    expect(retry.json().receipt.state).toBe('completed');
    expect(native.states.get('reviewer')?.queue).toHaveLength(1);
    expect((await post('child-message-001', 'changed text')).statusCode).toBe(409);
    expect(ctx.store.allEvents(session.id).filter(event => event.kind === 'user.message')).toEqual([]);
  } finally { await close(); }
});

it('a lost native ACK recovers input acceptance from the real-address native queue without another prompt', async () => {
  const { ctx, session, native, post, close } = await setup();
  native.loseNextResponse('subagents/prompt');
  try {
    expect((await post('child-queue-recovery-001', 'pending native queue input')).statusCode).toBe(503);
    const before = ctx.store.nativeActions.get('child-queue-recovery-001', session.id);
    expect(before).toMatchObject({ state: 'uncertain', reference: { dshChild: { afterSeq: 6, nativeRequestId: 'child-queue-recovery-001' } } });
    const observed = await ctx.app.inject({ method: 'GET', url: receiptPath(session.id, 'child-queue-recovery-001'), headers: { cookie: ctx.cookie } });
    expect(observed.statusCode).toBe(200); expect(observed.json().receipt).toMatchObject({ state: 'completed', reference: { dshChild: { messageId: native.states.get('reviewer')!.queue![0]!.id } } });
    expect((await post('child-queue-recovery-001', 'pending native queue input')).json().receipt.state).toBe('completed');
    expect(native.calls.filter(call => call.method === 'subagents/prompt')).toHaveLength(1);
  } finally { await close(); }
});

it('after inbox consumption, a lost native ACK is reconciled by paged exact native user identity and body', async () => {
  const { ctx, session, native, post, close } = await setup(); native.loseNextResponse('subagents/prompt');
  try {
    expect((await post('child-history-recovery-001', '  original native history\r\n  ')).statusCode).toBe(503);
    const state = native.states.get('reviewer')!; state.queue = []; native.setPageSize(2);
    for (let seq = 8; seq < 20; seq++) native.records.get('reviewer')!.push(childRecord(seq, 'tool/call', { callId: `later-${seq}`, name: 'read', arguments: '{}' }));
    state.cursor = 19;
    const previousPages = native.calls.filter(call => call.method === 'session/page').length;
    const observed = await ctx.app.inject({ method: 'GET', url: receiptPath(session.id, 'child-history-recovery-001'), headers: { cookie: ctx.cookie } });
    expect(observed.statusCode).toBe(200); expect(observed.json().receipt.state).toBe('completed');
    expect(native.calls.filter(call => call.method === 'session/page').length - previousPages).toBe(7);
    expect(native.calls.filter(call => call.method === 'subagents/prompt')).toHaveLength(1);
    expect(ctx.store.allEvents(session.id).filter(event => event.kind === 'user.message')).toEqual([]);
  } finally { await close(); }
});

it('a mismatched native body cannot settle an uncertain input, and pre-acceptance rejection keeps its exact native reason', async () => {
  const { ctx, session, native, post, close } = await setup(); native.loseNextResponse('subagents/prompt');
  try {
    expect((await post('child-wrong-echo-001', 'original input')).statusCode).toBe(503);
    native.states.get('reviewer')!.queue![0]!.content = [{ type: 'text', text: 'different body' }];
    (native.records.get('reviewer')!.at(-1)!.event.data as { content: unknown[] }).content = [{ type: 'text', text: 'different body' }];
    const unknown = await ctx.app.inject({ method: 'GET', url: receiptPath(session.id, 'child-wrong-echo-001'), headers: { cookie: ctx.cookie } });
    expect(unknown.json().receipt.state).toBe('uncertain'); expect(native.calls.filter(call => call.method === 'subagents/prompt')).toHaveLength(1);
  } finally { await close(); }
  const second = await setup(); second.native.rejectNextPrompt('subagent/delivery-unavailable');
  try {
    const rejected = await second.post('child-rejected-001', 'retained body'); expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({ receipt: { state: 'failed', reference: { dshChild: { rejection: { code: 'subagent/delivery-unavailable' } } } }, result: { accepted: false, failed: true } });
    expect(second.native.states.get('reviewer')?.queue).toBeNull();
    expect((await second.post('child-rejected-001', 'retained body')).json().receipt.state).toBe('failed');
    expect(second.native.calls.filter(call => call.method === 'subagents/prompt')).toHaveLength(1);
  } finally { await second.close(); }
});

it('cold native child inputs and current receipts do not create a parent writer, and foreign or replaced targets are rejected', async () => {
  const { ctx, session, native, close } = await setup(); native.cold();
  // Remove only the controlled local binding; the persisted session/native identity remains.
  await ctx.manager.dispose(session.id); ctx.manager.registerAdapter(native.adapter);
  const post = (child: string, commandId: string) => ctx.app.inject({ method: 'POST', url: `/api/sessions/${session.id}/subagents/${child}/prompt`, headers: { cookie: ctx.cookie },
    payload: { commandId, text: 'native child only', delivery: 'queue' } });
  try {
    expect((await post('reviewer', 'child-cold-input-001')).statusCode).toBe(200);
    expect(ctx.manager.getRuntime(session.id)).toBeUndefined(); expect(ctx.store.nativeOwners.get(session.id)?.state).toBe('released');
    for (const child of ['foreign', 'once', 'external']) expect((await post(child, `child-${child}-001`)).statusCode).toBe(409);
    expect(native.calls.filter(call => call.method === 'subagents/prompt')).toHaveLength(1);
    ctx.store.updateSession(session.id, { nativeId: 'changed-parent' });
    expect((await ctx.app.inject({ method: 'GET', url: receiptPath(session.id, 'child-cold-input-001'), headers: { cookie: ctx.cookie } })).statusCode).toBe(409);
    expect((await post('reviewer', 'child-cold-input-001')).statusCode).toBe(409);
    expect(native.calls.filter(call => call.method === 'subagents/prompt')).toHaveLength(1);
  } finally { await close(); }
});

it('child steer preserves native request identity, exact content and time zone without sending address fields or a parent prompt', async () => {
  const { native, post, close } = await setup();
  try {
    expect((await post('child-steer-message-001', '  原样\r\ntext  ', 'steer')).statusCode).toBe(200);
    const request = native.calls.find(call => call.method === 'subagents/prompt')?.args['request'];
    expect(request).toEqual({ requestId: 'child-steer-message-001', childSessionId: 'reviewer', delivery: 'steer',
      content: [{ type: 'text', text: '  原样\r\ntext  ' }], clientTimeZone: 'Asia/Shanghai' });
    expect(native.calls.some(call => call.method === 'session/prompt')).toBe(false);
  } finally { await close(); }
});
