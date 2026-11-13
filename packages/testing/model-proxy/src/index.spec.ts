import { createServer, request, type Server } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { ModelProxy, type ModelProxyRecord } from './index.js';
async function listen(server: Server): Promise<number> { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return (server.address() as { port: number }).port; }
async function close(server: Server): Promise<void> { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
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
