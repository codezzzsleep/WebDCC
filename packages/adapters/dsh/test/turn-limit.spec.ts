import { describe, expect, it } from 'vitest';
import type { TraceFrame } from '@webdcc/protocol';
import { DshAdapter } from '../src/adapter.js';

function nativeEnd(kind: string): TraceFrame {
  return { i: 42, t: 35_000, dir: 'in', ch: 'mux:session/follow', frame: {
    value: { type: 'event', event: { type: 'turn/end', seq: 42, time: 1794774032717, data: { turn: 2, reason: { kind } } } },
  } };
}

describe('native DSH termination reasons', () => {
  it('retains the captured max-tokens cause and never fabricates task/tool success', () => {
    const frame = nativeEnd('max-tokens');
    const events = DshAdapter.replay().feed(frame);
    expect(events).toContainEqual(expect.objectContaining({ type: 'turn.end', status: 'failed', native: {
      type: 'turn/end', seq: 42, time: 1794774032717, data: { turn: 2, reason: { kind: 'max-tokens' } },
    } }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'item.complete', kind: 'notice',
      data: expect.objectContaining({ level: 'warning', nativeType: 'turn/end:max-tokens', text: expect.stringContaining('未完成') }),
    }));
    expect(events.some(event => event.type === 'turn.end' && event.status === 'completed')).toBe(false);
    expect(events.some(event => event.type === 'item.complete' && ['file.change', 'tool.call', 'assistant.message'].includes(event.kind))).toBe(false);
  });

  it.each([['completed', 'completed'], ['interrupted', 'interrupted'], ['failed', 'failed'], ['error', 'failed']])(
    'preserves the native %s termination', (kind, status) => {
      const events = DshAdapter.replay().feed(nativeEnd(kind));
      expect(events).toContainEqual(expect.objectContaining({ type: 'turn.end', status }));
      expect(events.some(event => event.type === 'item.complete' && event.kind === 'notice')).toBe(false);
    },
  );
});
