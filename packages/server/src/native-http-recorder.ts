/** Native DSH preload/plugin. Uses the official header hook for attribution,
 * removes its private marker before fetch, and observes actual provider bytes.
 * It never changes model messages, tool declarations or permission decisions. */
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DiagnosticCapture, DiagnosticFileWriter, configureDiagnosticCaptureBudget, diagnosticSecretsFromHeaders, redactDiagnosticBytes, redactDiagnosticValue, sensitiveDiagnosticField } from '@webdcc/model-proxy';
import { readNativeDiagnosticContext, type NativeDiagnosticContext } from './native-diagnostic-context.js';

export const name = 'webdcc-native-http-recorder';
const MARKER = 'x-webdcc-native-session';
const LOGICAL = 'x-webdcc-native-request';
const PURPOSE = 'x-webdcc-native-purpose';
interface HeaderContext { sessionId?: string; purpose?: string; }
interface PluginContext { on: (name: string, callback: (request: HeaderContext, headers: Headers, next: () => Headers) => Headers) => unknown; }
export function apply(ctx: PluginContext): void {
  ctx.on('llm-pi-ai/request-headers', (request, _headers, next) => {
    const headers = next();
    if (request.sessionId !== undefined) headers.set(MARKER, request.sessionId);
    headers.set(LOGICAL, randomUUID());
    if (request.purpose !== undefined) headers.set(PURPOSE, request.purpose);
    return headers;
  });
}
const STATE = Symbol.for('webdcc.native.http.recorder');
const state = globalThis as unknown as Record<symbol, boolean>;
const directory = process.env['WDCC_TRACE_DIR'];
const limit = (name: string, fallback: number, minimum = 0): number => { if (process.env[name]?.trim() === '' || process.env[name] === undefined) return fallback; const value = Number(process.env[name]); return Number.isSafeInteger(value) && value >= minimum ? value : fallback; };
const captureLimits = [limit('WDCC_TRACE_MAX_CAPTURE_BYTES', 8 * 1024 * 1024), limit('WDCC_TRACE_MAX_CAPTURE_CHUNKS', 4096, 1)] as const;
const writer = new DiagnosticFileWriter({ maxFileBytes: limit('WDCC_TRACE_MAX_FILE_BYTES', 64 * 1024 * 1024), maxQueuedBytes: limit('WDCC_TRACE_MAX_QUEUED_BYTES', 32 * 1024 * 1024), maxActiveQueuedBytes: directory === undefined ? undefined : limit('WDCC_TRACE_MAX_ACTIVE_QUEUED_BYTES', 64 * 1024 * 1024), maxDirectoryBytes: limit('WDCC_TRACE_MAX_DIRECTORY_BYTES', 512 * 1024 * 1024) });
const reportedFiles = new Set<string>();
let reportedOverflow = false;
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function captureRequest(request: Request): { capture: DiagnosticCapture; done: Promise<void>; stop: () => void } {
  const capture = new DiagnosticCapture(...captureLimits);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let ended = false;
  let resolve!: () => void;
  const done = new Promise<void>(ready => { resolve = ready; });
  const complete = (): void => { ended = true; resolve(); };
  const cancel = (): void => { void reader?.cancel().catch(() => undefined); };
  void (async () => {
    try {
      reader = request.clone().body?.getReader();
      if (reader === undefined) return;
      for (;;) {
        const next = await reader.read();
        if (ended || next.done) break;
        // Capture reserves storage before copying the native reader's bytes.
        capture.push(Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength), 0);
        if (capture.truncated) { cancel(); break; }
      }
    } catch { capture.discard('capture-failed'); }
    finally { complete(); }
  })();
  return { capture, done, stop: () => {
    if (ended) return;
    capture.discard('capture-failed'); complete(); cancel();
  } };
}

const redact = redactDiagnosticBytes;
function safeUrl(value: string): string { const url = new URL(value); url.username = ''; url.password = ''; for (const key of [...url.searchParams.keys()]) if (/key|token|secret|password|signature/i.test(key)) url.searchParams.set(key, '<redacted>'); return url.href; }
function safeHeaders(headers: Headers, secrets: readonly string[] = []): Record<string, string> { return Object.fromEntries([...headers].map(([key, value]) => [key, sensitiveDiagnosticField.test(key) ? '<redacted>' : String(redactDiagnosticValue(value, secrets))])); }
function publish(file: string, row: unknown): void {
  const text = `${JSON.stringify(row)}\n`;
  void writer.write(file, text, 'append', () => {
    recordingFailure(file);
  });
}

function recordingFailure(file: string): void {
  // A diagnostic is explicit; never fail the original model call because a
  // recording disk is unavailable. Incomplete started requests remain visible.
  if (reportedFiles.has(file)) return;
  if (reportedFiles.size >= 256) { if (!reportedOverflow) { reportedOverflow = true; process.stderr.write('webdcc: additional native recording failures omitted\n'); } return; }
  reportedFiles.add(file);
  process.stderr.write('webdcc: native model recording write failed\n');
  void writer.writeCoverage(file.replace(/\.jsonl$/, '.coverage.json'), JSON.stringify({ incomplete: true, errors: ['Native diagnostic file could not be written'] }));
}

