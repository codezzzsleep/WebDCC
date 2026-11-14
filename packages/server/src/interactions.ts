import type { EventData, StoredEvent } from '@webdcc/protocol';
import type { Db } from './db.js';

type Kind = 'approve' | 'answer';
type State = 'pending' | 'sending' | 'collected' | 'resolved' | 'cancelled' | 'failed' | 'uncertain';
export interface InteractionRow {
  session_id: string; kind: Kind; id: string; group_id: string; state: State;
  revision: number; command_id: string | null; request: string; error: string | null;
}
type ObservedEvent = Pick<StoredEvent, 'sessionId' | 'kind' | 'data'>;
const conflict = (message: string, code = 'conflict'): Error => Object.assign(new Error(message), { statusCode: 409, code });

/** Durable native-request claims complement client-command idempotency.
 * Accepted answer values remain in the command journal rather than this index. */
export class InteractionStore {
  constructor(private readonly db: Db) {
    if (db.prepare('SELECT 1 FROM app_settings WHERE key = ?').get('interaction-index-v5') === undefined) db.transaction(() => {
      for (const row of db.prepare("SELECT session_id, kind, data FROM events WHERE kind IN ('approval.request', 'approval.resolved', 'question') ORDER BY session_id, seq").all() as { session_id: string; kind: StoredEvent['kind']; data: string }[]) this.observe({ sessionId: row.session_id, kind: row.kind, data: JSON.parse(row.data) as StoredEvent['data'] });
      db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('interaction-index-v5', 'true');
    })();
  }
  get(sessionId: string, kind: Kind, id: string): InteractionRow | undefined { return this.db.prepare('SELECT * FROM interactions WHERE session_id = ? AND kind = ? AND id = ?').get(sessionId, kind, id) as InteractionRow | undefined; }
  group(row: InteractionRow): InteractionRow[] { return this.db.prepare('SELECT * FROM interactions WHERE session_id = ? AND kind = ? AND group_id = ?').all(row.session_id, row.kind, row.group_id) as InteractionRow[]; }
  observe(event: ObservedEvent): void {
    if (event.kind === 'approval.resolved') {
      const data = event.data as EventData['approval.resolved'];
      this.db.prepare("UPDATE interactions SET state = 'resolved', revision = revision + 1 WHERE session_id = ? AND kind = 'approve' AND id = ?").run(event.sessionId, data.approvalId);
      return;
    }
    if (event.kind !== 'approval.request' && event.kind !== 'question') return;
    const kind: Kind = event.kind === 'question' ? 'answer' : 'approve';
    const question = event.data as EventData['question'];
    const id = kind === 'answer' ? question.questionId : (event.data as EventData['approval.request']).approvalId;
    const groupId = kind === 'answer' ? question.groupId ?? id : id;
    const state = kind === 'answer' && question.status === 'answered' ? 'resolved' : kind === 'answer' && question.status === 'skipped' ? 'cancelled' : 'pending';
    const request = kind === 'approve' ? { options: (event.data as EventData['approval.request']).options.map(option => ({ id: option.id })) } : {};
    this.db.prepare('INSERT OR IGNORE INTO interactions (session_id, kind, id, group_id, state, revision, request) VALUES (?, ?, ?, ?, ?, 1, ?)').run(event.sessionId, kind, id, groupId, state, JSON.stringify(request));
    if (state === 'resolved' || state === 'cancelled') this.db.prepare('UPDATE interactions SET state = ?, revision = revision + 1 WHERE session_id = ? AND kind = ? AND id = ?').run(state, event.sessionId, kind, id);
    else if (question.groupId !== undefined && kind === 'answer') this.db.prepare("UPDATE interactions SET group_id = ? WHERE session_id = ? AND kind = ? AND id = ? AND state IN ('pending', 'failed')").run(groupId, event.sessionId, kind, id);
  }
  claim(sessionId: string, kind: Kind, id: string, commandId: string): InteractionRow {
    return this.db.transaction(() => {
      const row = this.get(sessionId, kind, id);
      if (row === undefined) throw conflict('原生交互已结束或不存在');
      const group = this.group(row);
      if (group.some(item => item.state === 'uncertain')) throw conflict('上次交互提交结果待核对，不能重新发送', 'uncertain');
      if (group.some(item => item.state === 'sending')) throw conflict('另一个客户端正在回应此原生请求');
      if (row.state === 'resolved' || row.state === 'cancelled') throw conflict('原生交互已经结束');
      this.db.prepare("UPDATE interactions SET state = 'sending', command_id = ?, error = NULL, revision = revision + 1 WHERE session_id = ? AND kind = ? AND id = ?").run(commandId, sessionId, kind, id);
      return this.get(sessionId, kind, id)!;
    })();
  }
  finish(row: InteractionRow, collected = false): boolean {
    return this.db.transaction(() => {
      const current = this.get(row.session_id, row.kind, row.id);
      if (current?.command_id !== row.command_id || current.state !== 'sending') return false;
      if (collected) this.db.prepare("UPDATE interactions SET state = 'collected', revision = revision + 1 WHERE session_id = ? AND kind = ? AND id = ?").run(row.session_id, row.kind, row.id);
      else this.db.prepare("UPDATE interactions SET state = 'resolved', revision = revision + 1 WHERE session_id = ? AND kind = ? AND group_id = ? AND state NOT IN ('resolved', 'cancelled')").run(row.session_id, row.kind, row.group_id);
      return true;
    })();
  }
  fail(row: InteractionRow, error: unknown): void {
    const statusCode = (error as { statusCode?: number }).statusCode;
    const certain = (error as { code?: string }).code !== 'uncertain' && (statusCode === 400 || statusCode === 404 || statusCode === 409);
    this.db.prepare("UPDATE interactions SET state = ?, error = ?, revision = revision + 1 WHERE session_id = ? AND kind = ? AND id = ? AND state = 'sending' AND command_id = ?")
      .run(certain ? 'failed' : 'uncertain', certain ? 'native-rejected' : 'native-outcome-uncertain', row.session_id, row.kind, row.id, row.command_id);
  }
  recover(): void {
    this.db.exec(`UPDATE interactions SET state = 'uncertain', revision = revision + 1
      WHERE (session_id, kind, group_id) IN (SELECT session_id, kind, group_id FROM interactions WHERE state IN ('sending', 'collected')) AND state NOT IN ('resolved', 'cancelled');`);
  }
}
