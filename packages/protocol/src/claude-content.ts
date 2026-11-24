/** One block in the native assistant message. Query identity is observed by
 * the adapter; a missing message/query identity does not prove a grouping. */
export interface ClaudeBlockOrigin {
  agent: 'claude-code';
  nativeSessionId: string;
  nativeMessageId?: string;
  parentToolUseId: string | null;
  blockIndex: number;
  queryId?: string;
}

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): boolean => typeof value === 'string' && value !== '';

/** Legacy rows retain the SDK's abort flag even without normalized metadata. */
export function isIncompleteClaudeOutput(item: { data?: unknown; native?: unknown }): boolean {
  const native = object(item.native);
  return object(item.data)['incomplete'] === true && claudeBlockOrigin(item) !== undefined
    || native['type'] === 'assistant' && native['aborted'] === true;
}

export function claudeBlockOrigin(item: { data?: unknown; claudeBlock?: unknown }): ClaudeBlockOrigin | undefined {
  const origin = object(item.claudeBlock ?? object(item.data)['claudeBlock']);
  if (origin['agent'] !== 'claude-code' || !text(origin['nativeSessionId']) || !Number.isSafeInteger(origin['blockIndex']) || Number(origin['blockIndex']) < 0
    || origin['parentToolUseId'] !== null && !text(origin['parentToolUseId'])
    || origin['nativeMessageId'] !== undefined && !text(origin['nativeMessageId']) || origin['queryId'] !== undefined && !text(origin['queryId'])) return undefined;
  return origin as unknown as ClaudeBlockOrigin;
}

/** Completion time can follow later blocks. Reorder only positions proven
 * to belong to one query/session/message/actor; all other positions stay put.
 * This works for persisted, live and task-output rows without changing raw. */
export function orderClaudeBlocks<T extends { data?: unknown; claudeBlock?: unknown }>(items: readonly T[]): T[] {
  const result = [...items];
  const groups = new Map<string, { position: number; blockIndex: number; item: T }[]>();
  for (const [position, item] of items.entries()) {
    const origin = claudeBlockOrigin(item);
    if (origin?.queryId === undefined || origin.nativeMessageId === undefined) continue;
    const key = JSON.stringify([origin.queryId, origin.nativeSessionId, origin.nativeMessageId, origin.parentToolUseId]);
    const group = groups.get(key) ?? [];
    group.push({ position, blockIndex: origin.blockIndex, item }); groups.set(key, group);
  }
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => a.blockIndex - b.blockIndex);
    for (const [index, entry] of group.entries()) result[entry.position] = ordered[index]!.item;
  }
  return result;
}
