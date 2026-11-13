import { describe, expect, it } from 'vitest';
import { reduceTurn, resolveAnswer } from '../src/turn.js';
import type { StoredEvent } from '../src/events.js';

function event(seq: number, kind: StoredEvent['kind'], data: unknown, itemKey = `${kind}-${seq}`): StoredEvent {
  return { sessionId: 's', seq, turnId: 't', itemKey, kind, data: data as never, at: new Date(seq * 1000).toISOString() };
}

describe('M9 unified turn model', () => {
  it('NP-05/06 shows one current item and one current question after replacement projections', () => {
    const events = [
      event(1, 'user.message', { text: 'ask' }),
      event(2, 'turn.started', {}),
      event(3, 'question', { questionId: 'q', prompt: 'question' }, 'question-original'),
      event(4, 'command', { command: 'test', status: 'running' }, 'command'),
      event(5, 'command', { command: 'test', status: 'completed' }, 'command'),
      event(6, 'question', { questionId: 'q', prompt: 'question', status: 'answered' }, 'question-resolved'),
      event(7, 'approval.request', { approvalId: 'approval', title: 'approve', detail: '', options: [] }, 'approval'),
      event(8, 'approval.resolved', { approvalId: 'approval', optionId: 'deny', by: 'user' }, 'approval'),
    ];
    const view = reduceTurn(events);
    expect(view.steps.filter(event => event.kind === 'question')).toHaveLength(1);
    expect(view.steps.find(event => event.kind === 'question')?.data).toMatchObject({ status: 'answered' });
    expect(view.steps.filter(event => event.kind === 'command')).toHaveLength(1);
    expect(view.summary.commands).toBe(1);
    expect(view.steps.filter(event => event.kind === 'approval.request')).toHaveLength(1);
    expect(view.state).toBe('running');
  });
  it('uses native final_answer and keeps encrypted empty reasoning closed', () => {
    const events = [
      event(1, 'user.message', { text: 'hi' }),
      event(2, 'turn.started', {}),
      event(3, 'assistant.message', { text: 'thinking aloud', nativePhase: 'commentary' }, 'a1'),
      event(4, 'assistant.message', { text: 'answer', nativePhase: 'final_answer' }, 'a2'),
      event(5, 'turn.completed', { status: 'completed', durationMs: 10 }),
    ];
    const view = reduceTurn(events, []);
    expect(view.state).toBe('completed');
    expect(view.activity).toBeNull();
    expect(view.live).toEqual([]);
    expect(view.answer).toEqual([{ itemKey: 'a2', text: 'answer' }]);
    expect(resolveAnswer(events)).toEqual(view.answer);
  });

  it('derives one activity and treats turn.diff as a cumulative snapshot', () => {
    const events = [
      event(1, 'user.message', { text: 'edit' }),
      event(2, 'turn.started', {}),
      event(3, 'turn.diff', { changes: [{ path: 'old', kind: 'modify', added: 1, removed: 0 }] }),
      event(4, 'turn.diff', { changes: [{ path: 'new', kind: 'add', added: 2, removed: 0 }] }),
    ];
    const view = reduceTurn(events, [
      { itemKey: 'r', kind: 'reasoning', data: { text: '' }, turnId: 't' },
      { itemKey: 'c', kind: 'command', data: { command: 'ls', status: 'running' }, turnId: 't' },
    ]);
    expect(view.activity).toEqual({ kind: 'running' });
    expect(view.changes).toEqual([{ path: 'new', kind: 'add', added: 2, removed: 0 }]);
  });

  it('prefers Claude result.result as the stable final answer', () => {
    const events = [
      event(1, 'user.message', { text: 'hi' }),
      event(2, 'turn.started', {}),
      { ...event(3, 'assistant.message', { text: 'streamed' }, 'streamed'), native: { message: { stop_reason: 'end_turn' } } },
      { ...event(4, 'assistant.message', { text: 'result text', nativePhase: 'final_result' }, 'result'), native: { result: 'result text' } },
      { ...event(5, 'turn.completed', { status: 'completed', durationMs: 1 }), native: { result: 'result text' } },
    ];
    expect(resolveAnswer(events)).toEqual([{ itemKey: 'result', text: 'result text' }]);
  });

  it('从旧版 turn usage 的相邻采样恢复最新响应速度，不使用整轮时长', () => {
    const events = [
      event(1, 'user.message', { text: 'long task' }),
      event(2, 'turn.started', {}),
      { ...event(3, 'usage', { inputTokens: 100, outputTokens: 20, scope: 'turn' }), at: '2026-01-01T00:00:10.000Z' },
      { ...event(4, 'usage', { inputTokens: 120, outputTokens: 100, scope: 'turn' }), at: '2026-01-01T00:00:12.000Z' },
      event(5, 'turn.completed', { status: 'completed', durationMs: 600000 }),
    ];
    expect(reduceTurn(events).usage?.tokensPerSecond).toBe(50);
  });
});
