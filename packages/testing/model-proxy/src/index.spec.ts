import { createServer, request, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ModelProxy, configureDiagnosticCaptureBudget, diagnosticCaptureBudgetBytes, type ModelProxyRecord } from './index.js';
afterEach(() => { expect(diagnosticCaptureBudgetBytes()).toBe(0); configureDiagnosticCaptureBudget(64 * 1024 * 1024); });
async function listen(server: Server): Promise<number> { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return (server.address() as { port: number }).port; }
async function close(server: Server): Promise<void> { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

it.each(['http://fixture:%@127.0.0.1:1', 'http://fixture:%ff@127.0.0.1:1', 'http://%:valid@127.0.0.1:1'])('rejects malformed target credentials before listening: %s', target => {
  expect(() => new ModelProxy({ target })).toThrow('Invalid model recording target credentials');
});

it('preserves valid percent-encoded upstream Basic Auth and masks both encoded and decoded password echoes', async () => {
  const username = 'fixture@name'; const password = 'secret%:value';
  const encoded = encodeURIComponent(password);
  let authorization: string | undefined; let input = '';
  const upstream = createServer(async (req, res) => {
    authorization = req.headers.authorization;
    for await (const bytes of req) input += String(bytes);
    res.end(`native output ${password} ${encoded}`);
  });
  const port = await listen(upstream); const records: ModelProxyRecord[] = [];
  const proxy = new ModelProxy({ target: `http://${encodeURIComponent(username)}:${encoded}@127.0.0.1:${port}`, onRecord: record => { records.push(record); } });
  try {
    const address = await proxy.listen();
    const text = await (await fetch(address.url, { method: 'POST', body: `native input ${password} ${encoded}` })).text();
    expect(authorization).toBe(`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
    expect(input).toBe(`native input ${password} ${encoded}`); expect(text).toBe(`native output ${password} ${encoded}`);
    await proxy.flush();
    const requestBody = Buffer.from(records[0]!.request.body, 'base64').toString();
    const responseBody = Buffer.concat(records[0]!.response.chunks.map(chunk => Buffer.from(chunk.data, 'base64'))).toString();
    for (const body of [requestBody, responseBody]) { expect(body).not.toContain(password); expect(body).not.toContain(encoded); }
    expect(records[0]?.outcome).toBe('completed');
  } finally { await proxy.close(); await close(upstream); }
});

it('a standalone proxy directory quota marks recording incomplete after unchanged forwarding', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-proxy-directory-'));
  let sent = '';
  const upstream = createServer(async (req, res) => { for await (const part of req) sent += String(part); res.end('original response'); });
  const port = await listen(upstream);
  const proxy = new ModelProxy({ target: `http://127.0.0.1:${port}`, recordFile: join(directory, 'trace.jsonl'), maxRecordDirectoryBytes: 0 });
  try {
    const address = await proxy.listen();
    const response = await fetch(address.url, { method: 'POST', body: 'original request' });
    expect(response.status).toBe(200); expect(await response.text()).toBe('original response');
    expect(sent).toBe('original request');
    await expect(proxy.flush()).rejects.toThrow('Model recording is incomplete');
    expect(JSON.parse(await readFile(join(directory, '.wdcc-diagnostic-quota.json'), 'utf8'))).toMatchObject({ incomplete: true, scope: 'directory' });
  } finally { await proxy.close().catch(() => undefined); await close(upstream); await rm(directory, { recursive: true, force: true }); }
});
it('forwards the first SSE bytes before upstream ends and redacts a secret split across chunks', async () => {
  const records: ModelProxyRecord[] = [];
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let upstreamEnded = false;
  const upstream = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: secret-fi'); void gate.then(() => { upstreamEnded = true; res.end('xture\n\n'); }); });
  const port = await listen(upstream);
  const proxy = new ModelProxy({ target: `http://127.0.0.1:${port}/v1`, secrets: ['secret-fixture'], onRecord: record => { records.push(record); } });
  try {
    const address = await proxy.listen(); expect(address.url).toMatch(/\/v1$/);
    const response = await fetch(`${address.url}/responses`);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: secret-fi'); expect(upstreamEnded).toBe(false);
    release(); let received = ''; for (;;) { const chunk = await reader.read(); if (chunk.done) break; received += new TextDecoder().decode(chunk.value); }
    expect(received).toBe('xture\n\n'); await proxy.flush();
    expect(records[0]?.outcome).toBe('completed'); expect(records[0]?.request.path).toBe('/v1/responses');
    const recorded = Buffer.concat(records[0]!.response.chunks.map(chunk => Buffer.from(chunk.data, 'base64'))).toString();
    expect(recorded).not.toContain('secret-fixture'); expect(recorded.length).toBe('data: secret-fixture\n\n'.length);
  } finally { release(); await proxy.close(); await close(upstream); }
});

it('NP-14 independent proxies share one capture budget and release it before slow or failed record observers finish', async () => {
  configureDiagnosticCaptureBudget(6);
  let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
  const upstream = createServer((req, res) => { if (req.url === '/held') { res.write('123456'); void gate.then(() => res.end()); } else res.end('abcdef'); });
  const port = await listen(upstream);
  const records: ModelProxyRecord[] = [];
  let finishObserver!: () => void; const observer = new Promise<void>(resolve => { finishObserver = resolve; });
  const first = new ModelProxy({ target: `http://127.0.0.1:${port}`, onRecord: () => observer });
  const second = new ModelProxy({ target: `http://127.0.0.1:${port}`, onRecord: record => { records.push(record); } });
  try {
    const firstAddress = await first.listen(); const secondAddress = await second.listen();
    const held = await fetch(`${firstAddress.url}/held`); const reader = held.body!.getReader();
    expect(Buffer.from((await reader.read()).value!).toString()).toBe('123456');
    expect(diagnosticCaptureBudgetBytes()).toBe(6);
    expect(await (await fetch(secondAddress.url)).text()).toBe('abcdef'); await second.flush();
    expect(records[0]).toMatchObject({ response: { chunks: [] }, coverage: { truncated: true, responseBytes: 6, responseLimitReason: 'active-buffer-budget' } });
    expect(diagnosticCaptureBudgetBytes()).toBe(6);
    finish(); await reader.read();
    expect(diagnosticCaptureBudgetBytes()).toBe(0);
    expect(await (await fetch(secondAddress.url)).text()).toBe('abcdef'); await second.flush();
    expect(records[1]?.coverage?.truncated).toBe(false);
    finishObserver(); await first.flush();
  } finally { finish(); finishObserver(); await first.close(); await second.close(); await close(upstream); }
});

it('NP-14 recording callbacks can fail without keeping raw captures or breaking native response bytes', async () => {
  const upstream = createServer((_req, res) => res.end('response'));
  const port = await listen(upstream);
  const proxy = new ModelProxy({ target: `http://127.0.0.1:${port}`, onEvent: () => { throw new Error('observer'); }, onRecord: () => { throw new Error('record'); } });
  try {
    const address = await proxy.listen();
    expect(await (await fetch(address.url, { method: 'POST', body: 'input' })).text()).toBe('response');
    expect(diagnosticCaptureBudgetBytes()).toBe(0); await expect(proxy.flush()).rejects.toThrow('incomplete');
  } finally { await expect(proxy.close()).rejects.toThrow('incomplete'); await close(upstream); }
});
it('connection refusal and cancelled partial streams both retain terminal evidence', async () => {
  const unused = createServer(); const port = await listen(unused); await close(unused);
  const records: ModelProxyRecord[] = [];
  const proxy = new ModelProxy({ target: `http://127.0.0.1:${port}`, onRecord: record => { records.push(record); } });
  try { const address = await proxy.listen(); expect((await fetch(address.url)).status).toBe(502); await proxy.flush(); expect(records[0]).toMatchObject({ outcome: 'failed', response: { upstreamStatus: null } }); }
  finally { await proxy.close(); }
  const upstream = createServer((_req, res) => { res.write('partial'); }); const nextPort = await listen(upstream);
  const cancelled: ModelProxyRecord[] = [];
  const next = new ModelProxy({ target: `http://127.0.0.1:${nextPort}`, onRecord: record => { cancelled.push(record); } });
  try {
    const address = await next.listen();
    await new Promise<void>((resolve, reject) => { const req = request(address.url, res => { res.once('data', () => { req.destroy(); resolve(); }); }); req.once('error', reject); req.end(); });
    await new Promise(resolve => setImmediate(resolve)); await next.close(); expect(cancelled[0]?.outcome).toBe('cancelled'); expect(cancelled[0]?.response.chunks.length).toBeGreaterThan(0);
  } finally { await next.close(); await close(upstream); }
});

it('NP-14 forwards a streaming request before its end and drops over-limit captures without changing either direction', async () => {
  const records: ModelProxyRecord[] = [];
  let receivedFirst!: () => void;
  const first = new Promise<void>(resolve => { receivedFirst = resolve; });
  let upstreamBody = '';
  const upstream = createServer((req, res) => {
    req.on('data', bytes => { upstreamBody += String(bytes); receivedFirst(); });
    req.on('end', () => { res.end('large-secret-response'); });
  });
  const port = await listen(upstream);
  const proxy = new ModelProxy({ target: `http://127.0.0.1:${port}`, maxCaptureBytes: 8, onRecord: record => { records.push(record); } });
  try {
    const address = await proxy.listen();
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(`${address.url}/responses`, { method: 'POST' }, res => { let text = ''; res.on('data', bytes => { text += String(bytes); }); res.once('end', () => resolve(text)); });
      req.once('error', reject);
      req.write('first-');
      void first.then(() => { req.end('request-tail'); });
    });
    expect(upstreamBody).toBe('first-request-tail');
    expect(body).toBe('large-secret-response');
    await proxy.flush();
    expect(records[0]).toMatchObject({ outcome: 'completed', request: { body: '' }, response: { chunks: [] }, coverage: { truncated: true, requestBytes: 18, responseBytes: 21, digestScope: 'redacted' } });
  } finally { await proxy.close(); await close(upstream); }
});
