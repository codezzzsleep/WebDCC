import type { NativeActionReceipt, NativeActionRequest, NativeActionResponse, NativeActionState, ManagedProcessIdentity, RuntimeIdentity } from '@webdcc/protocol';
import type { Db } from './db.js';
import { payloadHash } from './command-journal.js';
import { captureProcess, processState } from './process-identity.js';

interface Row {
  command_id: string; session_id: string; type: string; payload_hash: string;
  state: NativeActionState; server_process: string; error: string | null; updated_at: string;
  reference: string | null;
}
const error = (message: string, statusCode = 409): Error => Object.assign(new Error(message), { statusCode, code: 'native-control-rejected' });
const targetKey = (action: Record<string, unknown>): string => payloadHash({ type: action['type'], id: action['requestId'] ?? action['taskId'] ?? action['cardId'] ?? action['childSessionId'] ?? action['terminalId'] ?? action['processId'] ?? null, runId: action['runId'] ?? null });
const receipt = (row: Row): NativeActionReceipt => ({ commandId: row.command_id, sessionId: row.session_id,
  type: row.type, state: row.state, updatedAt: row.updated_at, ...(row.error === null ? {} : { error: row.error }),
  ...(row.reference === null ? {} : { reference: JSON.parse(row.reference) as NonNullable<NativeActionReceipt['reference']> }) });

/** Claim before any native side effect. Neither replies nor results are stored.
 * A dead dispatcher is uncertain; a retry can never resubmit its operation. */
export class NativeActionStore {
  private readonly process: ManagedProcessIdentity;
  constructor(private readonly db: Db) {
    const identity = captureProcess(globalThis.process.pid);
    if (identity === undefined) throw new Error('Cannot capture native action dispatcher identity');
    this.process = identity;
    for (const row of db.prepare("SELECT * FROM native_actions WHERE state IN ('dispatching','submitted')").all() as Row[]) {
      if (processState(JSON.parse(row.server_process) as ManagedProcessIdentity) === 'exited') this.finish(row.command_id, 'uncertain', 'dispatcher-exited');
    }
  }
  get(commandId: string, sessionId: string): NativeActionReceipt | undefined {
    const row = this.db.prepare('SELECT * FROM native_actions WHERE command_id = ? AND session_id = ?').get(commandId, sessionId) as Row | undefined;
    return row === undefined ? undefined : receipt(row);
  }
  private finish(commandId: string, state: NativeActionState, reason?: string): void {
    this.db.prepare("UPDATE native_actions SET state = ?, error = ?, updated_at = ? WHERE command_id = ? AND state IN ('dispatching','submitted')")
      .run(state, reason ?? null, new Date().toISOString(), commandId);
  }
  bind(commandId: string, identity: RuntimeIdentity, nativeId: string): void {
    this.db.prepare('UPDATE native_actions SET runtime_key = ?, native_id = ? WHERE command_id = ?')
      .run(payloadHash(identity), nativeId, commandId);
  }
  /** Only an identified native terminal notification may close a submission. */
  confirm(sessionId: string, identity: RuntimeIdentity, nativeId: string, action: { type: string; [key: string]: unknown }): void {
    this.db.prepare("UPDATE native_actions SET state = 'completed', error = NULL, updated_at = ? WHERE session_id = ? AND runtime_key = ? AND native_id = ? AND target_key = ? AND state IN ('dispatching','submitted')")
      .run(new Date().toISOString(), sessionId, payloadHash(identity), nativeId, targetKey(action));
  }
  disconnect(sessionId: string, identity: RuntimeIdentity): void {
    this.db.prepare("UPDATE native_actions SET state = 'uncertain', error = 'native-connection-closed', updated_at = ? WHERE session_id = ? AND runtime_key = ? AND state IN ('dispatching','submitted')")
      .run(new Date().toISOString(), sessionId, payloadHash(identity));
  }
  confirmReference(sessionId: string, identity: RuntimeIdentity, nativeId: string, type: string, id: string): void {
    this.db.prepare("UPDATE native_actions SET state = 'completed', error = NULL, updated_at = ? WHERE session_id = ? AND runtime_key = ? AND native_id = ? AND type = ? AND json_extract(reference, '$.id') = ? AND state IN ('dispatching','submitted')")
      .run(new Date().toISOString(), sessionId, payloadHash(identity), nativeId, type, id);
  }
  async execute(sessionId: string, value: NativeActionRequest, run: () => Promise<unknown>): Promise<NativeActionResponse> {
    if (!value || typeof value !== 'object' || typeof value.commandId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(value.commandId)
      || !value.action || typeof value.action !== 'object' || Array.isArray(value.action) || typeof value.action.type !== 'string'
      || !/^[a-z][a-z0-9-]{0,79}$/.test(value.action.type) || (value.revision !== undefined && typeof value.revision !== 'string')
      || Object.keys(value).some(key => !['commandId', 'revision', 'action'].includes(key))) throw error('无效的原生命令', 400);
    const digest = payloadHash({ sessionId, ...value });
    const target = targetKey(value.action);
    const created = this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM native_actions WHERE command_id = ?').get(value.commandId)) return false;
      if (this.db.prepare("SELECT 1 FROM native_actions WHERE session_id = ? AND target_key = ? AND state IN ('dispatching','submitted','uncertain')").get(sessionId, target)) throw error('此原生操作仍在执行或结果未确认，不能重复提交');
      return this.db.prepare(`INSERT INTO native_actions
        (command_id, session_id, type, payload_hash, target_key, state, server_process, updated_at) VALUES (?, ?, ?, ?, ?, 'dispatching', ?, ?)`)
        .run(value.commandId, sessionId, value.action.type, digest, target, JSON.stringify(this.process), new Date().toISOString()).changes === 1;
    })();
    const row = this.db.prepare('SELECT * FROM native_actions WHERE command_id = ?').get(value.commandId) as Row;
    if (row.payload_hash !== digest || row.session_id !== sessionId) throw error('命令 ID 已被不同内容使用');
    if (!created) return { receipt: receipt(row) };
    try {
      const result = await run();
      const response = result !== null && typeof result === 'object' ? result as { id?: unknown; generation?: unknown } : {};
      if (typeof response.id === 'string' && response.id.length <= 128) {
        const reference = { id: response.id, ...(Number.isSafeInteger(response.generation) ? { generation: response.generation } : {}) };
        this.db.prepare('UPDATE native_actions SET reference = ? WHERE command_id = ?').run(JSON.stringify(reference), value.commandId);
      }
      const submitted = result !== null && typeof result === 'object' && (result as { confirmed?: boolean }).confirmed === false;
      this.finish(value.commandId, submitted ? 'submitted' : 'completed');
      return { receipt: this.get(value.commandId, sessionId)!, result };
    } catch (failure) {
      // Only our explicit pre-dispatch validation can prove there was no side effect.
      const rejected = (failure as { code?: string } | null)?.code === 'native-control-rejected';
      this.finish(value.commandId, rejected ? 'failed' : 'uncertain', rejected ? 'rejected-before-dispatch' : 'native-outcome-unconfirmed');
      throw failure;
    }
  }
}