if (directory !== undefined && !state[STATE]) {
  configureDiagnosticCaptureBudget(limit('WDCC_TRACE_MAX_ACTIVE_CAPTURE_BYTES', 64 * 1024 * 1024));
  state[STATE] = true;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const nativeId = request.headers.get(MARKER) ?? request.headers.get('x-session-id') ?? request.headers.get('session_id');
    const logicalId = request.headers.get(LOGICAL);
    const purpose = request.headers.get(PURPOSE);
    const modelRequest = logicalId !== null || /\/(responses|messages|chat\/completions|completions)(?:\/|$)/.test(new URL(request.url).pathname);
    if (!modelRequest) return original(input, init);
    const headers = new Headers(request.headers); headers.delete(MARKER); headers.delete(LOGICAL); headers.delete(PURPOSE);
    const observation = captureRequest(request);
    const requestCapture = observation.capture;
    const clean = new Request(request, { headers });
    const requestId = randomUUID(); const started = Date.now(); let seq = 0;
    const secrets = diagnosticSecretsFromHeaders(Object.fromEntries(request.headers));
    const context: Promise<NativeDiagnosticContext> = nativeId === null ? Promise.resolve({}) : readNativeDiagnosticContext(join(directory, `context-${encodeURIComponent(nativeId)}.json`));
    const file = join(directory, `model-${encodeURIComponent(nativeId ?? 'unassigned')}.jsonl`);
    const pendingRequest = observation.done.then(async () => {
      let value: unknown;
      try {
        const safe = redact(requestCapture.buffer(), secrets);
        value = { requestId, nativeId, logicalId, purpose, method: request.method, url: safeUrl(request.url), headers: safeHeaders(headers, secrets), body: safe.toString('base64'), bytes: requestCapture.bytes, coverage: { truncated: requestCapture.truncated, digestScope: 'redacted', ...(requestCapture.limitReason === undefined ? {} : { limitReason: requestCapture.limitReason }) }, sha256: sha256(safe), digestScope: 'redacted' };
      } finally { requestCapture.release(); }
      // Context I/O and diagnostic persistence never retain raw body chunks.
      const owner = await context;
      publish(file, { version: 1, runId: logicalId ?? requestId, seq: ++seq, at: new Date(started).toISOString(), elapsedMs: 0, source: 'model-http', channel: 'request', direction: 'out', context: redactDiagnosticValue(owner.value, secrets), ...(owner.error === undefined ? {} : { contextError: owner.error }), value });
    }).catch(() => { requestCapture.discard('capture-failed'); requestCapture.release(); recordingFailure(file); });
    const emit = (channel: string, value: unknown): void => { void pendingRequest.then(async () => {
      const owner = await context;
      publish(file, { version: 1, runId: logicalId ?? requestId, seq: ++seq, at: new Date().toISOString(), elapsedMs: Date.now() - started, source: 'model-http', channel, direction: 'in', context: redactDiagnosticValue(owner.value, secrets), ...(owner.error === undefined ? {} : { contextError: owner.error }), value: { requestId, value } });
    }).catch(() => recordingFailure(file)); };
    let terminal = false;
    let omittedChunkEvents = 0;
    let capture: DiagnosticCapture | undefined;
    const abortObserver = (): void => finish('cancelled', undefined, request.signal.reason);
    const finish = (outcome: string, status?: number, error?: unknown): void => {
      if (terminal) return;
      terminal = true;
      request.signal.removeEventListener('abort', abortObserver);
      observation.stop();
      try {
        const safe = redact(capture?.buffer() ?? Buffer.alloc(0), secrets);
        let offset = 0;
        const recordedChunks = (capture?.chunks ?? []).map(chunk => {
          const data = safe.subarray(offset, offset + chunk.bytes.length); offset += chunk.bytes.length;
          return { t: chunk.t, bytes: chunk.bytes.length, sha256: sha256(data), data: data.toString('base64') };
        });
        emit('complete', { outcome, status, chunks: recordedChunks, coverage: {
          truncated: (capture?.truncated ?? false) || requestCapture.truncated,
          requestBytes: requestCapture.bytes, responseBytes: capture?.bytes ?? 0, responseChunks: capture?.count ?? 0, digestScope: 'redacted',
          omittedChunkEvents,
          ...(requestCapture.limitReason === undefined ? {} : { requestLimitReason: requestCapture.limitReason }),
          ...(capture?.limitReason === undefined ? {} : { responseLimitReason: capture.limitReason }),
        }, ...(error === undefined ? {} : { error: redactDiagnosticValue(error instanceof Error ? error.message : String(error), secrets) }) });
      } catch { recordingFailure(file); }
      finally { capture?.release(); }
    };
    request.signal.addEventListener('abort', abortObserver, { once: true });
    if (request.signal.aborted) abortObserver();
    try {
      const response = await original(clean);
      emit('headers', { status: response.status, headers: safeHeaders(response.headers, secrets) });
      if (response.body === null) { finish('completed', response.status); return response; }
      const reader = response.body.getReader();
      capture = new DiagnosticCapture(...captureLimits);
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) { finish('completed', response.status); controller.close(); return; }
            const bytes = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
            if (!terminal) {
              capture!.push(bytes, Date.now() - started);
              // emit waits for request/context I/O. Bound those queued jobs as
              // well as raw chunks, without buffering or pausing native bytes.
              if (capture!.count <= captureLimits[1]) emit('chunk', { bytes: bytes.length, capture: capture!.truncated ? 'omitted' : 'pending-redaction' });
              else omittedChunkEvents++;
            }
            controller.enqueue(next.value);
          } catch (error) { finish('failed', response.status, error); controller.error(error); }
        },
        async cancel(reason) { finish('cancelled', response.status, reason); await reader.cancel(reason); },
      });
      const observed = new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
      Object.defineProperties(observed, { url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type } });
      return observed;
    } catch (error) { finish('failed', undefined, error); throw error; }
  };
}
