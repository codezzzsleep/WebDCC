import { createHash } from 'node:crypto';
import type { AdapterEvent, NativeEnvelopeDetail, NativeEnvelopeSummary, RuntimeIdentity, TraceFrame } from '@webdcc/protocol';
import { redactDiagnosticValue } from '@webdcc/model-proxy';
import type { Db } from './db.js';
import inventory from './native-inventory.json' with { type: 'json' };
import { payloadHash } from './command-journal.js';

interface Row {
  id: number; session_id: string; agent: string; native_id: string | null;
  owner_id: string | null; generation: number | null; received_at: string;
  source: NativeEnvelopeSummary['source']; direction: 'in' | 'out'; channel: string;
  disposition: string; schema_hash: string; raw_envelope_id: number | null;
  native_seq: number | null; native_turn_id: string | null; native_request_id: string | null;
  actor_id: string | null; parent_tool_use_id: string | null; payload_coverage: NativeEnvelopeSummary['payloadCoverage']; payload: string;
}
interface Context { sessionId: string; agent: string; nativeId?: string; identity?: RuntimeIdentity }
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | null => typeof value === 'string' ? value : null;
function privateSchema(value: unknown, depth = 0): boolean {
  if (depth > 32) return true;
  if (value === null || typeof value !== 'object') return false;
  const record = object(value);
  if (record['isSecret'] === true || record['writeOnly'] === true || record['format'] === 'password') return true;
  return Object.values(value).some(child => privateSchema(child, depth + 1));
}
function summary(row: Row): NativeEnvelopeSummary {
  return { id: row.id, sessionId: row.session_id, agent: row.agent, nativeId: row.native_id,
    ownerId: row.owner_id, generation: row.generation, receivedAt: row.received_at, source: row.source,
    direction: row.direction, channel: row.channel, disposition: row.disposition, schemaHash: row.schema_hash,
    rawEnvelopeId: row.raw_envelope_id, nativeSeq: row.native_seq, nativeTurnId: row.native_turn_id,
    nativeRequestId: row.native_request_id === null ? null : JSON.parse(row.native_request_id) as string | number,
    actorId: row.actor_id, parentToolUseId: row.parent_tool_use_id, payloadCoverage: row.payload_coverage };
}

/** Transport objects and adapter mappings have separate provenance. Missing
 * transport evidence is retained as missing, never manufactured from mappings. */
