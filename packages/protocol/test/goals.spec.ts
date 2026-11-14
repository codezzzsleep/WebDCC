import { expect, it } from 'vitest';
import { currentGoal, goalLabel, reduceTurn, type EventData, type StoredEvent } from '../src/index.js';
import { CodexAdapter } from '../../adapters/codex/src/adapter.js';

it('NP-23 retains 322 native notifications as evidence but projects one current goal and preserves the pause', () => {
  const replay = CodexAdapter.replay('s', 'native');
  const events: StoredEvent[] = [];
  for (let i = 0; i < 322; i++) {
    const mapped = replay.feed({ i, t: i, dir: 'in', ch: 'rpc', frame: { method: 'thread/goal/updated', params: {
      threadId: 'native', turnId: 'turn', goal: { threadId: 'native', objective: '完整完成任务', status: i === 321 ? 'paused' : 'active', tokensUsed: i, tokenBudget: null, timeUsedSeconds: i, createdAt: 1, updatedAt: i },
    } } }).find(event => event.type === 'item.complete');
    if (!mapped || mapped.type !== 'item.complete') throw new Error('missing native mapping');
    events.push({ sessionId: 's', seq: i + 1, at: new Date(i).toISOString(), turnId: 'turn', itemKey: mapped.itemKey, kind: mapped.kind, data: mapped.data as StoredEvent['data'], native: mapped.native });
  }
  expect(events).toHaveLength(322);
  const turn = reduceTurn(events);
  expect(turn.steps.filter(event => event.kind === 'goal')).toHaveLength(1);
  expect(turn.goal).toMatchObject({ status: 'paused', tokensUsed: 321 });
  expect(goalLabel(turn.goal!)).toBe('目标已暂停');
  const orphan: StoredEvent<'goal'> = { sessionId: 's', seq: 323, at: new Date().toISOString(), turnId: null, itemKey: 'goal', kind: 'goal', data: { objective: '', status: 'cleared' } };
  expect(currentGoal([...events, orphan])).toEqual(orphan.data);
});

it.each([
  ['complete', 'completed', '目标已完成'], ['paused', 'paused', '目标已暂停'], ['blocked', 'blocked', '目标受阻'],
  ['usageLimited', 'usageLimited', '目标已达用量限制'], ['budgetLimited', 'budgetLimited', '目标已达预算限制'], ['future-status', 'unknown', '目标状态未确认'],
])('NP-23 maps native status %s without treating it as active', (nativeStatus, status, label) => {
  const replay = CodexAdapter.replay('s');
  const mapped = replay.feed({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { method: 'thread/goal/updated', params: { goal: { objective: 'objective', status: nativeStatus } } } }).find(event => event.type === 'item.complete' && event.kind === 'goal');
  const data = (mapped as { data: EventData['goal'] }).data;
  expect(data).toMatchObject({ status, nativeStatus }); expect(goalLabel(data)).toBe(label);
});
