import { expect, it } from 'vitest';
import { createTestApp } from './helpers.js';
import { bindDshQuestionFixture } from './fixtures/dsh-question.js';
import type { DshHostClient } from '../../adapters/dsh/src/host.js';
import type { ServerMessage, DshQuestionWaitRequest } from '@webdcc/protocol';
import { once } from 'node:events';
import WebSocket from 'ws';
import { bindDshTimedPeer } from './fixtures/dsh-timed-peer.js';

it('authoritative native continuation releases a failed foreground answer claim without resending it', async () => {
  const ctx = await createTestApp(); const { session, native, feed } = bindDshQuestionFixture(ctx);
  const client = (native.adapter as unknown as { client: DshHostClient }).client;
  feed({ type: 'waterfall', event: 'user-questions/request', eventId: 'timed-waterfall', agentId: 'native-question-root',
    request: { questions: [{ id: 'one', question: 'Native timed question' }], wait: { callId: 'timed-call', timed: true } } });
  client.rpc = async () => { throw new Error('foreground response lost'); };
  try {
    await expect(ctx.manager.answer(session.id, 'timed-waterfall:one', 'foreground answer', 'original-foreground-answer')).rejects.toThrow('response lost');
    feed({ type: 'event', event: { type: 'tool/result', seq: 1, time: 1, data: { message: { toolCallId: 'timed-call', isError: false,
      content: [{ type: 'text', text: '{"pending":true,"callId":"timed-call"}' }] } } } });
    feed({ type: 'cancel', eventId: 'timed-waterfall' });
    client.rpc = async <T>() => true as T;
    await expect(ctx.manager.answer(session.id, 'timed-waterfall:one', 'explicit late answer', 'new-continued-answer')).resolves.toMatchObject({ submitted: true, confirmed: false });
  } finally { await ctx.close(); }
});

it('actual browser sockets own separate native wait streams; a foreign claim cannot time out another browser', async () => {
  const ctx = await createTestApp(); const peer = await bindDshTimedPeer(ctx); peer.ask();
  const sockets: WebSocket[] = [];
  try {
    const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const connect = async (name: string) => {
      const socket = new WebSocket(address.replace('http:', 'ws:') + '/api/ws', { headers: { cookie: ctx.cookie } }); sockets.push(socket);
      const messages: ServerMessage[] = []; socket.on('message', data => messages.push(JSON.parse(data.toString()) as ServerMessage));
      await once(socket, 'open');
      socket.send(JSON.stringify({ op: 'hello', clientId: name, feedAfter: 0, subscribe: [{ sessionId: peer.session.id, afterSeq: 0 }] }));
      await expect.poll(() => messages.some(message => message.op === 'snapshot')).toBe(true);
      const send = (message: DshQuestionWaitRequest) => socket.send(JSON.stringify(message));
      send({ op: 'dsh-question-wait', requestId: `request-${name}`, sessionId: peer.session.id, questionId: 'timed-waterfall:one', action: 'claim' });
      await expect.poll(() => messages.some(message => message.op === 'dsh-question-wait' && message.result.kind === 'claim')).toBe(true);
      const result = messages.find(message => message.op === 'dsh-question-wait' && message.result.kind === 'claim');
      if (result?.op !== 'dsh-question-wait' || result.result.kind !== 'claim') throw new Error('native opening absent');
      return { socket, messages, send, claimId: result.result.claimId };
    };
    const a = await connect('browser-a'); const b = await connect('browser-b');
    expect(peer.waits.size).toBe(2);
    b.send({ op: 'dsh-question-wait', requestId: 'foreign-timeout', sessionId: peer.session.id, questionId: 'timed-waterfall:one', action: 'timeout', claimId: a.claimId });
    await expect.poll(() => b.messages.some(message => message.op === 'dsh-question-wait' && message.requestId === 'foreign-timeout' && message.result.kind === 'error')).toBe(true);
    expect(peer.calls).toHaveLength(0); expect(peer.waits.size).toBe(2);
    const closed = once(a.socket, 'close'); a.socket.close(); await closed;
    await expect.poll(() => peer.waits.size).toBe(1);
    b.socket.send(JSON.stringify({ op: 'unsubscribe', sessionIds: [peer.session.id] }));
    await expect.poll(() => peer.waits.size).toBe(0);
  } finally { for (const socket of sockets) socket.terminate(); await peer.closePeer(); await ctx.close(); }
});

