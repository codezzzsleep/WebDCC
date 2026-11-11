import { join } from 'node:path';
import type { AgentAdapter } from '@webdcc/protocol';
import { buildApp } from './app.js';
import { loadConfig, tokenUrl, type Config } from './config.js';
import { openDb } from './db.js';
import { FileStore } from './files.js';
import { SessionManager } from './manager.js';
import { ProviderRegistry } from './providers.js';
import { DshConnectionStore } from './dsh-connection.js';
import { Store } from './store.js';

export interface ServerOptions {
  /** 注册到服务端的 adapter；测试注入 fake-adapter，生产由 adapters.ts 组装 */
  adapters?: AgentAdapter[];
  webDist?: string;
}

export interface RunningServer {
  close: () => Promise<void>;
  url: string;
  config: Config;
  /** 供开发/e2e 播种数据；生产代码不要依赖 */
  store: Store;
  manager: SessionManager;
}

export async function start(config: Config = loadConfig(), options: ServerOptions = {}): Promise<RunningServer> {
  const file = config.dataDir === ':memory:' ? ':memory:' : join(config.dataDir, 'webdcc.db');
  const db = openDb(file);
  const store = new Store(db);
  const files = new FileStore(config.dataDir, store);
  await files.init();
  const providers = new ProviderRegistry(store, config.dataDir);
  await providers.init();
  const dshStore = new DshConnectionStore(config.dataDir);
  await dshStore.init();
  const manager = new SessionManager(store, {
    idleDisposeMin: config.idleDisposeMin,
    resolveProvider: (id) => providers.runtimeConfig(id),
  });

  let adapters = options.adapters;
  if (adapters === undefined) {
    const { adapters: build } = await import('./adapters.js');
    const connection = dshStore.connection;
    adapters = await build({
      dsh: {
        mode: (process.env['WDCC_DSH_MODE'] === 'attach' ? 'attach' : 'spawn') as 'attach' | 'spawn',
        ...(connection === null ? {} : { url: connection.url, cookie: connection.cookie }),
      },
    });
  }
  for (const adapter of adapters) manager.registerAdapter(adapter);

  const { app, hub } = await buildApp({
    config,
    store,
    files,
    manager,
    providers,
    dsh: dshStore,
    webDist: options.webDist ?? join(process.cwd(), 'packages/web/dist'),
  });

  manager.setHooks({
    onFeed: (sessionId, patch, feedSeq) => hub.broadcastFeed(sessionId, patch, feedSeq),
    onEvent: (event) => hub.broadcastEvent(event),
    onDelta: (sessionId, itemKey, field, append) => hub.broadcastDelta(sessionId, itemKey, field, append),
    onUpdate: (sessionId, itemKey, data) => hub.broadcastUpdate(sessionId, itemKey, data),
    onStatus: () => undefined,
  });

  await app.listen({ host: config.host, port: config.port });
  store.pruneCommands();

  return {
    url: tokenUrl(config),
    config,
    store,
    manager,
    async close() {
      await manager.disposeAll();
      await app.close();
      db.close();
    },
  };
}

const isEntrypoint = ((): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === `file://${entry}` || import.meta.url.endsWith(entry.replace(/^.*?(\/packages\/)/, '$1'));
})();

if (isEntrypoint) {
  const config = loadConfig();
  const server = await start(config);
  process.stdout.write(`webdcc: ${server.url}\n`);
  const stop = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
