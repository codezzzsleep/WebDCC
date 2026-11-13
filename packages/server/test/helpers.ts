import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAdapter, type FakeAdapterOptions } from '@webdcc/fake-adapter';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { issueCookie } from '../src/auth.js';
import type { Config } from '../src/config.js';
import { openDb, type Db } from '../src/db.js';
import { FileStore } from '../src/files.js';
import { SessionManager } from '../src/manager.js';
import { ProviderRegistry } from '../src/providers.js';
import { DshConnectionStore } from '../src/dsh-connection.js';
import { Store } from '../src/store.js';
import { isolatedEnv, assertTestIsolation } from '../src/test-isolation.js';

export const TEST_TOKEN = 'test-token-0123456789abcdef0123456789abcdef';

export interface TestApp {
  app: FastifyInstance;
  store: Store;
  manager: SessionManager;
  files: FileStore;
  config: Config;
  dsh: DshConnectionStore;
  dataDir: string;
  cookie: string;
  close: () => Promise<void>;
}

// 单测也走同一套隔离（SPEC-M8 1.6.2）：绝不读取用户真实的 ~/.codex、~/.claude、~/.dsh
process.env['PLAYWRIGHT_BROWSERS_PATH'] ??= join(homedir(), '.cache', 'ms-playwright');
const isolated = isolatedEnv(process.env, 'wdcc-unit-test');
for (const key of ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'DSH_HOME'] as const) {
  process.env[key] = isolated.env[key];
}
process.env['WDCC_TEST_HOOKS'] = '1';
assertTestIsolation(process.env);

export async function createTestApp(adapterOptions: FakeAdapterOptions = {}, token: string = TEST_TOKEN, configPatch: Partial<Config> = {}): Promise<TestApp> {
  const dataDir = await mkdtemp(join(tmpdir(), 'wdcc-test-'));
  const db: Db = openDb(':memory:');
  const store = new Store(db);
  const files = new FileStore(dataDir, store);
  await files.init();
  const providers = new ProviderRegistry(store, dataDir);
  await providers.init();
  const manager = new SessionManager(store, { idleDisposeMin: 0, watchdogDataDir: dataDir, resolveProvider: (id) => providers.runtimeConfig(id) });
  manager.registerAdapter(new FakeAdapter(adapterOptions));
  manager.registerAdapter(new FakeAdapter({ ...adapterOptions, id: 'codex' }));
  manager.registerAdapter(new FakeAdapter({ ...adapterOptions, id: 'claude-code' }));

  const config: Config = {
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir,
    dshPort: 0,
    idleDisposeMin: 0,
    version: 'test',
    ...configPatch,
  };

  const dsh = new DshConnectionStore(dataDir);
  await dsh.init();
  const { app, hub } = await buildApp({ config, store, files, manager, providers, dsh });
  manager.setHooks({
    onFeed: (sessionId, patch, feedSeq) => hub.broadcastFeed(sessionId, patch, feedSeq),
    onEvent: (event) => hub.broadcastEvent(event),
    onDelta: (sessionId, itemKey, field, append) => hub.broadcastDelta(sessionId, itemKey, field, append),
    onUpdate: (sessionId, itemKey, data, turnId) => hub.broadcastUpdate(sessionId, itemKey, data, turnId),
    onStatus: () => undefined,
  });
  await app.ready();

  return {
    app,
    store,
    manager,
    files,
    config,
    dsh,
    dataDir,
    cookie: `wdcc-auth=${issueCookie(token)}`,
    async close() {
      await manager.disposeAll();
      await app.close();
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** 造一个工作区 + 会话，返回 id */
export async function seedWorkspaceAndSession(ctx: TestApp, agent = 'dsh', reasoningEffort?: string): Promise<{ workspaceId: string; sessionId: string }> {
  const path = join(ctx.dataDir, `ws-${randomBytes(4).toString('hex')}`);
  await mkdir(path, { recursive: true });
  const workspace = ctx.store.createWorkspace('测试工作区', path);
  const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: agent as never, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) });
  return { workspaceId: workspace.id, sessionId: session.id };
}
