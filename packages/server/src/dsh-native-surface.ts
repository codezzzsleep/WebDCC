/** Isolated-origin carrier for the frozen DSH Host. This is a separate HTTP
 * server, never a route serving native HTML under the WebDCC application. */
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket, { type RawData } from 'ws';
import { dshBaseUrl, readDshHostIdentity, requireDshBaseline, validateDshArgs, type DshHostIdentity } from '@webdcc/adapter-dsh';
import catalog from './native-inventory.json' with { type: 'json' };

export interface DshSurfaceConnection { url: string; browserCookie?: string; connectedAt: string }
export interface DshSurfaceRpc {
  commandId: string; endpoint: string; args: Record<string, unknown>; binding: string;
}
export interface DshNativeSurfaceOptions {
  publicOrigin?: string;
  applicationOrigins: string[];
  connection: () => DshSurfaceConnection | null;
  /** A revision/hash, never the WebDCC authentication credential itself. */
  authRevision?: () => string;
  /** Hosted-writer fencing belongs to SessionManager. Without this callback,
   * native mutations are unavailable; observation remains authenticated. */
  authorizeWrite?: (rpc: DshSurfaceRpc) => Promise<void>;
  /** Optional durable command admission supplied by the main server. */
  dispatchRpc?: (rpc: DshSurfaceRpc, execute: () => Promise<Response>) => Promise<Response>;
  cookieTtlMs?: number;
  identityRefreshMs?: number;
  maxBodyBytes?: number;
}
interface Binding { key: string; connectionKey: string; url: string; cookie: string; host: DshHostIdentity; checkedAt: number }
interface Ticket { binding: string; expiresAt: number; nativeId?: string }
interface Admission extends Ticket { seeded: boolean }

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message: string, statusCode = 403) => Object.assign(new Error(message), { statusCode });
function origin(value: string): string {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw fail('Native surface requires a bare HTTP(S) origin', 400);
  return parsed.origin;
}
const STREAMS = new Set(['$events', 'session/events', 'session/follow', 'session/control', 'session/observeEvent', 'session/observeState', 'session/observeProjections', 'workspace/follow', 'job/list', 'job/follow', 'speech/follow', 'forgePanel/follow', 'remoteAccess/follow', 'account/watch', 'account/watchExpiry', 'toolResults/watch', 'workspaceFiles/changes', 'userQuestions/attachWait', 'terminal/attach', 'terminal/retain']);
const READ_RPC = new Set(['session/list', 'session/search', 'session/page', 'session/state', 'session/projections', 'session/modelCatalog', 'session/canOpenWorkspacePath', 'session/workspacePathApplications', 'agentPresets/list', 'agentPresets/read', 'settings/describe', 'credentials/describe', 'commands/list', 'skills/list', 'permissionPresets/catalog', 'directoryPicker/list', 'workspaceFiles/list', 'workspaceFiles/stat', 'workspaceFiles/read', 'workspaceFiles/readBytes', 'fileReferences/list', 'llm/listProviders', 'llm/listConfigurableProviders', 'pluginInventory/list', 'pluginManager/listBundles', 'pluginManager/listPlugins', 'pluginManager/listVersionExemptions', 'pluginManager/listVersions', 'pluginManager/readBundleDetail', 'pluginManager/registries', 'pluginMarket/listIndexes', 'pluginMarket/search', 'pluginMarket/readEntryDetail', 'goals/get', 'schedule/catalog', 'schedule/list', 'schedule/view', 'schedule/history', 'schedule/deliveryLimits', 'speech/catalog', 'cotTranslation/limits', 'forgePanel/branches', 'forgePanel/localDiff', 'forgePanel/localText', 'forgePanel/changeRequestDiff', 'forgePanel/changeRequestText', 'forgePanel/changeRequestChecks', 'forgePanel/changeRequestStates', 'liveshareShares/list', 'liveshareShares/capabilities', 'liveshareShares/identity', 'messageFeedback/list', 'sessionReferenceResolver/candidates', 'terminal/list', 'terminal/shells', 'terminal/environment', 'dynamicCordisRunner/inventory', 'dynamicCordisRunner/getClientCode', 'pluginRecommendations/describe', 'account/getState', 'account/getProfile', 'account/getBalance', 'account/getUnnotifiedBonuses', 'account/hasRunningAccountTasks', 'productAnalytics/enabled']);
// Resource routes verified in the same 0.2.2-rc.1 source as the RPC catalog.
const FETCH_ROUTES: Record<string, readonly string[]> = {
  '/api/file': ['GET', 'HEAD'], '/api/plugin-manager/detail-file': ['GET'], '/api/plugin-market/detail-file': ['GET'],
  '/api/present.host': ['GET'], '/api/present.open': ['GET', 'POST'], '/api/changes.summary': ['GET'], '/api/changes.diff': ['GET'], '/api/changes.open': ['GET', 'POST'],
  '/api/session/uploadFileBinary': ['POST'],
};
// Native inventory is an independent fixed manifest. Transport validation uses
// the actual frozen catalog's request schemas from adapter-dsh.
const NATIVE_ENDPOINTS = new Set(catalog.entries.filter(value => value.agent === 'dsh').map(value => value.method));

