import type { StoredEvent } from '@webdcc/protocol';
import type { Db } from './db.js';

interface ItemScope { sessionId: string; nativeId: string; nativeTurnId?: string; itemKey: string; kind: string }
interface PartialRow { source_seq: number; event_seq: number }
const turnKey = (id: string | undefined): string => JSON.stringify(id ?? null);
const values = (scope: ItemScope) => [scope.sessionId, scope.nativeId, turnKey(scope.nativeTurnId), scope.itemKey, scope.kind];

/** A persisted start is partial projection evidence, never native completion
 * or writer ownership. Its source and public event pointers commit together. */
export class NativeHistoryStages {
  constructor(private readonly db: Db) {}

  start(scope: ItemScope, sourceSeq: number, eventSeq: number): void {
    this.db.prepare(`INSERT INTO native_history_partial_items
      (session_id, native_id, turn_key, item_key, kind, projection_version, source_seq, event_seq)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(session_id, native_id, turn_key, item_key, kind, projection_version)
      DO UPDATE SET source_seq = excluded.source_seq, event_seq = excluded.event_seq
      WHERE excluded.source_seq > native_history_partial_items.source_seq`).run(...values(scope), sourceSeq, eventSeq);
  }

  canComplete(scope: ItemScope, sourceSeq: number, current: StoredEvent): boolean {
    const row = this.db.prepare(`SELECT source_seq, event_seq FROM native_history_partial_items
      WHERE session_id = ? AND native_id = ? AND turn_key = ? AND item_key = ? AND kind = ? AND projection_version = 1`)
      .get(...values(scope)) as PartialRow | undefined;
    if (row !== undefined) return row.event_seq === current.seq && row.source_seq === current.nativeSeq && sourceSeq > row.source_seq;
    return this.legacyDshStart(scope, sourceSeq, current);
  }

  complete(scope: ItemScope): void {
    this.db.prepare(`DELETE FROM native_history_partial_items
      WHERE session_id = ? AND native_id = ? AND turn_key = ? AND item_key = ? AND kind = ? AND projection_version = 1`).run(...values(scope));
  }

  private legacyDshStart(scope: ItemScope, sourceSeq: number, current: StoredEvent): boolean {
    if (current.nativeSeq === undefined || sourceSeq <= current.nativeSeq || current.nativeEnvelopeId !== undefined
      || (this.db.prepare('SELECT agent FROM sessions WHERE id = ?').get(scope.sessionId) as { agent: string } | undefined)?.agent !== 'dsh') return false;
    const native = current.native;
    if (native === null || typeof native !== 'object' || Array.isArray(native)) return false;
    const raw = native as Record<string, unknown>; const data = raw['data'];
    if (raw['type'] !== 'tool/call' || raw['seq'] !== current.nativeSeq || data === null || typeof data !== 'object' || Array.isArray(data)) return false;
    const callId = (data as Record<string, unknown>)['callId'];
    if (typeof callId !== 'string' || current.itemKey !== `tool-${callId}`) return false;
    if (scope.nativeTurnId === undefined) { if (current.turnId !== null) return false; }
    else {
      const bindings = this.db.prepare('SELECT native_turn_id FROM native_turns WHERE session_id = ? AND turn_id = ?')
        .all(scope.sessionId, current.turnId) as { native_turn_id: string }[];
      if (bindings.length !== 1 || bindings[0]?.native_turn_id !== scope.nativeTurnId) return false;
    }
    // v14 DSH imports retained the actual tool/call as the event's source.
    // A kind/status guess or a mapping without matching raw is insufficient.
    const source = this.db.prepare('SELECT native FROM native_history_records WHERE session_id = ? AND native_id = ? AND native_seq = ?')
      .get(scope.sessionId, scope.nativeId, current.nativeSeq) as { native: string } | undefined;
    return source?.native === JSON.stringify(native);
  }
}
