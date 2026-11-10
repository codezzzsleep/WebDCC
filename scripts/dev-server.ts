/**
 * 本地开发用的服务端入口：注册 fake-adapter（无需任何真实 Agent）。
 * 用法：pnpm dev:server
 */
import { createFakeAdapters } from '../packages/testing/fake-adapter/src/index.js';
import { loadConfig } from '../packages/server/src/config.js';
import { start } from '../packages/server/src/main.js';

const config = loadConfig();
const server = await start(config, { adapters: createFakeAdapters({ delayMs: 30 }) });
process.stdout.write(`webdcc(dev, fake adapters): ${server.url}\n`);
const stop = (): void => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