function cookies(header: string | undefined): Record<string, string> {
  return Object.fromEntries((header ?? '').split(';').flatMap(part => { const split = part.indexOf('='); return split < 1 ? [] : [[part.slice(0, split).trim(), part.slice(split + 1).trim()]]; }));
}
function route(rawUrl: string): { path: string; query: string } {
  const parts = rawUrl.split('?');
  let decoded: string;
  try { decoded = decodeURIComponent(parts[0] ?? '/'); } catch { throw fail('Invalid native resource path', 400); }
  if (!decoded.startsWith('/') || decoded.startsWith('//') || decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(part => part === '..' || part === '.') || /%2f|%5c|%00|%2e/i.test(decoded)) throw fail('Native resource path escapes the registered Host');
  const query = parts.slice(1).join('?');
  if ([...new URLSearchParams(query).keys()].some(key => ['token', 'ticket', 'target', 'proxy'].includes(key.toLowerCase()))) throw fail('Native authentication and targets cannot be supplied in a URL');
  return { path: decoded, query };
}
function resourceAllowed(path: string): boolean {
  return path === '/' || path === '/index.html' || path === '/favicon.ico' || path.startsWith('/plugins/') || path === '/plugins' || path.startsWith('/assets/') || path.startsWith('/icons/') || /^\/[a-zA-Z0-9_.-]+\.(?:js|css|json|webmanifest|png|svg|ico|woff2?|gz)$/.test(path);
}
function rpcEnvelope(endpoint: string, body: unknown): { commandId: string; args: Record<string, unknown> } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw fail('Native RPC requires a JSON envelope', 400);
  const value = body as { type?: unknown; rpcId?: unknown; method?: unknown; payload?: { args?: unknown } };
  if (value.type !== 'client-request' || typeof value.rpcId !== 'string' || value.rpcId.length < 1 || value.rpcId.length > 256 || value.method !== endpoint) throw fail('Native RPC identity does not match its registered route', 400);
  try { validateDshArgs(endpoint, value.payload?.args); } catch { throw fail('Native RPC arguments violate the frozen Host contract', 400); }
  return { commandId: value.rpcId, args: value.payload!.args as Record<string, unknown> };
}
async function boundedHtml(response: Response): Promise<string> {
  const reader = response.body?.getReader(); if (reader === undefined) return '';
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 4 * 1024 * 1024) throw fail('Native index exceeds the bounded bootstrap size', 502); chunks.push(chunk.value); }
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks).toString('utf8');
}

export class DshNativeSurface {
  readonly app: FastifyInstance;
  readonly publicOrigin?: string;
  private readonly applicationOrigins: Set<string>;
  private readonly cookieName: string;
  private readonly tickets = new Map<string, Ticket>();
  private readonly admissions = new Map<string, Admission>();
  private readonly sockets = new Set<WebSocket>();
  private binding: Binding | null = null;
  private bindingRead: Promise<Binding> | null = null;
  private started = false;
  private epoch = 0;

