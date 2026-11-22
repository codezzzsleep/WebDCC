import { isValidEventData, type AdapterEvent, type EventKind, type NativeEnvelopeDetail, type NativeEnvelopeSummary } from '@webdcc/protocol';
import { jsonValueEqual } from './json-value-equal.js';
import { nativeCompletionIdentity } from './native-completion-identity.js';
import { stableJsonDigest } from './stable-json-digest.js';

type Completion = Extract<AdapterEvent, { type: 'item.complete' }>;
export interface NativeProjectionSource {
  readonly schemaHash: string;
  list(sessionId?: string, after?: number, limit?: number): NativeEnvelopeSummary[];
  get(id: number): NativeEnvelopeDetail | undefined;
  restricted(sessionId: string): boolean;
  diagnosticValue(value: unknown): unknown;
}
export interface NativeProjectionRebuildOptions { sessionId?: string; after?: number; limit?: number; maxBytes?: number }
export interface RebuiltNativeItem {
  projectionId: string; kind: Completion['kind']; itemKey: string; data: unknown; native?: unknown;
  origins: NativeEnvelopeSummary[];
}
export interface NativeProjectionRebuild {
  formatVersion: 1; projectionVersion: 1; scope: 'immutable-item-completions'; schemaHash: string;
  after: number; next: number; hasMore: boolean; complete: boolean;
  items: RebuiltNativeItem[];
  records: { id: number; status: 'rebuilt' | 'duplicate' | 'raw-only' | 'unavailable' | 'unverified' | 'unsupported'; reason?: string; projectionId?: string }[];
}
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
function omitted(value: unknown, payloadRedacted?: boolean, depth = 0): boolean {
  if (depth > 64) return true;
  if (typeof value === 'string') return value.includes('<redacted>') || value.includes('<unserializable>')
    || payloadRedacted !== false && /\*{3,}/.test(value);
  if (value === null || typeof value !== 'object') return false;
  return Object.hasOwn(value, 'omitted') || Object.values(value).some(child => omitted(child, payloadRedacted, depth + 1));
}
function immutable(event: Completion): boolean {
  return ['assistant.message', 'reasoning', 'file.read'].includes(event.kind)
    || ['command', 'tool.call', 'file.change'].includes(event.kind) && ['completed', 'failed'].includes(String(object(event.data)?.['status']));
}
function completion(value: unknown): Completion | undefined {
  const event = object(value);
  if (event?.['type'] !== 'item.complete' || typeof event['itemKey'] !== 'string' || typeof event['kind'] !== 'string'
    || !isValidEventData(event['kind'] as EventKind, event['data'])
    || event['nativeSeq'] !== undefined && (!Number.isSafeInteger(event['nativeSeq']) || Number(event['nativeSeq']) < 0)
    || event['nativeTurnId'] !== undefined && typeof event['nativeTurnId'] !== 'string') return undefined;
  return event as unknown as Completion;
}

/** Build an independent artifact. This reader never invokes adapters or
 * updates semantic events, input receipts, queues or writer ownership. */
