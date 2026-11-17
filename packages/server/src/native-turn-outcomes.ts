import { isValidEventData, type NativeEnvelopeDetail, type NativeEnvelopeSummary } from '@webdcc/protocol';
import { jsonValueEqual } from './json-value-equal.js';
import { stableJsonDigest } from './stable-json-digest.js';

export interface NativeTurnOutcomeSource {
  readonly schemaHash: string;
  list(sessionId?: string, after?: number, limit?: number): NativeEnvelopeSummary[];
  get(id: number): NativeEnvelopeDetail | undefined;
  restricted(sessionId: string): boolean;
  diagnosticValue(value: unknown): unknown;
  publicTurn(sessionId: string, nativeId: string, nativeTurnId: string): string | undefined;
}
export interface NativeTurnOutcomeOptions { sessionId?: string; after?: number; limit?: number; maxBytes?: number }
export interface RebuiltNativeTurnOutcome {
  scopeId: string; outcomeId: string; sessionId: string; publicTurnId: string; nativeId: string; nativeTurnId: string;
  status: 'completed' | 'failed' | 'interrupted'; usage?: unknown;
  origins: NativeEnvelopeDetail[];
}
type RecordStatus = 'rebuilt' | 'duplicate' | 'conflict' | 'raw-only' | 'unverified' | 'unsupported' | 'unavailable';
export interface NativeTurnOutcomes {
  formatVersion: 1; projectionVersion: 1; scope: 'native-turn-outcomes'; schemaHash: string;
  after: number; next: number; hasMore: boolean; complete: boolean;
  outcomes: RebuiltNativeTurnOutcome[];
  records: { id: number; status: RecordStatus; reason?: string; scopeId?: string; outcomeId?: string }[];
  conflicts: { scopeId: string; outcomeIds: string[] }[];
}
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
function incomplete(value: unknown, depth = 0): boolean {
  if (depth > 64) return true;
  if (typeof value === 'string') return /<redacted>|<unserializable>|\*{3,}/.test(value);
  return value !== null && typeof value === 'object' && (Object.hasOwn(value, 'omitted') || Object.values(value).some(child => incomplete(child, depth + 1)));
}
function terminal(payload: unknown): { status: RebuiltNativeTurnOutcome['status']; usage?: unknown } | undefined {
  const event = object(payload); if (event === undefined) return undefined;
  const data = event['type'] === 'turn.end' ? event : event['type'] === 'item.complete' && event['kind'] === 'turn.completed' && isValidEventData('turn.completed', event['data']) ? object(event['data']) : undefined;
  if (data === undefined || typeof data['status'] !== 'string' || !['completed', 'failed', 'interrupted'].includes(data['status'])) return undefined;
  if (data['usage'] !== undefined && !isValidEventData('usage', data['usage'])) return undefined;
  return { status: data['status'] as RebuiltNativeTurnOutcome['status'], ...(data['usage'] === undefined ? {} : { usage: data['usage'] }) };
}

/** Independent evidence artifact; never applies outcomes to a live writer,
 * command, queue or UI projection. Contradictory outcomes remain unresolved. */
