import { isValidEventData, type EventData, type EventKind, type HotRecovery, type RuntimeIdentity, type SessionDto, type SnapshotItem, type StoredEvent } from '@webdcc/protocol';
import type { NativeEventStore } from './native-events.js';
import type { NativeProjectionContexts } from './native-projection-context.js';
import { jsonValueEqual } from './json-value-equal.js';

export interface HotSnapshot { items: SnapshotItem[]; recovery?: HotRecovery }
export interface HotRecoveryOptions { maxRecords?: number; maxBytes?: number; identity?: RuntimeIdentity }
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const key = (turnId: string | null, itemKey: string) => JSON.stringify([turnId, itemKey]);
const supported = new Set<EventKind>(['assistant.message', 'reasoning', 'command', 'tool.call', 'file.read', 'file.change', 'turn.diff', 'plan']);
function omitted(value: unknown, depth = 0): boolean {
  if (depth > 64) return true;
  if (typeof value === 'string') return /<redacted>|<unserializable>|\*{3,}/.test(value);
  return value !== null && typeof value === 'object' && (Object.hasOwn(value, 'omitted') || Object.values(value).some(child => omitted(child, depth + 1)));
}

/** Reconstruct a lost observation, never a writer or native execution result.
 * Incomplete input fails closed: a missing later cancel must not revive an item. */
