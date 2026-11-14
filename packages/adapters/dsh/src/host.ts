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

/** Persistable credentials for current Host attach. Each cookie is returned
 * by its native exchange; the launch token is never retained or derived. */
export async function attachToDshCredentials(endpoint: string | number, token: string): Promise<{ cookie: string; browserCookie: string }> {
  const { attachDshBrowser } = await import('./identity.js');
  const browserCookie = await attachDshBrowser(endpoint, token);
  const cookie = await attachToDsh(endpoint, token);
  if (!/^dsh-auth-[^=]+=v2\./.test(cookie)) throw Object.assign(new Error('DSH operator authentication did not return a native v2 credential'), { statusCode: 401 });
  return { cookie, browserCookie };
}

export interface DshHostOptions {
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  connectTimeoutMs?: number;
  rpcTimeoutMs?: number;
  maxFrames?: number;
  /** Capture is bounded independently of the native HTTP response handling. */
  maxRpcCaptureBytes?: number;
  onRpcFrame?: DshRpcFrameObserver;
  /** Explicit synchronous persistence admission, separate from observation. */
  admitRpc?: DshRpcAdmission;
  onState?: (state: 'online' | 'reconnecting' | 'auth-required' | 'closed') => void;
}

export type DshRpcJson = null | boolean | number | string | readonly DshRpcJson[] | { readonly [key: string]: DshRpcJson };
export type DshRpcCaptureCoverage = 'complete' | 'oversize' | 'invalid-json' | 'transport-error' | 'http-auth-rejected';
/** A detached, deeply frozen JSON observation. Headers, credentials, invalid
 * bytes and hashes of omitted content are never part of this interface. */
export interface DshRpcObservation {
  readonly dir: 'in' | 'out';
  readonly endpoint: string;
  /** The actual transport request id, including on malformed responses. */
  readonly rpcId: string;
  readonly httpStatus?: number;
  readonly capture: Readonly<{ coverage: DshRpcCaptureCoverage; maxBytes: number; jsonBytes?: number }>;
  /** Complete native JSON or a safe capture marker, never the business value alone. */
  readonly frame: DshRpcJson;
}
export type DshRpcFrameObserver = (observation: DshRpcObservation) => void | Promise<void>;
export type DshRpcAdmission = (request: DshRpcObservation) => boolean;

