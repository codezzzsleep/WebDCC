/** Controlled official approval envelopes through the production HTTP/journal/adapter path. */
import { expect, it } from 'vitest';
import { createTestApp } from './helpers.js';
import { bindDshQuestionFixture } from './fixtures/dsh-question.js';
import type { DshHostClient } from '../../adapters/dsh/src/host.js';

async function approval() {
  const ctx = await createTestApp(); const base = bindDshQuestionFixture(ctx);
  const { session, native, feed } = base; const client = (native.adapter as unknown as { client: DshHostClient }).client;
  let seq = 0; const record = (type: string, data: unknown) => feed({ type: 'event', event: { type, seq: ++seq, time: Date.now(), data } });
  record('turn/start', { turn: 1 });
  record('approval/asked', { id: 'native-durable-id', callId: 'native-approval-call', toolName: 'write' });
  const ask = () => feed({ type: 'waterfall', event: 'approval/request', agentId: 'native-question-root', eventId: 'native-approval-waterfall',
    request: { callId: 'native-approval-call', toolName: 'write', reason: 'Native approval recovery' } });
  ask(); let release!: () => void;
  client.rpc = async <T>() => { await new Promise<void>(resolve => { release = resolve; }); return undefined as T; };
  const commandId = 'native-local-approval-command';
  const send = () => ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command: {
    op: 'approve', clientCommandId: commandId, sessionId: session.id, approvalId: 'native-approval-waterfall', optionId: 'allowed-once',
  } } });
  return { ...ctx, ...base, commandId, send, ask, record, dispatched: () => typeof release === 'function', release: () => release() };
}

for (const outcome of ['rejected', 'cancelled', 'allowed-once'] as const) it(`native ${outcome} before the HTTP ACK is retained without claiming a local receipt`, async () => {
  const ctx = await approval();
  try {
    const response = ctx.send();
    await expect.poll(ctx.dispatched).toBe(true);
    ctx.record('approval/decided', { id: 'native-durable-id', outcome });
    ctx.release();
    expect((await response).json()).toMatchObject({ ok: false, code: 'uncertain' });
    expect(ctx.store.journal.get(ctx.commandId)?.state).toBe('uncertain');
    expect(ctx.store.interactions.get(ctx.session.id, 'approve', 'native-approval-waterfall')?.state).toBe('resolved');
    expect(ctx.store.latestInteractionEvent(ctx.session.id, 'approve', 'native-approval-waterfall').event?.data).toMatchObject({ optionId: outcome, by: 'unknown' });
  } finally { await ctx.close(); }
});

it('a superseded native Client ACK cannot turn a re-delivered pending approval into sent', async () => {
  const ctx = await approval();
  try {
    const response = ctx.send();
    await expect.poll(ctx.dispatched).toBe(true);
    ctx.feed({ type: 'ready', clientId: 'replacement-native-client' }); ctx.ask();
    ctx.release();
    expect((await response).json()).toMatchObject({ ok: false, code: 'uncertain' });
    expect(ctx.store.journal.get(ctx.commandId)?.state).toBe('uncertain');
    expect(ctx.store.interactions.get(ctx.session.id, 'approve', 'native-approval-waterfall')?.state).toBe('uncertain');
  } finally { await ctx.close(); }
});

for (const outcome of ['allowed-once', 'rejected'] as const) it(`after a current transport ACK, native ${outcome} still lacks answering Client provenance`, async () => {
  const ctx = await approval();
  try {
    const response = ctx.send(); await expect.poll(ctx.dispatched).toBe(true); ctx.release();
    expect((await response).json()).toEqual({ ok: true });
    expect(ctx.store.interactions.get(ctx.session.id, 'approve', 'native-approval-waterfall')?.state).toBe('sent');
    ctx.record('approval/decided', { id: 'native-durable-id', outcome });
    expect(ctx.store.journal.get(ctx.commandId)?.state).toBe('uncertain');
  } finally { await ctx.close(); }
});

it('forwarding cancellation before the durable decision does not invent a native cancellation', async () => {
  const ctx = await approval();
  try {
    ctx.feed({ type: 'cancel', eventId: 'native-approval-waterfall' });
    expect(ctx.store.hasApprovalResolved(ctx.session.id, 'native-approval-waterfall')).toBe(false);
    ctx.record('approval/decided', { id: 'native-durable-id', outcome: 'rejected' });
    expect(ctx.store.latestInteractionEvent(ctx.session.id, 'approve', 'native-approval-waterfall').event?.data).toMatchObject({ optionId: 'rejected' });
  } finally { await ctx.close(); }
});

it('a void current ACK before the same-option native audit cannot establish which Client was accepted', async () => {
  const ctx = await approval();
  try {
    const response = ctx.send(); await expect.poll(ctx.dispatched).toBe(true); ctx.release();
    expect((await response).json()).toEqual({ ok: true });
    ctx.record('approval/decided', { id: 'native-durable-id', outcome: 'allowed-once' });
    expect(ctx.store.journal.get(ctx.commandId)?.state).toBe('uncertain');
    expect(ctx.store.latestInteractionEvent(ctx.session.id, 'approve', 'native-approval-waterfall').event?.data).toMatchObject({ optionId: 'allowed-once', by: 'unknown' });
  } finally { await ctx.close(); }
});

it('a native asked audit arriving after its waterfall binds the same call to its durable decision', async () => {
  const ctx = await createTestApp(); const { session, feed } = bindDshQuestionFixture(ctx);
  try {
    feed({ type: 'waterfall', event: 'approval/request', agentId: 'native-question-root', eventId: 'late-audit-waterfall',
      request: { callId: 'late-audit-call', toolName: 'write' } });
    feed({ type: 'event', event: { type: 'approval/asked', seq: 1, time: 1, data: { id: 'late-durable-id', callId: 'late-audit-call', toolName: 'write' } } });
    feed({ type: 'event', event: { type: 'approval/decided', seq: 2, time: 2, data: { id: 'late-durable-id', outcome: 'rejected' } } });
    expect(ctx.store.hasApprovalResolved(session.id, 'late-audit-waterfall')).toBe(true);
    expect(ctx.store.latestInteractionEvent(session.id, 'approve', 'late-audit-waterfall').event?.data).toMatchObject({ optionId: 'rejected' });
  } finally { await ctx.close(); }
});
