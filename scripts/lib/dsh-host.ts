/**
 * DSH Web Host API 的最小客户端（M0 探针用）。
 *
 * 协议事实来自 DSH 0.2.2-rc.1 源码核实（见 docs/protocol-notes.md）：
 *  - 一元 RPC：`POST /api/<namespace>/<method>`，信封 `{type:"client-request", rpcId, method, payload:{args}}`
 *  - 响应：`{type:"server-response", rpcId, result:{ok:true,value}}` / `{ok:false,error}`
 *  - 事件：WS `/api/remote.mux`，上行 `{type:"open", streamId, endpoint, payload:{args}}`
 *  - 认证：`GET /?token=<t>` → 303 + HttpOnly Cookie（`dsh-auth-<sha256(authority)>`）
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';

export interface RpcError {
  code: string;
  message: string;
  details?: unknown;
}

export class DshRpcError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(error: RpcError) {
    super(`[${error.code}] ${error.message}`);
    this.code = error.code;
    this.details = error.details;
  }
}

export interface SidecarOptions {
  port: number;
  env: Record<string, string | undefined>;
  cwd?: string;
  command?: string;
  bootTimeoutMs?: number;
}

export interface Sidecar {
  child: ChildProcessWithoutNullStreams;
  port: number;
  tokenUrl: string;
  token: string;
  stdoutLines: string[];
  stderrLines: string[];
  stop: () => Promise<void>;
}

/** 启动 `dsh web --no-open`，从 stdout 解析带 token 的 URL */
export async function startSidecar(options: SidecarOptions): Promise<Sidecar> {
  const command = options.command ?? 'dsh';
  const args = ['web', '--no-open', '--port', String(options.port)];
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as ChildProcessWithoutNullStreams;

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const tokenUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dsh web ${options.bootTimeoutMs ?? 90_000}ms 内没有打印 token URL`)), options.bootTimeoutMs ?? 90_000);
    createInterface({ input: child.stdout }).on('line', (line) => {
      stdoutLines.push(line);
      const match = /^dsh web: (http:\/\/\S+\?token=\S+)$/.exec(line.trim());
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    createInterface({ input: child.stderr }).on('line', (line) => {
      stderrLines.push(line);
      if (stderrLines.length > 200) stderrLines.shift();
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`dsh web 提前退出（code=${String(code)}, signal=${String(signal)}）\n${stderrLines.slice(-20).join('\n')}`));
    });
  });

  const parsed = new URL(tokenUrl);
  const port = Number(parsed.port);

  return {
    child,
    port,
    tokenUrl,
    token: parsed.searchParams.get('token') ?? '',
    stdoutLines,
    stderrLines,
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
    },
  };
}

export interface StreamFrame {
  type: string;
  streamId?: string;
  value?: unknown;
  error?: unknown;
}

export class DshHostClient {
  private readonly base: string;
  private cookie = '';
  private counter = 0;
  private ws: WebSocket | null = null;
  private readonly streamHandlers = new Map<string, (frame: StreamFrame) => void>();
  private readonly allFrames: unknown[] = [];

  constructor(readonly port: number) {
    this.base = `http://127.0.0.1:${port}`;
  }

  /** `GET /?token=` 换会话 Cookie */
  async authenticate(tokenUrl: string): Promise<string> {
    const response = await fetch(tokenUrl, { redirect: 'manual' });
    const setCookies = response.headers.getSetCookie();
    const first = setCookies[0];
    if (first === undefined) throw new Error(`token 换 Cookie 失败：HTTP ${response.status}，没有 Set-Cookie`);
    this.cookie = first.split(';')[0] ?? '';
    return this.cookie;
  }

  get cookieHeader(): string {
    return this.cookie;
  }

  /** 一元 RPC */
  async rpc<T = unknown>(endpoint: string, args: Record<string, unknown> = {}): Promise<T> {
    const rpcId = randomUUID();
    const body = { type: 'client-request', rpcId, method: endpoint, payload: { args } };
    const response = await fetch(`${this.base}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: this.cookie },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${endpoint} 返回非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
    }
    const envelope = parsed as { type?: string; rpcId?: string; result?: { ok?: boolean; value?: unknown; error?: RpcError } };
    if (envelope.result === undefined) throw new Error(`${endpoint} 响应缺少 result：${text.slice(0, 200)}`);
    if (envelope.result.ok !== true) throw new DshRpcError(envelope.result.error ?? { code: 'unknown', message: text.slice(0, 200) });
    return envelope.result.value as T;
  }

  /** 连上 `/api/remote.mux`（多路复用事件流） */
  async connect(): Promise<void> {
    const socket = new WebSocket(`ws://127.0.0.1:${this.port}/api/remote.mux`, { headers: { cookie: this.cookie } });
    this.ws = socket;
    socket.on('message', (data: WebSocket.RawData) => {
      let frame: StreamFrame;
      try {
        frame = JSON.parse(data.toString()) as StreamFrame;
      } catch {
        return;
      }
      this.allFrames.push(frame);
      const streamId = frame.streamId;
      if (streamId !== undefined) this.streamHandlers.get(streamId)?.(frame);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', (error) => reject(error));
    });
  }

  /** 打开一条逻辑流 */
  openStream(endpoint: string, args: Record<string, unknown>, onFrame: (frame: StreamFrame) => void): string {
    if (this.ws === null) throw new Error('先调用 connect()');
    this.counter += 1;
    const streamId = `s${this.counter}`;
    this.streamHandlers.set(streamId, onFrame);
    this.ws.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }));
    return streamId;
  }

  closeStream(streamId: string): void {
    this.ws?.send(JSON.stringify({ type: 'cancel', streamId }));
    this.streamHandlers.delete(streamId);
  }

  get frames(): readonly unknown[] {
    return this.allFrames;
  }

  async close(): Promise<void> {
    const socket = this.ws;
    if (socket === null) return;
    this.ws = null;
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.close();
    });
  }
}

/** 等某个条件成立（轮询），超时抛错 */
export async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时（${timeoutMs}ms）：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
