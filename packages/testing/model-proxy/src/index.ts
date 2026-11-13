import { createServer, request as requestHttp, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as requestHttps } from 'node:https';
import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export interface ModelProxyChunk { t: number; data: string; bytes?: number; sha256?: string; }
export interface ModelProxyRecord {
  i: number;
  t: number;
  requestId?: string;
  durationMs?: number;
  outcome?: 'completed' | 'failed' | 'cancelled';
  error?: { name: string; message: string; code?: string };
  request: { method: string; path: string; headers: IncomingHttpHeaders; body: string; sha256?: string };
  response: { status: number; headers: Record<string, string | string[] | undefined>; chunks: ModelProxyChunk[]; upstreamStatus?: number | null };
}
export interface ModelProxyEvent { requestId: string; t: number; phase: 'request' | 'headers' | 'chunk' | 'complete'; value: unknown; }
export interface ModelProxyOptions {
  target: string;
  host?: string;
  port?: number;
  recordFile?: string;
  /** Retained for source compatibility; forwarding always preserves real time. */
  speed?: number;
  secrets?: string[];
  onEvent?: (event: ModelProxyEvent) => void;
  onRecord?: (record: ModelProxyRecord) => void | Promise<void>;
}

const sensitiveHeader = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i;
function safeHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, sensitiveHeader.test(key) ? '<redacted>' : value]));
}
function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function safeBytes(bytes: Buffer, secrets: readonly string[]): Buffer {
  const result = Buffer.from(bytes);
  const candidates = new Set([...secrets.filter(Boolean), ...bytes.toString('latin1').matchAll(/\bsk-[A-Za-z0-9_-]{8,}\b/g)].map(value => typeof value === 'string' ? value : value[0]));
  for (const secret of candidates) {
    const needle = Buffer.from(secret);
    for (let at = result.indexOf(needle); at >= 0; at = result.indexOf(needle, at + needle.length)) result.fill(42, at, at + needle.length);
  }
  return result;
}
function safePath(path: string): string {
  const url = new URL(path, 'http://record.invalid');
  for (const key of [...url.searchParams.keys()]) if (/key|token|secret|password/i.test(key)) url.searchParams.set(key, '<redacted>');
  return `${url.pathname}${url.search}`;
}
async function bodyOf(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** A forwarding observer: headers and bytes reach the client as they arrive.
 * Completion records also cover partial streams, cancellation and no-response errors. */
export class ModelProxy {
  private server: Server | null = null;
  private readonly target: URL;
  private seq = 0;
  private readonly started = Date.now();
  private readonly pending = new Set<Promise<void>>();
  private readonly recordingErrors: Error[] = [];
  private readonly abortRequests = new Set<() => void>();
  constructor(private readonly options: ModelProxyOptions) { this.target = new URL(options.target); }

  async listen(): Promise<{ host: string; port: number; url: string }> {
    if (this.server !== null) throw new Error('model proxy already listening');
    if (this.options.recordFile !== undefined) await mkdir(dirname(this.options.recordFile), { recursive: true, mode: 0o700 });
    const host = this.options.host ?? '127.0.0.1';
    this.server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((resolve, reject) => { this.server?.once('error', reject); this.server?.listen(this.options.port ?? 0, host, resolve); });
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('proxy address unavailable');
    // Keep the provider base path. Replacing /v1 with a bare local origin would
    // silently send Codex /responses to the wrong upstream endpoint.
    const path = this.target.pathname.replace(/\/$/, '');
    return { host, port: address.port, url: `http://${host}:${address.port}${path}` };
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
    if (this.recordingErrors.length > 0) throw new AggregateError(this.recordingErrors, 'Model recording is incomplete');
  }
  async close(): Promise<void> {
    for (const abort of [...this.abortRequests]) abort();
    const server = this.server; this.server = null;
    if (server !== null) {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
    await this.flush();
  }
  private observe(event: ModelProxyEvent): void {
    try { this.options.onEvent?.(event); } catch (error) { this.recordingErrors.push(error instanceof Error ? error : new Error(String(error))); }
  }
  private persist(record: ModelProxyRecord): void {
    const work = (async () => {
      if (this.options.recordFile !== undefined) {
        await appendFile(this.options.recordFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        await chmod(this.options.recordFile, 0o600);
      }
      await this.options.onRecord?.(record);
    })().catch((error: unknown) => { this.recordingErrors.push(error instanceof Error ? error : new Error(String(error))); });
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const begun = Date.now();
    const requestIndex = ++this.seq;
    const elapsed = (): number => Date.now() - begun;
    let body: Buffer = Buffer.alloc(0);
    let responseStatus: number | null = null;
    let responseHeaders: IncomingHttpHeaders = {};
    const chunks: { t: number; bytes: Buffer }[] = [];
    let settled = false;
    let upstreamRequest: ClientRequest | undefined;
    let abort = (): void => undefined;
    const secrets = [...(this.options.secrets ?? [])];
    for (const [key, value] of Object.entries(req.headers)) if (sensitiveHeader.test(key) && typeof value === 'string') {
      secrets.push(value, value.replace(/^Bearer\s+/i, ''));
    }
    const finish = (outcome: 'completed' | 'failed' | 'cancelled', error?: Error): void => {
      if (settled) return;
      settled = true;
      this.abortRequests.delete(abort);
      const raw = Buffer.concat(chunks.map(chunk => chunk.bytes));
      const safe = safeBytes(raw, secrets);
      let offset = 0;
      const recordedChunks = chunks.map(chunk => {
        const data = safe.subarray(offset, offset + chunk.bytes.length); offset += chunk.bytes.length;
        return { t: chunk.t, data: data.toString('base64'), bytes: chunk.bytes.length, sha256: hash(chunk.bytes) };
      });
      const record: ModelProxyRecord = {
        i: requestIndex, t: begun - this.started, requestId, durationMs: elapsed(), outcome,
        ...(error === undefined ? {} : { error: { name: error.name, message: safeBytes(Buffer.from(error.message), secrets).toString(), ...('code' in error ? { code: String(error.code) } : {}) } }),
        request: { method: req.method ?? 'GET', path: safePath(req.url ?? '/'), headers: safeHeaders(req.headers), body: safeBytes(body, secrets).toString('base64'), sha256: hash(body) },
        response: { status: responseStatus ?? 502, upstreamStatus: responseStatus, headers: safeHeaders(responseHeaders), chunks: recordedChunks },
      };
      this.observe({ requestId, t: elapsed(), phase: 'complete', value: record });
      this.persist(record);
    };
    abort = () => { finish('cancelled', new Error('Recording route closed')); upstreamRequest?.destroy(); res.destroy(); };
    this.abortRequests.add(abort);
    try {
      body = await bodyOf(req);
      if (settled) return;
      this.observe({ requestId, t: elapsed(), phase: 'request', value: { method: req.method, path: safePath(req.url ?? '/'), headers: safeHeaders(req.headers), body: safeBytes(body, secrets).toString('base64'), sha256: hash(body) } });
      const url = new URL(req.url ?? '/', this.target.origin);
      url.username = this.target.username; url.password = this.target.password;
      const transport = url.protocol === 'https:' ? requestHttps : requestHttp;
      const upstream = transport(url, { method: req.method, headers: { ...req.headers, host: this.target.host, 'content-length': body.length } }, response => {
        responseStatus = response.statusCode ?? 502;
        responseHeaders = response.headers;
        this.observe({ requestId, t: elapsed(), phase: 'headers', value: { status: responseStatus, headers: safeHeaders(response.headers) } });
        for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) res.setHeader(key, value);
        res.writeHead(responseStatus);
        res.flushHeaders();
        response.on('data', (value: Buffer | string) => {
          const bytes = Buffer.from(value); const t = elapsed();
          chunks.push({ t, bytes });
          this.observe({ requestId, t, phase: 'chunk', value: { bytes: bytes.length, sha256: hash(bytes) } });
          if (!res.write(bytes)) { response.pause(); res.once('drain', () => response.resume()); }
        });
        response.once('end', () => { finish('completed'); res.end(); });
        response.once('error', error => { finish('failed', error); res.destroy(error); });
        response.once('aborted', () => { finish('failed', new Error('Upstream response aborted')); res.destroy(); });
      });
      upstreamRequest = upstream;
      upstream.once('error', error => {
        finish(res.destroyed ? 'cancelled' : 'failed', error);
        if (!res.destroyed) {
          if (res.headersSent) res.destroy(error);
          else { res.statusCode = 502; res.end('Upstream connection failed'); }
        }
      });
      res.once('close', () => { if (!res.writableFinished) { finish('cancelled', new Error('Downstream cancelled')); upstream.destroy(); } });
      upstream.end(body);
    } catch (error) {
      const problem = error instanceof Error ? error : new Error(String(error));
      finish(req.aborted ? 'cancelled' : 'failed', problem);
      if (!res.destroyed) { res.statusCode = 502; res.end('Upstream connection failed'); }
    }
  }
}

export async function startModelProxy(options: ModelProxyOptions): Promise<ModelProxy & { address: { host: string; port: number; url: string } }> {
  const proxy = new ModelProxy(options) as ModelProxy & { address: { host: string; port: number; url: string } };
  proxy.address = await proxy.listen();
  return proxy;
}
