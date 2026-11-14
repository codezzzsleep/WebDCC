import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pty from 'node-pty';
import type { RuntimeIdentity, ManagedProcessIdentity } from '@webdcc/protocol';
import { NativeTerminalOutput, type NativeOutputChunk } from './native-terminal-buffer.js';
import type { NativeOwnerStore } from './native-owners.js';
import { captureProcess, processState } from './process-identity.js';
import { nativeSurfaceError, nativeTerminalArgv, validateNativeTerminalTarget, validateNativeTakeover, type NativeSurfaceIntent, type NativeTerminalTarget } from './native-surface.js';

export interface NativeTerminalIdentityInspection {
  state: 'unverified' | 'verified' | 'drifted' | 'uncertain';
  nativeId: string | null;
  generation: number;
  ownerId: string;
  hostId: string;
  observedAt: string;
  reason: string;
}

export interface NativeTerminalView {
  id: string;
  sourceSessionId: string;
  ownerSessionId: string;
  agent: NativeTerminalTarget['agent'];
  intent: NativeSurfaceIntent;
  nativeId: string | null;
  nativeIdentityVerified: boolean;
  identityInspection: NativeTerminalIdentityInspection;
  identityChanges: NativeTerminalIdentityInspection[];
  nativeVersion: string;
  cwd: string;
  profilePath: string;
  generation: number;
  ownerId: string;
  state: 'running' | 'closing' | 'exited' | 'uncertain';
  exitCode: number | null;
  exitSignal: number | null;
  outputTruncated: boolean;
  logDownloadAvailable: boolean;
  rows: number;
  cols: number;
  createdAt: string;
  process: ManagedProcessIdentity;
}

export type NativeTerminalFrame =
  | { type: 'output'; chunk: NativeOutputChunk }
  | { type: 'state'; terminal: NativeTerminalView }
  | { type: 'snapshot'; terminal: NativeTerminalView; chunks: NativeOutputChunk[]; firstSeq: number; lastSeq: number; gap: boolean };

export interface NativeTerminalClient {
  send(frame: NativeTerminalFrame): void;
  close(code: number, reason: string): void;
}

export interface NativeTerminalSupervisorDeps {
  owners: NativeOwnerStore;
  /** Select fixed authorized paths/config; create a new Web row for new-native. */
  resolveTarget(sourceSessionId: string, intent: NativeSurfaceIntent): Promise<NativeTerminalTarget>;
  /** Native history or live owner evidence, never the requested argv alone. */
  verifyNativeIdentity?(target: NativeTerminalTarget, process: ManagedProcessIdentity): Promise<{ nativeId: string; evidence: string } | undefined>;
  onNativeIdentity?(target: NativeTerminalTarget, nativeId: string): Promise<void> | void;
  onReleased?(target: NativeTerminalTarget, verified: boolean): Promise<void> | void;
  onIdentityInspection?(target: NativeTerminalTarget, inspection: NativeTerminalIdentityInspection): void;
  logRoot?: string;
  maxTerminals?: number;
  replayBytes?: number;
  maxLogBytes?: number;
  exitTimeoutMs?: number;
  closedRetentionMs?: number;
  identityProbeIntervalMs?: number;
}

interface TerminalRecord {
  target: NativeTerminalTarget;
  identity: RuntimeIdentity;
  process: pty.IPty;
  processIdentity: ManagedProcessIdentity;
  output: NativeTerminalOutput;
  clients: Set<NativeTerminalClient>;
  subscriptions: pty.IDisposable[];
  view: NativeTerminalView;
  exit: Promise<void>;
  resolveExit(): void;
  renew?: ReturnType<typeof setInterval>;
  retain?: ReturnType<typeof setTimeout>;
  identityCheck?: ReturnType<typeof setTimeout>;
  inspectionTask?: Promise<boolean>;
  boundNativeId?: string;
  identityCompromised: boolean;
  closing?: Promise<NativeTerminalView>;
}

/** Browser sockets attach to an existing PTY; they never create/resume it. */
export class NativeTerminalSupervisor {
  private readonly records = new Map<string, TerminalRecord>();
  private readonly opening = new Set<string>();
  private readonly ownerId = `pty:${randomUUID()}`;
  private disposed = false;
  constructor(private readonly deps: NativeTerminalSupervisorDeps) {}

