import { isDeepStrictEqual } from 'node:util';
import type { EventData, NativeHistoryRecord, StoredEvent } from '@webdcc/protocol';
import { findUserEcho, resolveAnswer, ulid } from '@webdcc/protocol';
import type { Db } from './db.js';
import type { Store } from './store.js';
import { NativeHistoryStages } from './native-history-stages.js';

const itemIdentity = (nativeTurnId: string | undefined, itemKey: string, kind: string): string => JSON.stringify([nativeTurnId ?? null, itemKey, kind]);

/** Durable identity and projection for recovered native records. Historical
 * turn ends never enter the live manager's turn-assignment heuristic. */
export class NativeHistoryStore {
  private readonly stages: NativeHistoryStages;
  constructor(private readonly db: Db, private readonly store: Store) { this.stages = new NativeHistoryStages(db); }

  turn(sessionId: string, nativeTurnId: string): string | undefined {
    return (this.db.prepare('SELECT turn_id FROM native_turns WHERE session_id = ? AND native_turn_id = ?').get(sessionId, nativeTurnId) as { turn_id: string } | undefined)?.turn_id;
  }

  bind(sessionId: string, nativeTurnId: string, turnId: string): void {
    const previous = this.turn(sessionId, nativeTurnId);
    if (previous !== undefined && previous !== turnId) throw new Error('原生轮次已关联不同的 Web 轮次');
    this.db.prepare('INSERT OR IGNORE INTO native_turns (session_id, native_turn_id, turn_id) VALUES (?, ?, ?)').run(sessionId, nativeTurnId, turnId);
  }

