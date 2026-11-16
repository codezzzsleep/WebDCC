/** Controlled native envelopes/transport over production HTTP/SQLite. No Host or Provider. */
import { expect, it } from 'vitest';
import type { DshHostClient } from '../../adapters/dsh/src/host.js';
import { createTestApp } from './helpers.js';
import { bindDshQuestionFixture } from './fixtures/dsh-question.js';
import { bindDshTimedPeer } from './fixtures/dsh-timed-peer.js';

for (const order of ['before-ack', 'after-ack', 'transport-error'] as const) it(`native same-answer settlement ${order} does not identify the replying local Client`, async () => {
  const ctx = await createTestApp(); const { native, session, ask, result, feed } = bindDshQuestionFixture(ctx); const id = ask();
  let replies = 0;
  try {
    const client = (native.adapter as unknown as { client: DshHostClient }).client; const rpc = client.rpc.bind(client);
    const otherResult = () => { feed({ type: 'cancel', eventId: 'native-question-waterfall' }); result(['Continue']); };
    client.rpc = async <T>(endpoint: string, args: Record<string, unknown>) => {
      if (endpoint !== '$events/result') return rpc<T>(endpoint, args);
      replies++;
      if (order !== 'after-ack') otherResult();
      if (order === 'transport-error') throw Object.assign(new Error('controlled local reply transport loss'), { code: 'uncertain' });
      return undefined as T;
    };
    const commandId = `local-answer-${order}`;
    const response = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command: {
      op: 'answer', clientCommandId: commandId, sessionId: session.id, questionId: id, answer: { selected: ['Continue'] },
    } } });
    if (order === 'after-ack') otherResult();
    const event = ctx.store.latestInteractionEvent(session.id, 'answer', id).event;
    expect({ reply: response.json(), event: event?.data, commandState: ctx.store.journal.get(commandId)?.state }).toMatchObject({
      reply: order === 'after-ack' ? { ok: true } : { ok: false, code: 'uncertain' },
      event: { questionId: id, toolCallId: 'native-question-call', status: 'answered', resolution: 'native-resolved' },
      commandState: 'uncertain',
    });
    expect(replies).toBe(1);
    expect(ctx.store.interactions.get(session.id, 'answer', id)?.state).toBe('resolved');
  } finally { await ctx.close(); }
});

for (const outcome of ['not-continued', 'reply-queued'] as const) it(`continued native ${outcome} with a matching settled batch does not accept the local attempt`, async () => {
  const ctx = await createTestApp(); const peer = await bindDshTimedPeer(ctx); const id = peer.ask(); peer.continued();
  try {
    const rpc = peer.client.rpc.bind(peer.client);
    peer.client.rpc = async <T>(endpoint: string, args: Record<string, unknown>) => {
      if (endpoint !== 'userQuestions/answer') return rpc<T>(endpoint, args);
      peer.answered();
      if (outcome === 'reply-queued') throw Object.assign(new Error('controlled other reply is already queued'), { code: 'REPLY_QUEUED', statusCode: 409 });
      return false as T;
    };
    const commandId = `late-answer-${outcome}`;
    const response = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command: {
      op: 'answer', clientCommandId: commandId, sessionId: peer.session.id, questionId: id, answer: { selected: ['Original label'] },
    } } });
    expect({ reply: response.json(), event: ctx.store.latestInteractionEvent(peer.session.id, 'answer', id).event?.data }).toMatchObject({
      reply: { ok: false }, event: { status: 'answered', resolution: 'native-resolved' },
    });
    expect(ctx.store.journal.get(commandId)?.state).not.toBe('completed');
  } finally { await peer.closePeer(); await ctx.close(); }
});

it('a source HTTP continued boolean acceptance confirms only its current call, including settlement before the receipt', async () => {
  const ctx = await createTestApp(); const peer = await bindDshTimedPeer(ctx); const id = peer.ask(); peer.continued();
  try {
    const rpc = peer.client.rpc.bind(peer.client);
    peer.client.rpc = async <T>(endpoint: string, args: Record<string, unknown>) => {
      const receipt = await rpc<T>(endpoint, args);
      if (endpoint === 'userQuestions/answer') peer.answered();
      return receipt;
    };
    const response = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command: {
      op: 'answer', clientCommandId: 'late-answer-accepted', sessionId: peer.session.id, questionId: id, answer: { selected: ['Original label'] },
    } } });
    expect(response.json()).toMatchObject({ ok: true });
    expect(ctx.store.latestInteractionEvent(peer.session.id, 'answer', id).event?.data).toMatchObject({ status: 'answered', resolution: 'native-acknowledged' });
    expect(ctx.store.journal.get('late-answer-accepted')?.state).toBe('completed');
    expect(peer.calls.filter(call => call.endpoint === 'userQuestions/answer')).toHaveLength(1);
  } finally { await peer.closePeer(); await ctx.close(); }
});

it('a late continued true receipt from an older native generation cannot claim the current settlement', async () => {
  const ctx = await createTestApp(); const peer = await bindDshTimedPeer(ctx); const id = peer.ask(); peer.continued();
  let release!: () => void;
  try {
    const rpc = peer.client.rpc.bind(peer.client);
    peer.client.rpc = async <T>(endpoint: string, args: Record<string, unknown>) => {
      if (endpoint !== 'userQuestions/answer') return rpc<T>(endpoint, args);
      await new Promise<void>(resolve => { release = resolve; }); return true as T;
    };
    const submitted = ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command: {
      op: 'answer', clientCommandId: 'old-continued-receipt', sessionId: peer.session.id, questionId: id, answer: { selected: ['Original label'] },
    } } });
    await expect.poll(() => typeof release).toBe('function');
    const generation = (peer.native.adapter as unknown as { muxGeneration: number }).muxGeneration;
    peer.disconnectNative();
    await expect.poll(() => (peer.native.adapter as unknown as { muxGeneration: number }).muxGeneration).toBeGreaterThan(generation);
    peer.answered(); release();
    expect((await submitted).json()).toMatchObject({ ok: false, code: 'uncertain' });
    expect(ctx.store.journal.get('old-continued-receipt')?.state).toBe('uncertain');
    expect(ctx.store.latestInteractionEvent(peer.session.id, 'answer', id).event?.data).toMatchObject({ status: 'answered', resolution: 'native-resolved' });
  } finally { release?.(); await peer.closePeer(); await ctx.close(); }
});
