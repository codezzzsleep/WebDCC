import type { EventData, StoredEvent } from './events.js';

const labels: Record<EventData['goal']['status'], string> = {
  active: '目标进行中', paused: '目标已暂停', completed: '目标已完成', cleared: '目标已清除',
  blocked: '目标受阻', usageLimited: '目标已达用量限制', budgetLimited: '目标已达预算限制', unknown: '目标状态未确认',
};

export function goalLabel(goal: EventData['goal']): string {
  return labels[goal.status] ?? '目标状态未确认';
}

/** A goal belongs to the native session, including notifications outside a turn. */
export function currentGoal(events: readonly StoredEvent[]): EventData['goal'] | undefined {
  return events.findLast(event => event.kind === 'goal')?.data as EventData['goal'] | undefined;
}
