import { createHash, randomUUID } from 'node:crypto';
import type { Command, CommandRecord, CommandState, QueuedInput, UserInput } from '@webdcc/protocol';
import type { Db } from './db.js';

export function payloadHash(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
  return createHash('sha256').update(canonical).digest('hex');
}
interface Row { command_id: string; payload_hash: string | null; payload: string | null; op: string; session_id: string | null; state: CommandState; turn_id: string | null; result: string | null; updated_at: string }
interface InputRow { ordinal: number; command_id: string; session_id: string; turn_id: string; input: string; state: CommandState; created_at: string; preparation_error: string | null }
const input = (row: InputRow): QueuedInput => ({ ordinal: row.ordinal, commandId: row.command_id, sessionId: row.session_id, turnId: row.turn_id, input: JSON.parse(row.input) as UserInput, state: row.state, createdAt: row.created_at, ...(row.preparation_error === null ? {} : { preparationError: row.preparation_error }) });

/** SQLite owns acceptance and ordering; in-memory promises only coordinate work. */
export class CommandJournal {
  constructor(private readonly db: Db) {}

  isSensitive(command: Command): boolean {
    if (command.op !== 'answer') return false;
    const row = this.db.prepare("SELECT request FROM interactions WHERE session_id = ? AND kind = 'answer' AND id = ?").get(command.sessionId, command.questionId) as { request: string } | undefined;
    return row !== undefined && (JSON.parse(row.request) as { isSecret?: boolean }).isSecret === true;
  }

  get(commandId: string): CommandRecord | undefined {
    const row = this.db.prepare('SELECT * FROM command_journal WHERE command_id = ?').get(commandId) as Row | undefined;
    return row === undefined ? undefined : { commandId: row.command_id, payloadHash: row.payload_hash, payload: row.payload === null ? null : JSON.parse(row.payload) as Command, op: row.op, sessionId: row.session_id, state: row.state, turnId: row.turn_id, ...(row.result === null ? {} : { result: JSON.parse(row.result) as unknown }), updatedAt: row.updated_at };
  }

  claim(command: Command): { record: CommandRecord; created: boolean; conflict: boolean } {
    const digest = payloadHash(command);
    const stored = this.isSensitive(command) && command.op === 'answer' ? { ...command, answer: { omitted: 'sensitive-answer' } } : command;
    const result = this.db.prepare('INSERT OR IGNORE INTO command_journal (command_id, payload_hash, payload, op, session_id, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(command.clientCommandId, digest, JSON.stringify(stored), command.op, 'sessionId' in command ? command.sessionId : null, 'received', new Date().toISOString());
    const record = this.get(command.clientCommandId);
    if (record === undefined) throw new Error('Command claim did not persist');
    return { record, created: result.changes === 1, conflict: record.payloadHash !== null && record.payloadHash !== digest };
  }

  state(commandId: string, state: CommandState, result?: unknown): void {
    this.db.prepare('UPDATE command_journal SET state = ?, result = COALESCE(?, result), updated_at = ? WHERE command_id = ?').run(state, result === undefined ? null : JSON.stringify(result), new Date().toISOString(), commandId);
  }

  acquire(commandId: string): boolean {
    return this.db.prepare("UPDATE command_journal SET state = 'dispatching' WHERE command_id = ? AND state = 'received'").run(commandId).changes === 1;
  }

  enqueue(commandId: string, sessionId: string, turnId: string, value: UserInput): QueuedInput {
    return this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO input_queue (command_id, session_id, turn_id, input, state, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(commandId, sessionId, turnId, JSON.stringify(value), 'queued', new Date().toISOString());
      const row = this.db.prepare('SELECT * FROM input_queue WHERE command_id = ?').get(commandId) as InputRow;
      if (row.session_id !== sessionId || payloadHash(JSON.parse(row.input)) !== payloadHash(value)) throw Object.assign(new Error('命令正文冲突'), { statusCode: 409 });
      this.db.prepare('UPDATE command_journal SET turn_id = ?, session_id = ?, state = ? WHERE command_id = ?').run(row.turn_id, sessionId, row.state, commandId);
      return input(row);
    })();
  }

  queue(sessionId: string): QueuedInput[] {
    return (this.db.prepare("SELECT * FROM input_queue WHERE session_id = ? AND state NOT IN ('completed', 'failed', 'cancelled') ORDER BY ordinal").all(sessionId) as InputRow[]).map(input);
  }

  next(sessionId: string): QueuedInput | undefined {
    const rows = this.queue(sessionId);
    if (rows.some(row => ['dispatching', 'native-accepted', 'uncertain'].includes(row.state))) return undefined;
    const next = rows.find(row => row.state === 'queued'); return next?.preparationError === undefined ? next : undefined;
  }

  preparationError(turnId: string, error: string | null): void {
    this.db.prepare("UPDATE input_queue SET preparation_error = ? WHERE turn_id = ? AND state = 'queued'").run(error, turnId);
  }