it('a late foreground transport failure cannot lock a native continued question or overwrite a new late reply', async () => {
  const ctx = await createTestApp(); const { session, native, feed } = bindDshQuestionFixture(ctx);
  const client = (native.adapter as unknown as { client: DshHostClient }).client;
  feed({ type: 'waterfall', event: 'user-questions/request', eventId: 'timed-waterfall', agentId: 'native-question-root',
    request: { questions: [{ id: 'one', question: 'Native timed question' }], wait: { callId: 'timed-call', timed: true } } });
  let release!: () => void;
  client.rpc = async <T>(endpoint: string) => {
    if (endpoint === 'userQuestions/answer') return true as T;
    await new Promise<void>(resolve => { release = resolve; }); throw new Error('old foreground response lost');
  };
  try {
    const original = ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command: {
      op: 'answer', sessionId: session.id, questionId: 'timed-waterfall:one', clientCommandId: 'old-foreground', answer: 'old answer',
    } } });
    await expect.poll(() => typeof release).toBe('function');
    feed({ type: 'event', event: { type: 'tool/result', seq: 1, time: 1, data: { message: { toolCallId: 'timed-call', isError: false,
      content: [{ type: 'text', text: '{"pending":true,"callId":"timed-call"}' }] } } } });
    expect(ctx.store.interactions.get(session.id, 'answer', 'timed-waterfall:one')?.state).toBe('failed');
    await ctx.manager.answer(session.id, 'timed-waterfall:one', 'new late answer', 'new-late-reply');
    release();
    expect((await original).json()).toMatchObject({ ok: false });
    expect(ctx.store.journal.get('old-foreground')?.state).toBe('failed');
    expect(ctx.store.interactions.get(session.id, 'answer', 'timed-waterfall:one')).toMatchObject({ state: 'sent', command_id: 'new-late-reply' });
  } finally { release?.(); await ctx.close(); }
});

it('forwarding cancellation after a late answer was accepted does not overwrite its sent UI record', async () => {
  const ctx = await createTestApp(); const { session, native, feed } = bindDshQuestionFixture(ctx);
  const client = (native.adapter as unknown as { client: DshHostClient }).client;
  feed({ type: 'waterfall', event: 'user-questions/request', eventId: 'timed-waterfall', agentId: 'native-question-root',
    request: { questions: [{ id: 'one', question: 'Native timed question' }], wait: { callId: 'timed-call', timed: true } } });
  try {
    client.rpc = async () => { throw new Error('lost foreground response'); };
    await expect(ctx.manager.answer(session.id, 'timed-waterfall:one', 'foreground answer', 'foreground-command')).rejects.toThrow();
    feed({ type: 'event', event: { type: 'tool/result', seq: 1, time: 1, data: { message: { toolCallId: 'timed-call', isError: false,
      content: [{ type: 'text', text: '{"pending":true,"callId":"timed-call"}' }] } } } });
    client.rpc = async <T>() => true as T;
    await ctx.manager.answer(session.id, 'timed-waterfall:one', 'late answer', 'late-command');
    feed({ type: 'cancel', eventId: 'timed-waterfall' });
    expect(ctx.store.latestInteractionEvent(session.id, 'answer', 'timed-waterfall:one').event?.data).toMatchObject({ submission: 'sent' });
    expect(ctx.store.interactions.get(session.id, 'answer', 'timed-waterfall:one')).toMatchObject({ state: 'sent', command_id: 'late-command' });
  } finally { await ctx.close(); }
});
