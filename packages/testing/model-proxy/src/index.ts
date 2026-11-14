import { createServer, request as requestHttp, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as requestHttps } from 'node:https';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DiagnosticCapture, diagnosticSecretsFromHeaders, redactDiagnosticBytes, sensitiveDiagnosticField } from './redaction.js';
export { DiagnosticCapture, diagnosticSecretsFromHeaders, redactDiagnosticBytes, redactDiagnosticValue, sensitiveDiagnosticField } from './redaction.js';
import { DiagnosticFileWriter } from './diagnostic-writer.js';
export { DiagnosticFileWriter, type DiagnosticWriteLimits } from './diagnostic-writer.js';

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
  coverage?: { truncated: boolean; requestBytes: number; responseBytes: number; responseChunks: number; digestScope: 'redacted' };
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
  maxCaptureBytes?: number;
  maxCaptureChunks?: number;
  maxRecordFileBytes?: number;
  maxPendingRecordBytes?: number;
}

function safeHeaders(headers: IncomingHttpHeaders, secrets: readonly string[] = []): IncomingHttpHeaders {
  const redact = (value: string): string => redactDiagnosticBytes(Buffer.from(value), secrets).toString();
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, sensitiveDiagnosticField.test(key) ? '<redacted>' : Array.isArray(value) ? value.map(redact) : value === undefined ? undefined : redact(value)]));
}
function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
const safeBytes = redactDiagnosticBytes;
function safePath(path: string): string {
  const url = new URL(path, 'http://record.invalid');
  for (const key of [...url.searchParams.keys()]) if (/key|token|secret|password/i.test(key)) url.searchParams.set(key, '<redacted>');
  return `${url.pathname}${url.search}`;
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
  private readonly writer: DiagnosticFileWriter;
  private pendingBytes = 0;
  constructor(private readonly options: ModelProxyOptions) {
    this.target = new URL(options.target);
    new DiagnosticCapture(options.maxCaptureBytes, options.maxCaptureChunks);
    this.writer = new DiagnosticFileWriter({ maxFileBytes: options.maxRecordFileBytes, maxQueuedBytes: options.maxPendingRecordBytes });
  }

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
    try { this.options.onEvent?.(event); } catch (error) { this.recordingError(error); }
  }
  private recordingError(error: unknown): void { if (this.recordingErrors.length < 16) this.recordingErrors.push(error instanceof Error ? error : new Error(String(error))); }
  private persist(record: ModelProxyRecord): void {
    if (this.options.recordFile === undefined && this.options.onRecord === undefined) return;
    const text = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(text);
    if (this.pendingBytes + bytes > (this.options.maxPendingRecordBytes ?? 32 * 1024 * 1024)) { this.recordingError(new Error('Diagnostic record queue limit reached')); return; }
    this.pendingBytes += bytes;
    const work = (async () => {
      if (this.options.recordFile !== undefined) {
        await this.writer.write(this.options.recordFile, text, 'append', error => this.recordingError(error));
      }
      await this.options.onRecord?.(record);
    })().catch((error: unknown) => { this.recordingError(error); }).finally(() => { this.pendingBytes -= bytes; });
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const begun = Date.now();
    const requestIndex = ++this.seq;
    const elapsed = (): number => Date.now() - begun;
    const requestCapture = new DiagnosticCapture(this.options.maxCaptureBytes, this.options.maxCaptureChunks);
    let requestEnded = false;
    let responseStatus: number | null = null;
    let responseHeaders: IncomingHttpHeaders = {};
    const capture = new DiagnosticCapture(this.options.maxCaptureBytes, this.options.maxCaptureChunks);
    let settled = false;
    let upstreamRequest: ClientRequest | undefined;
    let abort = (): void => undefined;
    const secrets = [...(this.options.secrets ?? []), ...diagnosticSecretsFromHeaders(req.headers), this.target.password, decodeURIComponent(this.target.password)].filter(Boolean);
    const finish = (outcome: 'completed' | 'failed' | 'cancelled', error?: Error): void => {
      if (settled) return;
      settled = true;
      this.abortRequests.delete(abort);
      const raw = capture.buffer();
      const safe = safeBytes(raw, secrets);
      let offset = 0;
      const recordedChunks = capture.chunks.map(chunk => {
        const data = safe.subarray(offset, offset + chunk.bytes.length); offset += chunk.bytes.length;
        return { t: chunk.t, data: data.toString('base64'), bytes: chunk.bytes.length, sha256: hash(data) };
      });
      const record: ModelProxyRecord = {
        i: requestIndex, t: begun - this.started, requestId, durationMs: elapsed(), outcome,
        ...(error === undefined ? {} : { error: { name: error.name, message: safeBytes(Buffer.from(error.message), secrets).toString(), ...('code' in error ? { code: String(error.code) } : {}) } }),
        request: { method: req.method ?? 'GET', path: safeBytes(Buffer.from(safePath(req.url ?? '/')), secrets).toString(), headers: safeHeaders(req.headers, secrets), body: safeBytes(requestCapture.buffer(), secrets).toString('base64'), sha256: hash(safeBytes(requestCapture.buffer(), secrets)) },
        response: { status: responseStatus ?? 502, upstreamStatus: responseStatus, headers: safeHeaders(responseHeaders, secrets), chunks: recordedChunks },
        coverage: { truncated: capture.truncated || requestCapture.truncated || !requestEnded, requestBytes: requestCapture.bytes, responseBytes: capture.bytes, responseChunks: capture.count, digestScope: 'redacted' },
      };
      this.observe({ requestId, t: elapsed(), phase: 'complete', value: record });
      this.persist(record);
    };
    abort = () => { finish('cancelled', new Error('Recording route closed')); upstreamRequest?.destroy(); res.destroy(); };
    this.abortRequests.add(abort);
    try {
      this.observe({ requestId, t: elapsed(), phase: 'request', value: { method: req.method, path: safeBytes(Buffer.from(safePath(req.url ?? '/')), secrets).toString(), headers: safeHeaders(req.headers, secrets), capture: 'pending-redaction' } });
      const url = new URL(req.url ?? '/', this.target.origin);
      url.username = this.target.username; url.password = this.target.password;
      const transport = url.protocol === 'https:' ? requestHttps : requestHttp;
      const upstream = transport(url, { method: req.method, headers: { ...req.headers, host: this.target.host } }, response => {
        responseStatus = response.statusCode ?? 502;
        responseHeaders = response.headers;
        this.observe({ requestId, t: elapsed(), phase: 'headers', value: { status: responseStatus, headers: safeHeaders(response.headers, secrets) } });
        for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) res.setHeader(key, value);
        res.writeHead(responseStatus);
        res.flushHeaders();
        response.on('data', (value: Buffer | string) => {
          const bytes = Buffer.from(value); const t = elapsed();
          capture.push(bytes, t);
          this.observe({ requestId, t, phase: 'chunk', value: { bytes: bytes.length, capture: capture.truncated ? 'omitted' : 'pending-redaction' } });
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
      // Preserve request streaming and backpressure. Capture is a bounded
      // side channel, never the buffer from which native input is forwarded.
      req.on('data', (value: Buffer) => requestCapture.push(value, elapsed()));
      req.once('end', () => { requestEnded = true; });
      req.once('error', error => { finish('failed', error); upstream.destroy(error); });
      req.pipe(upstream);
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
