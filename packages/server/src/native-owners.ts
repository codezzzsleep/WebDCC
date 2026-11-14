import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AgentId, NativeOwnerDto, RuntimeIdentity, ManagedProcessIdentity } from '@webdcc/protocol';
import type { Db } from './db.js';
import { captureProcess } from './process-identity.js';

interface Row {
  session_id: string; agent: AgentId; host_id: string; native_id: string | null;
  owner_id: string; generation: number; state: NativeOwnerDto['state'];
  active_native_turn_id: string | null; last_observed_seq: number | null;
  lease_until: number; observed_at: string; server_pid: number;
  server_boot: string; server_start: string;
  managed_process?: string | null;
}
const boot = (): string => { try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return 'unknown'; } };
function processStart(pid: number): string {
  try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? 'unknown'; }
  catch { return 'missing'; }
}
const dto = (row: Row): NativeOwnerDto => ({ sessionId: row.session_id, agent: row.agent, hostId: row.host_id,
  nativeId: row.native_id, ownerId: row.owner_id, generation: row.generation, state: row.state,
  activeNativeTurnId: row.active_native_turn_id, lastObservedSeq: row.last_observed_seq,
  leaseUntil: row.lease_until, observedAt: row.observed_at, scope: 'webdcc-managed' });
const conflict = (message: string): Error => Object.assign(new Error(message), { statusCode: 409, code: 'native-owner-conflict' });

/** A lease timeout never proves that a native writer stopped. A different
 * owner cannot take over an unreleased connection, even after expiration. */
