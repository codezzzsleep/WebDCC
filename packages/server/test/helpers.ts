import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
import { Store } from '../src/store.js';

export const TEST_TOKEN = 'test-token-0123456789abcdef0123456789abcdef';

export interface TestApp {
  app: FastifyInstance;
  store: Store;
  manager: SessionManager;
  files: FileStore;
  config: Config;
  dataDir: string;
  cookie: string;
  close: () => Promise<void>;
}

export async function createTestApp(adapterOptions: FakeAdapterOptions = {}, token: string = TEST_TOKEN): Promise<TestApp> {
  const dataDir = await mkdtemp(join(tmpdir(), 'wdcc-test-'));
  const db: Db = openDb(':memory:');
  const store = new Store(db);
  const files = new FileStore(dataDir, store);
  await files.init();
  const providers = new ProviderRegistry(store, dataDir);
  await providers.init();
  const manager = new SessionManager(store, { idleDisposeMin: 0, resolveProvider: (id) => providers.runtimeConfig(id) });
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
  };

  const { app, hub } = await buildApp({ config, store, files, manager, providers });
  manager.setHooks({
    onFeed: (sessionId, patch, feedSeq) => hub.broadcastFeed(sessionId, patch, feedSeq),
    onEvent: (event) => hub.broadcastEvent(event),
    onDelta: (sessionId, itemKey, field, append) => hub.broadcastDelta(sessionId, itemKey, field, append),
    onUpdate: (sessionId, itemKey, data) => hub.broadcastUpdate(sessionId, itemKey, data),
    onStatus: () => undefined,
  });
  await app.ready();

  return {
    app,
    store,
    manager,
    files,
    config,
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
export async function seedWorkspaceAndSession(ctx: TestApp, agent = 'dsh'): Promise<{ workspaceId: string; sessionId: string }> {
  const path = join(ctx.dataDir, `ws-${randomBytes(4).toString('hex')}`);
  await mkdir(path, { recursive: true });
  const workspace = ctx.store.createWorkspace('测试工作区', path);
  const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: agent as never });
  return { workspaceId: workspace.id, sessionId: session.id };
}
