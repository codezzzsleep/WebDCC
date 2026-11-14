/** Native DSH preload/plugin. Uses the official header hook for attribution,
 * removes its private marker before fetch, and observes actual provider bytes.
 * It never changes model messages, tool declarations or permission decisions. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DiagnosticCapture, DiagnosticFileWriter, diagnosticSecretsFromHeaders, redactDiagnosticBytes, redactDiagnosticValue, sensitiveDiagnosticField } from '@webdcc/model-proxy';

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
const writer = new DiagnosticFileWriter({ maxFileBytes: limit('WDCC_TRACE_MAX_FILE_BYTES', 64 * 1024 * 1024), maxQueuedBytes: limit('WDCC_TRACE_MAX_QUEUED_BYTES', 32 * 1024 * 1024) });
const reportedFiles = new Set<string>();
let reportedOverflow = false;
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
async function captureRequest(request: Request): Promise<DiagnosticCapture> {
  const capture = new DiagnosticCapture(...captureLimits);
  const reader = request.clone().body?.getReader();
  if (reader === undefined) return capture;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      capture.push(Buffer.from(next.value), 0);
      if (capture.truncated) { void reader.cancel().catch(() => undefined); break; }
    }
  } catch { capture.truncated = true; capture.chunks.length = 0; }
  return capture;
}
const redact = redactDiagnosticBytes;
function safeUrl(value: string): string { const url = new URL(value); url.username = ''; url.password = ''; for (const key of [...url.searchParams.keys()]) if (/key|token|secret|password|signature/i.test(key)) url.searchParams.set(key, '<redacted>'); return url.href; }
function safeHeaders(headers: Headers, secrets: readonly string[] = []): Record<string, string> { return Object.fromEntries([...headers].map(([key, value]) => [key, sensitiveDiagnosticField.test(key) ? '<redacted>' : String(redactDiagnosticValue(value, secrets))])); }
function publish(file: string, row: unknown): void {
  const text = `${JSON.stringify(row)}\n`;
  void writer.write(file, text, 'append', () => {
    // A diagnostic is explicit; never fail the original model call because a
    // recording disk is unavailable. Incomplete started requests remain visible.
    if (reportedFiles.has(file)) return;
    if (reportedFiles.size >= 256) { if (!reportedOverflow) { reportedOverflow = true; process.stderr.write('webdcc: additional native recording failures omitted\n'); } return; }
    reportedFiles.add(file);
    process.stderr.write('webdcc: native model recording write failed\n');
    void writeFile(file.replace(/\.jsonl$/, '.coverage.json'), JSON.stringify({ incomplete: true, errors: ['Native diagnostic file could not be written'] }), { mode: 0o600 }).catch(() => undefined);
  });
}

if (directory !== undefined && !state[STATE]) {
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
    const body = captureRequest(request);
    const clean = new Request(request, { headers });
    const requestId = randomUUID(); const started = Date.now(); let seq = 0;
    const secrets = diagnosticSecretsFromHeaders(Object.fromEntries(request.headers));
    const context = nativeId === null ? Promise.resolve(undefined) : readFile(join(directory, `context-${encodeURIComponent(nativeId)}.json`), 'utf8').then(text => JSON.parse(text) as unknown).catch(() => undefined);
    const file = join(directory, `model-${encodeURIComponent(nativeId ?? 'unassigned')}.jsonl`);
    const pendingRequest = body.then(async capture => {
      const owner = await context;
      const bytes = capture.buffer();
      const safe = redact(bytes, secrets);
      publish(file, { version: 1, runId: logicalId ?? requestId, seq: ++seq, at: new Date(started).toISOString(), elapsedMs: 0, source: 'model-http', channel: 'request', direction: 'out', context: redactDiagnosticValue(owner, secrets), value: { requestId, nativeId, logicalId, purpose, method: request.method, url: safeUrl(request.url), headers: safeHeaders(headers, secrets), body: safe.toString('base64'), bytes: capture.bytes, coverage: { truncated: capture.truncated, digestScope: 'redacted' }, sha256: sha256(safe), digestScope: 'redacted' } });
    });
    const emit = (channel: string, value: unknown): void => { void pendingRequest.then(async () => publish(file, { version: 1, runId: logicalId ?? requestId, seq: ++seq, at: new Date().toISOString(), elapsedMs: Date.now() - started, source: 'model-http', channel, direction: 'in', context: redactDiagnosticValue(await context, secrets), value: { requestId, value } })); };
    try {
      const response = await original(clean);
      emit('headers', { status: response.status, headers: safeHeaders(response.headers, secrets) });
      if (response.body === null) { emit('complete', { outcome: 'completed', status: response.status }); return response; }
      const reader = response.body.getReader();
      let terminal = false;
      const capture = new DiagnosticCapture(...captureLimits);
      const finish = (outcome: string, error?: unknown): void => { if (!terminal) { terminal = true; void body.then(requestCapture => { const safe = redact(capture.buffer(), secrets); let offset = 0;
        const recordedChunks = capture.chunks.map(chunk => { const data = safe.subarray(offset, offset + chunk.bytes.length); offset += chunk.bytes.length; return { t: chunk.t, bytes: chunk.bytes.length, sha256: sha256(data), data: data.toString('base64') }; });
        emit('complete', { outcome, status: response.status, chunks: recordedChunks, coverage: { truncated: capture.truncated || requestCapture.truncated, requestBytes: requestCapture.bytes, responseBytes: capture.bytes, responseChunks: capture.count, digestScope: 'redacted' }, ...(error === undefined ? {} : { error: redactDiagnosticValue(error instanceof Error ? error.message : String(error), secrets) }) }); }); } };
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) { finish('completed'); controller.close(); return; }
            const bytes = Buffer.from(next.value);
            capture.push(bytes, Date.now() - started);
            emit('chunk', { bytes: bytes.length, capture: capture.truncated ? 'omitted' : 'pending-redaction' });
            controller.enqueue(next.value);
          } catch (error) { finish('failed', error); controller.error(error); }
        },
        async cancel(reason) { finish('cancelled', reason); await reader.cancel(reason); },
      });
      const observed = new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
      Object.defineProperties(observed, { url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type } });
      return observed;
    } catch (error) { emit('complete', { outcome: 'failed', error: redactDiagnosticValue(error instanceof Error ? error.message : String(error), secrets) }); throw error; }
  };
}
