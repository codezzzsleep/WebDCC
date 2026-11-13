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
import { assertTestIsolation } from './test-isolation.js';
import { discoverRunningDsh } from './dsh-discovery.js';
import { attachToDsh } from '@webdcc/adapter-dsh';
import { InteractionRecorder } from './interaction-recorder.js';
import { ModelRecording } from './model-recording.js';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  recorder?: InteractionRecorder;
}

export async function start(config: Config = loadConfig(), options: ServerOptions = {}): Promise<RunningServer> {
  // 测试模式下先检查家目录隔离，必须在任何配置扫描之前（SPEC-M8 1.6.2 / S-04）
  assertTestIsolation();
  const file = config.dataDir === ':memory:' ? ':memory:' : join(config.dataDir, 'webdcc.db');
  const db = openDb(file);
  const store = new Store(db);
  const files = new FileStore(config.dataDir, store);
  await files.init();
  const providers = new ProviderRegistry(store, config.dataDir);
  await providers.init();
  const dshStore = new DshConnectionStore(config.dataDir);
  await dshStore.init();
  const recorder = config.recordInteractions === false || config.dataDir === ':memory:' || process.env['WDCC_TEST_HOOKS'] === '1' ? undefined : new InteractionRecorder(config.dataDir);
  await recorder?.init();
  recorder?.addSecret(config.token);
  const modelRecording = recorder === undefined ? undefined : new ModelRecording(recorder);
  const manager = new SessionManager(store, {
    idleDisposeMin: config.idleDisposeMin,
    watchdogDataDir: config.dataDir,
    resolveProvider: (id) => providers.runtimeConfig(id),
    saveDiff: (name, diff) => files.putBufferSync(Buffer.from(diff, 'utf8'), name, 'text/x-diff').id,
    recorder,
    modelRecording,
  });

  let adapters = options.adapters;
  if (adapters === undefined) {
    const { adapters: build } = await import('./adapters.js');
    let connection = dshStore.connection;
    const requestedMode = process.env['WDCC_DSH_MODE'] ?? 'auto';
    let dshMode: 'attach' | 'spawn' = requestedMode === 'spawn' ? 'spawn' : 'attach';

    // DSH's launch token exists only in its process memory. For a local
    // systemd-managed DSH, discover the startup URL from its journal and
    // exchange it immediately; the user only sees the manual fallback when
    // discovery is unavailable.
    if (process.env['WDCC_ENABLE_DSH'] !== '0' && requestedMode !== 'spawn') {
      const discovered = await discoverRunningDsh({ service: process.env['WDCC_DSH_SERVICE'] }).catch(() => null);
      if (discovered !== null) {
        try {
          const cookie = await attachToDsh(discovered.origin, discovered.token);
          connection = {
            url: discovered.origin,
            cookie,
            connectedAt: new Date().toISOString(),
          };
          await dshStore.save(connection);
        } catch (error) {
          process.stderr.write(`webdcc: 自动连接 DSH 失败：${error instanceof Error ? error.message : String(error)}\n`);
        }
      } else if (connection === null && requestedMode === 'auto') {
        dshMode = 'spawn';
      }
    }
    adapters = await build({
      ...(recorder === undefined ? {} : { traceSink: (sessionId: string) => recorder.sink(sessionId), nativeRecorder: { directory: recorder.directory, module: process.env['WDCC_NATIVE_RECORDER_MODULE'] ?? join(dirname(fileURLToPath(import.meta.url)), 'native-http-recorder.cjs') } }),
      dsh: {
        mode: dshMode,
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
    recorder,
    webDist: options.webDist ?? process.env['WDCC_WEB_DIST'] ?? join(process.cwd(), 'packages/web/dist'),
    commit: process.env['WDCC_COMMIT'] ?? 'dev',
    builtAt: process.env['WDCC_BUILT_AT'] ?? new Date().toISOString(),
  });

  manager.setHooks({
    onFeed: (sessionId, patch, feedSeq) => hub.broadcastFeed(sessionId, patch, feedSeq),
    onEvent: (event) => hub.broadcastEvent(event),
    onDelta: (sessionId, itemKey, field, append) => hub.broadcastDelta(sessionId, itemKey, field, append),
    onUpdate: (sessionId, itemKey, data, turnId) => hub.broadcastUpdate(sessionId, itemKey, data, turnId),
    onStatus: () => undefined,
  });

  await app.listen({ host: config.host, port: config.port });
  if (config.port === 0) {
    const address = app.server.address();
    if (address !== null && typeof address !== 'string') config.port = address.port;
  }
  // F16：启动时只读扫描一次本机配置并导入 Provider
  const scan = await providers.scanLocal().catch(() => ({ imported: 0, skipped: 0 }));
  if (scan.imported > 0) process.stdout.write(`webdcc: 从本机导入了 ${scan.imported} 个 Provider\n`);
  store.pruneCommands();

  return {
    url: tokenUrl(config),
    config,
    store,
    manager,
    recorder,
    async close() {
      await manager.disposeAll();
      await app.close();
      await recorder?.flush();
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
  let server: RunningServer;
  try {
    server = await start(loadConfig());
  } catch (error) {
    process.stderr.write(`webdcc: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  process.stdout.write(`webdcc: ${server.url}\n`);
  const stop = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
