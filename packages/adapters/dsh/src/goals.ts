import type { EventData } from '@webdcc/protocol';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && typeof value === 'number' && value > 0; }
function nonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function normalized(value: unknown): value is string { return typeof value === 'string' && value.trim() !== '' && value.trim() === value; }
function ref(value: unknown): value is Record<string, unknown> & { id: string; revision: number } {
  const goal = record(value);
  return goal !== undefined && typeof goal['id'] === 'string' && goal['id'] !== '' && positive(goal['revision']);
}

/** Native 0.2.2-rc.1 durable GoalProjection; process-local activation is absent. */
export function dshGoalProjection(value: unknown): EventData['goal'] | undefined {
  if (value === null) return { objective: '', status: 'cleared' };
  const projection = record(value), goal = record(projection?.['goal']);
  if (goal === undefined || !ref(goal) || !normalized(goal['objective']) || !positive(goal['maxGoalRounds'])
    || !['active', 'paused', 'blocked', 'complete'].includes(String(goal['phase'])) || !nonNegative(projection?.['roundsStarted'])
    || projection['roundsStarted'] > goal['maxGoalRounds'] || !nonNegative(projection['createdAt'])
    || !nonNegative(projection['updatedAt']) || projection['updatedAt'] < projection['createdAt']) return undefined;
  const blocked = record(goal['blockedReason']);
  if (goal['phase'] === 'blocked') {
    if (typeof blocked?.['code'] !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(blocked['code'])
      || !normalized(blocked['message']) || Object.keys(blocked).length !== 2) return undefined;
  } else if (goal['blockedReason'] !== undefined) return undefined;
  const status = goal['phase'] === 'complete' ? 'completed' : goal['phase'] as 'active' | 'paused' | 'blocked';
  return { objective: goal['objective'], status, goalId: goal['id'], nativeRevision: goal['revision'], nativeStatus: String(goal['phase']),
    roundsStarted: projection['roundsStarted'], maxGoalRounds: goal['maxGoalRounds'],
    ...(blocked === undefined ? {} : { blockedReason: { code: blocked['code'] as string, message: blocked['message'] as string } }) };
}

/** A clear source event is an exact-reference tombstone, rather than null. */
export function dshGoalChange(value: unknown): EventData['goal'] | undefined {
  const change = record(value);
  if (change?.['kind'] !== 'goal/change' || change['version'] !== 1) return undefined;
  if (change['operation'] === 'clear') {
    if (!ref(change['cleared']) || !nonNegative(change['clearedAt'])) return undefined;
    return { objective: '', status: 'cleared', goalId: change['cleared'].id, nativeRevision: change['cleared'].revision, nativeStatus: 'clear' };
  }
  return ['create', 'edit', 'pause', 'resume', 'complete', 'block'].includes(String(change['operation'])) ? dshGoalProjection(change) : undefined;
}
