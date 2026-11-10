import { join } from 'node:path';
import type { AgentAdapter } from '@webdcc/protocol';
import { buildApp } from './app.js';
import { loadConfig, tokenUrl, type Config } from './config.js';
import { openDb } from './db.js';
import { FileStore } from './files.js';
import { SessionManager } from './manager.js';
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
}

export async function start(config: Config = loadConfig(), options: ServerOptions = {}): Promise<RunningServer> {
  const file = config.dataDir === ':memory:' ? ':memory:' : join(config.dataDir, 'webdcc.db');
  const db = openDb(file);
  const store = new Store(db);
  const files = new FileStore(config.dataDir, store);
  await files.init();
  const manager = new SessionManager(store, { idleDisposeMin: config.idleDisposeMin });

  for (const adapter of options.adapters ?? []) manager.registerAdapter(adapter);

  const { app, hub } = await buildApp({
    config,
    store,
    files,
    manager,
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
  const { adapters } = await import('./adapters.js');
  const server = await start(config, { adapters: await adapters() });
  process.stdout.write(`webdcc: ${server.url}\n`);
  const stop = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
