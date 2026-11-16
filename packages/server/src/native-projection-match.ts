import { isValidEventData, type AdapterEvent } from '@webdcc/protocol';
import type { Db } from './db.js';
import { payloadHash } from './command-journal.js';
import { nativeCompletionIdentity } from './native-completion-identity.js';
import { stableJsonDigest } from './stable-json-digest.js';

type Completion = Extract<AdapterEvent, { type: 'item.complete' }>;
interface Context { sessionId: string; agent: string; nativeId?: string }
interface Scope { native_id: string | null; native_turn_id: string | null }
interface Witness { event_key: string; envelope_id: number; event_seq: number; payload: string; payload_coverage: string }
const bareDigest = /^[0-9a-f]{64}$/;
const currentDigest = /^sha256-json-v2:[0-9a-f]{64}$/;

export function nativeProjectionDigest(context: Context, event: Completion, nativeId: string | null): string {
  return stableJsonDigest({ scheme: 'native-completion-2', agent: context.agent,
    identity: nativeCompletionIdentity(context, event, nativeId).canonical });
}
function incomplete(value: unknown, depth = 0): boolean {
  if (depth > 64) return true;
  if (typeof value === 'string') return value === '<redacted>' || value === '<unserializable>' || /\*{3,}/.test(value);
  if (value === null || typeof value !== 'object') return false;
  if (Object.hasOwn(value, 'omitted')) return true;
  return Object.values(value).some(child => incomplete(child, depth + 1));
}

/** Only a real committed event and its mapping can certify a legacy alias.
 * Lookup uses item and envelope indexes, independent of the digest's locale. */
export function committedNativeProjection(db: Db, context: Context, event: Completion, scope: Scope, key: string): { witness?: Witness; unverified: boolean } {
  const rows = db.prepare(`SELECT p.event_key, p.envelope_id, p.event_seq, e.payload, e.payload_coverage
    FROM events v INDEXED BY events_native_item
    CROSS JOIN native_event_envelopes e ON e.id = v.native_envelope_id AND e.session_id = v.session_id
    CROSS JOIN native_event_projections p INDEXED BY native_event_projection_envelope
      ON p.envelope_id = e.id AND p.event_seq = v.seq AND p.projection_version = 1
    WHERE v.session_id = ? AND v.kind = ? AND v.item_key = ? AND v.native_seq IS ?
      AND e.agent = ? AND e.native_id IS ? AND e.native_turn_id IS ?
      AND e.source = 'mapping' AND e.channel = 'item.complete'`).all(context.sessionId, event.kind, event.itemKey, event.nativeSeq ?? null,
      context.agent, scope.native_id, scope.native_turn_id) as Witness[];
  // Sort this item's candidates rather than making SQLite scan the entire
  // session in sequence order to satisfy ORDER BY before filtering.
  rows.sort((a, b) => a.event_seq - b.event_seq);
  const exact = rows.find(row => row.event_key === key);
  if (exact !== undefined) return { witness: exact, unverified: false };
  const identity = nativeCompletionIdentity(context, event, scope.native_id);
  const localLegacy = new Set([identity.canonical, ...identity.legacy].map(payloadHash));
  const known = rows.find(row => bareDigest.test(row.event_key) && localLegacy.has(row.event_key));
  if (known !== undefined) return { witness: known, unverified: false };
  let unverified = false;
  for (const row of rows) {
    if (currentDigest.test(row.event_key)) continue;
    if (!bareDigest.test(row.event_key) || scope.native_id === null || row.payload_coverage !== 'redacted') { unverified = true; continue; }
    let payload: unknown;
    try { payload = JSON.parse(row.payload); } catch { unverified = true; continue; }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || incomplete(payload)) { unverified = true; continue; }
    const old = payload as Record<string, unknown>;
    if (old['type'] !== 'item.complete' || old['kind'] !== event.kind || old['itemKey'] !== event.itemKey
      || !isValidEventData(event.kind, old['data'])
      || old['nativeSeq'] !== undefined && !Number.isSafeInteger(old['nativeSeq'])
      || old['nativeTurnId'] !== undefined && typeof old['nativeTurnId'] !== 'string') { unverified = true; continue; }
    if (nativeProjectionDigest(context, old as unknown as Completion, scope.native_id) === key) return { witness: row, unverified: false };
  }
  return { unverified };
}
