/** Actual production HTTP/journal/adapter with controlled native delivery/outcomes. */
import { expect, it } from 'vitest';
import type { DshApprovalRecoveryView, DshApprovalRetry } from '@webdcc/protocol';
import { createTestApp } from './helpers.js';
import { bindDshApprovalRetry } from './fixtures/dsh-approval-retry.js';

async function pending(capture = true) {
  const app = await createTestApp(); const native = bindDshApprovalRetry(app);
  const identity = native.native.adapter.dshApprovalDelivery;
  if (!capture) native.native.adapter.dshApprovalDelivery = async () => undefined;
  const post = (commandId: string, optionId = 'allowed-once', retryOf?: DshApprovalRetry) => app.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: app.cookie }, payload: { command: {
    op: 'approve', clientCommandId: commandId, sessionId: native.session.id, approvalId: native.approvalId, optionId,
    ...(retryOf === undefined ? {} : { retryOf }),
  } } });
  expect((await post('first-approval-choice')).json()).toMatchObject({ ok: false, code: 'uncertain' });
  native.native.adapter.dshApprovalDelivery = identity;
  native.reoffer();
  const recovery = async (): Promise<DshApprovalRecoveryView> => {
    const response = await app.app.inject({ method: 'GET', url: `/api/sessions/${native.session.id}/dsh/approval-recovery?approvalId=${native.approvalId}`, headers: { cookie: app.cookie } });
    expect(response.statusCode).toBe(200); return response.json() as DshApprovalRecoveryView;
  };
  return { ...app, ...native, post, recovery };
}
async function available(ctx: Awaited<ReturnType<typeof pending>>) {
  const value = await ctx.recovery(); expect(value.status).toBe('available');
  if (value.status !== 'available') throw new Error(value.reason);
  return value;
}

it('exposes an explicit original-choice retry after an uncertain RPC and the same native event is reoffered', async () => {
  const ctx = await pending();
  try {
    expect(await available(ctx)).toMatchObject({ approvalId: ctx.approvalId, optionId: 'allowed-once', retryOf: { commandId: 'first-approval-choice' } });
    expect(JSON.parse(ctx.store.interactions.get(ctx.session.id, 'approve', ctx.approvalId)!.request)).toMatchObject({
      dshApprovalAttempt: { optionId: 'allowed-once', delivery: { nativeId: 'native-question-root', agentId: 'native-question-root',
        eventId: ctx.approvalId, callId: 'approval-call', durableId: 'durable-approval', clientId: 'current-client' } },
    });
    expect(ctx.replies).toHaveLength(1);
  } finally { await ctx.close(); }
});

it('retries one immutable native event, deduplicates the new command and keeps acceptance provenance uncertain', async () => {
  const ctx = await pending();
  try {
    const view = await available(ctx);
    expect((await ctx.post('explicit-retry', view.optionId, view.retryOf)).json()).toEqual({ ok: true });
    expect((await ctx.post('explicit-retry', view.optionId, view.retryOf)).json()).toEqual({ ok: true });
    expect(ctx.replies).toEqual([
      { clientId: 'current-client', eventId: ctx.approvalId, outcome: { kind: 'result', value: 'allowed-once' } },
      { clientId: 'replacement-client', eventId: ctx.approvalId, outcome: { kind: 'result', value: 'allowed-once' } },
    ]);
    expect(ctx.store.interactions.get(ctx.session.id, 'approve', ctx.approvalId)?.state).toBe('sent');
    expect(await ctx.recovery()).toMatchObject({ status: 'unavailable' });
    ctx.record('approval/decided', { id: 'durable-approval', outcome: 'allowed-once' });
    expect(ctx.store.interactions.get(ctx.session.id, 'approve', ctx.approvalId)?.state).toBe('resolved');
    expect(ctx.store.journal.get('first-approval-choice')?.state).toBe('uncertain');
    expect(ctx.store.journal.get('explicit-retry')?.state).toBe('uncertain');
    expect(ctx.store.latestInteractionEvent(ctx.session.id, 'approve', ctx.approvalId).event?.data).toMatchObject({ optionId: 'allowed-once', by: 'unknown' });
    expect(await ctx.recovery()).toMatchObject({ status: 'unavailable' });
    expect(ctx.replies).toHaveLength(2);
  } finally { await ctx.close(); }
});

it('does not loosen ordinary approval claims or allow a changed choice through a recovery token', async () => {
  const ctx = await pending();
  try {
    const view = await available(ctx);
    expect((await ctx.post('ordinary-again')).json()).toMatchObject({ ok: false, code: 'uncertain' });
    expect((await ctx.post('changed-retry', 'rejected', view.retryOf)).json()).toMatchObject({ ok: false });
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.store.interactions.get(ctx.session.id, 'approve', ctx.approvalId)?.command_id).toBe('first-approval-choice');
  } finally { await ctx.close(); }
});

