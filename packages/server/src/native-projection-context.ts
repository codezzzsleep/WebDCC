import type { EventKind, NativeEnvelopeDetail, NativeEnvelopeSummary, RuntimeIdentity } from '@webdcc/protocol';
import type { Db } from './db.js';
import type { NativeEventStore } from './native-events.js';
import type { NativeOwnerStore } from './native-owners.js';
import { jsonValueEqual } from './json-value-equal.js';
import { stableJsonDigest } from './stable-json-digest.js';

export interface ProjectionAssignment {
  sessionId: string; identity: RuntimeIdentity; turnId: string | null; late: boolean; turnEnded: boolean;
  hot?: { present: boolean; closed: boolean; kind?: EventKind };
  ignoredReason?: 'unknown-native-turn';
}
export interface NativeProjectionContext {
  formatVersion: 1; source: NativeEnvelopeSummary; identity: RuntimeIdentity;
  turnId: string | null; late: boolean; turnEnded: boolean;
  hot?: ProjectionAssignment['hot']; rawDigest: string; contextDigest: string;
  ignoredReason?: ProjectionAssignment['ignoredReason'];
}
export type ProjectionContextLookup = { status: 'recorded'; context: NativeProjectionContext }
  | { status: 'missing' | 'unavailable' | 'unsupported' | 'unverified'; reason: string };
const key = (envelopeId: number) => `native-projection-context:${envelopeId}`;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const summary = ({ payload: _payload, ...source }: NativeEnvelopeDetail): NativeEnvelopeSummary => { void _payload; return source; };
const digest = (context: Omit<NativeProjectionContext, 'contextDigest'>) => stableJsonDigest({ scheme: 'native-projection-context-1', context });

/** Saves actual Web assignment; original native bodies stay in their envelope. */
export class NativeProjectionContexts {
  constructor(private readonly db: Db, private readonly native: NativeEventStore, private readonly owners: NativeOwnerStore) {}

  record(envelopeId: number, assignment: ProjectionAssignment): void {
    this.db.transaction(() => {
      this.owners.assert(assignment.sessionId, assignment.identity);
      const raw = this.native.get(envelopeId);
      if (raw === undefined || raw.source !== 'mapping' || raw.disposition !== 'accepted' || raw.schemaHash !== this.native.schemaHash
        || raw.sessionId !== assignment.sessionId || raw.ownerId !== assignment.identity.ownerId || raw.generation !== assignment.identity.generation
        || this.owners.get(assignment.sessionId)?.agent !== raw.agent) throw new Error('原生投影上下文与已接受来源不一致');
      if (assignment.turnId !== null && this.db.prepare(`SELECT 1 FROM events WHERE session_id = ? AND turn_id = ?
        UNION ALL SELECT 1 FROM native_turns WHERE session_id = ? AND turn_id = ? LIMIT 1`).get(assignment.sessionId, assignment.turnId, assignment.sessionId, assignment.turnId) === undefined)
        throw new Error('投影上下文缺少实际 Web 轮次');
      const identity = { ownerId: assignment.identity.ownerId, generation: assignment.identity.generation, hostId: assignment.identity.hostId };
      const value: Omit<NativeProjectionContext, 'contextDigest'> = { formatVersion: 1, source: summary(raw), identity,
        turnId: assignment.turnId, late: assignment.late, turnEnded: assignment.turnEnded,
        ...(assignment.hot === undefined ? {} : { hot: { ...assignment.hot } }),
        ...(assignment.ignoredReason === undefined ? {} : { ignoredReason: assignment.ignoredReason }), rawDigest: stableJsonDigest(raw) };
      const context: NativeProjectionContext = { ...value, contextDigest: digest(value) };
      const previous = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key(envelopeId)) as { value: string } | undefined;
      if (previous !== undefined) {
        const lookup = this.get(envelopeId);
        if (lookup.status !== 'recorded' || !jsonValueEqual(lookup.context, context)) throw new Error('同一原生投影上下文发生冲突');
        return;
      }
      this.db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(key(envelopeId), JSON.stringify(context));
    }).immediate();
  }

  get(envelopeId: number): ProjectionContextLookup {
    return readNativeProjectionContext(this.db, this.native, envelopeId);
  }
}

/** Reads saved assignment without creating a writer or inserting Host state. */
export function readNativeProjectionContext(db: Db, native: NativeEventStore, envelopeId: number): ProjectionContextLookup {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key(envelopeId)) as { value: string } | undefined;
  if (row === undefined) return { status: 'missing', reason: 'projection-context-not-recorded' };
  let value: Record<string, unknown> | undefined;
  try { value = object(JSON.parse(row.value)); } catch { /* Keep corrupt evidence. */ }
  if (value === undefined) return { status: 'unavailable', reason: 'projection-context-invalid-json' };
  if (value['formatVersion'] !== 1) return { status: 'unsupported', reason: 'projection-context-version-not-supported' };
  const identity = object(value['identity']); const hot = object(value['hot']);
  if (identity === undefined || typeof identity['ownerId'] !== 'string' || identity['ownerId'] === '' || typeof identity['hostId'] !== 'string' || identity['hostId'] === ''
    || !Number.isSafeInteger(identity['generation']) || Number(identity['generation']) < 1
    || value['turnId'] !== null && (typeof value['turnId'] !== 'string' || value['turnId'] === '')
    || typeof value['late'] !== 'boolean' || typeof value['turnEnded'] !== 'boolean'
    || value['ignoredReason'] !== undefined && value['ignoredReason'] !== 'unknown-native-turn'
    || value['hot'] !== undefined && (hot === undefined || typeof hot['present'] !== 'boolean' || typeof hot['closed'] !== 'boolean'
      || hot['kind'] !== undefined && typeof hot['kind'] !== 'string')) return { status: 'unverified', reason: 'projection-context-shape-invalid' };
  let raw: NativeEnvelopeDetail | undefined;
  try { raw = native.get(envelopeId); } catch { /* Keep an invalid original unavailable. */ }
  if (raw === undefined) return { status: 'unavailable', reason: 'projection-source-missing-or-invalid' };
  if (raw.schemaHash !== native.schemaHash) return { status: 'unsupported', reason: 'projection-source-schema-not-supported' };
  if (!jsonValueEqual(value['source'], summary(raw)) || raw.source !== 'mapping' || raw.disposition !== 'accepted'
    || identity['ownerId'] !== raw.ownerId || identity['generation'] !== raw.generation) return { status: 'unverified', reason: 'projection-context-source-conflict' };
  const { contextDigest, ...body } = value;
  if (value['rawDigest'] !== stableJsonDigest(raw) || contextDigest !== digest(body as unknown as Omit<NativeProjectionContext, 'contextDigest'>))
    return { status: 'unverified', reason: 'projection-context-digest-conflict' };
  return { status: 'recorded', context: value as unknown as NativeProjectionContext };
}