  inputState(turnId: string, state: CommandState): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE input_queue SET state = ? WHERE turn_id = ?').run(state, turnId);
      this.db.prepare('UPDATE command_journal SET state = ?, updated_at = ? WHERE turn_id = ?').run(state, new Date().toISOString(), turnId);
    })();
  }

  beginInput(turnId: string, targetTurnId?: string): boolean {
    return this.db.transaction(() => {
      const changed = this.db.prepare("UPDATE input_queue SET state = 'dispatching' WHERE turn_id = ? AND state = 'queued'").run(turnId).changes === 1;
      if (changed) {
        this.db.prepare("UPDATE command_journal SET state = 'dispatching' WHERE turn_id = ?").run(turnId);
        this.db.prepare('INSERT OR IGNORE INTO native_input_ids (command_id, session_id, turn_id, native_request_id, target_turn_id) SELECT command_id, session_id, turn_id, ?, ? FROM input_queue WHERE turn_id = ?')
          .run(randomUUID(), targetTurnId ?? null, turnId);
      }
      return changed;
    })();
  }
  nativeRequestId(turnId: string): string {
    const row = this.db.prepare('SELECT native_request_id FROM native_input_ids WHERE turn_id = ?').get(turnId) as { native_request_id: string } | undefined;
    if (!row) throw new Error('原生输入身份尚未持久化');
    return row.native_request_id;
  }
  nativeInput(sessionId: string, nativeRequestId: string): { commandId: string; turnId: string } | undefined {
    const record = this.nativeInputRecord(sessionId, nativeRequestId); return record === undefined ? undefined : { commandId: record.commandId, turnId: record.turnId };
  }

  nativeInputRecord(sessionId: string, nativeRequestId: string): { commandId: string; turnId: string; admissionTurnId: string; input: UserInput; steered: boolean } | undefined {
    const row = this.db.prepare(`SELECT n.command_id, n.turn_id, n.target_turn_id, q.input FROM native_input_ids n JOIN input_queue q ON q.turn_id = n.turn_id
      WHERE n.session_id = ? AND q.session_id = n.session_id AND n.native_request_id = ?`).get(sessionId, nativeRequestId) as { command_id: string; turn_id: string; target_turn_id: string | null; input: string } | undefined;
    return row === undefined ? undefined : { commandId: row.command_id, turnId: row.target_turn_id ?? row.turn_id, admissionTurnId: row.turn_id, input: JSON.parse(row.input) as UserInput, steered: row.target_turn_id !== null };
  }

  nativeTargetTurn(admissionTurnId: string): string | undefined {
    return (this.db.prepare('SELECT target_turn_id FROM native_input_ids WHERE turn_id = ?').get(admissionTurnId) as { target_turn_id: string | null } | undefined)?.target_turn_id ?? undefined;
  }

  confirmNativeInput(sessionId: string, nativeRequestId: string, text: string, nativeTurnId?: string): boolean {
    const record = this.nativeInputRecord(sessionId, nativeRequestId);
    if (record === undefined || !record.steered) return false;
    if (record.input.text !== text) throw new Error('原生介入输入身份相同但正文不同');
    if (nativeTurnId !== undefined) {
      const target = this.db.prepare('SELECT turn_id FROM native_turns WHERE session_id = ? AND native_turn_id = ?').get(sessionId, nativeTurnId) as { turn_id: string } | undefined;
      if (target?.turn_id !== record.turnId) throw new Error('原生介入回声不属于服务端绑定的目标轮次');
    }
    this.inputState(record.admissionTurnId, 'completed'); return true;
  }

  settleNativeInputs(sessionId: string, turnId: string, state: 'completed' | 'failed', confirmedNativeIds: readonly string[]): void {
    for (const row of this.db.prepare(`SELECT q.turn_id, n.native_request_id FROM input_queue q JOIN native_input_ids n ON n.turn_id = q.turn_id
      WHERE n.session_id = ? AND n.target_turn_id = ? AND q.state IN ('uncertain', 'dispatching', 'native-accepted')`).all(sessionId, turnId) as { turn_id: string; native_request_id: string }[]) if (confirmedNativeIds.includes(row.native_request_id)) this.inputState(row.turn_id, state);
  }

  cancel(sessionId: string, commandId: string): void {
    const row = this.queue(sessionId).find(row => row.commandId === commandId);
    if (row === undefined) throw Object.assign(new Error('队列输入不存在'), { statusCode: 404 });
    if (row.state !== 'queued') throw Object.assign(new Error('原生接收状态待核对，不能取消为未执行'), { statusCode: 409 });
    this.db.transaction(() => {
      if (this.db.prepare("UPDATE input_queue SET state = 'cancelled' WHERE turn_id = ? AND state = 'queued'").run(row.turnId).changes !== 1) throw Object.assign(new Error('队列状态已变化'), { statusCode: 409 });
      this.db.prepare("UPDATE command_journal SET state = 'cancelled', updated_at = ? WHERE turn_id = ?").run(new Date().toISOString(), row.turnId);
    })();
  }

  recover(sessionIds?: string[]): void {
    this.db.transaction(() => {
      if (sessionIds !== undefined) {
        for (const id of sessionIds) {
          this.db.prepare("UPDATE input_queue SET state = 'uncertain' WHERE session_id = ? AND state IN ('dispatching', 'native-accepted')").run(id);
          this.db.prepare("UPDATE command_journal SET state = 'uncertain' WHERE session_id = ? AND state IN ('dispatching', 'native-accepted')").run(id);
        }
        return;
      }
      this.db.exec("UPDATE input_queue SET state = 'uncertain' WHERE state IN ('dispatching', 'native-accepted')");
      this.db.exec("UPDATE command_journal SET state = 'uncertain' WHERE state IN ('dispatching', 'native-accepted')");
    })();
  }
}
