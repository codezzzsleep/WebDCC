import type { EventData, StoredEvent, UsageData } from './events.js';

export type UsageEvent = Pick<StoredEvent, 'kind' | 'data' | 'native' | 'at' | 'itemKey'>;
export type CodexUsageHistory = Map<string, { latest: number; seen: Set<number> }>;
export interface UsageObservation {
  usage: UsageData;
  at: string;
  terminal: boolean;
  tokens?: number;
  partial: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Read original usage where older projections lost fields or scope. Codex's
 * last is one response, even if generation timing was never observed. */
export function observeUsage(event: UsageEvent, codexTotals: CodexUsageHistory, agent?: string): UsageObservation | undefined {
  const terminal = event.kind === 'turn.completed';
  const data = terminal ? (event.data as EventData['turn.completed']).usage
    : event.kind === 'usage' ? event.data as UsageData : undefined;
  if (!terminal && event.kind !== 'usage') return undefined;
  const native = record(event.native);
  const source = record(native?.['usage']);
  const codex = !terminal ? record(native?.['tokenUsage']) : undefined;
  const claude = terminal && native?.['type'] === 'result' && source !== undefined;
  const dsh = !terminal && native?.['type'] === 'usage' && source !== undefined;
  if (data === undefined && !claude && !dsh && codex === undefined) return undefined;

  const usage = { ...data };
  let nativeTotal: number | undefined;
  // Older Codex rows retain these projected counters without the original
  // last/total pair. Timing scope alone cannot prove complete accounting.
  let partial = !terminal && codex === undefined && /^usage-thread-tokenUsage-updated-\d+$/u.test(event.itemKey);
  if (codex !== undefined) {
    const last = record(codex['last']);
    nativeTotal = count(last?.['totalTokens']);
    usage.inputTokens = count(last?.['inputTokens']);
    usage.outputTokens = count(last?.['outputTokens']);
    usage.cacheReadInputTokens = count(last?.['cachedInputTokens']);
    usage.cacheCreationInputTokens = count(last?.['cacheWriteInputTokens']);
    usage.reasoningOutputTokens = count(last?.['reasoningOutputTokens']);
    usage.scope = 'attempt';
    const total = count(record(codex['total'])?.['totalTokens']);
    const thread = typeof native?.['threadId'] === 'string' ? native['threadId'] : '';
    if (total !== undefined) {
      const history = codexTotals.get(thread);
      if (history?.seen.has(total)) return undefined;
      const responseTokens = nativeTotal ?? completeSum([usage.inputTokens, usage.outputTokens]);
      partial = responseTokens !== undefined && total - (history?.latest ?? 0) !== responseTokens;
      if (history === undefined) codexTotals.set(thread, { latest: total, seen: new Set([total]) });
      else {
        history.latest = total;
        history.seen.add(total);
      }
    }
  } else if (claude) {
    usage.inputTokens = count(source['input_tokens']) ?? usage.inputTokens;
    usage.outputTokens = count(source['output_tokens']) ?? usage.outputTokens;
    usage.cacheReadInputTokens = count(source['cache_read_input_tokens']) ?? usage.cacheReadInputTokens;
    usage.cacheCreationInputTokens = count(source['cache_creation_input_tokens']) ?? usage.cacheCreationInputTokens;
  } else if (dsh) {
    nativeTotal = count(source['totalTokens']);
    usage.inputTokens = count(source['inputTokens']) ?? usage.inputTokens;
    usage.outputTokens = count(source['outputTokens']) ?? usage.outputTokens;
    usage.cacheReadInputTokens = count(source['cacheReadTokens']) ?? usage.cacheReadInputTokens;
    usage.cacheCreationInputTokens = count(source['cacheWriteTokens']) ?? usage.cacheCreationInputTokens;
  }

  // Claude and DSH report uncached input and separate cache buckets. Codex's
  // cache and reasoning counters are already included in input and output.
  const buckets = [count(usage.inputTokens), count(usage.outputTokens)];
  if (claude || dsh || agent === 'claude-code' || agent === 'dsh') {
    buckets.push(count(usage.cacheReadInputTokens), count(usage.cacheCreationInputTokens));
  }
  const known = buckets.filter(value => value !== undefined);
  const observed = known.length === 0 ? undefined : completeSum(known);
  const allBucketsKnown = known.length === buckets.length;
  const exactNativeTotal = nativeTotal !== undefined && nativeTotal >= (observed ?? 0) &&
    (!allBucketsKnown || nativeTotal === observed);
  const tokens = exactNativeTotal ? nativeTotal : observed;
  return { usage, at: event.at, terminal, tokens,
    partial: partial || tokens === undefined || (!exactNativeTotal && (!allBucketsKnown || nativeTotal !== undefined)) };
}

function completeSum(counts: readonly (number | undefined)[]): number | undefined {
  if (counts.some(value => value === undefined)) return undefined;
  const total = counts.reduce<number>((sum, value) => sum + value!, 0);
  return count(total);
}

/** Attempt records cover responses; a terminal snapshot is an alternative
 * source for a turn with no attempt records. */
export function selectTurnUsage(observations: readonly UsageObservation[]): UsageObservation[] {
  const attempts = observations.filter(sample => !sample.terminal && sample.usage.scope === 'attempt');
  if (attempts.length > 0) return attempts;
  const latest = observations.findLast(sample => !sample.terminal) ?? observations.at(-1);
  return latest === undefined ? [] : [latest];
}
