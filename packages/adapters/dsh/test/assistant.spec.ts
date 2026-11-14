import { expect, it } from 'vitest';
import { DshAssistantBridge, expandDshAssistantStream } from '../src/assistant.js';
import { DshAdapter } from '../src/adapter.js';
const stream = [
  { type: 'chunk', time: 10, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
  { type: 'text-chunks', time0: 11, index: 0, dt: [1], texts: ['prefix ', 'rest'] },
];
it('compact baselines preserve exact chunk boundaries and reject incomplete native cuts', () => {
  expect(expandDshAssistantStream(stream)).toEqual([{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'prefix ' }, { type: 'text-delta', index: 0, text: 'rest' }]);
  const bridge = new DshAssistantBridge();
  bridge.baseline({ revision: 10, activeAttempt: { attemptId: 'attempt', startedAfterSeq: 0, turn: 1, step: 1, nextIndex: 3, stream } });
  expect(bridge.accept({ type: 'chunk', attemptId: 'attempt', revision: 11, index: 3 })).toBe('chunk');
  expect(bridge.accept({ type: 'chunk', attemptId: 'attempt', revision: 11, index: 3 })).toBe('ignored');
  expect(bridge.accept({ type: 'chunk', attemptId: 'other', revision: 12, index: 4 })).toBe('ignored');
  expect(bridge.accept({ type: 'chunk', attemptId: 'attempt', revision: 12, index: 5 })).toBe('rebaseline');
  expect(bridge.accept({ type: 'chunk', attemptId: 'attempt', revision: 14, index: 4 })).toBe('rebaseline');
  expect(() => bridge.baseline({ revision: 10, activeAttempt: { attemptId: 'attempt', startedAfterSeq: 0, turn: 1, step: 1, nextIndex: 4, stream } })).toThrow('dense index');
  expect(() => expandDshAssistantStream([{ type: 'text-chunks', time0: 0, index: 0, dt: [], texts: ['a', 'b'] }])).toThrow('run');
});
it('a live durable settlement waits for its exact indexed native end before becoming final', () => {
  const replay = DshAdapter.replay('local');
  const feed = (value: unknown) => replay.feed({ i: 1, t: 0, dir: 'in', ch: 'mux:$events', frame: { value } });
  feed({ type: 'snapshot', header: { id: 'native' }, cursor: -1, records: [], hasMore: false,
    assistantStream: { revision: 10, activeAttempt: { attemptId: 'attempt', startedAfterSeq: -1, turn: 1, step: 1, nextIndex: 3, stream } } });
  const event = { type: 'assistant/message', seq: 0, time: 1000, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'prefix rest' }] } } };
  expect(feed({ type: 'event', event }).filter(event => event.type === 'item.complete' && event.kind === 'assistant.message')).toHaveLength(0);
  expect(feed({ type: 'assistant-stream', frame: { type: 'end', attemptId: 'attempt', revision: 11, index: 3, outcome: { kind: 'committed', seq: 0, eventType: 'assistant/message' } } })).toContainEqual(expect.objectContaining({ type: 'item.complete', kind: 'assistant.message', data: { text: 'prefix rest' } }));
});
it('abandoning a later attempt cannot cancel the previous durable message', () => {
  const replay = DshAdapter.replay('local');
  const feed = (value: unknown) => replay.feed({ i: 1, t: 0, dir: 'in', ch: 'mux:$events', frame: { value } });
  feed({ type: 'snapshot', header: { id: 'native' }, cursor: -1, records: [], hasMore: false,
    assistantStream: { revision: 10, activeAttempt: { attemptId: 'successful', startedAfterSeq: -1, turn: 1, step: 1, nextIndex: 3, stream } } });
  feed({ type: 'event', event: { type: 'assistant/message', seq: 0, time: 1000, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'prefix rest' }] } } } });
  feed({ type: 'assistant-stream', frame: { type: 'end', attemptId: 'successful', revision: 11, index: 3, outcome: { kind: 'committed', seq: 0, eventType: 'assistant/message' } } });
  feed({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'failed', revision: 12, startedAfterSeq: 0, turn: 1, step: 2 } });
  feed({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'failed', revision: 13, index: 0, chunk: { type: 'text-delta', index: 0, text: 'partial' } } });
  const end = feed({ type: 'assistant-stream', frame: { type: 'end', attemptId: 'failed', revision: 14, index: 1, outcome: { kind: 'abandoned' } } });
  expect(end.filter(event => event.type === 'item.cancel').map(event => event.type === 'item.cancel' && event.itemKey)).toEqual(['msg-attempt-failed-0']);
});
it('a reconnected active attempt replaces the prefix then appends its dense suffix once', () => {
  const replay = DshAdapter.replay('local');
  const feed = (value: unknown) => replay.feed({ i: 1, t: 0, dir: 'in', ch: 'mux:$events', frame: { value } });
  const opening = { type: 'snapshot', header: { id: 'native' }, cursor: -1, records: [], hasMore: false,
    assistantStream: { revision: 10, activeAttempt: { attemptId: 'attempt', startedAfterSeq: -1, turn: 1, step: 1, nextIndex: 3, stream } } };
  const first = feed(opening);
  expect(first).toContainEqual(expect.objectContaining({ type: 'item.start', itemKey: 'msg-attempt-attempt-0' }));
  expect(first.filter(event => event.type === 'item.delta').map(event => event.type === 'item.delta' && event.append)).toEqual(['prefix ', 'rest']);
  const replacement = feed(opening);
  expect(replacement.filter(event => event.type === 'item.delta')).toHaveLength(2);
  const suffix = feed({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'attempt', revision: 11, index: 3, chunk: { type: 'text-delta', index: 0, text: ' suffix' } } });
  expect(suffix).toContainEqual({ type: 'item.delta', itemKey: 'msg-attempt-attempt-0', field: 'text', append: ' suffix' });
  expect(feed({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'attempt', revision: 11, index: 3, chunk: { type: 'text-delta', index: 0, text: ' duplicate' } } }).filter(event => event.type === 'item.delta')).toHaveLength(0);
  expect(feed({ type: 'assistant-stream', frame: { type: 'end', attemptId: 'attempt', revision: 12, index: 4, outcome: { kind: 'abandoned' } } })).toContainEqual({ type: 'item.cancel', itemKey: 'msg-attempt-attempt-0' });
});