it('rejects a cached token after native Client re-delivery and permits a freshly checked original choice', async () => {
  const ctx = await pending();
  try {
    const stale = await available(ctx); ctx.feed({ type: 'ready', clientId: 'third-client' }); ctx.ask();
    expect((await ctx.post('stale-token', stale.optionId, stale.retryOf)).json()).toMatchObject({ ok: false });
    expect(ctx.replies).toHaveLength(1);
    const fresh = await available(ctx);
    expect((await ctx.post('fresh-token', fresh.optionId, fresh.retryOf)).json()).toEqual({ ok: true });
    expect(ctx.replies[1]).toMatchObject({ clientId: 'third-client', eventId: ctx.approvalId });
  } finally { await ctx.close(); }
});

for (const changed of ['host', 'call', 'durable', 'agent'] as const) it(`refuses recovery after the native ${changed} identity changes`, async () => {
  const ctx = await pending();
  try {
    const view = await available(ctx);
    if (changed === 'host') {
      const original = ctx.native.adapter.hostIdentity;
      ctx.native.adapter.hostIdentity = async () => ({ ...await original(), fingerprint: 'different-controlled-host' });
    } else if (changed === 'agent') ctx.store.updateSession(ctx.session.id, { nativeId: 'another-native-agent' });
    else {
      if (changed === 'durable') ctx.record('approval/asked', { id: 'another-durable-id', callId: 'approval-call', toolName: 'write' });
      ctx.feed({ type: 'waterfall', event: 'approval/request', agentId: 'native-question-root', eventId: ctx.approvalId,
        request: { callId: changed === 'call' ? 'another-call' : 'approval-call', toolName: 'write' } });
    }
    expect(await ctx.recovery()).toMatchObject({ status: 'unavailable' });
    expect((await ctx.post('foreign-retry', view.optionId, view.retryOf)).json()).toMatchObject({ ok: false });
    expect(ctx.replies).toHaveLength(1);
  } finally { await ctx.close(); }
});

it('keeps missing old correlation unavailable instead of reconstructing it from the latest request', async () => {
  const ctx = await pending(false);
  try {
    expect(await ctx.recovery()).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('未留存') });
    expect(ctx.replies).toHaveLength(1);
  } finally { await ctx.close(); }
});

it('admits only one of two competing explicit recovery commands', async () => {
  const ctx = await pending(); let release!: () => void;
  try {
    const view = await available(ctx); const rpc = ctx.client.rpc;
    ctx.client.rpc = async <T>(endpoint: string, args: Record<string, unknown>) => {
      if (endpoint === '$events/result') await new Promise<void>(resolve => { release = resolve; });
      return rpc<T>(endpoint, args);
    };
    const first = ctx.post('retry-browser-one', view.optionId, view.retryOf);
    await expect.poll(() => typeof release).toBe('function');
    expect((await ctx.post('retry-browser-two', view.optionId, view.retryOf)).json()).toMatchObject({ ok: false });
    release(); expect((await first).json()).toEqual({ ok: true });
    expect(ctx.replies).toHaveLength(2);
  } finally { release?.(); await ctx.close(); }
});

it('a native decision received during recovery preflight prevents any repeated RPC', async () => {
  const ctx = await pending(); let release!: () => void;
  try {
    const original = ctx.native.adapter.hostIdentity;
    ctx.native.adapter.hostIdentity = async () => { await new Promise<void>(resolve => { release = resolve; }); return original(); };
    const query = ctx.recovery(); await expect.poll(() => typeof release).toBe('function');
    ctx.record('approval/decided', { id: 'durable-approval', outcome: 'rejected' }); release();
    expect(await query).toMatchObject({ status: 'unavailable' });
    expect(ctx.store.latestInteractionEvent(ctx.session.id, 'approve', ctx.approvalId).event?.data).toMatchObject({ optionId: 'rejected' });
    expect(ctx.replies).toHaveLength(1);
  } finally { release?.(); await ctx.close(); }
});

it('a definitely unsubmitted stale retry preserves the original uncertainty for another explicit check', async () => {
  const ctx = await pending();
  try {
    const view = await available(ctx); const retry = ctx.native.adapter.retryDshApproval;
    ctx.native.adapter.retryDshApproval = async (...args) => {
      ctx.feed({ type: 'ready', clientId: 'changed-before-native-dispatch' }); ctx.ask();
      return retry.apply(ctx.native.adapter, args);
    };
    expect((await ctx.post('reclaimed-but-not-dispatched', view.optionId, view.retryOf)).json()).toMatchObject({ ok: false });
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.store.journal.get('reclaimed-but-not-dispatched')?.state).toBe('failed');
    expect(ctx.store.interactions.get(ctx.session.id, 'approve', ctx.approvalId)).toMatchObject({ state: 'uncertain', command_id: 'first-approval-choice' });
    ctx.native.adapter.retryDshApproval = retry;
    const fresh = await available(ctx);
    expect((await ctx.post('fresh-after-no-dispatch', fresh.optionId, fresh.retryOf)).json()).toEqual({ ok: true });
    expect(ctx.replies).toHaveLength(2);
  } finally { await ctx.close(); }
});