  constructor(private readonly options: DshNativeSurfaceOptions) {
    this.publicOrigin = options.publicOrigin === undefined ? undefined : origin(options.publicOrigin);
    this.applicationOrigins = new Set(options.applicationOrigins.map(origin));
    if (this.publicOrigin !== undefined && this.applicationOrigins.has(this.publicOrigin)) throw fail('DSH native HTML must have an origin distinct from WebDCC', 400);
    this.cookieName = `wdcc-dsh-surface-${hash(this.publicOrigin ?? 'disabled').slice(0, 24)}`;
    this.app = Fastify({ logger: false, bodyLimit: options.maxBodyBytes ?? 32 * 1024 * 1024 });
    this.app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
      const values = new URLSearchParams(String(body));
      if (values.getAll('ticket').length !== 1 || [...values.keys()].some(key => key !== 'ticket')) { done(fail('Invalid native entry form', 400)); return; }
      done(null, { ticket: values.get('ticket') });
    });
    this.app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
    this.app.setErrorHandler((error, _request, reply) => {
      const status = (error as { statusCode?: number }).statusCode ?? 502;
      return reply.status(status).send({ error: error instanceof Error && (status === 400 || status === 403) ? error.message : 'Native surface is unavailable; reopen it from WebDCC' });
    });
    this.app.addHook('onRequest', async (request, reply) => {
      const configured = this.publicOrigin;
      if (configured === undefined || request.headers.host !== new URL(configured).host) return reply.status(403).send({ error: 'Native surface Host is not registered' });
      const path = route(request.raw.url ?? '/').path;
      const requiredOrigin = path === '/__webdcc/open' ? this.applicationOrigins : new Set([configured]);
      const requiresOrigin = request.method !== 'GET' && request.method !== 'HEAD' || request.headers.upgrade?.toLowerCase() === 'websocket';
      if (requiresOrigin && (typeof request.headers.origin !== 'string' || !requiredOrigin.has(request.headers.origin))) return reply.status(403).send({ error: 'Native surface Origin is not registered' });
      reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').header('x-content-type-options', 'nosniff')
        .header('cross-origin-opener-policy', 'same-origin').header('cross-origin-resource-policy', 'same-origin')
        .header('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https: wss:; worker-src 'self' blob:; frame-src 'self' https:; form-action 'self' https:; base-uri 'self'; frame-ancestors 'none'");
    });
  }

  async initialize(): Promise<void> {
    await this.app.register(websocket, { options: { maxPayload: this.options.maxBodyBytes ?? 32 * 1024 * 1024 } });
    this.app.post('/__webdcc/open', async (request, reply) => {
      const value = request.body as { ticket?: unknown } | undefined;
      if (typeof value?.ticket !== 'string' || Object.keys(value).some(key => key !== 'ticket')) throw fail('Native entry requires one ticket in the POST body', 400);
      const ticket = this.tickets.get(hash(value.ticket)); this.tickets.delete(hash(value.ticket));
      if (ticket === undefined || ticket.expiresAt <= Date.now()) throw fail('Native entry ticket expired or was already used', 401);
      const binding = await this.currentBinding(true);
      if (ticket.binding !== binding.key) throw fail('Native entry belongs to a revoked Host connection', 401);
      this.prune();
      const cookie = randomBytes(32).toString('base64url');
      this.admissions.set(hash(cookie), { binding: binding.key, expiresAt: Date.now() + (this.options.cookieTtlMs ?? 30 * 60_000), nativeId: ticket.nativeId, seeded: false });
      reply.header('set-cookie', `${this.cookieName}=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((this.options.cookieTtlMs ?? 30 * 60_000) / 1000)}${this.publicOrigin?.startsWith('https:') ? '; Secure' : ''}`);
      return reply.redirect('/', 303);
    });
    this.app.get('/api/remote.mux', { websocket: true }, (socket, request) => { void this.bridgeSocket(socket, request); });
    this.app.route({ method: ['GET', 'HEAD', 'POST'], url: '/*', handler: async (request, reply) => {
      const { binding, admission } = await this.admit(request);
      const target = route(request.raw.url ?? '/');
      const endpoint = target.path.startsWith('/api/') ? target.path.slice(5) : undefined;
      const fixedFetch = FETCH_ROUTES[target.path];
      if (fixedFetch !== undefined) {
        if (!fixedFetch.includes(request.method)) throw fail('Native resource method is unavailable', 405);
      } else if (endpoint !== undefined) {
        if (request.method !== 'POST' || !(NATIVE_ENDPOINTS.has(endpoint) || endpoint === '$events/result')) throw fail('Native RPC route is outside the fixed catalog', 404);
      } else if (!['GET', 'HEAD'].includes(request.method) || !resourceAllowed(target.path)) throw fail('Native resource is outside the fixed routes', 404);
      let rpc: DshSurfaceRpc | undefined;
      if (endpoint !== undefined && fixedFetch === undefined) {
        const parsed = rpcEnvelope(endpoint, request.body);
        rpc = { ...parsed, endpoint, binding: binding.key };
        if (!READ_RPC.has(endpoint)) await this.authorizeWrite(rpc);
      } else if (request.method === 'POST') {
        const nativeId = new URLSearchParams(target.query).get('sessionId');
        rpc = { commandId: randomBytes(16).toString('hex'), endpoint: target.path.slice(5), binding: binding.key, args: { sessionId: nativeId } };
        await this.authorizeWrite(rpc);
      }
      const execute = () => this.fetchNative(binding, target, request);
      const guardedExecute = () => { this.assertCurrent(binding, admission); return execute(); };
      this.assertCurrent(binding, admission);
      const response = rpc !== undefined && !READ_RPC.has(rpc.endpoint) ? await this.options.dispatchRpc!(rpc, guardedExecute) : await guardedExecute();
      if (!this.stillCurrent(binding) || admission.expiresAt <= Date.now()) throw fail('Native Host changed while the response was in flight', 401);
      if ([401, 403].includes(response.status)) this.revoke();
      for (const [name, value] of response.headers) {
        if (['content-type', 'content-disposition', 'accept-ranges', 'content-range'].includes(name) || name.startsWith('x-dsh-')) reply.header(name, value);
      }
      reply.status(response.status);
      const location = response.headers.get('location');
      if (location !== null) {
        const redirect = new URL(location, new URL(target.path.slice(1), binding.url));
        const base = new URL(binding.url);
        if (redirect.origin !== base.origin || !redirect.pathname.startsWith(base.pathname)) throw fail('Native redirect leaves the registered Host', 502);
        const path = '/' + redirect.pathname.slice(base.pathname.length);
        route(path + redirect.search);
        reply.header('location', path + redirect.search + redirect.hash);
      }
      if (request.method === 'HEAD' || response.body === null) return reply.send();
      if ((target.path === '/' || target.path === '/index.html') && response.headers.get('content-type')?.includes('text/html')) {
        const html = await boundedHtml(response);
        const nativeId = admission.seeded ? undefined : admission.nativeId;
        admission.seeded = true;
        const script = `<script>(()=>{try{const k=${JSON.stringify(binding.key)};if(localStorage.getItem('__webdcc.dshHost')!==k){localStorage.clear();localStorage.setItem('__webdcc.dshHost',k)}${nativeId === undefined ? '' : `localStorage.setItem('dsh.sessions.current',${JSON.stringify(JSON.stringify({ sessionId: nativeId })).replaceAll('<', '\\u003c')});`}}catch{}})()</script>`;
        const nativeHtml = html.replace(/<head(?:\s[^>]*)?>/i, opening => opening + script);
        const banner = !this.httpWritable() ? '<div role="status" style="position:fixed;right:12px;bottom:12px;z-index:2147483647;max-width:360px;padding:10px 14px;background:#17202d;color:white;border-radius:8px;font:13px system-ui">WebDCC 只读入口：可查看 DSH 状态，当前不能提交修改。</div>' : '';
        return reply.send(banner === '' ? nativeHtml : nativeHtml.replace(/<body(?:\s[^>]*)?>/i, opening => opening + banner));
      }
      return reply.send(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]));
    } });
    await this.app.ready();
  }

  status() {
    return { status: this.publicOrigin === undefined ? 'unavailable' : this.started ? 'ready' : 'configured', publicOrigin: this.publicOrigin ?? null,
      reason: this.publicOrigin === undefined ? 'An isolated native origin has not been configured' : null, writable: this.httpWritable(),
      streamWrites: false, readonlyPassiveFollow: true,
      ownership: 'native-arbitration; external ownership release is not established by this surface',
      navigation: { chat: 'fixed-native-localStorage-selection', settings: 'native-navigation-required', schedule: 'native-navigation-required', plugins: 'native-navigation-required', forge: 'native-navigation-required' } };
  }
  async start(options: { host: string; port: number }): Promise<ReturnType<DshNativeSurface['status']>> {
    if (this.publicOrigin === undefined) return this.status();
    await this.app.listen(options); this.started = true; return this.status();
  }
  async issueTicket(options: { nativeId?: string } = {}): Promise<{ actionUrl: string; ticket: string; expiresAt: string }> {
    if (this.publicOrigin === undefined || !this.started) throw fail('An isolated native origin is unavailable', 503);
    if (options.nativeId !== undefined && (typeof options.nativeId !== 'string' || options.nativeId.length > 256 || !/^[A-Za-z0-9_:.-]+$/.test(options.nativeId))) throw fail('Invalid native Session identity', 400);
    const binding = await this.currentBinding(true);
    this.prune();
    const ticket = randomBytes(32).toString('base64url'); const expiresAt = Date.now() + 45_000;
    this.tickets.set(hash(ticket), { binding: binding.key, expiresAt, nativeId: options.nativeId });
    return { actionUrl: `${this.publicOrigin}/__webdcc/open`, ticket, expiresAt: new Date(expiresAt).toISOString() };
  }
  revoke(): void {
    this.epoch++; this.binding = null; this.tickets.clear(); this.admissions.clear();
    for (const socket of this.sockets) socket.close(1008, 'Native surface authentication revoked');
  }
  async close(): Promise<void> { this.revoke(); this.started = false; await this.app.close(); }
  private prune(): void {
    for (const [key, value] of this.tickets) if (value.expiresAt <= Date.now()) this.tickets.delete(key);
    for (const [key, value] of this.admissions) if (value.expiresAt <= Date.now()) this.admissions.delete(key);
    if (this.tickets.size >= 256 || this.admissions.size >= 256) throw fail('Native surface admission capacity exceeded', 429);
  }
  private connectionKey(connection: DshSurfaceConnection): string { return hash({ url: dshBaseUrl(connection.url), connectedAt: connection.connectedAt, credential: connection.browserCookie, authRevision: this.options.authRevision?.() ?? '' }); }
  private stillCurrent(binding: Binding): boolean {
    const connection = this.options.connection(); return connection !== null && this.connectionKey(connection) === binding.connectionKey && this.binding?.key === binding.key;
  }
  private assertCurrent(binding: Binding, admission: Admission): void {
    if (!this.stillCurrent(binding) || admission.expiresAt <= Date.now()) throw Object.assign(fail('Native surface was revoked before dispatch', 401), { code: 'native-control-rejected' });
  }
  private httpWritable(): boolean { return this.options.authorizeWrite !== undefined && this.options.dispatchRpc !== undefined; }
  private async currentBinding(force = false): Promise<Binding> {
    const connection = this.options.connection();
    if (connection === null || !connection.browserCookie) { this.revoke(); throw fail('Native browser authentication is unavailable', 401); }
    const connectionKey = this.connectionKey(connection);
    if (this.binding !== null && this.binding.connectionKey === connectionKey && !force && Date.now() - this.binding.checkedAt < (this.options.identityRefreshMs ?? 5000)) return this.binding;
    if (this.bindingRead !== null) return this.bindingRead;
    const epoch = this.epoch;
    const read = (async () => {
      const host = await readDshHostIdentity(connection.url, connection.browserCookie);
      requireDshBaseline(host);
      if (epoch !== this.epoch || this.options.connection() === null || this.connectionKey(this.options.connection()!) !== connectionKey) throw fail('Native Host changed during authentication', 401);
      const key = hash({ connectionKey, manifest: host.fingerprint });
      if (this.binding !== null && this.binding.key !== key) this.revoke();
      const binding = { key, connectionKey, url: dshBaseUrl(connection.url), cookie: connection.browserCookie!, host, checkedAt: Date.now() };
      this.binding = binding; return binding;
    })();
    this.bindingRead = read;
    try { return await read; } catch (error) { this.revoke(); throw error; } finally { if (this.bindingRead === read) this.bindingRead = null; }
  }
  private async admit(request: FastifyRequest): Promise<{ binding: Binding; admission: Admission }> {
    const cookie = cookies(request.headers.cookie)[this.cookieName];
    const admission = cookie === undefined ? undefined : this.admissions.get(hash(cookie));
    if (admission === undefined || admission.expiresAt <= Date.now()) throw fail('Native surface authentication expired', 401);
    const binding = await this.currentBinding();
    if (admission.binding !== binding.key) throw fail('Native surface belongs to a revoked Host', 401);
    return { binding, admission };
  }
  private async authorizeWrite(rpc: DshSurfaceRpc): Promise<void> {
    if (!this.httpWritable()) throw fail('Native surface is read-only until hosted writer fencing and durable dispatch are configured', 409);
    await this.options.authorizeWrite!(rpc);
  }
  private fetchNative(binding: Binding, target: { path: string; query: string }, request: FastifyRequest): Promise<Response> {
    // DSH's combined plugin scripts use /plugins/??package,...&rev=... .
    // The second '?' is part of the query, not another URL delimiter.
    const url = new URL(target.path.slice(1), binding.url); url.search = target.query === '' ? '' : `?${target.query}`;
    const headers: Record<string, string> = { cookie: binding.cookie, origin: new URL(binding.url).origin };
    for (const name of ['content-type', 'accept', 'range', 'content-disposition', 'x-dsh-file-name', 'x-dsh-upload-name']) if (typeof request.headers[name] === 'string') headers[name] = request.headers[name]!;
    const body = request.method === 'POST' ? Buffer.isBuffer(request.body) ? request.body : JSON.stringify(request.body) : undefined;
    return fetch(url, { method: request.method, redirect: 'manual', headers, ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(60_000) });
  }
  private async bridgeSocket(socket: WebSocket, request: FastifyRequest): Promise<void> {
    let upstream: WebSocket | undefined;
    const buffered: { frame: string; bytes: number }[] = [];
    let bufferedBytes = 0;
    const arrivals: { data: RawData; binary: boolean }[] = [];
    let arrivalBytes = 0;
    let handler: ((data: RawData, binary: boolean) => void) | undefined;
    // Install before the first await: the native browser opens subscriptions
    // immediately on WebSocket open, ahead of our Host identity read.
    socket.on('message', (data, binary) => {
      if (handler !== undefined) { handler(data, binary); return; }
      arrivalBytes += Buffer.byteLength(data.toString());
      if (arrivalBytes > 1024 * 1024) { socket.close(1008, 'Native handshake buffer exceeded'); return; }
      arrivals.push({ data, binary });
    });
    this.sockets.add(socket);
    const stop = () => { upstream?.terminate(); this.sockets.delete(socket); };
    socket.once('close', stop); socket.on('error', stop);
    try {
      const { binding, admission } = await this.admit(request);
      if (socket.readyState !== WebSocket.OPEN) return;
      const url = new URL('api/remote.mux', binding.url); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      upstream = new WebSocket(url, { headers: { cookie: binding.cookie, origin: new URL(binding.url).origin }, maxPayload: this.options.maxBodyBytes ?? 32 * 1024 * 1024 });
      const native = upstream;
      let eventsClientId = '';
      let queue = Promise.resolve();
      handler = (data, binary) => {
        queue = queue.then(async () => {
          if (socket.readyState !== WebSocket.OPEN || binary || !this.stillCurrent(binding) || admission.expiresAt <= Date.now()) throw fail('Native socket admission expired');
          const value = JSON.parse(data.toString()) as { type?: string; streamId?: string; endpoint?: string; payload?: { args?: Record<string, unknown> } };
          if (typeof value.streamId !== 'string' || value.streamId.length < 1 || value.streamId.length > 256) throw fail('Invalid native stream identity');
          if (value.type === 'open') {
            if (typeof value.endpoint !== 'string' || !STREAMS.has(value.endpoint)) throw fail('Native mux endpoint is outside the fixed stream catalog');
            validateDshArgs(value.endpoint, value.payload?.args);
            const follow = value.payload?.args?.['request'] as { activate?: boolean } | undefined;
            if (value.endpoint === 'session/follow' && follow?.activate === true && !this.httpWritable()) follow.activate = false;
            else if (value.endpoint === 'terminal/retain' || value.endpoint === 'session/follow' && follow?.activate === true || value.endpoint === 'userQuestions/attachWait') throw fail('Native stream mutations need a durable stream dispatcher', 409);
          } else if (value.type !== 'cancel') throw fail('Native mux frame is unavailable');
          const frame = JSON.stringify(value);
          this.assertCurrent(binding, admission);
          if (native.readyState === WebSocket.OPEN) { if (native.bufferedAmount > 4 * 1024 * 1024) throw fail('Native stream backpressure', 503); native.send(frame); }
          else { bufferedBytes += Buffer.byteLength(frame); if (bufferedBytes > 1024 * 1024) throw fail('Native mux opening buffer exceeded'); buffered.push({ frame, bytes: Buffer.byteLength(frame) }); }
        }).catch(() => { socket.close(1008, 'Native stream rejected'); });
      };
      for (const { data, binary } of arrivals.splice(0)) handler(data, binary);
      arrivalBytes = 0;
      native.once('open', () => {
        try { for (const { frame } of buffered.splice(0)) { this.assertCurrent(binding, admission); if (socket.readyState !== WebSocket.OPEN) throw fail('Native browser socket closed'); native.send(frame); } bufferedBytes = 0; }
        catch { socket.close(1008, 'Native surface revoked before stream dispatch'); native.terminate(); }
      });
      native.on('message', (data, binary) => {
        if (socket.readyState !== WebSocket.OPEN || !this.stillCurrent(binding)) return;
        if (!binary && !this.httpWritable()) {
          try {
            const frame = JSON.parse(data.toString()) as { value?: { type?: string; clientId?: string; eventId?: string } };
            if (frame.value?.type === 'ready' && typeof frame.value.clientId === 'string') eventsClientId = frame.value.clientId;
            if (frame.value?.type === 'waterfall' && eventsClientId !== '' && typeof frame.value.eventId === 'string') {
              // A read-only browser observer must not capture an approval or
              // question away from another native answerer. Native next is
              // transport delegation, never a fabricated result/approval.
              void this.delegateReadonly(binding, eventsClientId, frame.value.eventId).catch(() => socket.close(1011, 'Native observer delegation failed'));
              return;
            }
          } catch { /* Non-event stream data keeps its native bytes. */ }
        }
        if (socket.bufferedAmount > 4 * 1024 * 1024) { socket.close(1013, 'Native stream backpressure'); return; }
        socket.send(data, { binary });
      });
      native.once('error', () => socket.close(1011, 'Native Host connection failed'));
      native.once('close', () => socket.close(1012, 'Native Host disconnected'));
      const check = setInterval(() => {
        if (!this.stillCurrent(binding) || admission.expiresAt <= Date.now()) { socket.close(1008, 'Native surface revoked'); return; }
        void this.currentBinding().catch(() => socket.close(1008, 'Native surface revoked'));
      }, 5000); check.unref(); socket.once('close', () => clearInterval(check));
    } catch { socket.close(1008, 'Native surface authentication rejected'); }
  }
  private async delegateReadonly(binding: Binding, clientId: string, eventId: string): Promise<void> {
    if (!this.stillCurrent(binding)) return;
    const args = { clientId, eventId, outcome: { kind: 'next' } }; validateDshArgs('$events/result', args);
    const rpcId = randomBytes(16).toString('hex');
    const response = await fetch(new URL('api/$events/result', binding.url), { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: { cookie: binding.cookie, origin: new URL(binding.url).origin, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: '$events/result', payload: { args } }),
    });
    if (!response.ok) throw fail('Native observer delegation failed', 502);
    const receipt = JSON.parse(await boundedHtml(response)) as { type?: string; rpcId?: string; result?: { ok?: boolean } };
    if (receipt.type !== 'server-response' || receipt.rpcId !== rpcId || receipt.result?.ok !== true) throw fail('Native observer delegation was not acknowledged', 502);
  }
}

export async function createDshNativeSurface(options: DshNativeSurfaceOptions): Promise<DshNativeSurface> {
  const surface = new DshNativeSurface(options); await surface.initialize(); return surface;
}