function freezeRpcJson(value: DshRpcJson): DshRpcJson {
  const pending: DshRpcJson[] = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) pending.push(child);
      Object.freeze(item);
    }
  }
  return value;
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

  private rpcObservation(dir: 'in' | 'out', endpoint: string, rpcId: string,
    payload: { json: unknown } | { serialized: string } | { coverage: Exclude<DshRpcCaptureCoverage, 'complete' | 'oversize'> }, httpStatus?: number): DshRpcObservation {
    const configured = this.options.maxRpcCaptureBytes ?? 1024 * 1024;
    const maxBytes = Number.isSafeInteger(configured) ? Math.max(0, Math.min(configured, 4 * 1024 * 1024)) : 1024 * 1024;
    let coverage: DshRpcCaptureCoverage;
    let jsonBytes: number | undefined;
    let frame: DshRpcJson;
    if ('coverage' in payload) coverage = payload.coverage;
    else {
      try {
        const serialized = 'serialized' in payload ? payload.serialized : JSON.stringify(payload.json);
        jsonBytes = Buffer.byteLength(serialized);
        coverage = jsonBytes > maxBytes ? 'oversize' : 'complete';
        if (coverage === 'complete') frame = freezeRpcJson(JSON.parse(serialized) as DshRpcJson);
      } catch { coverage = 'oversize'; }
    }
    if (coverage !== 'complete') frame = Object.freeze({ type: 'dsh-rpc-capture', rpcId, method: endpoint, coverage });
    return Object.freeze({ dir, endpoint, rpcId, ...(httpStatus === undefined ? {} : { httpStatus }),
      capture: Object.freeze({ coverage, maxBytes, ...(jsonBytes === undefined ? {} : { jsonBytes }) }), frame: frame! });
  }

  private observeRpc(observation: DshRpcObservation, observer?: DshRpcFrameObserver): void {
    for (const sink of [this.options.onRpcFrame, observer]) {
      if (sink === undefined) continue;
      try { const pending = sink(observation); if (pending !== undefined) void pending.catch(() => undefined); }
      catch { /* Capture observers do not change dispatch, retries or HTTP errors. */ }
    }
  }

  async rpc<T = unknown>(endpoint: string, args: Record<string, unknown> = {}, observer?: DshRpcFrameObserver, admitRpc?: DshRpcAdmission): Promise<T> {
    if (!/^(?:[\w-]+\/[\w-]+|\$events\/result)$/.test(endpoint)) throw new Error('Invalid DSH RPC endpoint');
    validateDshArgs(endpoint, args);
    const rpcId = randomUUID();
    const body = JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } });
    const capture = observer !== undefined || this.options.onRpcFrame !== undefined || admitRpc !== undefined || this.options.admitRpc !== undefined;
    if (capture) {
      const request = this.rpcObservation('out', endpoint, rpcId, { serialized: body });
      this.observeRpc(request, observer);
      for (const admit of [this.options.admitRpc, admitRpc]) {
        if (admit === undefined) continue;
        let accepted = false;
        try { accepted = admit(request); } catch { /* Failure precedes the HTTP dispatch. */ }
        if (!accepted) throw Object.assign(new Error('DSH native RPC request was not durably admitted; no HTTP request was dispatched'), { code: 'uncertain' });
      }
    }
    let response: Response;
    try { response = await fetch(`${this.base}api/${endpoint}`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(this.options.rpcTimeoutMs ?? 30_000),
      headers: { 'content-type': 'application/json', cookie: this.cookie },
      body,
    }); } catch (error) {
      if (capture) this.observeRpc(this.rpcObservation('in', endpoint, rpcId, { coverage: 'transport-error' }), observer);
      throw error;
    }
    if ([401, 403].includes(response.status)) {
      if (capture) this.observeRpc(this.rpcObservation('in', endpoint, rpcId, { coverage: 'http-auth-rejected' }, response.status), observer);
      this.authenticationLost();
      throw Object.assign(new Error('DSH 认证已失效，请重新连接目标 Host'), { code: 'dsh-needs-link', statusCode: 401 });
    }
    let value: unknown;
    try { value = await response.json(); } catch {
      if (capture) this.observeRpc(this.rpcObservation('in', endpoint, rpcId, { coverage: 'invalid-json' }, response.status), observer);
      throw new Error(`${endpoint} 返回非 JSON（HTTP ${response.status}）`);
    }
    if (capture) this.observeRpc(this.rpcObservation('in', endpoint, rpcId, { json: value }, response.status), observer);
    const envelope = value as { type?: string; rpcId?: string; result?: { ok?: boolean; value?: unknown; error?: RpcError } } | null;
    if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId || envelope.result === undefined || envelope.result === null || typeof envelope.result.ok !== 'boolean') throw new Error(`${endpoint} 响应身份或信封不匹配`);
    if (!response.ok && envelope.result.ok) throw new Error(`${endpoint} HTTP ${response.status} 未成功`);
    if (envelope.result.ok !== true) throw new DshRpcError(envelope.result.error ?? { code: 'unknown', message: 'Native request failed' });
    validateDshResult(endpoint, envelope.result.value);
    return envelope.result.value as T;
  }

  /** Read one authoritative opening from a native snapshot stream, then
   * release only this subscription. Never mistake a streaming RPC for unary. */
  async snapshot<T = unknown>(endpoint: string, args: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
    await this.connect();
    return new Promise<T>((resolve, reject) => {
      const streamId = this.openStream(endpoint, args, frame => {
        if (!['item', 'error', 'end'].includes(frame.type)) return;
        clearTimeout(timer);
        this.closeStream(streamId);
        if (frame.type !== 'item') { reject(new Error(`DSH ${endpoint} snapshot ended before its baseline`)); return; }
        try { validateDshResult(endpoint, frame.value); resolve(frame.value as T); } catch (error) { reject(error); }
      });
      const timer = setTimeout(() => { this.closeStream(streamId); reject(new Error(`DSH ${endpoint} snapshot timed out`)); }, timeoutMs);
    });
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