export function recoverNativeHot(native: NativeEventStore, contexts: NativeProjectionContexts, session: SessionDto,
  events: StoredEvent[], options: HotRecoveryOptions = {}): HotSnapshot {
  const maxRecords = options.maxRecords ?? 5000; const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 5000 || !Number.isSafeInteger(maxBytes) || maxBytes < 4096 || maxBytes > 2 * 1024 * 1024)
    throw new Error('Invalid hot recovery budget');
  const recovery: HotRecovery = { formatVersion: 1, coverage: 'complete', throughEnvelopeId: 0, hasMore: false, issues: [], omittedIssues: 0 };
  const issue = (envelopeId: number | null, reason: string) => {
    recovery.coverage = 'partial';
    if (recovery.issues.length < 50) recovery.issues.push({ envelopeId, reason }); else recovery.omittedIssues++;
  };
  const items = new Map<string, SnapshotItem>(); const closed = new Set<string>();
  const ended = new Set(events.filter(event => event.kind === 'turn.completed' && event.turnId !== null).map(event => event.turnId));
  const committed = new Map(events.filter(event => event.nativeEnvelopeId !== undefined).map(event => [event.nativeEnvelopeId!, event]));
  const boundary = session.conversation?.resetSeq ?? 0;
  const boundaryEnvelope = events.find(event => event.seq === boundary)?.nativeEnvelopeId ?? 0;
  let after = boundaryEnvelope; let count = 0; let bytes = 0; let relevant = false;
  while (count < maxRecords) {
    const page = native.list(session.id, after, Math.min(500, maxRecords - count) + 1);
    if (page.length === 0) break;
    const rows = page.slice(0, Math.min(500, maxRecords - count));
    for (const row of rows) {
      after = row.id; recovery.throughEnvelopeId = row.id; count++;
      if (row.source !== 'mapping' || row.direction !== 'in' || row.disposition !== 'accepted'
        || !['item.start', 'item.delta', 'item.update', 'item.cancel', 'item.complete', 'turn.end'].includes(row.channel)) continue;
      if (options.identity !== undefined && (row.ownerId !== options.identity.ownerId || row.generation !== options.identity.generation)) continue;
      // A reset establishes a different native root. Child-native identities
      // require a separate projection contract and are not inferred here.
      if (row.nativeId !== session.nativeId && row.actorId === null && row.parentToolUseId === null) continue;
      relevant = true;
      const published = committed.get(row.id);
      if (published !== undefined && published.seq <= boundary) continue;
      if (published?.kind === 'turn.completed') continue;
      if (published !== undefined && row.channel === 'item.complete') { items.delete(key(published.turnId, published.itemKey)); closed.add(key(published.turnId, published.itemKey)); continue; }
      if (row.schemaHash !== native.schemaHash) { issue(row.id, 'source-schema-not-supported'); continue; }
      if (row.agent !== session.agent || !row.nativeId || !row.ownerId || !Number.isSafeInteger(row.generation) || Number(row.generation) < 1) { issue(row.id, 'source-identity-incomplete'); continue; }
      if (row.nativeId !== session.nativeId) { issue(row.id, 'child-native-hot-not-supported'); continue; }
      let lookup;
      try { lookup = contexts.get(row.id); } catch { issue(row.id, 'projection-context-read-failed'); continue; }
      if (lookup.status !== 'recorded') { issue(row.id, lookup.reason); continue; }
      const context = lookup.context;
      if (options.identity !== undefined && !jsonValueEqual(context.identity, options.identity)) { issue(row.id, 'hot-host-identity-conflict'); continue; }
      if (context.ignoredReason !== undefined) continue;
      let payload: unknown;
      try { payload = native.get(row.id)?.payload; } catch { issue(row.id, 'source-payload-invalid'); continue; }
      const event = object(payload);
      bytes += Buffer.byteLength(JSON.stringify(payload) ?? '');
      if (bytes > maxBytes) { issue(row.id, 'recovery-scan-size-limit'); recovery.hasMore = true; break; }
      if (event === undefined || event['type'] !== row.channel) { issue(row.id, 'mapping-shape-invalid'); continue; }
      if (event['runtime'] !== undefined && !jsonValueEqual(event['runtime'], context.identity)
        || event['nativeTurnId'] !== undefined && event['nativeTurnId'] !== row.nativeTurnId
        || event['nativeSeq'] !== undefined && event['nativeSeq'] !== row.nativeSeq) { issue(row.id, 'mapping-source-identity-conflict'); continue; }
      if (row.payloadCoverage !== 'redacted' || native.restricted(session.id) || omitted(payload) || !jsonValueEqual(native.diagnosticValue(payload), payload)) {
        issue(row.id, 'source-content-incomplete-or-sensitive'); continue;
      }
      if (row.channel === 'turn.end') {
        if (!['completed', 'failed', 'interrupted'].includes(String(event['status']))) { issue(row.id, 'terminal-mapping-invalid'); continue; }
        if (context.turnId !== null) { ended.add(context.turnId); for (const [id, item] of items) if (item.turnId === context.turnId) items.delete(id); }
        continue;
      }
      if (typeof event['itemKey'] !== 'string' || event['itemKey'] === '') { issue(row.id, 'item-identity-missing'); continue; }
      const id = key(context.turnId, event['itemKey']);
      if (row.channel === 'item.cancel' || row.channel === 'item.complete') {
        if (row.channel === 'item.complete' && (typeof event['kind'] !== 'string' || !isValidEventData(event['kind'] as EventKind, event['data']))) { issue(row.id, 'completion-mapping-invalid'); continue; }
        items.delete(id); closed.add(id); continue;
      }
      if (context.turnEnded || ended.has(context.turnId) || context.hot?.closed || closed.has(id)) { items.delete(id); continue; }
      if (context.hot === undefined) { issue(row.id, 'item-context-missing'); continue; }
      if (row.channel === 'item.start') {
        if (typeof event['kind'] !== 'string' || !isValidEventData(event['kind'] as EventKind, event['data'])) { issue(row.id, 'start-mapping-invalid'); continue; }
        if (!supported.has(event['kind'] as EventKind)) { issue(row.id, 'hot-kind-not-supported'); continue; }
        const previous = items.get(id);
        if (previous?.observation !== undefined && !jsonValueEqual(previous.observation.identity, context.identity)) { issue(row.id, 'hot-owner-generation-conflict'); continue; }
        items.set(id, { itemKey: event['itemKey'], kind: event['kind'] as EventKind, data: event['data'] as EventData[EventKind], turnId: context.turnId,
          observation: { state: 'lost', identity: context.identity, origins: [row] } });
      } else {
        if (!context.hot.present) continue; // The actual live mapping was ignored.
        const item = items.get(id);
        if (item === undefined || !jsonValueEqual(item.observation?.identity, context.identity) || item.kind !== context.hot.kind) { issue(row.id, 'hot-prefix-not-verified'); continue; }
        if (row.channel === 'item.update') {
          if (!isValidEventData(item.kind, event['data'])) { issue(row.id, 'update-mapping-invalid'); continue; }
          item.data = event['data'] as EventData[EventKind];
        } else {
          if (!['text', 'output'].includes(String(event['field'])) || typeof event['append'] !== 'string') { issue(row.id, 'delta-mapping-invalid'); continue; }
          const data = item.data as { text?: string; outputTail?: string };
          if (event['field'] === 'text') data.text = (data.text ?? '') + event['append']; else data.outputTail = (data.outputTail ?? '') + event['append'];
        }
        item.observation!.origins.push(row);
      }
    }
    if (recovery.hasMore) break;
    recovery.hasMore = page.length > rows.length;
    if (!recovery.hasMore) break;
    recovery.hasMore = false;
  }
  if (count === maxRecords && native.list(session.id, after, 1).length > 0) { recovery.hasMore = true; issue(null, 'recovery-record-limit'); }
  for (const [id, item] of items) if (ended.has(item.turnId ?? null)) items.delete(id);
  if (Buffer.byteLength(JSON.stringify([...items.values()])) > maxBytes) issue(null, 'recovery-output-size-limit');
  return { items: recovery.coverage === 'partial' ? [] : [...items.values()],
    ...(relevant || recovery.issues.length > 0 ? { recovery } : {}) };
}
