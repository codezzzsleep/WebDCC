import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { createDshNativeSurface, type DshSurfaceConnection } from '../src/dsh-native-surface.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const mainOrigin = 'http://127.0.0.1:30999';
const nativeCookie = 'dsh-auth-fixture=v1.test.signature';
const boot = (version = '0.2.2-rc.1', rev = 'fixture') => `<html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({ rev, release: { version }, entries: [] })}</script><script src="plugins/client.js"></script></head><body>native page</body></html>`;
async function unusedPort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function fixture(options: { writable?: boolean; identityRefreshMs?: number; noDispatcher?: boolean; authorizationGate?: Promise<void>; dispatchGate?: Promise<void>; upgradeGate?: Promise<void> } = {}) {
  let version = '0.2.2-rc.1';
  const requests: { url: string; cookie?: string; origin?: string; body: string }[] = [];
  const frames: unknown[] = [];
  const nativeSockets: WebSocket[] = [];
  let upgrades = 0;
  const native = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString(); requests.push({ url: request.url ?? '', cookie: request.headers.cookie, origin: request.headers.origin, body });
    if (request.url === '/dsh/') {
      await new Promise(resolve => setTimeout(resolve, 10)); response.setHeader('content-type', 'text/html'); response.setHeader('set-cookie', 'native-secret=must-not-leave-server'); response.end(boot(version)); return;
    }
    if (request.url?.startsWith('/dsh/plugins/')) { response.setHeader('content-type', 'text/javascript'); response.end('globalThis.nativeLoaded=true'); return; }
    if (request.url === '/dsh/api/settings/describe' || request.url === '/dsh/api/commands/execute' || request.url === '/dsh/api/$events/result') {
      const envelope = JSON.parse(body) as { rpcId: string }; response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: 'native-receipt' } })); return;
    }
    if (request.url === '/dsh/api/file?path=notes.txt') { response.setHeader('content-type', 'text/plain'); response.setHeader('content-disposition', 'attachment; filename="notes.txt"'); response.end('native download'); return; }
    response.statusCode = 404; response.end();
  });
  const mux = new WebSocketServer({ noServer: true });
  native.on('upgrade', async (request, socket, head) => {
    upgrades++; await options.upgradeGate;
    expect(request.url).toBe('/dsh/api/remote.mux'); expect(request.headers.cookie).toBe(nativeCookie);
    expect(request.headers.origin).toBe(baseOrigin);
    mux.handleUpgrade(request, socket, head, ws => { nativeSockets.push(ws); ws.on('message', data => {
      const frame = JSON.parse(data.toString()) as { streamId?: string; endpoint?: string }; frames.push(frame);
      if (frame.endpoint === '$events') {
        ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'ready', clientId: 'native-observer' } }));
        ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'waterfall', event: 'approval/request', eventId: 'native-approval' } }));
      } else ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { native: true } }));
    }); });
  });
  native.listen(0, '127.0.0.1'); await once(native, 'listening');
  const baseOrigin = `http://127.0.0.1:${(native.address() as { port: number }).port}`;
  cleanup.push(async () => { for (const socket of nativeSockets) socket.terminate(); await new Promise<void>(resolve => mux.close(() => resolve())); native.closeIdleConnections(); await new Promise<void>(resolve => native.close(() => resolve())); });
  let connection: DshSurfaceConnection | null = { url: `${baseOrigin}/dsh/`, browserCookie: nativeCookie, connectedAt: '2026-11-14T00:00:00Z' };
  let authRevision = 'login-one'; let authorized = 0; let journaled = 0;
  const port = await unusedPort(); const publicOrigin = `http://127.0.0.1:${port}`;
  const surface = await createDshNativeSurface({ publicOrigin, applicationOrigins: [mainOrigin], connection: () => connection, authRevision: () => authRevision,
    identityRefreshMs: options.identityRefreshMs ?? 5000,
    ...(options.writable === false ? {} : { authorizeWrite: async () => { authorized++; await options.authorizationGate; } }),
    ...(options.writable === false || options.noDispatcher ? {} : { dispatchRpc: async (_rpc, execute) => { journaled++; await options.dispatchGate; return execute(); } }),
  });
  await surface.start({ host: '127.0.0.1', port }); cleanup.push(() => surface.close());
  const headers = { host: new URL(publicOrigin).host };
  const login = async (nativeId?: string) => {
    const ticket = await surface.issueTicket(nativeId === undefined ? {} : { nativeId });
    expect(ticket.actionUrl).not.toContain(ticket.ticket);
    const exchange = await surface.app.inject({ method: 'POST', url: '/__webdcc/open', headers: { ...headers, origin: mainOrigin, 'content-type': 'application/x-www-form-urlencoded', cookie: 'wdcc-auth-real-main=must-not-forward' }, payload: new URLSearchParams({ ticket: ticket.ticket }).toString() });
    expect(exchange.statusCode).toBe(303); expect(exchange.headers['location']).toBe('/');
    const cookie = String(exchange.headers['set-cookie']).split(';')[0]!;
    return { ticket, cookie };
  };
  return { surface, headers, login, publicOrigin, frames, requests, baseOrigin,
    changeHost() { connection = connection === null ? null : { ...connection, connectedAt: '2026-11-14T01:00:00Z' }; },
    rotateAuth() { authRevision = 'login-two'; }, changeVersion() { version = '0.3.0'; },
    get authorized() { return authorized; }, get journaled() { return journaled; }, get upgrades() { return upgrades; } };
}

