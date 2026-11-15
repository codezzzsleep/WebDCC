import { describe, expect, it } from 'vitest';
import type { AdapterEvent, EventData, StoredEvent, TraceFrame } from '@webdcc/protocol';
import { resolveAnswer } from '@webdcc/protocol';
import { DshAdapter } from '../src/adapter.js';
import { DshTranslator } from '../src/translator.js';

const limited = { code: 'RATE_LIMIT', status: 429, message: 'Model is at its concurrency limit' };
function retryFrame(seq: number, type: string, data: Record<string, unknown>): TraceFrame {
  return { i: seq, t: seq, dir: 'in', ch: 'mux:session/follow', frame: { value: { type: 'event', event: { type, seq, time: seq, data } } } };
}
function scheduled(retry: number, maxRetries = 5): Record<string, unknown> {
  return { retryId: 'series', turn: 1, step: 1, provider: 'coarena', mode: 'normal', policyKey: 'normal', retry, maxRetries, delayMs: retry === 1 ? 469 : 1004, failure: limited };
}
function started(retry: number): Record<string, unknown> { return { retryId: 'series', turn: 1, step: 1, retry }; }
function notices(events: AdapterEvent[]): { itemKey: string; data: EventData['notice'] }[] {
  return events.flatMap(event => event.type === 'history' ? notices(event.records.flatMap(record => record.events))
    : event.type === 'item.complete' && event.kind === 'notice' ? [{ itemKey: event.itemKey, data: event.data }] : []);
}
function twoRetries(maxRetries = 5): TraceFrame[] {
  return [retryFrame(1, 'turn/start', { turn: 1 }), retryFrame(2, 'llm/retry', scheduled(1, maxRetries)), retryFrame(3, 'llm/retry-started', started(1)), retryFrame(4, 'llm/retry', scheduled(2, maxRetries)), retryFrame(5, 'llm/retry-started', started(2))];
}

