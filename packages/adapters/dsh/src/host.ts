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
import { validateDshArgs, validateDshResult } from './contracts.js';

export function dshBaseUrl(value: string | number): string {
  const url = new URL(typeof value === 'number' ? `http://127.0.0.1:${value}/` : value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('DSH endpoint must be an HTTP(S) Host URL');
  url.search = ''; url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

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
  args?: string[];
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
  const args = options.args ?? ['web', '--no-open', '--port', String(options.port), '--host', '127.0.0.1'];
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as ChildProcessWithoutNullStreams;

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  let tokenUrl: string;
  try { tokenUrl = await new Promise<string>((resolve, reject) => {
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
    child.once('error', error => { clearTimeout(timer); reject(error); });
  }); } catch (error) {
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
    }
    throw error;
  }

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

/** attach 模式：用启动 token 换一个 operator Cookie（SPEC-M8 2.2） */
export async function attachToDsh(endpoint: string | number, token: string): Promise<string> {
  const origin = dshBaseUrl(endpoint);
  const target = new URL('connect', origin);
  target.searchParams.set('token', token);
  target.searchParams.set('interactions', 'answer');
  const response = await fetch(target, {
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
    headers: { host: new URL(origin).host },
  });
  const setCookies = response.headers.getSetCookie();
  const first = setCookies[0];
  if ((!response.ok && ![302, 303, 307].includes(response.status)) || first === undefined) throw new Error(`DSH /connect 失败：HTTP ${response.status}`);
  // v2 Cookie 形如 dsh-auth-<hash>=v2…，是 operator Cookie，可用于 /api 与 remote.mux
  return first.split(';')[0] ?? '';
}

export interface DshHostOptions {
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  connectTimeoutMs?: number;
  rpcTimeoutMs?: number;
  maxFrames?: number;
  onState?: (state: 'online' | 'reconnecting' | 'auth-required' | 'closed') => void;
}

interface StreamSubscription {
  endpoint: string;
  args: Record<string, unknown>;
  handler: (frame: StreamFrame) => void;
}

export class DshHostClient {
  private readonly base: string;
  private readonly websocketBase: string;
  private cookie = '';
  private counter = 0;
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closing = false;
  private authRequired = false;
  private reconnectAttempt = 0;
  private readonly streams = new Map<string, StreamSubscription>();
  private readonly allFrames: unknown[] = [];

  constructor(endpoint: string | number, private readonly options: DshHostOptions = {}) {
    this.base = dshBaseUrl(endpoint);
    this.websocketBase = this.base.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  }

  useCookie(cookie: string): void {
    this.cookie = cookie;
    this.authRequired = false;
  }

  async authenticate(tokenUrl: string): Promise<string> {
    if (dshBaseUrl(tokenUrl) !== this.base) throw new Error('DSH authentication target does not match Host');
    const response = await fetch(tokenUrl, { redirect: 'manual', signal: AbortSignal.timeout(this.options.connectTimeoutMs ?? 10_000) });
    const first = response.headers.getSetCookie()[0];
    if ((!response.ok && ![302, 303, 307].includes(response.status)) || first === undefined) throw new Error(`token 换 Cookie 失败：HTTP ${response.status}`);
    this.useCookie(first.split(';')[0] ?? '');
    return this.cookie;
  }

  get cookieHeader(): string { return this.cookie; }
  get isConnected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  async rpc<T = unknown>(endpoint: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!/^(?:[\w-]+\/[\w-]+|\$events\/result)$/.test(endpoint)) throw new Error('Invalid DSH RPC endpoint');
    validateDshArgs(endpoint, args);
    const rpcId = randomUUID();
    const response = await fetch(`${this.base}api/${endpoint}`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(this.options.rpcTimeoutMs ?? 30_000),
      headers: { 'content-type': 'application/json', cookie: this.cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
    });
    if ([401, 403].includes(response.status)) {
      this.authenticationLost();
      throw Object.assign(new Error('DSH 认证已失效，请重新连接目标 Host'), { code: 'dsh-needs-link', statusCode: 401 });
    }
    let value: unknown;
    try { value = await response.json(); } catch { throw new Error(`${endpoint} 返回非 JSON（HTTP ${response.status}）`); }
    const envelope = value as { type?: string; rpcId?: string; result?: { ok?: boolean; value?: unknown; error?: RpcError } } | null;
    if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId || envelope.result === undefined || envelope.result === null || typeof envelope.result.ok !== 'boolean') throw new Error(`${endpoint} 响应身份或信封不匹配`);
    if (!response.ok && envelope.result.ok) throw new Error(`${endpoint} HTTP ${response.status} 未成功`);
    if (envelope.result.ok !== true) throw new DshRpcError(envelope.result.error ?? { code: 'unknown', message: 'Native request failed' });
    validateDshResult(endpoint, envelope.result.value);
    return envelope.result.value as T;
  }

  connect(): Promise<void> {
    if (this.authRequired) return Promise.reject(Object.assign(new Error('DSH 需要重新认证'), { code: 'dsh-needs-link' }));
    if (this.isConnected) return Promise.resolve();
    if (this.connecting !== null) return this.connecting;
    this.closing = false;
    const pending = this.openSocket();
    this.connecting = pending;
    void pending.finally(() => { if (this.connecting === pending) this.connecting = null; }).catch(() => undefined);
    return pending;
  }

  private openSocket(): Promise<void> {
    const socket = new WebSocket(`${this.websocketBase}api/remote.mux`, { headers: { cookie: this.cookie } });
    this.ws = socket;
    return new Promise<void>((resolve, reject) => {
      let opened = false;
      const timer = setTimeout(() => { reject(new Error('DSH 连接超时')); socket.terminate(); }, this.options.connectTimeoutMs ?? 10_000);
      socket.once('open', () => {
        opened = true;
        clearTimeout(timer);
        if (this.ws !== socket || this.closing) { socket.terminate(); reject(new Error('DSH 连接已取消')); return; }
        this.reconnectAttempt = 0;
        this.options.onState?.('online');
        for (const [id, stream] of this.streams) this.sendOpen(id, stream);
        resolve();
      });
      socket.on('message', data => {
        if (this.ws !== socket) return;
        let frame: StreamFrame;
        try {
          const value: unknown = JSON.parse(data.toString());
          if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
          frame = value as StreamFrame;
        } catch { return; }
        const limit = Math.max(0, this.options.maxFrames ?? 0);
        if (limit > 0) { this.allFrames.push(frame); if (this.allFrames.length > limit) this.allFrames.shift(); }
        if (typeof frame.streamId === 'string') {
          const stream = this.streams.get(frame.streamId);
          if (frame.type === 'end' || frame.type === 'error') this.streams.delete(frame.streamId);
          stream?.handler(frame);
        }
      });
      socket.on('error', error => { clearTimeout(timer); if (!opened) reject(error); });
      socket.on('unexpected-response', (request, response) => {
        clearTimeout(timer);
        if ([401, 403].includes(response.statusCode ?? 0)) this.authenticationLost();
        request.destroy();
        socket.terminate();
        reject(new Error(`DSH handshake HTTP ${response.statusCode ?? 'unknown'}`));
      });
      socket.once('close', () => {
        clearTimeout(timer);
        if (!opened) reject(new Error('DSH 连接在打开前关闭'));
        if (this.ws !== socket) return;
        this.ws = null;
        if (!this.closing && !this.authRequired) this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.closing || this.authRequired) return;
    this.options.onState?.('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => this.scheduleReconnect());
    }, Math.min(this.options.maxReconnectDelayMs ?? 30_000, (this.options.reconnectDelayMs ?? 1000) * 2 ** Math.min(this.reconnectAttempt++, 10)));
    this.reconnectTimer.unref?.();
  }

  private authenticationLost(): void {
    if (this.authRequired) return;
    this.authRequired = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.options.onState?.('auth-required');
    this.ws?.terminate();
  }

  private sendOpen(id: string, stream: StreamSubscription): void {
    if (!this.isConnected) throw new Error('DSH 尚未连接');
    this.ws?.send(JSON.stringify({ type: 'open', streamId: id, endpoint: stream.endpoint, payload: { args: stream.args } }));
  }

  openStream(endpoint: string, args: Record<string, unknown>, handler: (frame: StreamFrame) => void): string {
    validateDshArgs(endpoint, args);
    if (!this.isConnected) throw new Error('先调用 connect()');
    const streamId = `s${++this.counter}`;
    const stream = { endpoint, args: structuredClone(args), handler };
    this.streams.set(streamId, stream);
    this.sendOpen(streamId, stream);
    return streamId;
  }

  updateStreamArgs(streamId: string, args: Record<string, unknown>): void {
    const stream = this.streams.get(streamId);
    if (stream !== undefined) stream.args = structuredClone(args);
  }

  closeStream(streamId: string): void {
    this.streams.delete(streamId);
    if (this.isConnected) this.ws?.send(JSON.stringify({ type: 'cancel', streamId }));
  }

  get frames(): readonly unknown[] { return this.allFrames; }

  async close(): Promise<void> {
    this.closing = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.streams.clear();
    const socket = this.ws;
    this.ws = null;
    if (socket !== null && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { socket.terminate(); resolve(); }, 1000);
        socket.once('close', () => { clearTimeout(timer); resolve(); });
        if (socket.readyState === WebSocket.CONNECTING) socket.terminate(); else socket.close();
      });
    }
    this.options.onState?.('closed');
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
