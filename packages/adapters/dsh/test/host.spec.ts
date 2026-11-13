import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { attachToDsh, dshBaseUrl, DshHostClient, startSidecar } from '../src/host.js';

afterEach(() => vi.unstubAllGlobals());
it('NP-10 keeps deployment prefixes in authentication and RPC and rejects mismatched responses', async () => {
  expect(dshBaseUrl('https://host.example/dsh/?token=secret')).toBe('https://host.example/dsh/');
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit) => {
    urls.push(String(url));
    if (init.method !== 'POST') return new Response(null, { status: 303, headers: { 'set-cookie': 'dsh-auth-test=value; HttpOnly' } });
    const request = JSON.parse(String(init.body)) as { rpcId: string };
    return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: 42 } }));
  });
  const cookie = await attachToDsh('https://host.example/dsh/', 'token');
  const host = new DshHostClient('https://host.example/dsh/');
  host.useCookie(cookie);
  expect(await host.rpc('commands/execute', { agentId: 'one', line: '/help', submittedAttachments: [] })).toBe(42);
  expect(urls).toEqual(['https://host.example/dsh/connect?token=token&interactions=answer', 'https://host.example/dsh/api/commands/execute']);
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ type: 'server-response', rpcId: 'wrong', result: { ok: true, value: 42 } })));
  await expect(host.rpc('settings/describe', {})).rejects.toThrow('身份');
});

async function muxServer() {
  const server = createServer();
  const mux = new WebSocketServer({ noServer: true });
  let authenticated = true;
  let upgrades = 0;
  const sockets: WebSocket[] = [];
  const received: { connection: number; frame: Record<string, unknown> }[] = [];
  server.on('upgrade', (request, socket, head) => {
    upgrades++;
    expect(request.url).toBe('/dsh/api/remote.mux');
    if (!authenticated) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    mux.handleUpgrade(request, socket, head, ws => {
      sockets.push(ws);
      const connection = sockets.length;
      ws.on('message', value => received.push({ connection, frame: JSON.parse(String(value)) as Record<string, unknown> }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing server address');
  return {
    endpoint: `http://127.0.0.1:${address.port}/dsh/`, sockets, received,
    expire() { authenticated = false; }, authenticate() { authenticated = true; },
    get upgrades() { return upgrades; },
    async close() { for (const socket of sockets) socket.terminate(); await new Promise<void>(resolve => mux.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

it('NP-10 restores surviving subscriptions after a real socket loss and stops reconnecting on close', async () => {
  const server = await muxServer();
  const states: string[] = [];
  const host = new DshHostClient(server.endpoint, { reconnectDelayMs: 10, onState: state => states.push(state), maxFrames: 2 });
  const frames: unknown[] = [];
  try {
    await Promise.all([host.connect(), host.connect(), host.connect()]);
    expect(server.upgrades).toBe(1);
    const follow = host.openStream('session/follow', { request: { address: { kind: 'session', sessionId: 'one' } } }, frame => frames.push(frame));
    const cancelled = host.openStream('$events', {}, () => undefined);
    host.closeStream(cancelled);
    await vi.waitFor(() => expect(server.received).toHaveLength(3));
    server.sockets[0]?.terminate();
    await vi.waitFor(() => expect(server.received.filter(entry => entry.connection === 2)).toHaveLength(1));
    expect(server.received.at(-1)?.frame).toMatchObject({ type: 'open', streamId: follow, endpoint: 'session/follow' });
    server.sockets[1]?.send(JSON.stringify({ type: 'item', streamId: follow, value: { type: 'event', event: { seq: 7 } } }));
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(states).toContain('reconnecting');
    await host.close();
    await host.close();
    expect(host.isConnected).toBe(false);
    expect(server.upgrades).toBe(2);
    expect(states.at(-1)).toBe('closed');
  } finally { await host.close(); await server.close(); }
});

it('NP-10 waits for fresh credentials after a 401 handshake and retains only live streams', async () => {
  const server = await muxServer();
  const states: string[] = [];
  const host = new DshHostClient(server.endpoint, { reconnectDelayMs: 10, onState: state => states.push(state) });
  try {
    await host.connect();
    let ended = false;
    const terminal = host.openStream('session/follow', { request: { address: { kind: 'session', sessionId: 'one' } } }, () => { ended = true; });
    const live = host.openStream('$events', {}, () => undefined);
    await vi.waitFor(() => expect(server.received).toHaveLength(2));
    server.sockets[0]?.send(JSON.stringify({ type: 'end', streamId: terminal }));
    await vi.waitFor(() => expect(ended).toBe(true));
    expect(host.frames).toHaveLength(0);
    server.expire();
    server.sockets[0]?.terminate();
    await vi.waitFor(() => expect(states).toContain('auth-required'));
    await expect(host.connect()).rejects.toMatchObject({ code: 'dsh-needs-link' });
    expect(server.upgrades).toBe(2);
    server.authenticate();
    host.useCookie('dsh-auth-test=fresh');
    await host.connect();
    await vi.waitFor(() => expect(server.received.filter(entry => entry.connection === 2)).toHaveLength(1));
    expect(server.received.at(-1)?.frame).toMatchObject({ streamId: live });
  } finally { await host.close(); await server.close(); }
});

it('NP-10 does not follow credential-bearing redirects and rejects invalid RPC envelopes', async () => {
  const host = new DshHostClient('https://example.test/dsh/');
  vi.stubGlobal('fetch', async () => new Response(null, { status: 401, headers: { 'set-cookie': 'wrong=credential' } }));
  await expect(attachToDsh('https://example.test/dsh/', 'token')).rejects.toThrow('401');
  await expect(host.authenticate('https://other.test/dsh/?token=token')).rejects.toThrow('target');
  await expect(host.rpc('session/modelCatalog')).rejects.toMatchObject({ code: 'dsh-needs-link' });
  await expect(host.rpc('../escape')).rejects.toThrow('endpoint');
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    expect(init.redirect).toBe('manual');
    const request = JSON.parse(String(init.body)) as { rpcId: string };
    return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: null }));
  });
  await expect(host.rpc('session/modelCatalog')).rejects.toThrow('信封');
});

it('NP-10 cleans up failed sidecar boots and reports spawn errors without crashing', async () => {
  await expect(startSidecar({ port: 0, env: {}, command: '/missing/wdcc-dsh' })).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(startSidecar({ port: 0, env: {}, command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], bootTimeoutMs: 20 })).rejects.toThrow('token URL');
});
