import type { StoredEvent } from './events.js';
import type { TurnView } from './turn.js';

export interface InvariantFailure {
  id: string;
  frame: number;
  message: string;
}

export interface InvariantOptions {
  frame?: number;
  inputProducedEvent?: boolean;
  deltaFrame?: boolean;
}

/** Shared L1 checks. The checker is intentionally data-only so it can run on
 * every recorded frame in milliseconds and report the first broken invariant. */
export function checkTurnInvariants(events: readonly StoredEvent[], view: TurnView, options: InvariantOptions = {}): InvariantFailure[] {
  const frame = options.frame ?? 0;
  const failures: InvariantFailure[] = [];
  const fail = (id: string, message: string): void => { failures.push({ id, frame, message }); };
  if (view.state === 'completed' || view.state === 'interrupted' || view.state === 'failed') {
    if (view.live.length !== 0) fail('I1', '终止态仍有进行中条目');
    if (view.activity !== null) fail('I4', '终止态 activity 必须为 null');
  }
  const keys = new Map<string, number>();
  for (const event of events) {
    keys.set(event.itemKey, (keys.get(event.itemKey) ?? 0) + 1);
  }
  for (const [key, count] of keys) if (count > 1) fail('I2', `itemKey ${key} 多次持久化`);
  const turnIds = new Set(events.filter((event) => event.turnId !== null).map((event) => event.turnId));
  if (turnIds.size > 1) fail('I3', '一轮包含多个 turnId');
  if (events.filter((event) => event.kind === 'user.message').length > 1) fail('I3', 'user.message 不止一条');
  if (events.filter((event) => event.kind === 'turn.started').length > 1) fail('I3', 'turn.started 不止一条');
  if (events.filter((event) => event.kind === 'turn.completed').length > 1) fail('I3', 'turn.completed 不止一条');
  if (options.inputProducedEvent === false && options.deltaFrame !== true) fail('I8', '输入帧没有产生事件且未登记为 delta');
  return failures;
}

export function assertTurnInvariants(events: readonly StoredEvent[], view: TurnView, options: InvariantOptions = {}): void {
  const failures = checkTurnInvariants(events, view, options);
  if (failures.length > 0) throw new Error(failures.map((failure) => `${failure.id}@${failure.frame}: ${failure.message}`).join('\n'));
}