describe('DSH retry display through the production Handler', () => {
  it('two 429s then success retain cause/count/wait/start on one notice and match replay', () => {
    const frames = [...twoRetries(), retryFrame(6, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'success' }] } }), retryFrame(7, 'turn/end', { turn: 1, reason: { kind: 'completed' } })];
    const live = DshAdapter.replay(), replay = new DshTranslator();
    const actual = frames.flatMap(frame => live.feed(frame));
    const display = notices(actual);
    expect(display.map(view => view.data.text)).toEqual([
      expect.stringContaining('模型限流（HTTP 429）：Model is at its concurrency limit；约 0.5 秒后重试（1/5）'),
      expect.stringContaining('正在重试（1/5）'),
      expect.stringContaining('约 1.0 秒后重试（2/5）'),
      expect.stringContaining('正在重试（2/5）'),
      expect.stringContaining('模型重试成功（2/5）'),
    ]);
    expect(new Set(display.map(view => view.itemKey)).size).toBe(1);
    expect(notices(frames.flatMap(frame => replay.feed(frame)))).toEqual(display);
    expect(actual.some(event => event.type === 'item.complete' && event.kind === 'unknown')).toBe(false);
    const waiting = actual.find(event => event.type === 'item.complete' && event.kind === 'notice');
    expect(waiting).toMatchObject({ native: { type: 'llm/retry', data: scheduled(1) } });
  });

  it('a cancelled retry wait has a cancelled final notice instead of success', () => {
    const handler = DshAdapter.replay();
    handler.feed(retryFrame(1, 'llm/retry', scheduled(1)));
    const events = handler.feed(retryFrame(2, 'turn/end', { turn: 1, reason: { kind: 'interrupted' } }));
    expect(notices(events)[0]?.data.text).toContain('已取消等待重试（1/5）');
    expect(events).toContainEqual(expect.objectContaining({ type: 'turn.end', status: 'interrupted' }));
  });

  it('retry exhaustion reports the terminal provider error and never becomes a completed answer', () => {
    const handler = DshAdapter.replay();
    const events = [...twoRetries(2), retryFrame(6, 'turn/end', { turn: 1, reason: { kind: 'error', error: { ...limited, message: 'still limited' } } })].flatMap(frame => handler.feed(frame));
    expect(notices(events).at(-1)?.data.text).toContain('模型重试失败，已达重试上限（2/2）；模型限流（HTTP 429）：still limited');
    expect(events).toContainEqual(expect.objectContaining({ type: 'turn.end', status: 'failed' }));
    expect(events.some(event => event.type === 'item.complete' && event.kind === 'assistant.message')).toBe(false);
  });

  it('always policy has no invented ceiling, and a start without history does not claim unlimited retries', () => {
    const handler = DshAdapter.replay(); const { maxRetries: _max, ...data } = scheduled(1);
    expect(notices(handler.feed(retryFrame(1, 'llm/retry', { ...data, mode: 'always' })))[0]?.data.text).toContain('无固定上限');
    const disconnected = DshAdapter.replay();
    const text = notices(disconnected.feed(retryFrame(1, 'llm/retry-started', started(1))))[0]?.data.text;
    expect(text).toBe('正在重试（第 1 次）');
  });

  it('failed compact prefixes remain inspectable and cannot be selected as final answers', () => {
    const handler = DshAdapter.replay();
    const stream = [{ type: 'text-chunks', time0: 0, index: 0, dt: [1], texts: [' exact ', 'prefix\n'] }, { type: 'reasoning-chunks', time0: 2, index: 1, dt: [], texts: ['thinking'] }];
    const events = [retryFrame(1, 'assistant/attempt', { turn: 1, step: 1, stream }), retryFrame(2, 'llm/retry', scheduled(1)), retryFrame(3, 'llm/retry-started', started(1)), retryFrame(4, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'success' }] } })].flatMap(frame => handler.feed(frame));
    expect(notices(events)[0]?.data.details).toBe('部分回答：\n exact prefix\n\n\n部分思考：\nthinking');
    const stored: StoredEvent[] = events.flatMap((event, seq) => event.type === 'item.complete' ? [{ sessionId: 's', turnId: 't', seq, at: new Date(seq).toISOString(), itemKey: event.itemKey, kind: event.kind, data: event.data, native: event.native }] : []);
    expect(resolveAnswer(stored)).toEqual([{ itemKey: 'msg-4', text: 'success' }]);
    expect(notices(handler.feed(retryFrame(5, 'assistant/attempt', { turn: 1, step: 2, stream: [] })))).toEqual([]);
  });

  it('a failed live settlement retires its transient text only after preserving its durable prefix', () => {
    const handler = DshAdapter.replay();
    const feed = (i: number, value: unknown) => handler.feed({ i, t: i, dir: 'in', ch: 'mux:session/follow', frame: { value } });
    feed(1, { type: 'assistant-stream', frame: { type: 'start', attemptId: 'failed', revision: 1, startedAfterSeq: 0, turn: 1, step: 1 } });
    feed(2, { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'failed', revision: 2, index: 0, chunk: { type: 'text-delta', index: 0, text: 'prefix' } } });
    const event = { type: 'assistant/attempt', seq: 1, time: 1, data: { turn: 1, step: 1, stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [], texts: ['prefix'] }] } };
    expect(notices(feed(3, { type: 'event', event }))).toEqual([]);
    const settled = feed(4, { type: 'assistant-stream', frame: { type: 'end', attemptId: 'failed', revision: 3, index: 1, outcome: { kind: 'committed', seq: 1, eventType: 'assistant/attempt' } } });
    expect(settled).toContainEqual({ type: 'item.cancel', itemKey: 'msg-attempt-failed-0' });
    expect(notices(settled)[0]?.data.details).toBe('部分回答：\nprefix');
  });

  it('malformed known payloads and genuinely unknown events preserve their native frames', () => {
    const handler = DshAdapter.replay();
    for (const frame of [retryFrame(1, 'llm/retry', { ...scheduled(1), delayMs: -1 }), retryFrame(2, 'assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'invalid' }] }), retryFrame(3, 'plugin/new-event', { value: 1 })]) {
      expect(handler.feed(frame)).toContainEqual(expect.objectContaining({ type: 'item.complete', kind: 'unknown', native: (frame.frame as { value: { event: unknown } }).value.event }));
    }
  });

  it('a policy retry ID reused by another turn never overwrites the previous turn notice', () => {
    const handler = DshAdapter.replay();
    const first = notices(handler.feed(retryFrame(1, 'llm/retry', scheduled(1))))[0];
    handler.feed(retryFrame(2, 'assistant/message', { turn: 1, step: 1, message: { content: [] } }));
    const second = notices(handler.feed(retryFrame(3, 'llm/retry', { ...scheduled(2), turn: 2 })))[0];
    expect(first?.itemKey).not.toBe(second?.itemKey);
    expect(notices(handler.feed(retryFrame(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } })))).toEqual([]);
  });

  it('cold native history rebuilds the same waiting/start/terminal notice as live events', () => {
    const frames = [...twoRetries(), retryFrame(6, 'turn/end', { turn: 1, reason: { kind: 'error', error: limited } })];
    const live = DshAdapter.replay();
    const expected = notices(frames.flatMap(frame => live.feed(frame)));
    const cold = DshAdapter.replay();
    const actual = cold.feed({ i: 1, t: 0, dir: 'in', ch: 'mux:session/follow', frame: { value: {
      type: 'snapshot', header: { id: 'native' }, cursor: 5, hasMore: false,
      records: frames.map(frame => {
        const value = (frame.frame as { value: { type: string; event: Record<string, unknown> } }).value;
        return { ...value, event: { ...value.event, seq: Number(value.event['seq']) - 1 } };
      }),
    } } });
    expect(notices(actual)).toEqual(expected);
  });
});
