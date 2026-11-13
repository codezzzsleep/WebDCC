/** Native DSH preload/plugin. Uses the official header hook for attribution,
 * removes its private marker before fetch, and observes actual provider bytes.
 * It never changes model messages, tool declarations or permission decisions. */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

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
const queues = new Map<string, Promise<void>>();
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function redact(bytes: Buffer, secrets: string[]): Buffer {
  const result = Buffer.from(bytes);
  const candidates = new Set([...secrets.filter(Boolean), ...[...bytes.toString('latin1').matchAll(/\bsk-[A-Za-z0-9_-]{8,}\b/g)].map(match => match[0])]);
  for (const secret of candidates) {
    const needle = Buffer.from(secret);
    for (let at = result.indexOf(needle); at >= 0; at = result.indexOf(needle, at + needle.length)) result.fill(42, at, at + needle.length);
  }
  return result;
}
function safeUrl(value: string): string { const url = new URL(value); for (const key of [...url.searchParams.keys()]) if (/key|token|secret|password/i.test(key)) url.searchParams.set(key, '<redacted>'); return url.href; }
function safeHeaders(headers: Headers): Record<string, string> { return Object.fromEntries([...headers].map(([key, value]) => [key, /authorization|cookie|api.?key/i.test(key) ? '<redacted>' : value])); }
function publish(file: string, row: unknown): void {
  const text = `${JSON.stringify(row)}\n`;
  const work = (queues.get(file) ?? Promise.resolve()).then(async () => { await mkdir(directory as string, { recursive: true, mode: 0o700 }); await appendFile(file, text, { mode: 0o600 }); }).catch(() => {
    // A diagnostic is explicit; never fail the original model call because a
    // recording disk is unavailable. Incomplete started requests remain visible.
    process.stderr.write('webdcc: native model recording write failed\n');
  });
  queues.set(file, work); void work.finally(() => { if (queues.get(file) === work) queues.delete(file); });
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
    const body = request.clone().arrayBuffer().then(value => Buffer.from(value)).catch(() => Buffer.alloc(0));
    const clean = new Request(request, { headers });
    const requestId = randomUUID(); const started = Date.now(); let seq = 0;
    const secrets = [...request.headers].filter(([key]) => /authorization|cookie|api.?key/i.test(key)).flatMap(([, value]) => [value, value.replace(/^Bearer\s+/i, '')]);
    const context = nativeId === null ? Promise.resolve(undefined) : readFile(join(directory, `context-${encodeURIComponent(nativeId)}.json`), 'utf8').then(text => JSON.parse(text) as unknown).catch(() => undefined);
    const file = join(directory, `model-${encodeURIComponent(nativeId ?? 'unassigned')}.jsonl`);
    const pendingRequest = body.then(async bytes => {
      const owner = await context;
      publish(file, { version: 1, runId: logicalId ?? requestId, seq: ++seq, at: new Date(started).toISOString(), elapsedMs: 0, source: 'model-http', channel: 'request', direction: 'out', context: owner, value: { requestId, nativeId, logicalId, purpose, method: request.method, url: safeUrl(request.url), headers: safeHeaders(headers), body: redact(bytes, secrets).toString('base64'), bytes: bytes.length, sha256: sha256(bytes) } });
    });
    const emit = (channel: string, value: unknown): void => { void pendingRequest.then(async () => publish(file, { version: 1, runId: logicalId ?? requestId, seq: ++seq, at: new Date().toISOString(), elapsedMs: Date.now() - started, source: 'model-http', channel, direction: 'in', context: await context, value: { requestId, value } })); };
    try {
      const response = await original(clean);
      emit('headers', { status: response.status, headers: safeHeaders(response.headers) });
      if (response.body === null) { emit('complete', { outcome: 'completed', status: response.status }); return response; }
      const reader = response.body.getReader();
      let terminal = false;
      const chunks: { t: number; bytes: Buffer }[] = [];
      const finish = (outcome: string, error?: unknown): void => { if (!terminal) { terminal = true; const safe = redact(Buffer.concat(chunks.map(chunk => chunk.bytes)), secrets); let offset = 0;
        const recordedChunks = chunks.map(chunk => { const data = safe.subarray(offset, offset + chunk.bytes.length); offset += chunk.bytes.length; return { t: chunk.t, bytes: chunk.bytes.length, sha256: sha256(chunk.bytes), data: data.toString('base64') }; });
        emit('complete', { outcome, status: response.status, chunks: recordedChunks, ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }) }); } };
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) { finish('completed'); controller.close(); return; }
            const bytes = Buffer.from(next.value);
            chunks.push({ t: Date.now() - started, bytes });
            emit('chunk', { bytes: bytes.length, sha256: sha256(bytes) });
            controller.enqueue(next.value);
          } catch (error) { finish('failed', error); controller.error(error); }
        },
        async cancel(reason) { finish('cancelled', reason); await reader.cancel(reason); },
      });
      const observed = new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
      Object.defineProperties(observed, { url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type } });
      return observed;
    } catch (error) { emit('complete', { outcome: 'failed', error: error instanceof Error ? error.message : String(error) }); throw error; }
  };
}
