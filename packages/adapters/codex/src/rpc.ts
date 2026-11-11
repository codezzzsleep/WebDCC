/**
 * 换行分隔 JSON-RPC 的 stdio 客户端：给 `codex app-server` 这类"子进程 + JSON-RPC"的
 * 原生 Agent 用。SPEC 5.2：省略 `"jsonrpc":"2.0"`。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type Frame = Record<string, unknown>;

export interface StartOptions {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** 每一帧（收/发）都会回调，用于录制 fixtures */
  onFrame?: (direction: 'in' | 'out', frame: Frame) => void;
  onStderr?: (line: string) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export type NotificationHandler = (frame: Frame) => void;
export type ServerRequestHandler = (frame: Frame) => unknown | Promise<unknown>;

export class JsonRpcStdio {
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers: NotificationHandler[] = [];
  private readonly serverRequestHandlers: ServerRequestHandler[] = [];
  private closed = false;
  private readonly frames: Frame[] = [];

  private constructor(child: ChildProcessWithoutNullStreams, private readonly options: StartOptions) {
    this.child = child;
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => this.onLine(line));
    const errRl = createInterface({ input: child.stderr });
    errRl.on('line', (line) => this.options.onStderr?.(line));
    // 没装 codex（ENOENT）等启动失败：不能让未处理的 'error' 事件拖垮整个服务进程
    child.on('error', (error) => {
      this.closed = true;
      this.options.onStderr?.(`无法启动 ${options.command}：${error.message}`);
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`无法启动 ${options.command}：${error.message}`));
      }
      this.pending.clear();
    });
    child.stdin.on('error', () => undefined);
    child.on('exit', (code, signal) => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`子进程退出（code=${String(code)}, signal=${String(signal)}），请求 ${p.method} 未完成`));
      }
      this.pending.clear();
    });
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
      frame = JSON.parse(trimmed) as Frame;
    } catch {
      this.options.onStderr?.(`非 JSON 输出：${trimmed.slice(0, 200)}`);
      return;
    }
    this.frames.push(frame);
    this.options.onFrame?.('in', frame);

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

    if (hasMethod && typeof id === 'number') {
      void this.handleServerRequest(frame, id);
      return;
    }

    if (hasMethod) {
      for (const handler of this.notificationHandlers) handler(frame);
    }
  }

  private async handleServerRequest(frame: Frame, id: number): Promise<void> {
    const method = String(frame['method']);
    for (const handler of this.serverRequestHandlers) {
      try {
        const result = await handler(frame);
        // undefined 表示"稍后由 respond() 回包"（审批/提问会挂起）
        if (result === undefined) return;
        this.send({ id, result });
        return;
      } catch (error) {
        this.send({ id, error: { code: -32000, message: String(error) } });
        return;
      }
    }
    this.send({ id, error: { code: -32601, message: `未实现的 server request: ${method}` } });
  }

  /** 由 adapter 在用户决策后回包（审批 / 提问 / 其它反向请求） */
  respond(id: number, result: unknown): void {
    this.send({ id, result });
  }

  private send(frame: Frame): void {
    if (this.closed) return;
    this.options.onFrame?.('out', frame);
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandlers.push(handler);
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandlers.push(handler);
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 120_000): Promise<T> {
    const id = this.nextId++;
    const frame: Frame = params === undefined ? { method, id } : { method, id, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        method,
      });
      this.send(frame);
    });
  }

  notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { method } : { method, params });
  }

  /** 等第一个满足条件的通知帧 */
  waitForNotification(predicate: (frame: Frame) => boolean, timeoutMs = 120_000): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待通知超时（${timeoutMs}ms）`)), timeoutMs);
      this.onNotification((frame) => {
        if (predicate(frame)) {
          clearTimeout(timer);
          resolve(frame);
        }
      });
    });
  }

  /** 收集通知直到 predicate 成立，返回期间的所有帧 */
  collectUntil(predicate: (frame: Frame) => boolean, timeoutMs = 120_000): Promise<Frame[]> {
    return new Promise((resolve, reject) => {
      const collected: Frame[] = [];
      const timer = setTimeout(() => reject(new Error(`收集通知超时（${timeoutMs}ms）`)), timeoutMs);
      this.onNotification((frame) => {
        collected.push(frame);
        if (predicate(frame)) {
          clearTimeout(timer);
          resolve(collected);
        }
      });
    });
  }

  async kill(signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
    if (this.closed) return;
    const exited = new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    this.child.kill(signal);
    await exited;
  }
}
