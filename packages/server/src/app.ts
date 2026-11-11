import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { authorityOf, authState, cookieHeaderValue, cookieNameFor, isAuthenticated, issueCookie, tokenEquals } from './auth.js';
import type { Config } from './config.js';
import { CommandDispatcher } from './dispatcher.js';
import type { FileStore } from './files.js';
import { LiveHub } from './hub.js';
import type { SessionManager } from './manager.js';
import type { ProviderRegistry } from './providers.js';
import type { DshConnectionStore } from './dsh-connection.js';
import { registerRoutes, sendJsonError } from './rest.js';
import type { Store } from './store.js';

export interface BuildAppOptions {
  config: Config;
  store: Store;
  files: FileStore;
  manager: SessionManager;
  providers: ProviderRegistry;
  dsh: DshConnectionStore;
  webDist?: string;
}

export interface BuiltApp {
  app: FastifyInstance;
  hub: LiveHub;
  dispatcher: CommandDispatcher;
}

const UNAUTHORIZED_HTML = `<!doctype html><meta charset="utf-8"><title>WebDCC</title>
<body style="font-family:system-ui;padding:48px;line-height:1.7">
<h1>WebDCC</h1>
<p>请用启动时打印的带 token 链接打开本页（终端里的 <code>dsh</code> 风格提示行）。</p>
</body>`;

/** 过渡期：合法但旧名字的 Cookie 换发按 Host 派生的新名字（F18） */
function reissueIfLegacy(token: string, request: FastifyRequest, reply: FastifyReply, authority: string): void {
  if (authState(token, request.headers.cookie, authority) !== 'legacy') return;
  reply.header('set-cookie', cookieHeaderValue(cookieNameFor(authority), issueCookie(token)));
}

export async function buildApp(options: BuildAppOptions): Promise<BuiltApp> {
  const { config, store, files, manager } = options;
  const app = Fastify({ logger: false, bodyLimit: 200 * 1024 * 1024, trustProxy: true });
  const dispatcher = new CommandDispatcher(store, manager, files);
  const hub = new LiveHub(store, manager, dispatcher, config.token, `${config.host}:${config.port}`);

  await app.register(websocket);

  app.addHook('onRequest', async (request, reply) => {
    const path = (request.url.split('?')[0] ?? '/').replace(/\/+$/, '') || '/';
    const protectedPath = path.startsWith('/api/') || path === '/api' || path.startsWith('/files/');
    if (!protectedPath) return;
    if (path === '/api/ws') return; // WS 自己在 upgrade 后校验（hub.attach）
    const authority = authorityOf(request.headers, config.host, config.port);
    if (!isAuthenticated(config.token, request.headers.cookie, authority)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }
    return undefined;
  });

  // 用 token 换 Cookie（SPEC 12.1）
  app.get('/', async (request, reply) => {
    const query = request.query as { token?: string };
    const authority = authorityOf(request.headers, config.host, config.port);
    if (typeof query.token === 'string' && query.token !== '') {
      if (!tokenEquals(config.token, query.token)) return reply.status(403).type('text/html').send(UNAUTHORIZED_HTML);
      reply.header('set-cookie', cookieHeaderValue(cookieNameFor(authority), issueCookie(config.token)));
      return reply.redirect('/', 302);
    }
    if (options.webDist !== undefined && existsSync(join(options.webDist, 'index.html'))) {
      if (!isAuthenticated(config.token, request.headers.cookie, authority)) return reply.status(401).type('text/html').send(UNAUTHORIZED_HTML);
      reissueIfLegacy(config.token, request, reply, authority);
      return reply.type('text/html').sendFile('index.html');
    }
    if (!isAuthenticated(config.token, request.headers.cookie, authority)) return reply.status(401).type('text/html').send(UNAUTHORIZED_HTML);
    reissueIfLegacy(config.token, request, reply, authority);
    return reply
      .type('text/html')
      .send('<!doctype html><meta charset="utf-8"><title>WebDCC</title><body style="font-family:system-ui;padding:48px"><h1>WebDCC</h1><p>服务端已就绪。前端（M2）尚未构建。</p>');
  });

  if (options.webDist !== undefined && existsSync(options.webDist)) {
    await app.register(fastifyStatic, {
      root: options.webDist,
      prefix: '/',
      wildcard: false,
      index: false,
    });
  }

  registerRoutes(app, { store, files, manager, hub, dispatcher, version: config.version, providers: options.providers, dsh: options.dsh });
  hub.attach(app);

  app.setErrorHandler((error, _request, reply) => sendJsonError(reply, error));

  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split('?')[0] ?? '/';
    if (path.startsWith('/api/') || path.startsWith('/files/')) return reply.status(404).send({ error: 'not found' });
    if (options.webDist !== undefined && existsSync(join(options.webDist, 'index.html'))) {
      if (!isAuthenticated(config.token, request.headers.cookie, authorityOf(request.headers, config.host, config.port))) {
        return reply.status(401).send({ error: 'unauthorized' });
      }
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.status(404).send({ error: 'not found' });
  });

  return { app, hub, dispatcher };
}
