import type { StoredEvent } from '@webdcc/protocol';
import type { Db } from './db.js';

export type PublicationWitness = Pick<StoredEvent, 'seq' | 'kind' | 'turnId' | 'itemKey'>;
export interface RecoveryEventSource {
  boundaryEnvelope(sequence: number): number;
  publication(envelopeId: number): PublicationWitness | undefined;
  ended(turnId: string | null): boolean;
  semanticEnvelopes(turnId: string | null, kind: string, itemKey: string, limit: number): number[];
}

/** Public metadata witnesses only. Neither data nor native bodies are read or
 * parsed, and witness lists are bounded by the candidate reader's budget. */
export function storedRecoveryEvents(db: Db, sessionId: string): RecoveryEventSource {
  return {
    boundaryEnvelope: sequence => (db.prepare('SELECT native_envelope_id AS id FROM events WHERE session_id = ? AND seq = ?').get(sessionId, sequence) as { id: number | null } | undefined)?.id ?? 0,
    publication: envelopeId => {
      const row = db.prepare(`SELECT seq, kind, turn_id AS turnId, item_key AS itemKey FROM events
        WHERE session_id = ? AND native_envelope_id = ? ORDER BY seq DESC LIMIT 1`).get(sessionId, envelopeId) as PublicationWitness | undefined;
      return row === undefined ? undefined : { ...row, turnId: row.turnId === '' ? null : row.turnId };
    },
    ended: turnId => turnId !== null && db.prepare("SELECT 1 FROM events WHERE session_id = ? AND turn_id = ? AND kind = 'turn.completed' LIMIT 1").get(sessionId, turnId) !== undefined,
    semanticEnvelopes: (turnId, kind, itemKey, limit) => (db.prepare(`SELECT native_envelope_id AS id FROM events
      WHERE session_id = ? AND turn_id = ? AND kind = ? AND item_key = ? AND native_envelope_id IS NOT NULL ORDER BY seq LIMIT ?`)
      .all(sessionId, turnId ?? '', kind, itemKey, limit) as { id: number }[]).map(row => row.id),
  };
}

/** Retain the existing pure-reader API for captured in-memory evidence. */
export function recoveryEvents(events: StoredEvent[] | RecoveryEventSource): RecoveryEventSource {
  if (!Array.isArray(events)) return events;
  return {
    boundaryEnvelope: seq => events.find(event => event.seq === seq)?.nativeEnvelopeId ?? 0,
    publication: id => events.findLast(event => event.nativeEnvelopeId === id),
    ended: turnId => turnId !== null && events.some(event => event.kind === 'turn.completed' && event.turnId === turnId),
    semanticEnvelopes: (turnId, kind, itemKey, limit) => events.filter(event => event.turnId === turnId && event.kind === kind && event.itemKey === itemKey && event.nativeEnvelopeId !== undefined).slice(0, limit).map(event => event.nativeEnvelopeId!),
  };
}
