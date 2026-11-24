import type { TraceFrame } from '../../packages/protocol/src/index.js';

export interface CapturedRow { runId?: string; seq?: number; source?: string; channel?: string; value?: unknown }
export interface ClaudeQueryReplayContext { runId: string; throughSequence: number; queryId: string; generation: number; evidenceSequence: number }
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Query identity comes only from a separately recorded lifecycle signal,
 * never from the output projection we are about to compare. Fail on gaps. */
export function claudeReplayContexts(rows: CapturedRow[]): ClaudeQueryReplayContext[] {
  const native = rows.filter(row => row.source === 'native');
  const runs = new Set(native.map(row => row.runId));
  if (runs.size !== 1 || typeof native[0]?.runId !== 'string' || native.some(row => !Number.isSafeInteger(row.seq))) throw new Error('Claude replay requires one ordered capture run');
  if (native.some((row, index) => index > 0 && row.seq! <= native[index - 1]!.seq!)) throw new Error('Claude native capture sequence is not ordered');
  const runId = native[0].runId;
  const signals = rows.filter(row => row.source === 'mapped' && row.runId === runId).flatMap(row => {
    const value = object(row.value); const data = object(value['data']); const signal = object(data['claudeTaskRuntime']);
    if (value['type'] !== 'item.complete' || value['kind'] !== 'internal' || data['nativeType'] !== 'claude-query-runtime' || signal['state'] !== 'started') return [];
    if (!Number.isSafeInteger(row.seq) || typeof signal['id'] !== 'string' || signal['id'] === '') throw new Error('Invalid captured Claude query lifecycle');
    return [{ seq: row.seq!, queryId: signal['id'], generation: data['claudeQueryGeneration'] }];
  }).sort((a, b) => a.seq - b.seq);
  if (signals.length === 0) throw new Error('Missing captured Claude query identity context');
  const ids = new Set<string>(); const contexts: ClaudeQueryReplayContext[] = [];
  for (const signal of signals) {
    if (ids.has(signal.queryId)) throw new Error('Repeated captured Claude query start');
    ids.add(signal.queryId);
    contexts.push({ runId, queryId: signal.queryId, generation: Number(signal.generation), evidenceSequence: signal.seq, throughSequence: Number.MAX_SAFE_INTEGER });
  }
  for (const [i, context] of contexts.entries()) context.throughSequence = (contexts[i + 1]?.evidenceSequence ?? Number.MAX_SAFE_INTEGER) - 1;
  for (const [index, context] of contexts.entries()) {
    const values = new Set<number>();
    if (Number.isSafeInteger(context.generation) && context.generation > 0) values.add(context.generation);
    for (const row of native) {
      if (context.evidenceSequence >= row.seq! || row.seq! > context.throughSequence) continue;
      const frame = object(object(row.value)['frame']);
      if (Number.isSafeInteger(frame['queryGeneration']) && Number(frame['queryGeneration']) > 0) values.add(Number(frame['queryGeneration']));
    }
    if (values.size !== 1) throw new Error('Missing or conflicting captured Claude query generation');
    context.generation = [...values][0]!;
    if (index > 0 && context.generation <= contexts[index - 1]!.generation) throw new Error('Captured Claude query generations are not increasing');
  }
  for (const row of native) {
    const frame = object(row.value) as unknown as TraceFrame;
    if (frame.dir === 'in' && ['sdk', 'canUseTool'].includes(frame.ch) && !contexts.some(context => context.evidenceSequence < row.seq! && row.seq! <= context.throughSequence)) throw new Error('Claude query context does not precede native output');
  }
  return contexts;
}
