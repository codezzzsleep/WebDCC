import { recoveryEvents, type RecoveryEventSource } from './native-recovery-events.js';
import { claudeOutputOrigin, type CompletedRecovery, type NativeEnvelopeDetail, type RecoveredCompletion, type RecoveredCompletionKind,
  type RuntimeIdentity, type SessionDto, type StoredEvent } from '@webdcc/protocol';
import type { NativeEventStore } from './native-events.js';
import type { NativeProjectionContexts } from './native-projection-context.js';
import { rebuildNativeProjection } from './native-projection-rebuild.js';
import { jsonValueEqual } from './json-value-equal.js';
import { stableJsonDigest } from './stable-json-digest.js';

export interface CompletedSnapshot { completed: RecoveredCompletion[]; completedRecovery?: CompletedRecovery }
export interface CompletedSnapshotOptions { identity?: RuntimeIdentity; maxRecords?: number; maxBytes?: number }
const supported = new Set(['assistant.message', 'reasoning', 'command', 'tool.call', 'file.read', 'file.change']);

/** Recover original immutable output in a read model. Original assignments,
 * rather than a timestamp/current input guess, determine public turn identity. */
export function recoverCompletedSnapshot(native: NativeEventStore, contexts: NativeProjectionContexts, session: SessionDto,
  events: StoredEvent[] | RecoveryEventSource, options: CompletedSnapshotOptions = {}): CompletedSnapshot {
  const maxRecords = options.maxRecords ?? 5000; const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 5000 || !Number.isSafeInteger(maxBytes) || maxBytes < 4096 || maxBytes > 2 * 1024 * 1024)
    throw new Error('Invalid completed snapshot budget');
  const recovery: CompletedRecovery = { formatVersion: 1, scope: 'immutable-completed-items', coverage: 'complete', throughEnvelopeId: 0,
    hasMore: false, issues: [], omittedIssues: 0, conflicts: [] };
  const issue = (id: number | null, reason: string) => { recovery.coverage = 'partial'; if (recovery.issues.length < 50) recovery.issues.push({ envelopeId: id, reason }); else recovery.omittedIssues++; };
  const source = recoveryEvents(events);
  const rawCache = new Map<number, NativeEnvelopeDetail | undefined>();
  let witnesses = 0;
  const byId = new Map<string, RecoveredCompletion>(); const scopes = new Map<string, Set<string>>();
  const boundary = session.conversation?.resetSeq ?? 0;
  let after = source.boundaryEnvelope(boundary); let count = 0; let bytes = 0; let relevant = false;
  while (count < maxRecords) {
    const size = Math.min(500, maxRecords - count); const page = native.list(session.id, after, size + 1);
    if (page.length === 0) break;
    for (const row of page.slice(0, size)) {
      after = row.id; recovery.throughEnvelopeId = row.id; count++;
      if (row.source !== 'mapping' || row.direction !== 'in' || row.channel !== 'item.complete'
        || !['accepted', 'duplicate-projection'].includes(row.disposition)) continue;
      if (options.identity !== undefined && (row.ownerId !== options.identity.ownerId || row.generation !== options.identity.generation)) continue;
      relevant = true;
      if (source.publication(row.id) !== undefined) continue; // This reader covers missing semantic publications.
      if (row.agent !== session.agent || !row.ownerId || !row.nativeId || row.nativeId !== session.nativeId) { issue(row.id, 'completed-source-identity-not-supported'); continue; }
      let raw: NativeEnvelopeDetail | undefined;
      try { raw = native.get(row.id); } catch { issue(row.id, 'completed-source-payload-invalid'); continue; }
      if (raw === undefined) { issue(row.id, 'completed-source-payload-missing'); continue; }
      bytes += Buffer.byteLength(JSON.stringify(raw));
      if (bytes > maxBytes) { issue(row.id, 'completed-scan-size-limit'); recovery.hasMore = true; break; }
      const decoded = rebuildNativeProjection({ schemaHash: native.schemaHash, list: () => [row], get: () => raw,
        restricted: id => native.restricted(id), diagnosticValue: value => native.diagnosticValue(value) }, { sessionId: session.id, limit: 1, maxBytes });
      const candidate = decoded.items[0];
      if (candidate === undefined) {
        const failure = decoded.records[0]; issue(row.id, failure?.reason ?? 'completed-mapping-not-supported'); continue;
      }
      if (!supported.has(candidate.kind)) { issue(row.id, 'completed-kind-not-supported'); continue; }
      // Published bytes already have a real semantic sequence. Do not turn a
      // reconnect into a second result or a new unread notification.
      let lookup;
      try { lookup = contexts.get(row.id); } catch { issue(row.id, 'completed-context-read-failed'); continue; }
      if (lookup.status !== 'recorded') { issue(row.id, lookup.reason); continue; }
      const context = lookup.context;
      if (context.ignoredReason !== undefined) continue;
      if (options.identity !== undefined && !jsonValueEqual(context.identity, options.identity)) { issue(row.id, 'completed-owner-identity-conflict'); continue; }
      const payload = raw.payload as Record<string, unknown>;
      if (payload['runtime'] !== undefined && !jsonValueEqual(payload['runtime'], context.identity)) { issue(row.id, 'completed-runtime-identity-conflict'); continue; }
      if (claudeOutputOrigin(candidate) !== undefined) { issue(row.id, 'child-completion-consumer-required'); continue; }
      const scopeId = stableJsonDigest({ scheme: 'completed-ui-scope-1', sessionId: session.id, turnId: context.turnId, identity: context.identity,
        nativeId: row.nativeId, nativeTurnId: row.nativeTurnId, actorId: row.actorId, parentToolUseId: row.parentToolUseId, kind: candidate.kind, itemKey: candidate.itemKey });
      // Include native opaque content as well as actual Web identity. Native
      // IDs, text or keys alone cannot certify equality across public turns.
      const projectionId = stableJsonDigest({ scheme: 'completed-ui-item-1', scopeId, data: candidate.data,
        ...(Object.hasOwn(payload, 'native') ? { native: candidate.native } : {}) });
      const versions = scopes.get(scopeId) ?? new Set<string>(); versions.add(projectionId); scopes.set(scopeId, versions);
      let represented = false;
      const remaining = maxRecords - witnesses;
      const envelopes = source.semanticEnvelopes(context.turnId, candidate.kind, candidate.itemKey, remaining + 1);
      if (envelopes.length > remaining) { issue(row.id, 'completed-semantic-witness-limit'); recovery.hasMore = true; break; }
      for (const envelopeId of envelopes) {
        witnesses++;
        let known = rawCache.get(envelopeId);
        if (!rawCache.has(envelopeId)) {
          try { known = native.get(envelopeId); } catch { /* Unverifiable bytes cannot hide a retained result. */ }
          rawCache.set(envelopeId, known);
          if (known !== undefined) bytes += Buffer.byteLength(JSON.stringify(known));
        }
        if (bytes > maxBytes) { issue(row.id, 'completed-scan-size-limit'); recovery.hasMore = true; break; }
        if (known === undefined || known.source !== 'mapping' || known.channel !== 'item.complete' || known.disposition !== 'accepted'
          || known.schemaHash !== row.schemaHash || known.payloadCoverage !== 'redacted' || known.agent !== row.agent || known.nativeId !== row.nativeId
          || known.nativeTurnId !== row.nativeTurnId || known.ownerId !== row.ownerId || known.generation !== row.generation
          || known.actorId !== row.actorId || known.parentToolUseId !== row.parentToolUseId) continue;
        const body = known.payload as Record<string, unknown> | null;
        if (body === null || typeof body !== 'object' || Array.isArray(body) || body['type'] !== 'item.complete'
          || body['kind'] !== candidate.kind || body['itemKey'] !== candidate.itemKey) continue;
        if (jsonValueEqual(body['data'], candidate.data) && jsonValueEqual(body['native'], candidate.native)) represented = true;
      }
      if (recovery.hasMore) break;
      if (represented) continue;
      const item = byId.get(projectionId);
      const assignment = { envelopeId: row.id, contextDigest: context.contextDigest, late: context.late, turnEnded: context.turnEnded };
      if (item !== undefined) { item.origins.push(row); item.assignments.push(assignment); }
      else byId.set(projectionId, { projectionId, scopeId, sessionId: session.id, turnId: context.turnId, kind: candidate.kind as RecoveredCompletionKind,
        itemKey: candidate.itemKey, data: candidate.data as RecoveredCompletion['data'], ...(candidate.native === undefined ? {} : { native: candidate.native }),
        identity: context.identity, late: context.late, turnEnded: context.turnEnded, origins: [row], assignments: [assignment] });
      if (Buffer.byteLength(JSON.stringify([...byId.values()])) > maxBytes) { issue(row.id, 'completed-output-size-limit'); recovery.hasMore = true; break; }
    }
    if (recovery.hasMore || page.length <= size) break;
  }
  if (count === maxRecords && native.list(session.id, after, 1).length > 0) { recovery.hasMore = true; issue(null, 'completed-record-limit'); }
  for (const [scopeId, values] of scopes) if (values.size > 1) {
    recovery.conflicts.push({ scopeId, projectionIds: [...values] }); issue(null, 'multiple-completed-content-versions');
    for (const id of values) { const item = byId.get(id); if (item !== undefined) item.conflict = true; }
  }
  // A budget cut may hide another version. Retain partial coverage, never
  // choose an arbitrary prefix as the authoritative completed result.
  const completed = recovery.hasMore ? [] : [...byId.values()];
  if (Buffer.byteLength(JSON.stringify({ completed, completedRecovery: recovery })) > maxBytes) { completed.length = 0; recovery.conflicts = []; issue(null, 'completed-output-size-limit'); }
  return { completed, ...(relevant || recovery.issues.length > 0 ? { completedRecovery: recovery } : {}) };
}