it('native surface is explicitly unavailable without an isolated origin and rejects the main origin', async () => {
  const disabled = await createDshNativeSurface({ applicationOrigins: [mainOrigin], connection: () => null }); cleanup.push(() => disabled.close());
  expect(disabled.status()).toMatchObject({ status: 'unavailable', publicOrigin: null });
  await expect(disabled.issueTicket()).rejects.toMatchObject({ statusCode: 503 });
  await expect(createDshNativeSurface({ publicOrigin: mainOrigin, applicationOrigins: [mainOrigin], connection: () => null })).rejects.toMatchObject({ statusCode: 400 });
});
it('one-use POST tickets authenticate native HTML and resources without forwarding WebDCC cookies', async () => {
  const f = await fixture();
  expect((await f.surface.app.inject({ url: '/', headers: f.headers })).statusCode).toBe(401);
  const { cookie, ticket } = await f.login('native-session');
  const reused = await f.surface.app.inject({ method: 'POST', url: '/__webdcc/open', headers: { ...f.headers, origin: mainOrigin }, payload: { ticket: ticket.ticket } });
  expect(reused.statusCode).toBe(401);
  const html = await f.surface.app.inject({ url: '/', headers: { ...f.headers, cookie: `${cookie}; wdcc-auth-real-main=must-not-forward` } });
  expect(html.statusCode).toBe(200); expect(html.body).toContain('native page'); expect(html.body).toContain('dsh.sessions.current');
  expect(html.body).toContain('native-session'); expect(html.headers['set-cookie']).toBeUndefined();
  expect(html.headers['cross-origin-opener-policy']).toBe('same-origin'); expect(html.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  const resource = await f.surface.app.inject({ url: '/plugins/client.js?rev=frozen', headers: { ...f.headers, cookie } });
  expect(resource.statusCode).toBe(200); expect(f.requests.at(-1)?.url).toBe('/dsh/plugins/client.js?rev=frozen');
  const combined = await f.surface.app.inject({ url: '/plugins/??@native/client.js,@native/session.js&rev=frozen', headers: { ...f.headers, cookie } });
  expect(combined.statusCode).toBe(200); expect(f.requests.at(-1)?.url).toBe('/dsh/plugins/??@native/client.js,@native/session.js&rev=frozen');
  expect(f.requests.every(request => request.cookie === nativeCookie)).toBe(true);
  const download = await f.surface.app.inject({ url: '/api/file?path=notes.txt', headers: { ...f.headers, cookie } });
  expect(download.body).toBe('native download'); expect(download.headers['content-disposition']).toContain('attachment');
});
it('registered JSON RPCs are validated, fenced and journaled; arbitrary proxies and origins are refused', async () => {
  const f = await fixture(); const { cookie } = await f.login();
  const envelope = { type: 'client-request', rpcId: 'native-command', method: 'commands/execute', payload: { args: { agentId: 'native', line: '/native exact  \r\nbody', submittedAttachments: [] } } };
  const rejected = await f.surface.app.inject({ method: 'POST', url: '/api/commands/execute', headers: { ...f.headers, cookie, origin: mainOrigin }, payload: envelope });
  expect(rejected.statusCode).toBe(403); expect(f.authorized).toBe(0);
  const sent = await f.surface.app.inject({ method: 'POST', url: '/api/commands/execute', headers: { ...f.headers, cookie, origin: f.publicOrigin }, payload: envelope });
  expect(sent.statusCode).toBe(200); expect(f.authorized).toBe(1); expect(f.journaled).toBe(1);
  expect(JSON.parse(f.requests.at(-1)!.body)).toEqual(envelope); expect(f.requests.at(-1)?.origin).toBe(f.baseOrigin);
  const invalid = await f.surface.app.inject({ method: 'POST', url: '/api/commands/execute', headers: { ...f.headers, cookie, origin: f.publicOrigin }, payload: { ...envelope, method: 'credentials/set' } });
  expect(invalid.statusCode).toBe(400); expect(f.authorized).toBe(1);
  for (const url of ['/proxy?target=https://evil.test', '/?token=secret', '/%2e%2e/api/commands/execute', '//evil.test/', '/api/not-known']) expect((await f.surface.app.inject({ url, headers: { ...f.headers, cookie } })).statusCode).not.toBe(200);
  expect((await f.surface.app.inject({ url: '/', headers: { ...f.headers, host: new URL(mainOrigin).host, cookie } })).statusCode).toBe(403);
});
it('Host identity and main authentication changes invalidate issued tickets and existing surface cookies', async () => {
  const f = await fixture(); const { cookie } = await f.login(); const old = await f.surface.issueTicket(); f.changeHost();
  expect((await f.surface.app.inject({ url: '/', headers: { ...f.headers, cookie } })).statusCode).toBe(401);
  expect((await f.surface.app.inject({ method: 'POST', url: '/__webdcc/open', headers: { ...f.headers, origin: mainOrigin }, payload: { ticket: old.ticket } })).statusCode).toBe(401);
  const fresh = await f.login(); f.rotateAuth();
  expect((await f.surface.app.inject({ url: '/', headers: { ...f.headers, cookie: fresh.cookie } })).statusCode).toBe(401);
  f.changeVersion(); await expect(f.surface.issueTicket()).rejects.toMatchObject({ code: 'dsh-host-version-blocked' });
});
it('read-only admission refuses mutations until hosted writer fencing is supplied', async () => {
  const f = await fixture({ writable: false }); const { cookie } = await f.login();
  expect(f.surface.status().writable).toBe(false);
  const envelope = { type: 'client-request', rpcId: 'mutation', method: 'commands/execute', payload: { args: { agentId: 'native', line: '/test', submittedAttachments: [] } } };
  expect((await f.surface.app.inject({ method: 'POST', url: '/api/commands/execute', headers: { ...f.headers, cookie, origin: f.publicOrigin }, payload: envelope })).statusCode).toBe(409);
  expect(f.requests.some(request => request.url.endsWith('/commands/execute'))).toBe(false);
});
it('real WS forwards early fixed subscriptions, strips main cookies and closes when revoked', async () => {
  const f = await fixture({ identityRefreshMs: 0 }); const { cookie } = await f.login();
  const client = new WebSocket(f.publicOrigin.replace('http:', 'ws:') + '/api/remote.mux', { headers: { cookie: `${cookie}; wdcc-auth-main=must-not-forward`, origin: f.publicOrigin } });
  const message = once(client, 'message');
  client.on('open', () => client.send(JSON.stringify({ type: 'open', streamId: 'workspace', endpoint: 'workspace/follow', payload: { args: {} } })));
  expect(JSON.parse(String((await message)[0]))).toMatchObject({ streamId: 'workspace', value: { native: true } });
  expect(f.frames).toContainEqual({ type: 'open', streamId: 'workspace', endpoint: 'workspace/follow', payload: { args: {} } });
  const closed = once(client, 'close'); f.surface.revoke(); expect((await closed)[0]).toBe(1008);
});
it('a read-only native view follows existing history passively without activating a writer', async () => {
  const f = await fixture({ writable: false }); const { cookie } = await f.login();
  const client = new WebSocket(f.publicOrigin.replace('http:', 'ws:') + '/api/remote.mux', { headers: { cookie, origin: f.publicOrigin } });
  const message = once(client, 'message');
  client.on('open', () => client.send(JSON.stringify({ type: 'open', streamId: 'passive', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: 'existing' }, activate: true, assistantStream: true } } } })));
  await message;
  expect(f.frames).toContainEqual({ type: 'open', streamId: 'passive', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: 'existing' }, activate: false, assistantStream: true } } } });
  expect(f.authorized).toBe(0); client.close(); await once(client, 'close');
});
it('a read-only observer delegates native approvals instead of claiming or approving them', async () => {
  const f = await fixture({ writable: false }); const { cookie } = await f.login();
  const client = new WebSocket(f.publicOrigin.replace('http:', 'ws:') + '/api/remote.mux', { headers: { cookie, origin: f.publicOrigin } });
  const received: unknown[] = []; client.on('message', data => received.push(JSON.parse(data.toString())));
  client.on('open', () => client.send(JSON.stringify({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } })));
  await vi.waitFor(() => expect(f.requests.some(request => request.url === '/dsh/api/$events/result')).toBe(true));
  const delegated = JSON.parse(f.requests.find(request => request.url === '/dsh/api/$events/result')!.body) as { payload: unknown };
  expect(delegated.payload).toEqual({ args: { clientId: 'native-observer', eventId: 'native-approval', outcome: { kind: 'next' } } });
  expect(received).toHaveLength(1); expect(received[0]).toMatchObject({ value: { type: 'ready' } });
  client.close(); await once(client, 'close');
});
it('HTTP writes need a durable dispatcher as well as an authorizer', async () => {
  const f = await fixture({ noDispatcher: true }); const { cookie } = await f.login();
  const envelope = { type: 'client-request', rpcId: 'no-journal', method: 'commands/execute', payload: { args: { agentId: 'native', line: '/test', submittedAttachments: [] } } };
  expect(f.surface.status().writable).toBe(false);
  const response = await f.surface.app.inject({ method: 'POST', url: '/api/commands/execute', headers: { ...f.headers, cookie, origin: f.publicOrigin }, payload: envelope });
  expect(response.statusCode).toBe(409); expect(f.authorized).toBe(0); expect(f.requests.some(request => request.url.endsWith('/commands/execute'))).toBe(false);
});
it('Host/auth changes during deferred authorization or dispatch prevent the native effect', async () => {
  for (const phase of ['authorization', 'dispatch'] as const) {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(phase === 'authorization' ? { authorizationGate: gate } : { dispatchGate: gate }); const { cookie } = await f.login();
    const response = f.surface.app.inject({ method: 'POST', url: '/api/commands/execute', headers: { ...f.headers, cookie, origin: f.publicOrigin }, payload: { type: 'client-request', rpcId: `delayed-${phase}`, method: 'commands/execute', payload: { args: { agentId: 'native', line: '/must-not-run', submittedAttachments: [] } } } });
    await vi.waitFor(() => expect(phase === 'authorization' ? f.authorized : f.journaled).toBe(1));
    if (phase === 'authorization') f.changeHost(); else f.rotateAuth(); release();
    expect((await response).statusCode).toBe(401);
    expect(f.requests.some(request => request.url.endsWith('/commands/execute'))).toBe(false);
  }
});
it('native stream mutations are blocked without a durable stream dispatcher', async () => {
  const f = await fixture(); const { cookie } = await f.login();
  const client = new WebSocket(f.publicOrigin.replace('http:', 'ws:') + '/api/remote.mux', { headers: { cookie, origin: f.publicOrigin } });
  const closed = once(client, 'close');
  client.on('open', () => client.send(JSON.stringify({ type: 'open', streamId: 'activate', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: 'native' }, activate: true } } } })));
  expect((await closed)[0]).toBe(1008); expect(f.frames).toEqual([]); expect(f.authorized).toBe(0); expect(f.surface.status().streamWrites).toBe(false);
});
it('revocation before the native WS opens prevents flushing buffered subscriptions', async () => {
  let release!: () => void; const upgradeGate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ upgradeGate }); const { cookie } = await f.login();
  const client = new WebSocket(f.publicOrigin.replace('http:', 'ws:') + '/api/remote.mux', { headers: { cookie, origin: f.publicOrigin } });
  const closed = once(client, 'close');
  await once(client, 'open'); await vi.waitFor(() => expect(f.upgrades).toBe(1));
  const received = Promise.all([...f.surface.app.websocketServer.clients].map(socket => once(socket, 'message')));
  client.send(JSON.stringify({ type: 'open', streamId: 'buffered', endpoint: 'workspace/follow', payload: { args: {} } }));
  await received; f.rotateAuth(); release();
  expect((await closed)[0]).toBe(1008); expect(f.frames).toEqual([]);
});
