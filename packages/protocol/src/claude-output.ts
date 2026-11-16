import type { StoredEvent } from './events.js';

/** A result attachment, distinct from the native result's ordinary text. */
export interface ClaudeStructuredOutput {
  agent: 'claude-code';
  format: 'json_schema';
  status: 'completed' | 'failed' | 'interrupted' | 'unknown';
  source: 'result.structured_output' | 'result';
  nativeSessionId?: string;
  nativeResultId?: string;
  /** Adapter query identity; absent when recovering an older stored result. */
  queryId?: string;
  resultIndex?: number;
  nativeSubtype?: string;
  terminalReason?: string;
  value?: unknown;
  rawText?: string;
  errors?: string[];
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Never parse ordinary result text or infer success from a missing attachment. */
export function claudeResultOutput(value: unknown, queryId?: string, expected = false): ClaudeStructuredOutput | undefined {
  const result = object(value);
  if (result['type'] !== 'result') return undefined;
  const attached = Object.hasOwn(result, 'structured_output') && result['structured_output'] !== undefined;
  const retryFailure = result['subtype'] === 'error_max_structured_output_retries' || result['terminal_reason'] === 'structured_output_retry_exhausted';
  if (!attached && !expected && !retryFailure) return undefined;
  const failed = result['is_error'] === true || typeof result['subtype'] === 'string' && result['subtype'].startsWith('error_');
  const aborted = result['terminal_reason'] === 'aborted_streaming' || result['terminal_reason'] === 'aborted_tools';
  return {
    agent: 'claude-code', format: 'json_schema', source: attached ? 'result.structured_output' : 'result',
    status: failed ? aborted ? 'interrupted' : 'failed' : attached && result['subtype'] === 'success' && result['is_error'] === false ? 'completed' : 'unknown',
    ...(typeof result['session_id'] === 'string' ? { nativeSessionId: result['session_id'] } : {}),
    ...(typeof result['uuid'] === 'string' ? { nativeResultId: result['uuid'] } : {}),
    ...(queryId === undefined ? {} : { queryId }),
    ...(Number.isSafeInteger(result['result_index']) && Number(result['result_index']) >= 0 ? { resultIndex: Number(result['result_index']) } : {}),
    ...(typeof result['subtype'] === 'string' ? { nativeSubtype: result['subtype'] } : {}),
    ...(typeof result['terminal_reason'] === 'string' ? { terminalReason: result['terminal_reason'] } : {}),
    ...(attached ? { value: result['structured_output'] } : {}),
    ...((failed || !attached) && typeof result['result'] === 'string' ? { rawText: result['result'] } : {}),
    ...(Array.isArray(result['errors']) && result['errors'].every(error => typeof error === 'string') ? { errors: result['errors'] as string[] } : {}),
  };
}

export function isClaudeStructuredOutput(value: unknown): value is ClaudeStructuredOutput {
  const data = object(value);
  return data['agent'] === 'claude-code' && data['format'] === 'json_schema'
    && ['completed', 'failed', 'interrupted', 'unknown'].includes(String(data['status']))
    && ['result.structured_output', 'result'].includes(String(data['source']))
    && (data['status'] !== 'completed' || Object.hasOwn(data, 'value') && data['value'] !== undefined)
    && ['nativeSessionId', 'nativeResultId', 'queryId', 'nativeSubtype', 'terminalReason', 'rawText'].every(key => data[key] === undefined || typeof data[key] === 'string')
    && (data['resultIndex'] === undefined || Number.isSafeInteger(data['resultIndex']) && Number(data['resultIndex']) >= 0)
    && (data['errors'] === undefined || Array.isArray(data['errors']) && data['errors'].every(error => typeof error === 'string'));
}

export interface ClaudeStructuredOutputView { itemKey: string; seq: number; data: ClaudeStructuredOutput }

/** Old completions retained the native attachment before there was a card.
 * Recover it without rewriting the original row or duplicating a new projection. */
export function claudeStructuredOutputs(events: readonly StoredEvent[]): ClaudeStructuredOutputView[] {
  const projected = events.filter(event => event.kind === 'structured.output' && isClaudeStructuredOutput(event.data));
  const outputs = new Map<string, ClaudeStructuredOutputView>(projected.map(event => [event.itemKey,
    { itemKey: event.itemKey, seq: event.seq, data: event.data as ClaudeStructuredOutput }]));
  for (const event of events) {
    if (event.kind !== 'turn.completed') continue;
    const data = claudeResultOutput(event.native);
    if (data === undefined || projected.some(candidate => {
      const current = candidate.data as ClaudeStructuredOutput;
      return event.nativeEnvelopeId !== undefined && candidate.nativeEnvelopeId === event.nativeEnvelopeId
        || data.nativeResultId !== undefined && current.nativeResultId === data.nativeResultId && current.nativeSessionId === data.nativeSessionId;
    })) continue;
    const itemKey = `${event.itemKey}:structured-output`;
    outputs.set(itemKey, { itemKey, seq: event.seq, data });
  }
  return [...outputs.values()].sort((first, second) => first.seq - second.seq);
}
