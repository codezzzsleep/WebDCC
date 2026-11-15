import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import type { RuntimeIdentity } from '@webdcc/protocol';
import { NativeTerminalOutput, type NativeOutputChunk } from './native-terminal-buffer.js';
import { nativeSurfaceError } from './native-surface.js';
import { terminalSize } from './native-terminal.js';

export interface NativeProcessCompletion { exitCode: number; stdout: string; stderr: string }
export interface NativeProcessDelta { stream: 'stdout' | 'stderr'; deltaBase64: string; capReached: boolean }
export interface NativeProcessContext {
  identity: RuntimeIdentity; nativeId: string; agent: 'codex' | 'dsh'; cwd: string;
  /** command/exec is standalone: its native command policy must be verified separately. */
  permissions: { source: 'native-command-config' | 'native-command-policy'; description: string; matchesSession: boolean };
}
export interface NativeProcessBridge {
  context(sessionId: string): Promise<NativeProcessContext> | NativeProcessContext;
  assert(sessionId: string, identity: RuntimeIdentity): void;
  start(sessionId: string, processId: string, params: { command: string[]; size: { rows: number; cols: number } }, onOutput: (delta: NativeProcessDelta) => void): Promise<NativeProcessCompletion>;
  write(sessionId: string, params: { processId: string; deltaBase64?: string; closeStdin?: boolean }): Promise<void>;
  resize(sessionId: string, params: { processId: string; size: { rows: number; cols: number } }): Promise<void>;
  terminate(sessionId: string, params: { processId: string }): Promise<void>;
}
export interface NativeProcessView {
  id: string;
  sessionId: string;
  nativeId: string;
  agent: 'codex' | 'dsh';
  cwd: string;
  generation: number;
  command: string[];
  state: 'starting' | 'running' | 'closing' | 'exited' | 'uncertain';
  exitCode: number | null;
  outputTruncated: boolean;
  logDownloadAvailable: boolean;
  rows: number;
  cols: number;
  error?: string;
  permissionSummary: string;
  confirmed: boolean;
}
export type NativeProcessFrame =
  | { type: 'output'; chunk: NativeOutputChunk }
  | { type: 'state'; process: NativeProcessView }
  | { type: 'snapshot'; process: NativeProcessView; chunks: NativeOutputChunk[]; firstSeq: number; lastSeq: number; gap: boolean };
interface ProcessClient { send(frame: NativeProcessFrame): void; close(code: number, reason: string): void }
interface ProcessRecord {
  context: NativeProcessContext;
  view: NativeProcessView;
  output: NativeTerminalOutput;
  clients: Set<ProcessClient>;
  completed: Promise<void>;
  inputBytes: number;
  actions: number;
}

/** NP-33 uses the existing native execution sandbox and native connection.
 * It never spawns a platform shell or substitutes the NP-43 CLI terminal. */
export class NativeProcessSupervisor {
  private readonly records = new Map<string, ProcessRecord>();
  private disposed = false;
  private opening = 0;
  constructor(private readonly bridge: NativeProcessBridge, private readonly options: { logRoot?: string; maxProcesses?: number; maxLogBytes?: number; replayBytes?: number; exitTimeoutMs?: number; onState?(view: NativeProcessView): void } = {}) {}