export function rebuildNativeProjection(source: NativeProjectionSource, options: NativeProjectionRebuildOptions = {}): NativeProjectionRebuild {
  const after = options.after ?? 0; const limit = options.limit ?? 100; const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500
    || !Number.isSafeInteger(maxBytes) || maxBytes < 4096 || maxBytes > 2 * 1024 * 1024
    || options.sessionId !== undefined && (options.sessionId === '' || options.sessionId.length > 256)) throw new Error('Invalid native projection rebuild window');
  const page = source.list(options.sessionId, after, limit + 1);
  const report: NativeProjectionRebuild = { formatVersion: 1, projectionVersion: 1, scope: 'immutable-item-completions', schemaHash: source.schemaHash,
    after, next: after, hasMore: page.length > limit, complete: false, items: [], records: [] };
  const byId = new Map<string, RebuiltNativeItem>();
  for (const summary of page.slice(0, limit)) {
    let candidate: RebuiltNativeItem | undefined;
    let entry: NativeProjectionRebuild['records'][number];
    if (summary.source !== 'mapping' || summary.direction !== 'in' || summary.channel !== 'item.complete') entry = { id: summary.id, status: 'raw-only', reason: 'outside-immutable-item-scope' };
    else if (!['accepted', 'duplicate-projection'].includes(summary.disposition)) entry = { id: summary.id, status: 'unverified', reason: 'source-not-accepted' };
    else if (summary.schemaHash !== source.schemaHash) entry = { id: summary.id, status: 'unsupported', reason: 'source-schema-not-supported' };
    else if (summary.payloadCoverage !== 'redacted' || source.restricted(summary.sessionId)) entry = { id: summary.id, status: 'unavailable', reason: 'source-payload-not-available' };
    else if (!['codex', 'claude-code', 'dsh'].includes(summary.agent) || summary.nativeId === null || summary.nativeId === ''
      || summary.ownerId === null || !Number.isSafeInteger(summary.generation) || Number(summary.generation) < 1) entry = { id: summary.id, status: 'unverified', reason: 'native-source-identity-incomplete' };
    else {
      let detail: NativeEnvelopeDetail | undefined;
      try { detail = source.get(summary.id); } catch { /* Invalid saved JSON remains unavailable. */ }
      const event = completion(detail?.payload);
      if (detail === undefined) entry = { id: summary.id, status: 'unavailable', reason: 'source-payload-missing-or-invalid' };
      else if (!jsonValueEqual(Object.fromEntries(Object.entries(detail).filter(([key]) => key !== 'payload')), summary)) entry = { id: summary.id, status: 'unverified', reason: 'source-metadata-conflict' };
      else if (event === undefined || !immutable(event)) entry = { id: summary.id, status: 'unsupported', reason: 'mapping-not-supported' };
      else if (summary.payloadRedacted === true || object(event.data)?.['incomplete'] === true || event.kind === 'file.read' && object(event.data)?.['status'] === 'running'
        || omitted(event.data, summary.payloadRedacted) || omitted(event.native, summary.payloadRedacted) || !jsonValueEqual(source.diagnosticValue(event.data), event.data)
        || !jsonValueEqual(source.diagnosticValue(event.native), event.native)) entry = { id: summary.id, status: 'unavailable', reason: 'mapping-content-incomplete-or-sensitive' };
      else {
        const runtime = object(event.runtime);
        const mismatched = event.runtime !== undefined && (runtime === undefined || runtime['ownerId'] !== summary.ownerId || runtime['generation'] !== summary.generation
          || typeof runtime['hostId'] !== 'string' || runtime['hostId'] === '')
          || event.nativeTurnId !== undefined && summary.nativeTurnId !== null && event.nativeTurnId !== summary.nativeTurnId;
        if (mismatched) entry = { id: summary.id, status: 'unverified', reason: 'mapping-source-identity-conflict' };
        else {
          const projectionId = stableJsonDigest({ scheme: 'native-item-rebuild-1', agent: summary.agent, nativeTurnId: summary.nativeTurnId,
            actorId: summary.actorId, parentToolUseId: summary.parentToolUseId, hostId: runtime?.['hostId'] ?? null,
            identity: nativeCompletionIdentity({ sessionId: summary.sessionId, agent: summary.agent }, event, summary.nativeId).canonical });
          candidate = byId.get(projectionId);
          if (candidate === undefined) {
            candidate = { projectionId, kind: event.kind, itemKey: event.itemKey, data: event.data,
              ...(event.native === undefined ? {} : { native: event.native }), origins: [summary] };
            entry = { id: summary.id, status: 'rebuilt', projectionId };
          } else entry = { id: summary.id, status: 'duplicate', projectionId };
        }
      }
    }
    if (candidate !== undefined) {
      if (entry.status === 'duplicate') candidate.origins.push(summary);
      else report.items.push(candidate);
    }
    report.records.push(entry); report.next = summary.id;
    if (Buffer.byteLength(JSON.stringify(report)) + 1 > maxBytes) {
      report.records.pop();
      if (candidate !== undefined) { if (entry.status === 'duplicate') candidate.origins.pop(); else report.items.pop(); }
      const unavailable = { id: summary.id, status: 'unavailable' as const, reason: 'rebuild-output-size-limit' };
      report.records.push(unavailable);
      if (Buffer.byteLength(JSON.stringify(report)) + 1 > maxBytes) { report.records.pop(); report.next = report.records.at(-1)?.id ?? after; }
      report.hasMore = page.some(record => record.id > report.next);
      break;
    }
    if (candidate !== undefined && entry.status === 'rebuilt') byId.set(candidate.projectionId, candidate);
  }
  report.complete = report.records.length > 0 && !report.hasMore && report.records.every(record => record.status === 'rebuilt' || record.status === 'duplicate');
  return report;
}