  import(sessionId: string, nativeId: string, records: NativeHistoryRecord[]): StoredEvent[] {
    return this.db.transaction(() => {
      const session = this.store.getSession(sessionId);
      if (session === undefined || session.nativeId !== undefined && session.nativeId !== nativeId) throw new Error('原生历史不属于当前会话');
      const existing = this.store.allEvents(sessionId);
      const echoes = new Set<string>();
      let admittedTurn: string | undefined;
      for (const record of records) {
        for (const input of record.admittedInputs ?? []) {
          const identity = this.store.journal.nativeInputRecord(sessionId, input.nativeRequestId);
          if (identity !== undefined && identity.input.text !== input.text) throw new Error('原生输入身份相同但正文不同');
          const commandId = identity?.commandId ?? input.nativeRequestId;
          const local = findUserEcho(existing, { text: input.text, clientCommandId: commandId });
          // A server-pinned steer input belongs to an already active turn. It
          // must never seed the next native turn-start in an imported page.
          if (identity?.steered) {
            admittedTurn = undefined;
            if (record.nativeTurnId !== undefined && this.turn(sessionId, record.nativeTurnId) !== identity.turnId) throw new Error('原生介入身份不属于已绑定的目标轮次');
          } else if (identity !== undefined || local?.turnId != null) admittedTurn = identity?.turnId ?? local!.turnId!;
        }
        if (record.nativeTurnId !== undefined && record.events.some(event => event.type === 'turn.start') && admittedTurn !== undefined) {
          this.bind(sessionId, record.nativeTurnId, admittedTurn);
          admittedTurn = undefined;
        }
      }
      // Native user-message request identities join local prewrites before
      // any recovered turn starts are assigned a public identity.
      for (const record of records) for (const event of record.events) {
        if (event.type !== 'item.complete' || event.kind !== 'user.message') continue;
        const data = event.data as EventData['user.message'];
        if (data.clientCommandId === undefined) continue;
        const identity = this.store.journal.nativeInputRecord(sessionId, data.clientCommandId);
        if (identity !== undefined && identity.input.text !== data.text) throw new Error('原生消息身份相同但正文不同');
        const commandId = identity?.commandId ?? data.clientCommandId;
        const local = findUserEcho(existing, { ...data, clientCommandId: commandId });
        if (local === undefined || local.turnId === null) continue;
        this.store.journal.confirmNativeInput(sessionId, data.clientCommandId, data.text, record.nativeTurnId);
        if (record.nativeTurnId !== undefined) this.bind(sessionId, record.nativeTurnId, identity?.turnId ?? local.turnId);
        echoes.add(itemIdentity(record.nativeTurnId, event.itemKey, event.kind));
      }
      const emitted: StoredEvent[] = [];
      const completed = new Set(records.flatMap(record => record.events.flatMap(event => event.type === 'item.complete' ? [itemIdentity(record.nativeTurnId, event.itemKey, event.kind)] : [])));
      const append = (input: Parameters<Store['appendEvent']>[0]): StoredEvent => { const stored = this.store.appendEvent(input); emitted.push(stored); existing.push(stored); return stored; };
      for (const record of records) {
        if (!Number.isSafeInteger(record.nativeSeq) || record.nativeSeq < 0 || !Number.isFinite(Date.parse(record.at))) throw new Error('原生历史记录水位或时间无效');
        const native = JSON.stringify(record.native);
        const previous = this.db.prepare('SELECT native FROM native_history_records WHERE session_id = ? AND native_id = ? AND native_seq = ?').get(sessionId, nativeId, record.nativeSeq) as { native: string } | undefined;
        if (previous !== undefined) {
          let same = previous.native === native;
          if (!same) {
            // Compare serialized JSON values without changing retained raw
            // bytes. Malformed saved evidence cannot certify a duplicate.
            try { same = isDeepStrictEqual(JSON.parse(previous.native), JSON.parse(native)); }
            catch { /* Preserve the existing explicit collision below. */ }
          }
          if (!same) throw new Error('同一原生历史身份内容发生冲突');
          continue;
        }
        this.db.prepare('INSERT INTO native_history_records (session_id, native_id, native_seq, at, native) VALUES (?, ?, ?, ?, ?)').run(sessionId, nativeId, record.nativeSeq, record.at, native);
        let turnId: string | null = null;
        if (record.nativeTurnId !== undefined) {
          turnId = this.turn(sessionId, record.nativeTurnId) ?? ulid();
          this.bind(sessionId, record.nativeTurnId, turnId);
        }
        const base = { sessionId, turnId, at: record.at, native: record.native, nativeSeq: record.nativeSeq };
        for (const event of record.events) {
          if (event.type === 'turn.start') {
            if (!existing.some(candidate => candidate.turnId === turnId && candidate.kind === 'turn.started')) append({ ...base, itemKey: `native-turn-start-${record.nativeSeq}`, kind: 'turn.started', data: {} });
          } else if (event.type === 'turn.end') {
            if (existing.some(candidate => candidate.turnId === turnId && candidate.kind === 'turn.completed')) continue;
            const turnEvents = existing.filter(candidate => candidate.turnId === turnId);
            const start = turnEvents.find(candidate => candidate.kind === 'turn.started');
            append({ ...base, itemKey: `native-turn-end-${record.nativeSeq}`, kind: 'turn.completed', data: { status: event.status, durationMs: start === undefined ? 0 : Math.max(0, Date.parse(record.at) - Date.parse(start.at)), answerItemKeys: resolveAnswer(turnEvents).map(item => item.itemKey), ...(event.usage === undefined ? {} : { usage: event.usage }) } });
          } else if (event.type === 'item.complete' || event.type === 'item.start') {
            const identity = itemIdentity(record.nativeTurnId, event.itemKey, event.kind);
            if (echoes.has(identity) || event.type === 'item.start' && completed.has(identity)) continue;
            if (event.kind === 'question') {
              const question = event.data as EventData['question'];
              const state = this.store.interactions.get(sessionId, 'answer', question.questionId)?.state;
              if (question.asyncReply !== undefined && question.status !== 'answered' && question.status !== 'skipped' && (state === 'resolved' || state === 'cancelled')) continue;
            }
            // CLI roundtrips also recover items already observed live. Their
            // identity is the native turn + item, independent of history seq.
            // The full recovered source remains in native_history_records.
            const scope = { sessionId, nativeId, nativeTurnId: record.nativeTurnId, itemKey: event.itemKey, kind: event.kind };
            const current = existing.findLast(candidate => candidate.turnId === turnId && candidate.itemKey === event.itemKey && candidate.kind === event.kind);
            if (current !== undefined && (event.type !== 'item.complete' || !this.stages.canComplete(scope, record.nativeSeq, current))) continue;
            const stored = append({ ...base, itemKey: event.itemKey, kind: event.kind, data: event.data as EventData[typeof event.kind] });
            if (event.type === 'item.start') this.stages.start(scope, record.nativeSeq, stored.seq);
            else this.stages.complete(scope);
          }
        }
        if (record.events.length === 0) append({ ...base, itemKey: `native-record-${record.nativeSeq}`, kind: 'internal', data: { nativeType: String((record.native as { type?: unknown })?.type ?? 'native') } });
      }
      return emitted;
    })();
  }
}
