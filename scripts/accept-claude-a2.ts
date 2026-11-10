/**
 * A2（Claude 部分）：通过 adapter 启动的会话仍然加载用户自己的 .mcp.json 与 hooks。
 * 用法：npx tsx scripts/accept-claude-a2.ts
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { ClaudeAdapter } from '../packages/adapters/claude/src/adapter.js';
import { startAnthropicMock } from '../packages/testing/mock-models/src/anthropic-server.js';
import { start } from '../packages/server/src/main.js';
import type { Plan } from '../packages/testing/mock-models/src/plan.js';

const plan = JSON.parse(readFileSync('packages/testing/mock-models/plans/probe.json', 'utf8')) as Plan;
const mock = await startAnthropicMock({ plan, port: 0, log: () => undefined });
const dataDir = await mkdtemp(join(tmpdir(), 'wdcc-claude-a2-'));
const workspace = await mkdtemp(join(tmpdir(), 'wdcc-claude-a2-ws-'));
const configDir = await mkdtemp(join(tmpdir(), 'wdcc-claude-a2-home-'));
const marker = join(workspace, 'hook-fired.txt');

const MCP = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const say = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') return say(msg.id, { protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'wdccecho', version: '0' } });
  if (msg.method === 'tools/list') return say(msg.id, { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });
  if (msg.method === 'notifications/initialized') return;
  if (msg.id !== undefined) say(msg.id, {});
});
`;
await mkdir(join(workspace, '.claude'), { recursive: true });
await writeFile(join(workspace, 'mcp-server.cjs'), MCP, 'utf8');
await writeFile(
  join(workspace, '.mcp.json'),
  JSON.stringify({ mcpServers: { wdccecho: { type: 'stdio', command: process.execPath, args: [join(workspace, 'mcp-server.cjs')] } } }, null, 2),
  'utf8',
);
await writeFile(
  join(workspace, '.claude/settings.json'),
  JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `printf 'fired\\n' >> ${marker}` }] }] } }, null, 2),
  'utf8',
);

const adapter = new ClaudeAdapter({
  env: { ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'mock-key', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CONFIG_DIR: configDir },
});
const server = await start(
  { host: '127.0.0.1', port: 0, token: 't', dataDir, dshPort: 0, idleDisposeMin: 0, version: 'a2' },
  { adapters: [adapter] },
);

async function waitFor(predicate: () => boolean, timeoutMs = 90_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

const workspaceRow = server.store.createWorkspace('ws', workspace);
const session = await server.manager.createSession({ workspaceId: workspaceRow.id, agent: 'claude-code', accessMode: 'acceptEdits' });
const autoTimer = setInterval(() => {
  void (async () => {
    for (const event of server.store.allEvents(session.id)) {
      if (event.kind !== 'approval.request') continue;
      const approvalId = (event.data as { approvalId: string }).approvalId;
      if (server.store.hasApprovalResolved(session.id, approvalId)) continue;
      await server.manager.approve(session.id, { approvalId, optionId: 'allow' }).catch(() => undefined);
    }
  })();
}, 300);

server.manager.send(session.id, { text: '说一句话' });
await waitFor(() => server.store.allEvents(session.id).some((event) => event.kind === 'turn.completed'));
clearInterval(autoTimer);

const all = server.store.allEvents(session.id);
for (const event of server.store.allEvents(session.id).filter((item) => item.kind === 'error')) console.log('  error:', JSON.stringify(event.data).slice(0, 300));
console.log('  kinds:', [...new Set(all.map((event) => event.kind))].join(','));
console.log('  internal:', all.filter((event) => event.kind === 'internal').map((event) => (event.data as { nativeType: string }).nativeType).join(','));
console.log('  native 有值的 internal:', all.filter((event) => event.kind === 'internal' && event.native !== undefined).length);
const initEvent = all.find((event) => event.kind === 'internal' && (event.data as { nativeType: string }).nativeType === 'system/init');
const init = initEvent?.native as { tools?: string[]; mcp_servers?: { name?: string; status?: string }[]; slash_commands?: string[] } | undefined;
const tools = init?.tools ?? [];
const servers = init?.mcp_servers ?? [];
const hookContent = await readFile(marker, 'utf8').catch(() => '');

const okMcp = servers.some((server) => server.name === 'wdccecho');
const okTool = tools.some((tool) => tool.includes('mcp__wdccecho'));
const okHooks = hookContent.includes('fired');
const okSlash = (init?.slash_commands ?? []).length > 0;

console.log(`mcp_servers: ${JSON.stringify(servers)}`);
console.log(`MCP 工具出现在 tools 里: ${okTool}`);
console.log(`hooks 生效: ${okHooks}`);
console.log(`斜杠命令数: ${init?.slash_commands?.length ?? 0}`);
console.log(`工具总数: ${tools.length}`);

await server.close();
await mock.close();
await rm(dataDir, { recursive: true, force: true });
await rm(workspace, { recursive: true, force: true });
await rm(configDir, { recursive: true, force: true });
process.exit(okMcp && okTool && okHooks && okSlash ? 0 : 1);
