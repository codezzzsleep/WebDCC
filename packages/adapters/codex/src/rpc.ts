/**
 * 换行分隔 JSON-RPC 的 stdio 客户端：给 `codex app-server` 这类"子进程 + JSON-RPC"的
 * 原生 Agent 用。SPEC 5.2：省略 `"jsonrpc":"2.0"`。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

export type Frame = Record<string, unknown>;

export interface StartOptions {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** 每一帧（收/发）都会回调，用于录制 fixtures */
  onFrame?: (direction: 'in' | 'out', frame: Frame) => void | boolean;
  onStderr?: (line: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** Raw diagnostic retention is opt-in and bounded. onFrame remains a stream. */
  maxFrames?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
  method: string;
}

export type NotificationHandler = (frame: Frame) => void;
export type ServerRequestHandler = (frame: Frame) => unknown | Promise<unknown>;

export class JsonRpcStdio {
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly serverRequestHandlers = new Set<ServerRequestHandler>();
  private readonly waiters = new Set<(error: Error) => void>();
  private readonly output: Interface;
  private readonly errors: Interface;
  private closed = false;
  private terminating?: Promise<void>;
  private readonly frames: Frame[] = [];

  private constructor(child: ChildProcessWithoutNullStreams, private readonly options: StartOptions) {
    this.child = child;
    this.output = createInterface({ input: child.stdout });
    this.output.on('line', (line) => this.onLine(line));
    this.errors = createInterface({ input: child.stderr });
    this.errors.on('line', (line) => this.options.onStderr?.(line));
    // 没装 codex（ENOENT）等启动失败：不能让未处理的 'error' 事件拖垮整个服务进程
    child.on('error', (error) => {
      this.options.onStderr?.(`无法启动 ${options.command}：${error.message}`);
      this.closePending(new Error(`无法启动 ${options.command}：${error.message}`));
    });
    child.stdin.on('error', () => undefined);
    child.on('exit', (code, signal) => {
      this.closePending(new Error(`子进程退出（code=${String(code)}, signal=${String(signal)}）`));
      this.options.onExit?.(code, signal);
    });
  }