  async create(sourceSessionId: string, intent: NativeSurfaceIntent, options: { rows?: number; cols?: number; recordOutput?: boolean } = {}): Promise<NativeTerminalView> {
    if (this.disposed) throw nativeSurfaceError('原生终端服务已关闭', 503);
    if (this.opening.has(sourceSessionId)) throw nativeSurfaceError('此会话的原生终端正在启动');
    if (this.records.size + this.opening.size >= (this.deps.maxTerminals ?? 8)) throw nativeSurfaceError('原生终端数量已达到上限，请关闭已有终端', 429);
    this.opening.add(sourceSessionId);
    let record: TerminalRecord | undefined;
    let identity: RuntimeIdentity | undefined;
    let target: NativeTerminalTarget | undefined;
    let spawned = false;
    try {
      target = await validateNativeTerminalTarget(await this.deps.resolveTarget(sourceSessionId, intent), intent);
      if (target.sourceSessionId !== sourceSessionId) throw nativeSurfaceError('授权目标与来源会话不一致', 403);
      if (intent === 'same-session' && this.deps.verifyNativeIdentity === undefined) throw nativeSurfaceError('缺少启动后的原生身份验证，同会话接管受阻');
      if (this.disposed) throw nativeSurfaceError('原生终端服务已关闭', 503);
      // Re-check process/release evidence after the version probe and before spawn.
      if (intent === 'same-session') validateNativeTakeover(target);
      identity = this.deps.owners.acquire(this.ownerId, target.ownerSessionId, target.agent, target.nativeId);
      const size = terminalSize(options.rows ?? 30, options.cols ?? 100);
      const output = new NativeTerminalOutput(this.deps.replayBytes, options.recordOutput === true ? (this.deps.logRoot ?? join(tmpdir(), 'webdcc-native-terminal')) : undefined, this.deps.maxLogBytes);
      let process: pty.IPty;
      try { process = pty.spawn(target.executable, nativeTerminalArgv(target, intent), { name: 'xterm-256color', cwd: target.cwd, env: { ...target.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }, ...size }); spawned = true; }
      catch (error) { output.dispose(); throw error; }
      const captured = captureProcess(process.pid, target.profilePath);
      if (captured === undefined) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let subscription: pty.IDisposable | undefined;
        const exited = new Promise<boolean>(resolve => {
          subscription = process.onExit(() => resolve(true));
          timeout = setTimeout(() => resolve(false), this.deps.exitTimeoutMs ?? 7_000);
        });
        try { process.kill('SIGKILL'); } catch { /* An actual exit event is still required. */ }
        const verifiedExit = await exited;
        if (timeout !== undefined) clearTimeout(timeout);
        subscription?.dispose();
        output.dispose();
        this.deps.owners.release(target.ownerSessionId, identity, verifiedExit);
        // Preserve the exit proof for cleanup without inventing a native id.
        spawned = !verifiedExit;
        throw nativeSurfaceError(verifiedExit ? 'PTY 启动期间已退出，没有可用的原生身份' : 'PTY 已启动但进程身份未捕获，释放状态需核对');
      }
      const processIdentity = { ...captured, nativeVersion: target.nativeVersion };
      let resolveExit!: () => void;
      const exit = new Promise<void>(resolve => { resolveExit = resolve; });
      const id = randomUUID();
      record = { target, identity, process, processIdentity, output, clients: new Set(), subscriptions: [], exit, resolveExit, identityCompromised: false,
        view: { id, sourceSessionId, ownerSessionId: target.ownerSessionId, agent: target.agent, intent, nativeId: target.nativeId ?? null,
          nativeIdentityVerified: false, identityInspection: { state: 'unverified', nativeId: target.nativeId ?? null, generation: identity.generation, ownerId: identity.ownerId, hostId: identity.hostId, observedAt: new Date().toISOString(), reason: '原生身份尚未验证' }, identityChanges: [], nativeVersion: target.nativeVersion, cwd: target.cwd, profilePath: target.profilePath,
          generation: identity.generation, ownerId: identity.ownerId, state: 'running', exitCode: null, exitSignal: null,
          outputTruncated: false, logDownloadAvailable: output.logPath !== undefined, ...size, createdAt: new Date().toISOString(), process: processIdentity } };
      this.records.set(id, record);
      const active = record;
      active.subscriptions.push(process.onData(data => this.onData(active, data)));
      active.subscriptions.push(process.onExit(event => this.onExit(active, event)));
      this.deps.owners.bindProcess(target.ownerSessionId, identity, process.pid, target.profilePath, target.nativeVersion);
      active.renew = setInterval(() => {
        if (!this.deps.owners.current(active.target.ownerSessionId, active.identity)) void this.stopRecord(active).catch(() => undefined);
        else this.deps.owners.renew(active.target.ownerSessionId, active.identity);
      }, 10_000);
      active.renew.unref();
      if (this.deps.verifyNativeIdentity !== undefined) {
        active.inspectionTask = this.checkIdentity(active);
        const verified = await active.inspectionTask;
        if (!verified && intent === 'same-session') throw nativeSurfaceError('CLI 实际原生身份尚未确认，同会话接管受阻');
        this.scheduleIdentityCheck(active);
      }
      return this.view(active);
    } catch (error) {
      if (record !== undefined) await this.close(record.view.id).catch(() => undefined);
      else if (target !== undefined) {
        if (identity !== undefined && this.deps.owners.current(target.ownerSessionId, identity)) this.deps.owners.release(target.ownerSessionId, identity, !spawned);
        await this.deps.onReleased?.(target, !spawned);
      }
      throw error;
    } finally { this.opening.delete(sourceSessionId); }
  }

  list(sourceSessionId: string): NativeTerminalView[] {
    return [...this.records.values()].filter(record => record.target.sourceSessionId === sourceSessionId || record.target.ownerSessionId === sourceSessionId).map(record => this.view(record));
  }
  get(id: string): NativeTerminalView { return this.view(this.require(id)); }
  snapshot(id: string, afterSeq = 0): Extract<NativeTerminalFrame, { type: 'snapshot' }> {
    const record = this.require(id);
    return { type: 'snapshot', terminal: this.view(record), ...record.output.snapshot(afterSeq) };
  }
  attach(id: string, generation: number, client: NativeTerminalClient, afterSeq = 0): () => void {
    const record = this.require(id);
    if (generation !== record.identity.generation) throw nativeSurfaceError('终端运行代际已变化');
    if (record.clients.size >= 4) throw nativeSurfaceError('此终端连接数已达到上限', 429);
    if (record.view.state === 'running') this.deps.owners.assert(record.target.ownerSessionId, record.identity);
    record.clients.add(client);
    try { client.send(this.snapshot(id, afterSeq)); } catch (error) { record.clients.delete(client); throw error; }
    return () => { record.clients.delete(client); };
  }
  input(id: string, generation: number, data: string): void {
    const record = this.writable(id, generation);
    if (typeof data !== 'string' || Buffer.byteLength(data) > 64 * 1024) throw nativeSurfaceError('终端输入超出单帧限制', 400);
    record.process.write(data);
  }
  resize(id: string, generation: number, rows: number, cols: number): void {
    const record = this.writable(id, generation);
    const size = terminalSize(rows, cols);
    record.process.resize(size.cols, size.rows);
    Object.assign(record.view, size);
  }
  async stop(id: string, generation: number): Promise<NativeTerminalView> {
    const record = this.require(id);
    if (generation !== record.identity.generation) throw nativeSurfaceError('终端运行代际已变化');
    this.deps.owners.assert(record.target.ownerSessionId, record.identity);
    return this.stopRecord(record);
  }
  async close(id: string): Promise<NativeTerminalView> {
    const record = this.require(id);
    const result = await this.stopRecord(record);
    await record.inspectionTask?.catch(() => undefined);
    if (result.state !== 'exited') throw nativeSurfaceError('原生进程退出尚未确认，资源保留以便核对');
    if (record.retain !== undefined) clearTimeout(record.retain);
    for (const client of record.clients) client.close(1000, 'terminal closed');
    record.clients.clear();
    record.output.dispose();
    this.records.delete(id);
    return { ...result, logDownloadAvailable: false };
  }
  log(id: string): { path: string; truncated: boolean } {
    const record = this.require(id);
    if (record.output.logPath === undefined || !record.view.logDownloadAvailable) throw nativeSurfaceError('此终端未启用临时日志保留', 404);
    return { path: record.output.logPath, truncated: record.output.truncated };
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    const results = await Promise.allSettled([...this.records.keys()].map(id => this.close(id)));
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  metrics(): { terminals: number; processes: number; ptys: number; clients: number; listeners: number; replayBytes: number; logFiles: number } {
    const records = [...this.records.values()];
    return { terminals: records.length, processes: records.filter(record => processState(record.processIdentity) === 'running').length,
      ptys: records.filter(record => record.subscriptions.length > 0).length, clients: records.reduce((sum, record) => sum + record.clients.size, 0),
      listeners: records.reduce((sum, record) => sum + record.subscriptions.length, 0), replayBytes: records.reduce((sum, record) => sum + record.output.metrics().replayBytes, 0),
      logFiles: records.reduce((sum, record) => sum + record.output.metrics().logFiles, 0) };
  }
  private require(id: string): TerminalRecord {
    const record = this.records.get(id);
    if (record === undefined) throw nativeSurfaceError('原生终端不存在或已关闭', 404);
    return record;
  }
  private view(record: TerminalRecord): NativeTerminalView { return { ...record.view, identityInspection: { ...record.view.identityInspection }, identityChanges: record.view.identityChanges.map(inspection => ({ ...inspection })), outputTruncated: record.output.truncated }; }
  private writable(id: string, generation: number): TerminalRecord {
    const record = this.require(id);
    if (generation !== record.identity.generation) throw nativeSurfaceError('终端运行代际已变化');
    this.deps.owners.assert(record.target.ownerSessionId, record.identity);
    if (record.view.state !== 'running') throw nativeSurfaceError('原生终端已停止或正在关闭');
    if (record.view.intent === 'same-session' && !record.view.nativeIdentityVerified) throw nativeSurfaceError('实际原生身份尚未验证，不能写入');
    return record;
  }
  private broadcast(record: TerminalRecord, frame: NativeTerminalFrame): void {
    for (const client of record.clients) {
      try { client.send(frame); } catch { record.clients.delete(client); client.close(1013, 'terminal backpressure'); }
    }
  }
  private onData(record: TerminalRecord, data: string): void {
    // Split huge emissions before buffering and before a websocket send.
    for (let offset = 0; offset < data.length;) {
      let end = Math.min(data.length, offset + 16_384);
      if (end < data.length && /[\uD800-\uDBFF]/u.test(data[end - 1]!)) end--;
      const chunk = record.output.append(data.slice(offset, end));
      offset = end;
      if (this.deps.owners.current(record.target.ownerSessionId, record.identity)) this.broadcast(record, { type: 'output', chunk });
    }
    if (record.output.truncated) void this.stopRecord(record).catch(() => undefined);
  }
  private onExit(record: TerminalRecord, event: { exitCode: number; signal?: number }): void {
    record.view.state = 'exited';
    record.view.exitCode = event.exitCode;
    record.view.exitSignal = event.signal ?? null;
    if (record.renew !== undefined) clearInterval(record.renew);
    if (record.identityCheck !== undefined) clearTimeout(record.identityCheck);
    record.subscriptions.splice(0).forEach(subscription => subscription.dispose());
    record.output.seal();
    const identityReleaseVerified = !record.identityCompromised;
    this.deps.owners.release(record.target.ownerSessionId, record.identity, identityReleaseVerified);
    void Promise.resolve().then(() => this.deps.onReleased?.(record.target, identityReleaseVerified)).catch(() => undefined);
    this.broadcast(record, { type: 'state', terminal: this.view(record) });
    record.resolveExit();
    record.retain = setTimeout(() => { void this.close(record.view.id).catch(() => undefined); }, this.deps.closedRetentionMs ?? 15 * 60_000);
    record.retain.unref();
  }
  private stopRecord(record: TerminalRecord): Promise<NativeTerminalView> {
    if (record.view.state === 'exited') return Promise.resolve(this.view(record));
    if (record.closing !== undefined) return record.closing;
    record.view.state = 'closing';
    this.deps.owners.close(record.target.ownerSessionId, record.identity);
    this.broadcast(record, { type: 'state', terminal: this.view(record) });
    record.closing = (async () => {
      // Check captured PID/start/boot before every signal; never signal a reused PID.
      try { if (processState(record.processIdentity) === 'running') record.process.kill('SIGTERM'); }
      catch (error) { record.view.state = 'uncertain'; this.deps.owners.release(record.target.ownerSessionId, record.identity, false); throw error; }
      const timeout = this.deps.exitTimeoutMs ?? 7_000;
      const kill = setTimeout(() => { try { if (processState(record.processIdentity) === 'running') record.process.kill('SIGKILL'); } catch { /* The exit deadline keeps release uncertain. */ } }, Math.min(2_000, timeout / 2));
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([record.exit, new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(nativeSurfaceError('等待原生 PTY 退出超时')), timeout); })]);
      } catch (error) {
        record.view.state = 'uncertain';
        this.deps.owners.release(record.target.ownerSessionId, record.identity, false);
        this.broadcast(record, { type: 'state', terminal: this.view(record) });
        record.closing = undefined;
        throw error;
      } finally { clearTimeout(kill); if (deadline !== undefined) clearTimeout(deadline); }
      return this.view(record);
    })();
    return record.closing;
  }
  private async checkIdentity(record: TerminalRecord): Promise<boolean> {
    const verified = await this.deps.verifyNativeIdentity?.(record.target, record.processIdentity);
    if (record.view.state !== 'running' || record.identityCompromised || !this.deps.owners.current(record.target.ownerSessionId, record.identity)) return false;
    if (verified === undefined) {
      if (record.boundNativeId !== undefined) this.compromiseIdentity(record, 'uncertain', null, '已绑定的原生身份失去验证证据，需要核对');
      else this.inspectIdentity(record, 'unverified', null, '原生身份尚未取得实际 writer 关联证据');
      return false;
    }
    this.deps.owners.assert(record.target.ownerSessionId, record.identity);
    if (!verified.nativeId || !verified.evidence) { this.compromiseIdentity(record, 'uncertain', null, '原生身份验证结果无效，需要核对'); return false; }
    if ((record.boundNativeId !== undefined && verified.nativeId !== record.boundNativeId) || (record.view.intent === 'same-session' && verified.nativeId !== record.target.nativeId)) {
      this.compromiseIdentity(record, 'drifted', verified.nativeId, 'CLI 已切换原生会话，托管写入已撤销，需要核对');
      return false;
    }
    if (record.boundNativeId === verified.nativeId) { this.inspectIdentity(record, 'verified', verified.nativeId, '持续验证的 writer 身份与已绑定原生会话一致'); return true; }
    try { this.deps.owners.activate(record.target.ownerSessionId, record.identity, verified.nativeId); }
    catch { this.compromiseIdentity(record, 'drifted', verified.nativeId, '原生身份已关联其他 Web 会话或 owner 无法取得，托管写入已撤销'); return false; }
    record.boundNativeId = verified.nativeId;
    record.view.nativeId = verified.nativeId;
    record.view.nativeIdentityVerified = true;
    this.inspectIdentity(record, 'verified', verified.nativeId, '实际 writer 与原生会话已绑定，仍需持续核对');
    await this.deps.onNativeIdentity?.(record.target, verified.nativeId);
    this.broadcast(record, { type: 'state', terminal: this.view(record) });
    return true;
  }
  private scheduleIdentityCheck(record: TerminalRecord): void {
    if (record.view.state !== 'running' || record.identityCompromised) return;
    record.identityCheck = setTimeout(() => {
      if (record.view.state !== 'running' || !this.deps.owners.current(record.target.ownerSessionId, record.identity)) return;
      record.inspectionTask = this.checkIdentity(record);
      void record.inspectionTask.then(() => this.scheduleIdentityCheck(record)).catch(() => { this.compromiseIdentity(record, 'uncertain', null, '原生身份持续核对失败，托管写入已撤销'); });
    }, this.deps.identityProbeIntervalMs ?? 2_000);
    record.identityCheck.unref();
  }
  private inspectIdentity(record: TerminalRecord, state: NativeTerminalIdentityInspection['state'], nativeId: string | null, reason: string): void {
    const previous = record.view.identityInspection;
    const inspection: NativeTerminalIdentityInspection = { state, nativeId, reason, generation: record.identity.generation, ownerId: record.identity.ownerId, hostId: record.identity.hostId, observedAt: new Date().toISOString() };
    record.view.identityInspection = inspection;
    if (previous.state !== state || previous.nativeId !== nativeId || previous.reason !== reason) {
      record.view.identityChanges.push(inspection);
      if (record.view.identityChanges.length > 16) record.view.identityChanges.shift();
      try { this.deps.onIdentityInspection?.(record.target, { ...inspection }); } catch { /* Observers cannot restore a revoked owner. */ }
      this.broadcast(record, { type: 'state', terminal: this.view(record) });
    }
  }
  private compromiseIdentity(record: TerminalRecord, state: 'drifted' | 'uncertain', nativeId: string | null, reason: string): void {
    if (record.view.state === 'exited' || record.identityCompromised) return;
    record.identityCompromised = true;
    record.view.nativeIdentityVerified = false;
    this.inspectIdentity(record, state, nativeId, reason);
    this.deps.owners.release(record.target.ownerSessionId, record.identity, false);
    void this.stopRecord(record).catch(() => undefined);
  }
}

export function terminalSize(rows: number, cols: number): { rows: number; cols: number } {
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < 2 || rows > 200 || cols < 2 || cols > 400) throw nativeSurfaceError('终端尺寸必须为 rows 2–200 / cols 2–400', 400);
  return { rows, cols };
}
