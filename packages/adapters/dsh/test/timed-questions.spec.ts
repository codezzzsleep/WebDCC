import { expect, it, vi } from 'vitest';
import type { TraceFrame } from '@webdcc/protocol';
import { DshAdapter } from '../src/adapter.js';
import type { DshHostClient, StreamFrame } from '../src/host.js';

const frame = (value: unknown): TraceFrame => ({ i: 1, t: 1, dir: 'in', ch: 'mux:$events', frame: { type: 'item', value } });
function timedQuestion() {
  const replay = DshAdapter.replay('local', 'native-root');
  const client = (replay.adapter as unknown as { client: DshHostClient }).client;
  const streams: { endpoint: string; handler: (frame: StreamFrame) => void }[] = [];
  Object.defineProperty(client, 'isConnected', { value: true });
  client.openStream = (endpoint, _args, handler) => { streams.push({ endpoint, handler }); return `stream-${streams.length}`; };
  client.closeStream = vi.fn();
  replay.adapter.hostIdentity = async () => ({ url: 'http://127.0.0.1:1/', source: 'native-bootstrap', status: 'verified', version: '0.2.2-rc.1',
    fingerprint: 'f'.repeat(64), profile: { scope: 'current-host-profile', identity: 'unavailable-in-api' } });
  replay.feed(frame({ type: 'ready', clientId: 'native-client' }));
  replay.feed(frame({ type: 'waterfall', event: 'user-questions/request', eventId: 'timed-waterfall', agentId: 'native-root',
    request: { questions: [{ id: 'one', question: 'Native timed question' }], wait: { callId: 'timed-call', timed: true } } }));
  return { replay, client, streams };
}

it('a timed question has no native claim until an actual browser answer surface attaches', () => {
  const { streams } = timedQuestion();
  expect(streams).toHaveLength(0);
});

it('each browser gets the native opening duration and releases only its own claim', async () => {
  const { replay, streams, client } = timedQuestion();
  const first = new AbortController(); const second = new AbortController();
  const a = replay.adapter.claimDshQuestionWait('local', 'timed-waterfall:one', first.signal);
  const b = replay.adapter.claimDshQuestionWait('local', 'timed-waterfall:one', second.signal);
  await expect.poll(() => streams.length).toBe(2);
  streams[0]!.handler({ type: 'item', streamId: 'stream-1', value: { remainingMs: 4312 } });
  streams[1]!.handler({ type: 'item', streamId: 'stream-2', value: { remainingMs: 3210 } });
  const openedA = await a; const openedB = await b;
  expect(openedA).toMatchObject({ callId: 'timed-call', remainingMs: 4312 });
  expect(openedB).toMatchObject({ callId: 'timed-call', remainingMs: 3210 });
  first.abort(); await openedA!.closed;
  expect(client.closeStream).toHaveBeenCalledExactlyOnceWith('stream-1');
  replay.feed(frame({ type: 'cancel', eventId: 'timed-waterfall' }));
  await openedB!.closed;
  expect(client.closeStream).toHaveBeenLastCalledWith('stream-2');
});

it('re-delivery closes an old pending opening, whose late frame cannot resume a browser countdown', async () => {
  const { replay, streams, client } = timedQuestion();
  const claiming = replay.adapter.claimDshQuestionWait('local', 'timed-waterfall:one', new AbortController().signal);
  await expect.poll(() => streams.length).toBe(1);
  replay.feed(frame({ type: 'waterfall', event: 'user-questions/request', eventId: 'timed-waterfall', agentId: 'native-root',
    request: { questions: [{ id: 'one', question: 'Native timed question' }], wait: { callId: 'timed-call', timed: true } } }));
  expect(await claiming).toBeUndefined();
  streams[0]!.handler({ type: 'item', streamId: 'stream-1', value: { remainingMs: 9999 } });
  expect(client.closeStream).toHaveBeenCalledExactlyOnceWith('stream-1');
});

it('timeout returns the official error with the original client and waterfall identity', async () => {
  const { replay, client } = timedQuestion();
  const calls: unknown[] = [];
  client.rpc = async <T>(endpoint: string, args: unknown) => { calls.push({ endpoint, args }); return undefined as T; };
  await replay.adapter.timeoutDshQuestion('local', 'timed-waterfall:one', new AbortController().signal);
  expect(calls).toEqual([{ endpoint: '$events/result', args: { clientId: 'native-client', eventId: 'timed-waterfall', outcome: {
    kind: 'rejected', error: { name: 'UserQuestionError', code: 'ASK_TIMED_OUT', message: 'ask_user_question timed out before the user answered' },
  } } }]);
  await expect(replay.adapter.timeoutDshQuestion('local', 'foreign-question', new AbortController().signal)).rejects.toThrow('前台等待已经结束');
  expect(calls).toHaveLength(1);
});

it('a timed native pending result followed by forwarding cancel preserves one nonblocking continued question', () => {
  const { replay } = timedQuestion();
  const continued = replay.feed(frame({ type: 'event', event: { type: 'tool/result', seq: 1, time: 1, data: { message: { toolCallId: 'timed-call', isError: false,
    content: [{ type: 'text', text: '{"pending":true,"callId":"timed-call"}' }] } } } }));
  const cancelled = replay.feed(frame({ type: 'cancel', eventId: 'timed-waterfall' }));
  expect(continued).toContainEqual(expect.objectContaining({ kind: 'question', data: expect.objectContaining({ questionId: 'timed-waterfall:one', isBlocking: false }) }));
  expect(cancelled.some(event => event.type === 'item.complete' && event.kind === 'question')).toBe(false);
});