export class NativeOwnerStore {
  readonly hostId: string;
  private readonly serverBoot = boot();
  private readonly serverStart = processStart(process.pid);
  constructor(private readonly db: Db, private readonly leaseMs = 30_000) {
    db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)').run('native-host-id', randomUUID());
    this.hostId = (db.prepare('SELECT value FROM app_settings WHERE key = ?').get('native-host-id') as { value: string }).value;
  }
  get(sessionId: string): NativeOwnerDto | undefined {
    const row = this.db.prepare('SELECT * FROM native_owners WHERE session_id = ?').get(sessionId) as Row | undefined;
    return row === undefined ? undefined : dto(row);
  }
  acquire(ownerId: string, sessionId: string, agent: AgentId, nativeId?: string): RuntimeIdentity {
    return this.db.transaction(() => {
      const previous = this.get(sessionId);
      if (previous !== undefined && previous.state !== 'released') throw conflict(previous.state === 'uncertain'
        ? '原生运行实例释放状态待核对，不能启动新的写入实例' : '另一个运行实例仍持有此会话');
      if (nativeId && this.db.prepare('SELECT session_id FROM native_owners WHERE host_id = ? AND agent = ? AND native_id = ? AND session_id <> ?')
        .get(this.hostId, agent, nativeId, sessionId) !== undefined) throw conflict('此原生会话已关联另一个 Web 会话');
      const generation = (previous?.generation ?? 0) + 1;
      const now = Date.now();
      this.db.prepare(`INSERT INTO native_owners (session_id, agent, host_id, native_id, owner_id, generation, state,
        lease_until, observed_at, server_pid, server_boot, server_start)
        VALUES (?, ?, ?, ?, ?, ?, 'opening', ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET owner_id=excluded.owner_id, generation=excluded.generation,
        state='opening', lease_until=excluded.lease_until, observed_at=excluded.observed_at,
        server_pid=excluded.server_pid, server_boot=excluded.server_boot, server_start=excluded.server_start,
        managed_process=NULL, active_native_turn_id=NULL, last_observed_seq=NULL`)
        .run(sessionId, agent, this.hostId, nativeId || null, ownerId, generation, now + this.leaseMs,
          new Date(now).toISOString(), process.pid, this.serverBoot, this.serverStart);
      return { ownerId, generation, hostId: this.hostId };
    })();
  }
  current(sessionId: string, identity: RuntimeIdentity): boolean {
    const row = this.get(sessionId);
    return row !== undefined && row.ownerId === identity.ownerId && row.generation === identity.generation
      && row.hostId === identity.hostId && (row.state === 'opening' || row.state === 'active');
  }
  assert(sessionId: string, identity: RuntimeIdentity): void {
    if (!this.current(sessionId, identity)) throw Object.assign(new Error('原生运行代际已变化，执行结果需要核对'), { statusCode: 409, code: 'uncertain' });
  }
  activate(sessionId: string, identity: RuntimeIdentity, nativeId: string): void {
    this.assert(sessionId, identity);
    const duplicate = nativeId === '' ? undefined : this.db.prepare('SELECT session_id FROM native_owners WHERE host_id = ? AND agent = (SELECT agent FROM native_owners WHERE session_id = ?) AND native_id = ? AND session_id <> ?')
      .get(identity.hostId, sessionId, nativeId, sessionId);
    if (duplicate !== undefined) throw conflict('此原生会话已关联另一个 Web 会话，不能创建第二个写入实例');
    this.db.prepare("UPDATE native_owners SET native_id = ?, state = 'active' WHERE session_id = ? AND owner_id = ? AND generation = ?")
      .run(nativeId || null, sessionId, identity.ownerId, identity.generation);
    this.renew(sessionId, identity);
  }
  renew(sessionId: string, identity: RuntimeIdentity): boolean {
    return this.db.prepare("UPDATE native_owners SET lease_until = ? WHERE session_id = ? AND owner_id = ? AND generation = ? AND state IN ('opening','active')")
      .run(Date.now() + this.leaseMs, sessionId, identity.ownerId, identity.generation).changes === 1;
  }
  observe(sessionId: string, identity: RuntimeIdentity, nativeTurnId: string | null, seq?: number): void {
    this.assert(sessionId, identity);
    this.db.prepare('UPDATE native_owners SET active_native_turn_id = ?, last_observed_seq = COALESCE(?, last_observed_seq), observed_at = ?, lease_until = ? WHERE session_id = ? AND owner_id = ? AND generation = ?')
      .run(nativeTurnId, seq ?? null, new Date().toISOString(), Date.now() + this.leaseMs, sessionId, identity.ownerId, identity.generation);
  }
  close(sessionId: string, identity: RuntimeIdentity): void {
    this.db.prepare("UPDATE native_owners SET state = 'closing' WHERE session_id = ? AND owner_id = ? AND generation = ? AND state IN ('opening','active')")
      .run(sessionId, identity.ownerId, identity.generation);
  }
  release(sessionId: string, identity: RuntimeIdentity, verified: boolean): void {
    this.db.prepare('UPDATE native_owners SET state = ?, lease_until = 0 WHERE session_id = ? AND owner_id = ? AND generation = ?')
      .run(verified ? 'released' : 'uncertain', sessionId, identity.ownerId, identity.generation);
  }
  managedProcess(sessionId: string): ManagedProcessIdentity | null {
    const row = this.db.prepare('SELECT managed_process FROM native_owners WHERE session_id = ?').get(sessionId) as { managed_process: string | null } | undefined;
    return row?.managed_process == null ? null : JSON.parse(row.managed_process) as ManagedProcessIdentity;
  }
  bindProcess(sessionId: string, identity: RuntimeIdentity, pid: number, profilePath?: string, nativeVersion?: string): void {
    this.assert(sessionId, identity);
    const captured = captureProcess(pid, profilePath);
    if (captured === undefined) throw new Error('托管子进程身份无法验证');
    this.db.prepare('UPDATE native_owners SET managed_process = ? WHERE session_id = ? AND owner_id = ? AND generation = ?')
      .run(JSON.stringify({ ...captured, ...(nativeVersion === undefined ? {} : { nativeVersion }) }), sessionId, identity.ownerId, identity.generation);
  }
  reconcileRelease(sessionId: string, ownerId: string, generation: number): void {
    const changed = this.db.prepare("UPDATE native_owners SET state = 'released', active_native_turn_id = NULL, lease_until = 0 WHERE session_id = ? AND owner_id = ? AND generation = ? AND state IN ('uncertain','released')")
      .run(sessionId, ownerId, generation).changes;
    if (changed !== 1) throw conflict('运行身份已变化，请重新核对');
  }
  /** Recover only abandoned owners. Starting a second manager must not rewrite
   * another live manager's commands or interactions as uncertain. */
  recoverableSessions(): string[] {
    return this.db.transaction(() => {
      const sessions = this.db.prepare('SELECT id FROM sessions').all() as { id: string }[];
      return sessions.filter(({ id }) => {
        const row = this.db.prepare('SELECT * FROM native_owners WHERE session_id = ?').get(id) as Row | undefined;
        if (row === undefined || row.state === 'released' || row.state === 'uncertain') return true;
        if (row.server_boot === 'unknown' || this.serverBoot === 'unknown') return false;
        if (row.server_boot === this.serverBoot && processStart(row.server_pid) === row.server_start) return false;
        this.db.prepare("UPDATE native_owners SET state = 'uncertain', lease_until = 0 WHERE session_id = ?").run(id);
        return true;
      }).map(({ id }) => id);
    })();
  }
}
