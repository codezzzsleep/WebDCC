import type { NativeActionReceipt, NativeActionRequest, NativeActionResponse, NativeActionState, NativeForkContinuation, ManagedProcessIdentity, RuntimeIdentity, DshSubagentInputReference } from '@webdcc/protocol';
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
const receipt = (row: Row): NativeActionReceipt => {
  const reference = row.reference === null ? undefined : JSON.parse(row.reference) as NonNullable<NativeActionReceipt['reference']> & { callReturnedAt?: string; continuation?: NativeForkContinuation };
  return { commandId: row.command_id, sessionId: row.session_id, type: row.type, state: row.state, updatedAt: row.updated_at,
    ...(row.error === null ? {} : { error: row.error }), ...(reference === undefined ? {} : {
      reference: { id: reference.id, ...(reference.generation === undefined ? {} : { generation: reference.generation }), ...(reference.runId === undefined ? {} : { runId: reference.runId }),
        ...(reference.dshChild === undefined ? {} : { dshChild: reference.dshChild }) },
      ...(reference.callReturnedAt === undefined ? {} : { callReturnedAt: reference.callReturnedAt }),
      ...(reference.continuation === undefined ? {} : { continuation: reference.continuation }),
    }) };
};

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
  /** Slash command output is a redacted user-visible projection. Other native
   * actions (including secret replies) still retain only their receipt. */
  saveSlashResult(commandId: string, sessionId: string, result: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO slash_results (command_id, session_id, result) VALUES (?, ?, ?)')
      .run(commandId, sessionId, JSON.stringify(result));
  }
  slashResult(commandId: string, sessionId: string): NativeActionResponse | undefined {
    const status = this.get(commandId, sessionId);
    if (status === undefined || !['slash-goal', 'slash-control', 'compact'].includes(status.type)) return undefined;
    const row = this.db.prepare('SELECT result FROM slash_results WHERE command_id = ? AND session_id = ?').get(commandId, sessionId) as { result: string } | undefined;
    return { receipt: status, ...(row === undefined ? {} : { result: JSON.parse(row.result) as unknown }) };
  }
  private finish(commandId: string, state: NativeActionState, reason?: string): void {
    this.db.prepare("UPDATE native_actions SET state = ?, error = ?, updated_at = ? WHERE command_id = ? AND state IN ('dispatching','submitted')")
      .run(state, reason ?? null, new Date().toISOString(), commandId);
  }
  bind(commandId: string, identity: RuntimeIdentity, nativeId: string): void {
    this.db.prepare('UPDATE native_actions SET runtime_key = ?, native_id = ? WHERE command_id = ?')
      .run(payloadHash(identity), nativeId, commandId);
  }
  /** The session, feed and completed receipt commit together after the native
   * fork returns. A crash before this transaction leaves an uncertain action. */
  recordFork(commandId: string, sessionId: string, identity: RuntimeIdentity, sourceNativeId: string, nativeId: string,
    create: () => NativeForkContinuation): NativeForkContinuation {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM native_actions WHERE command_id = ? AND session_id = ?').get(commandId, sessionId) as Row & { runtime_key: string | null; native_id: string | null } | undefined;
      if (row === undefined || row.type !== 'fork' || row.runtime_key !== payloadHash(identity) || row.native_id !== sourceNativeId) throw new Error('Native fork receipt does not match its source writer');
      const previous = row.reference === null ? {} : JSON.parse(row.reference) as { continuation?: NativeForkContinuation };
      if (previous.continuation !== undefined) {
        if (previous.continuation.nativeId !== nativeId || previous.continuation.sourceNativeId !== sourceNativeId) throw new Error('Native fork receipt already belongs to another result');
        return previous.continuation;
      }
      if (row.state !== 'dispatching') throw new Error('Native fork dispatch is no longer current');
      const continuation = create();
      if (continuation.nativeId !== nativeId || continuation.sourceNativeId !== sourceNativeId) throw new Error('Native fork session does not match the returned identity');
      this.db.prepare("UPDATE native_actions SET reference = ?, state = 'completed', error = NULL, updated_at = ? WHERE command_id = ?")
        .run(JSON.stringify({ id: nativeId, continuation }), new Date().toISOString(), commandId);
      return continuation;
    })();
  }
  /** A returned SDK stop call is evidence about the old command, even when
   * the operation subsequently loses its owner. It never settles the task. */
  recordStopReturn(commandId: string, result: unknown): void {
    const value = result !== null && typeof result === 'object' ? result as { id?: unknown; runId?: unknown; callReturnedAt?: unknown } : {};
    if (typeof value.id !== 'string' || value.id === '' || value.id.length > 4096
      || value.runId !== null && value.runId !== undefined && typeof value.runId !== 'string') return;
    const row = this.db.prepare("SELECT reference, target_key FROM native_actions WHERE command_id = ? AND type = 'stop-task'").get(commandId) as { reference: string | null; target_key: string } | undefined;
    const runId = value.runId ?? null;
    if (row === undefined || row.target_key !== targetKey({ type: 'stop-task', taskId: value.id, runId })) return;
    const previous = row.reference === null ? {} : JSON.parse(row.reference) as { callReturnedAt?: string };
    const returnedAt = typeof value.callReturnedAt === 'string' && Number.isFinite(Date.parse(value.callReturnedAt)) ? value.callReturnedAt : new Date().toISOString();
    this.db.prepare('UPDATE native_actions SET reference = ? WHERE command_id = ?')
      .run(JSON.stringify({ id: value.id, runId, callReturnedAt: previous.callReturnedAt ?? returnedAt }), commandId);
  }
  /** Only an identified native terminal notification may close a submission. */
  confirm(sessionId: string, identity: RuntimeIdentity, nativeId: string, action: { type: string; [key: string]: unknown }): void {
    this.db.prepare("UPDATE native_actions SET state = 'completed', error = NULL, updated_at = ? WHERE session_id = ? AND runtime_key = ? AND native_id = ? AND target_key = ? AND state IN ('dispatching','submitted')")
      .run(new Date().toISOString(), sessionId, payloadHash(identity), nativeId, targetKey(action));
  }
  taskEnded(sessionId: string, identity: RuntimeIdentity, nativeId: string, taskId: string, runId: string | null, status: string): void {
    const action = { type: 'stop-task', taskId, runId };
    if (status === 'stopped') { this.confirm(sessionId, identity, nativeId, action); return; }
    if (status !== 'completed' && status !== 'failed') return;
    // A natural/error terminal event settles the wait without claiming that
    // this request stopped the task. The call return remains independent.
    this.db.prepare("UPDATE native_actions SET state = 'uncertain', error = ?, updated_at = ? WHERE session_id = ? AND runtime_key = ? AND native_id = ? AND target_key = ? AND state IN ('dispatching','submitted')")
      .run(`task-ended-without-stop-confirmation:${status}`, new Date().toISOString(), sessionId, payloadHash(identity), nativeId, targetKey(action));
  }
  disconnect(sessionId: string, identity: RuntimeIdentity): void {
    this.db.prepare("UPDATE native_actions SET state = 'uncertain', error = 'native-connection-closed', updated_at = ? WHERE session_id = ? AND runtime_key = ? AND state IN ('dispatching','submitted')")
      .run(new Date().toISOString(), sessionId, payloadHash(identity));
  }
  confirmReference(sessionId: string, identity: RuntimeIdentity, nativeId: string, type: string, id: string): void {
    this.db.prepare("UPDATE native_actions SET state = 'completed', error = NULL, updated_at = ? WHERE session_id = ? AND runtime_key = ? AND native_id = ? AND type = ? AND json_extract(reference, '$.id') = ? AND state IN ('dispatching','submitted')")
      .run(new Date().toISOString(), sessionId, payloadHash(identity), nativeId, type, id);
  }
  /** Bind a passive child's input before native admission, without a parent writer. */
  bindChildPrompt(commandId: string, sessionId: string, target: DshSubagentInputReference): void {
    const reference = { id: target.childSessionId, dshChild: target };
    const updated = this.db.prepare("UPDATE native_actions SET native_id = ?, reference = ? WHERE command_id = ? AND session_id = ? AND type = 'dsh-child-prompt' AND state = 'dispatching'")
      .run(target.parentSessionId, JSON.stringify(reference), commandId, sessionId);
    if (updated.changes !== 1) throw error('子消息身份未持久化，不能发送');
  }
  /** Only native queue/history or the exact RPC receipt proves input acceptance. */
  acceptChildPrompt(commandId: string, sessionId: string, target: DshSubagentInputReference, messageId: string): void {
    const current = this.get(commandId, sessionId); const saved = current?.reference?.dshChild;
    if (current?.type !== 'dsh-child-prompt' || saved?.parentSessionId !== target.parentSessionId || saved.childSessionId !== target.childSessionId
      || saved.nativeRequestId !== target.nativeRequestId || saved.contentHash !== target.contentHash || typeof messageId !== 'string' || messageId === '') throw error('子消息接收身份不匹配');
    const reference = { id: messageId, dshChild: { ...saved, messageId } };
    this.db.prepare("UPDATE native_actions SET state = 'completed', error = NULL, reference = ?, updated_at = ? WHERE command_id = ? AND session_id = ? AND type = 'dsh-child-prompt' AND state IN ('dispatching','submitted','uncertain')")
      .run(JSON.stringify(reference), new Date().toISOString(), commandId, sessionId);
  }
  rejectChildPrompt(commandId: string, sessionId: string, rejection: { code: string; message: string }): void {
    const current = this.get(commandId, sessionId); const target = current?.reference?.dshChild;
    if (current?.type !== 'dsh-child-prompt' || target === undefined) throw error('子消息拒绝身份不匹配');
    this.db.prepare("UPDATE native_actions SET reference = ? WHERE command_id = ? AND session_id = ? AND state = 'dispatching'")
      .run(JSON.stringify({ id: target.childSessionId, dshChild: { ...target, rejection } }), commandId, sessionId);
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
      const response = result !== null && typeof result === 'object' ? result as { id?: unknown; generation?: unknown; runId?: unknown } : {};
      if (value.action.type === 'stop-task') this.recordStopReturn(value.commandId, result);
      else if (value.action.type !== 'fork' && typeof response.id === 'string' && response.id.length <= 128) {
        const reference = { id: response.id, ...(Number.isSafeInteger(response.generation) ? { generation: response.generation } : {}) };
        this.db.prepare('UPDATE native_actions SET reference = ? WHERE command_id = ?').run(JSON.stringify(reference), value.commandId);
      }
      const submitted = result !== null && typeof result === 'object' && (result as { confirmed?: boolean }).confirmed === false;
      const failed = result !== null && typeof result === 'object' && (result as { failed?: boolean }).failed === true;
      this.finish(value.commandId, failed ? 'failed' : submitted ? 'submitted' : 'completed', failed ? 'native-command-failed' : undefined);
      return { receipt: this.get(value.commandId, sessionId)!, result };
    } catch (failure) {
      if (value.action.type === 'stop-task') this.recordStopReturn(value.commandId, (failure as { nativeCallReturn?: unknown } | null)?.nativeCallReturn);
      // A verified adapter-specific native rejection can also prove no
      // operation effect. A received RPC error alone does not prove that.
      const code = (failure as { code?: string } | null)?.code;
      const preflight = code === 'native-control-rejected';
      const nativeRejected = code === 'native-control-rejected-no-effect';
      this.finish(value.commandId, preflight || nativeRejected ? 'failed' : 'uncertain',
        preflight ? 'rejected-before-dispatch' : nativeRejected ? 'native-rejected-without-effects' : 'native-outcome-unconfirmed');
      throw failure;
    }
  }
}