export function rebuildNativeTurnOutcomes(source: NativeTurnOutcomeSource, options: NativeTurnOutcomeOptions = {}): NativeTurnOutcomes {
  const after = options.after ?? 0; const limit = options.limit ?? 100; const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500
    || !Number.isSafeInteger(maxBytes) || maxBytes < 4096 || maxBytes > 2 * 1024 * 1024
    || options.sessionId !== undefined && (options.sessionId === '' || options.sessionId.length > 256)) throw new Error('Invalid native turn outcome window');
  const page = source.list(options.sessionId, after, limit + 1);
  const report: NativeTurnOutcomes = { formatVersion: 1, projectionVersion: 1, scope: 'native-turn-outcomes', schemaHash: source.schemaHash,
    after, next: after, hasMore: page.length > limit, complete: false, outcomes: [], records: [], conflicts: [] };
  const byOutcome = new Map<string, RebuiltNativeTurnOutcome>();
  for (const row of page.slice(0, limit)) {
    let entry: NativeTurnOutcomes['records'][number]; let detail: NativeEnvelopeDetail | undefined; let candidate: RebuiltNativeTurnOutcome | undefined;
    if (row.source !== 'mapping' || row.direction !== 'in' || !['turn.end', 'item.complete'].includes(row.channel)) entry = { id: row.id, status: 'raw-only', reason: 'outside-native-terminal-scope' };
    else if (!['accepted', 'duplicate-projection'].includes(row.disposition)) entry = { id: row.id, status: 'unverified', reason: 'source-not-accepted' };
    else if (row.schemaHash !== source.schemaHash) entry = { id: row.id, status: 'unsupported', reason: 'source-schema-not-supported' };
    else if (row.payloadCoverage !== 'redacted' || source.restricted(row.sessionId)) entry = { id: row.id, status: 'unavailable', reason: 'source-payload-not-available' };
    else if (!['codex', 'claude-code', 'dsh'].includes(row.agent) || !row.nativeId || !row.nativeTurnId || !row.ownerId
      || !Number.isSafeInteger(row.generation) || Number(row.generation) < 1) entry = { id: row.id, status: 'unverified', reason: 'native-source-identity-incomplete' };
    else {
      try { detail = source.get(row.id); } catch { /* Invalid saved source stays explicit. */ }
      const event = object(detail?.payload); const result = terminal(detail?.payload); const runtime = object(event?.['runtime']);
      if (detail === undefined) entry = { id: row.id, status: 'unavailable', reason: 'source-payload-missing-or-invalid' };
      else if (!jsonValueEqual(Object.fromEntries(Object.entries(detail).filter(([key]) => key !== 'payload')), row)) entry = { id: row.id, status: 'unverified', reason: 'source-metadata-conflict' };
      else if (event === undefined || event['scope'] === 'session' || result === undefined) entry = { id: row.id, status: 'unsupported', reason: 'mapping-not-supported' };
      else if (event['nativeTurnId'] !== row.nativeTurnId || event['runtime'] !== undefined && (runtime === undefined || runtime['ownerId'] !== row.ownerId
        || runtime['generation'] !== row.generation || typeof runtime['hostId'] !== 'string' || runtime['hostId'] === '')
        || event['nativeSeq'] !== undefined && (!Number.isSafeInteger(event['nativeSeq']) || Number(event['nativeSeq']) < 0)
        || row.nativeSeq !== null && event['nativeSeq'] !== undefined && event['nativeSeq'] !== row.nativeSeq) entry = { id: row.id, status: 'unverified', reason: 'mapping-source-identity-conflict' };
      else if (incomplete(event) || !jsonValueEqual(source.diagnosticValue(event), event)) entry = { id: row.id, status: 'unavailable', reason: 'mapping-content-incomplete-or-sensitive' };
      else {
        const publicTurnId = source.publicTurn(row.sessionId, row.nativeId, row.nativeTurnId);
        if (!publicTurnId) entry = { id: row.id, status: 'unverified', reason: 'public-turn-binding-not-verified' };
        else {
          const scopeId = stableJsonDigest({ scheme: 'native-turn-scope-1', sessionId: row.sessionId, agent: row.agent, nativeId: row.nativeId,
            nativeTurnId: row.nativeTurnId, publicTurnId, actorId: row.actorId, parentToolUseId: row.parentToolUseId, hostId: runtime?.['hostId'] ?? null });
          const outcomeId = stableJsonDigest({ scheme: 'native-turn-outcome-1', scopeId, ...result });
          candidate = byOutcome.get(outcomeId);
          entry = { id: row.id, status: candidate === undefined ? 'rebuilt' : 'duplicate', scopeId, outcomeId };
          candidate ??= { scopeId, outcomeId, sessionId: row.sessionId, publicTurnId, nativeId: row.nativeId, nativeTurnId: row.nativeTurnId, ...result, origins: [] };
        }
      }
    }
    if (candidate !== undefined && detail !== undefined) {
      candidate.origins.push(detail); if (entry.status === 'rebuilt') report.outcomes.push(candidate);
    }
    report.records.push(entry); report.next = row.id;
    // Include potential conflict annotations before enforcing the output cap.
    const conflicts = [...new Set(report.outcomes.map(outcome => outcome.scopeId))].flatMap(scopeId => {
      const outcomeIds = report.outcomes.filter(outcome => outcome.scopeId === scopeId).map(outcome => outcome.outcomeId);
      return outcomeIds.length > 1 ? [{ scopeId, outcomeIds }] : [];
    });
    const annotated = (records: NativeTurnOutcomes['records']) => records.map(record => conflicts.some(conflict => conflict.scopeId === record.scopeId)
      ? { ...record, status: 'conflict', reason: 'contradictory-native-outcomes' } : record);
    const size = Buffer.byteLength(JSON.stringify({ ...report, conflicts, records: annotated(report.records) })) + 1;
    if (size > maxBytes) {
      report.records.pop(); if (candidate !== undefined) { candidate.origins.pop(); if (entry.status === 'rebuilt') report.outcomes.pop(); }
      report.next = report.records.at(-1)?.id ?? after; report.hasMore = true;
      const excluded = { id: row.id, status: 'unavailable' as const, reason: 'rebuild-output-size-limit' };
      report.records.push(excluded);
      const previousAnnotated = report.records.map(record => report.conflicts.some(conflict => conflict.scopeId === record.scopeId)
        ? { ...record, status: 'conflict', reason: 'contradictory-native-outcomes' } : record);
      if (Buffer.byteLength(JSON.stringify({ ...report, next: row.id, records: previousAnnotated })) + 1 > maxBytes) report.records.pop();
      else report.next = row.id;
      report.hasMore = page.some(candidate => candidate.id > report.next);
      break;
    }
    report.conflicts = conflicts;
    if (candidate !== undefined) byOutcome.set(candidate.outcomeId, candidate);
  }
  for (const conflict of report.conflicts) for (const record of report.records) if (record.scopeId === conflict.scopeId) {
    record.status = 'conflict'; record.reason = 'contradictory-native-outcomes';
  }
  report.complete = report.records.length > 0 && !report.hasMore && report.conflicts.length === 0 && report.records.every(record => ['rebuilt', 'duplicate'].includes(record.status));
  return report;
}
