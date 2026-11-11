/**
 * e2e 专用服务端：三个 fake adapter，dsh/codex 正常完成，claude-code 会请求审批。
 * 通过 /?token=e2e-token 登录。
 */
import { mkdir } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { loadConfig } from '../packages/server/src/config.js';
import { start } from '../packages/server/src/main.js';

// 测试隔离（SPEC-M8 1.4）：绝不读取用户真实的 ~/.codex、~/.claude、~/.dsh
const isolatedHome = mkdtempSync(join(tmpdir(), 'wdcc-e2e-home-'));
const isolatedCodex = mkdtempSync(join(tmpdir(), 'wdcc-e2e-codex-'));
const isolatedClaude = mkdtempSync(join(tmpdir(), 'wdcc-e2e-claude-'));
process.env['HOME'] = isolatedHome;
process.env['CODEX_HOME'] = isolatedCodex;
process.env['CLAUDE_CONFIG_DIR'] = isolatedClaude;

const config = loadConfig();
const adapters = [
  new FakeAdapter({ id: 'dsh', delayMs: 2, itemsPerTurn: 95, injectUnknown: true, injectInternal: true }),
  new FakeAdapter({ id: 'codex', delayMs: 4, itemsPerTurn: 20 }),
  new FakeAdapter({ id: 'claude-code', delayMs: 20, itemsPerTurn: 4, injectApproval: true, injectQuestion: true }),
];
const server = await start(config, { adapters });

// 播种一个工作区，供 e2e 直接新建会话
const workspaceDir = '/tmp/wdcc-e2e-workspace';
await mkdir(workspaceDir, { recursive: true });
if (server.store.listWorkspaces().length === 0) {
  server.store.createWorkspace('e2e 工作区', workspaceDir);
}
process.stdout.write(`e2e server: ${server.url}\n`);
const stop = (): void => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