  private closePending(error: Error): void {
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const reject of [...this.waiters]) reject(error);
    this.waiters.clear();
    this.notificationHandlers.clear();
    this.serverRequestHandlers.clear();
    this.output.close();
    this.errors.close();
  }

  get resourceCounts(): { pending: number; listeners: number; waiters: number; frames: number } {
    return { pending: this.pending.size, listeners: this.notificationHandlers.size + this.serverRequestHandlers.size, waiters: this.waiters.size, frames: this.frames.length };
  }

  static start(options: StartOptions): JsonRpcStdio {
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    return new JsonRpcStdio(child, options);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 收到的原始帧（供 fixtures 使用） */
  get receivedFrames(): readonly Frame[] {
    return this.frames;
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let frame: Frame;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('RPC frame must be an object');
      frame = value as Frame;
    } catch {
      this.options.onStderr?.(`非 JSON 输出：${trimmed.slice(0, 200)}`);
      return;
    }
    const maxFrames = Math.max(0, this.options.maxFrames ?? 0);
    if (maxFrames > 0) {
      this.frames.push(frame);
      if (this.frames.length > maxFrames) this.frames.shift();
    }
    if (this.options.onFrame?.('in', frame) === false) {
      this.closePending(new Error('原生事件未持久化或运行代际已关闭'));
      this.child.kill('SIGTERM');
      return;
    }

    const id = frame['id'];
    const hasMethod = typeof frame['method'] === 'string';

    if (typeof id === 'number' && !hasMethod) {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if ('error' in frame) pending.reject(new Error(`${pending.method} 失败：${JSON.stringify(frame['error'])}`));
      else pending.resolve(frame['result']);
      return;
    }

    if (hasMethod && (typeof id === 'number' || typeof id === 'string')) {
      void this.handleServerRequest(frame, id);
      return;
    }

    if (hasMethod) {
      for (const handler of this.notificationHandlers) handler(frame);
    }
  }

  private async handleServerRequest(frame: Frame, id: string | number): Promise<void> {
    const method = String(frame['method']);
    for (const handler of this.serverRequestHandlers) {
      try {
        const result = await handler(frame);
        // undefined 表示"稍后由 respond() 回包"（审批/提问会挂起）
        if (result === undefined) return;
        this.send({ id, result });
        return;
      } catch (error) {
        if (!this.closed) this.send({ id, error: { code: (error as { code?: number }).code ?? -32000, message: String(error) } });
        return;
      }
    }
    this.send({ id, error: { code: -32601, message: `未实现的 server request: ${method}` } });
  }

  /** 由 adapter 在用户决策后回包（审批 / 提问 / 其它反向请求） */
  respond(id: string | number, result: unknown): void {
    this.send({ id, result });
  }

  private send(frame: Frame): void {
    if (this.closed) throw new Error('RPC transport is closed');
    if (this.options.onFrame?.('out', frame) === false) {
      const error = Object.assign(new Error('原生事件未持久化或运行代际已关闭'), { code: 'uncertain' });
      this.closePending(error);
      this.child.kill('SIGTERM');
      throw error;
    }
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onServerRequest(handler: ServerRequestHandler): () => void {
    this.serverRequestHandlers.add(handler);
    return () => this.serverRequestHandlers.delete(handler);
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 120_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('RPC transport is closed'));
    const id = this.nextId++;
    const frame: Frame = params === undefined ? { method, id } : { method, id, params };
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs === 0 ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        method,
      });
      try { this.send(frame); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { method } : { method, params });
  }

  /** 等第一个满足条件的通知帧 */
  waitForNotification(predicate: (frame: Frame) => boolean, timeoutMs = 120_000): Promise<Frame> {
    return this.collectUntil(predicate, timeoutMs).then(frames => frames[frames.length - 1] as Frame);
  }

  /** 收集通知直到 predicate 成立，返回期间的所有帧 */
  collectUntil(predicate: (frame: Frame) => boolean, timeoutMs = 120_000): Promise<Frame[]> {
    if (this.closed) return Promise.reject(new Error('RPC transport is closed'));
    return new Promise((resolve, reject) => {
      const collected: Frame[] = [];
      const cleanup = (): void => { clearTimeout(timer); this.notificationHandlers.delete(handler); this.waiters.delete(fail); };
      const fail = (error: Error): void => { cleanup(); reject(error); };
      const timer = setTimeout(() => fail(new Error(`收集通知超时（${timeoutMs}ms）`)), timeoutMs);
      const handler = (frame: Frame): void => {
        collected.push(frame);
        try { if (predicate(frame)) { cleanup(); resolve(collected); } } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      };
      this.waiters.add(fail);
      this.notificationHandlers.add(handler);
    });
  }

  async kill(signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
    // A closed protocol channel is not evidence that its process exited.
    if (this.child.pid === undefined || this.child.exitCode !== null || this.child.signalCode !== null) return;
    if (this.terminating !== undefined) {
      if (signal === 'SIGKILL') this.child.kill(signal);
      return this.terminating;
    }
    const pending = new Promise<void>((resolve, reject) => {
      const finish = (): void => { clearTimeout(timer); this.child.removeListener('exit', finish); resolve(); };
      const timer = setTimeout(() => {
        this.child.removeListener('exit', finish);
        reject(new Error('原生子进程退出未确认，不能释放运行所有权'));
      }, 5000);
      this.child.once('exit', finish);
      try { this.child.kill(signal); }
      catch (error) { clearTimeout(timer); this.child.removeListener('exit', finish); reject(error); }
    });
    this.terminating = pending;
    try { await pending; } finally { if (this.terminating === pending) this.terminating = undefined; }
  }
}