  async start(sessionId: string, command: string[], size: { rows: number; cols: number }, recordOutput = false): Promise<NativeProcessView> {
    if (this.disposed) throw nativeSurfaceError('原生进程服务已关闭', 503);
    if (this.records.size + this.opening >= (this.options.maxProcesses ?? 16)) throw nativeSurfaceError('原生进程数量已达到上限', 429);
    this.opening++;
    try { return await this.startRecord(sessionId, command, size, recordOutput); }
    finally { this.opening--; }
  }
  private async startRecord(sessionId: string, command: string[], size: { rows: number; cols: number }, recordOutput: boolean): Promise<NativeProcessView> {
    if (this.disposed) throw nativeSurfaceError('原生进程服务已关闭', 503);
    if (this.records.size >= (this.options.maxProcesses ?? 16)) throw nativeSurfaceError('原生进程数量已达到上限', 429);
    validateNativeCommand(command);
    terminalSize(size.rows, size.cols);
    const context = await this.bridge.context(sessionId);
    if (this.disposed) throw nativeSurfaceError('原生进程服务已关闭', 503);
    this.bridge.assert(sessionId, context.identity);
    if (!context.nativeId || !['codex', 'dsh'].includes(context.agent)) throw nativeSurfaceError('此 Agent 没有已验证的原生交互进程接口');
    if (!context.permissions?.matchesSession || !context.permissions.description) throw nativeSurfaceError('原生命令沙箱与当前会话权限尚未验证一致，不能启动');
    const id = randomUUID();
    const output = new NativeTerminalOutput(this.options.replayBytes, recordOutput ? (this.options.logRoot ?? join(tmpdir(), 'webdcc-native-process')) : undefined, this.options.maxLogBytes);
    const view: NativeProcessView = { id, sessionId, nativeId: context.nativeId, agent: context.agent, cwd: context.cwd, generation: context.identity.generation,
      command: [...command], state: 'starting', exitCode: null, outputTruncated: false, logDownloadAvailable: output.logPath !== undefined, permissionSummary: context.permissions.description, confirmed: false, ...size };
    const record: ProcessRecord = { context, view, output, clients: new Set(), completed: Promise.resolve(), inputBytes: 0, actions: 0 };
    const stdout = new StringDecoder('utf8');
    const stderr = new StringDecoder('utf8');
    this.records.set(id, record);
    record.completed = Promise.resolve().then(() => this.bridge.start(sessionId, id, { command: [...command], size }, delta => {
      if (!this.current(record)) return;
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(delta.deltaBase64)) { this.uncertain(record, '原生输出编码无效'); return; }
      if (record.view.state === 'starting') { record.view.state = 'running'; record.view.confirmed = true; this.state(record); }
      // Native bytes may split UTF-8. Buffer them per stream using StringDecoder.
      const decoder = delta.stream === 'stdout' ? stdout : stderr;
      this.append(record, decoder.write(Buffer.from(delta.deltaBase64, 'base64')));
      record.view.outputTruncated ||= delta.capReached;
    })).then(result => {
      if (!this.current(record)) { this.uncertain(record, '原生运行代际已变化，进程结果需核对'); return; }
      this.append(record, stdout.end()); this.append(record, stderr.end());
      this.append(record, result.stdout); this.append(record, result.stderr);
      record.view.state = 'exited'; record.view.exitCode = result.exitCode; record.view.confirmed = true;
      record.output.seal(); this.state(record);
    }).catch(error => { this.uncertain(record, error instanceof Error ? error.message : '原生进程结果未知'); });
    return this.view(record);
  }
  list(sessionId: string): NativeProcessView[] { return [...this.records.values()].filter(record => record.view.sessionId === sessionId).map(record => this.view(record)); }
  get(id: string): NativeProcessView { return this.view(this.require(id)); }
  attach(id: string, generation: number, client: ProcessClient, afterSeq = 0): () => void {
    const record = this.require(id);
    if (record.view.generation !== generation) throw nativeSurfaceError('原生进程代际已变化');
    if (record.clients.size >= 4) throw nativeSurfaceError('原生进程连接数已达到上限', 429);
    record.clients.add(client);
    client.send({ type: 'snapshot', process: this.view(record), ...record.output.snapshot(afterSeq) });
    return () => record.clients.delete(client);
  }
  async write(id: string, generation: number, data: string, closeStdin = false): Promise<void> {
    const record = this.writable(id, generation);
    const bytes = Buffer.byteLength(data);
    if (bytes > 64 * 1024 || record.inputBytes + bytes > 256 * 1024) throw nativeSurfaceError('原生 stdin 背压限制', 429);
    this.reserveAction(record);
    record.inputBytes += bytes;
    try { await this.bridge.write(record.view.sessionId, { processId: id, deltaBase64: Buffer.from(data).toString('base64'), closeStdin }); }
    finally { record.inputBytes -= bytes; record.actions--; }
  }
  async resize(id: string, generation: number, rows: number, cols: number): Promise<void> {
    const record = this.writable(id, generation);
    const size = terminalSize(rows, cols);
    this.reserveAction(record);
    try { await this.bridge.resize(record.view.sessionId, { processId: id, size }); Object.assign(record.view, size); }
    finally { record.actions--; }
  }
  async stop(id: string, generation: number): Promise<NativeProcessView> {
    const record = this.require(id);
    if (generation !== record.view.generation) throw nativeSurfaceError('原生进程代际已变化');
    if (record.view.state === 'exited') return this.view(record);
    this.bridge.assert(record.view.sessionId, record.context.identity);
    record.view.state = 'closing'; this.state(record);
    await this.bridge.terminate(record.view.sessionId, { processId: id });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([record.completed, new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(nativeSurfaceError('原生终止已请求，exit 尚未确认')), this.options.exitTimeoutMs ?? 10_000); })]);
      if (this.view(record).state !== 'exited') throw nativeSurfaceError('原生进程终态尚未确认');
      return this.view(record);
    } catch (error) { this.uncertain(record, error instanceof Error ? error.message : '原生进程退出未知'); throw error; }
    finally { if (deadline !== undefined) clearTimeout(deadline); }
  }
  async close(id: string, generation: number): Promise<void> {
    const record = this.require(id);
    await this.stop(id, generation);
    for (const client of record.clients) client.close(1000, 'native process closed');
    record.clients.clear(); record.output.dispose(); this.records.delete(id);
  }
  log(id: string): { path: string; truncated: boolean } {
    const record = this.require(id);
    if (!record.output.logPath) throw nativeSurfaceError('此原生进程未启用临时日志保留', 404);
    return { path: record.output.logPath, truncated: record.view.outputTruncated || record.output.truncated };
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    const results = await Promise.allSettled([...this.records.values()].map(record => this.close(record.view.id, record.view.generation)));
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  metrics(): { processes: number; clients: number; replayBytes: number; logFiles: number } {
    const values = [...this.records.values()];
    return { processes: values.length, clients: values.reduce((sum, record) => sum + record.clients.size, 0), replayBytes: values.reduce((sum, record) => sum + record.output.metrics().replayBytes, 0), logFiles: values.reduce((sum, record) => sum + record.output.metrics().logFiles, 0) };
  }
  private require(id: string): ProcessRecord { const record = this.records.get(id); if (!record) throw nativeSurfaceError('原生进程不存在或已关闭', 404); return record; }
  private current(record: ProcessRecord): boolean { try { this.bridge.assert(record.view.sessionId, record.context.identity); return true; } catch { return false; } }
  private reserveAction(record: ProcessRecord): void { if (record.actions >= 32) throw nativeSurfaceError('原生进程操作背压限制', 429); record.actions++; }
  private writable(id: string, generation: number): ProcessRecord {
    const record = this.require(id);
    if (generation !== record.view.generation) throw nativeSurfaceError('旧代际不能写入原生进程');
    this.bridge.assert(record.view.sessionId, record.context.identity);
    if (!['starting', 'running'].includes(record.view.state)) throw nativeSurfaceError('原生进程不在可写状态');
    return record;
  }
  private view(record: ProcessRecord): NativeProcessView { return { ...record.view, command: [...record.view.command], outputTruncated: record.view.outputTruncated || record.output.truncated }; }
  private state(record: ProcessRecord): void { const view = this.view(record); this.broadcast(record, { type: 'state', process: view }); try { this.options.onState?.(view); } catch { /* State observers cannot change native process lifecycle. */ } }
  private uncertain(record: ProcessRecord, error: string): void { record.view.state = 'uncertain'; record.view.error = error; this.state(record); }
  private append(record: ProcessRecord, data: string): void {
    if (!data) return;
    for (let offset = 0; offset < data.length;) {
      let end = Math.min(data.length, offset + 16_384);
      if (end < data.length && /[\uD800-\uDBFF]/u.test(data[end - 1]!)) end--;
      this.broadcast(record, { type: 'output', chunk: record.output.append(data.slice(offset, end)) });
      offset = end;
    }
    if (record.output.truncated && record.view.state === 'running') void this.stop(record.view.id, record.view.generation).catch(() => undefined);
  }
  private broadcast(record: ProcessRecord, frame: NativeProcessFrame): void {
    for (const client of record.clients) { try { client.send(frame); } catch { record.clients.delete(client); client.close(1013, 'native output backpressure'); } }
  }
}

export function validateNativeCommand(command: string[]): void {
  if (!Array.isArray(command) || !command.length || command.length > 64 || command.some(argument => typeof argument !== 'string' || argument.includes('\0') || Buffer.byteLength(argument) > 8_192) || command[0] === '') throw nativeSurfaceError('原生命令必须是有界 argv 数组', 400);
}