export class NativeEventStore {
  readonly schemaHash = createHash('sha256').update(JSON.stringify(inventory)).digest('hex');
  private readonly secrets = new Set<string>();
  constructor(private readonly db: Db) {}
  addSecret(value: string | undefined): void { if (value) this.secrets.add(value); }
  redact(value: unknown): unknown { return redactDiagnosticValue(value, [...this.secrets]); }
  diagnosticValue(value: unknown): unknown { return privateSchema(value) ? { omitted: 'sensitive-native-request' } : redactDiagnosticValue(value, [...this.secrets]); }
  private insert(context: Context, source: Row['source'], direction: 'in' | 'out', channel: string, value: unknown, disposition: string, rawEnvelopeId?: number): number {
    const root = object(value); const native = object(root['native'] ?? root['frame'] ?? value);
    const params = object(native['params']); const event = object(object(native['value'])['event']);
    const observedNativeId = text(native['session_id'] ?? params['threadId'] ?? object(object(native['result'])['thread'])['id'] ?? object(native['result'])['sessionId']);
    const request = native['id'] ?? params['requestId'] ?? native['toolUseID'];
    const requestId = typeof request === 'string' || typeof request === 'number' ? request : null;
    const restricted = privateSchema(value) || /^account\/|oauth|authentication/i.test(String(native['method'] ?? channel));
    // Persist the policy as well: a response after restart must remain restricted.
    const knownRestricted = requestId !== null && this.db.prepare("SELECT 1 FROM native_event_envelopes WHERE session_id = ? AND generation IS ? AND native_request_id = ? AND payload_coverage = 'restricted' LIMIT 1")
      .get(context.sessionId, context.identity?.generation ?? null, JSON.stringify(requestId)) !== undefined;
    let coverage: Row['payload_coverage'] = restricted || knownRestricted ? 'restricted' : 'redacted';
    let payload = coverage === 'restricted' ? JSON.stringify({ omitted: 'sensitive-native-request' }) : JSON.stringify(redactDiagnosticValue(value, [...this.secrets]));
    if (Buffer.byteLength(payload) > 1024 * 1024) { coverage = 'oversize'; payload = JSON.stringify({ omitted: 'native-envelope-size-limit', bytes: Buffer.byteLength(payload) }); }
    const seq = root['nativeSeq'] ?? event['seq'] ?? object(native['value'])['seq'] ?? native['seq'];
    const turnId = root['nativeTurnId'] ?? params['turnId'] ?? object(params['turn'])['id'] ?? event['turnId'];
    const result = this.db.prepare(`INSERT INTO native_event_envelopes (session_id, agent, native_id, owner_id, generation, received_at,
      source, direction, channel, disposition, schema_hash, raw_envelope_id, native_seq, native_turn_id, native_request_id, actor_id, parent_tool_use_id, payload_coverage, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(context.sessionId, context.agent, observedNativeId ?? (context.nativeId || null), context.identity?.ownerId ?? null, context.identity?.generation ?? null,
        new Date().toISOString(), source, direction, channel, disposition, this.schemaHash, rawEnvelopeId ?? null,
        Number.isSafeInteger(seq) ? seq : null, text(turnId), requestId === null ? null : JSON.stringify(requestId),
        text(native['actorId'] ?? native['agent_id'] ?? params['actorId']), text(native['parent_tool_use_id']), coverage, payload);
    return Number(result.lastInsertRowid);
  }
  frame(context: Context, frame: TraceFrame, accepted: boolean): number {
    return this.insert(context, 'transport', frame.dir, frame.ch, frame.frame, accepted ? frame.dir === 'out' ? 'outgoing-attempt' : 'observed' : 'stale-owner');
  }
  mapping(context: Context, event: AdapterEvent, disposition: string): { id: number; duplicate: boolean } {
    const id = this.insert(context, 'mapping', 'in', event.type, event, disposition, event.nativeEnvelopeId);
    if (disposition !== 'accepted' || event.type !== 'item.complete') return { id, duplicate: false };
    const immutable = event.kind === 'assistant.message' || event.kind === 'file.read'
      || ['command', 'file.change', 'tool.call'].includes(event.kind) && ['completed', 'failed'].includes(String(object(event.data)['status']));
    if (event.nativeSeq === undefined && (!immutable || event.native === undefined)) return { id, duplicate: false };
    const key = payloadHash({ sessionId: context.sessionId, nativeId: context.nativeId, seq: event.nativeSeq,
      kind: event.kind, itemKey: event.itemKey, turnId: event.nativeTurnId, data: event.data });
    const previous = this.db.prepare('SELECT event_seq FROM native_event_projections WHERE projection_version = 1 AND event_key = ?').get(key) as { event_seq: number | null } | undefined;
    const duplicate = previous?.event_seq != null;
    if (duplicate) this.db.prepare("UPDATE native_event_envelopes SET disposition = 'duplicate-projection' WHERE id = ?").run(id);
    else this.db.prepare('INSERT INTO native_event_projections (projection_version, event_key, envelope_id) VALUES (1, ?, ?) ON CONFLICT(projection_version, event_key) DO UPDATE SET envelope_id = excluded.envelope_id WHERE event_seq IS NULL').run(key, id);
    return { id, duplicate };
  }
  projected(envelopeId: number, seq: number): void {
    this.db.prepare('UPDATE native_event_projections SET event_seq = ? WHERE envelope_id = ? AND event_seq IS NULL').run(seq, envelopeId);
  }
  list(sessionId?: string, after = 0, limit = 50): NativeEnvelopeSummary[] {
    const columns = 'id, session_id, agent, native_id, owner_id, generation, received_at, source, direction, channel, disposition, schema_hash, raw_envelope_id, native_seq, native_turn_id, native_request_id, actor_id, parent_tool_use_id, payload_coverage';
    const rows = (sessionId === undefined ? this.db.prepare(`SELECT ${columns} FROM native_event_envelopes WHERE id > ? ORDER BY id LIMIT ?`).all(after, limit)
      : this.db.prepare(`SELECT ${columns} FROM native_event_envelopes WHERE session_id = ? AND id > ? ORDER BY id LIMIT ?`).all(sessionId, after, limit)) as Row[];
    return rows.map(summary);
  }
  get(id: number): NativeEnvelopeDetail | undefined {
    const row = this.db.prepare('SELECT * FROM native_event_envelopes WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? undefined : { ...summary(row), payload: JSON.parse(row.payload) as unknown };
  }
}
