/**
 * M0 核实：Claude Code 走 Agent SDK 时，是否真的加载了「项目 .mcp.json」和「hooks」。
 *
 * SPEC 3.2 的硬约束是：不传 `mcpServers`/`hooks` 等选项，靠原生 `settingSources`
 * 让用户自己的配置生效。这个脚本用临时项目目录验证这一点：
 *   1. 项目里放 `.mcp.json`（一个最小 stdio MCP server，提供 echo 工具）
 *   2. `.claude/settings.json` 里放一个 UserPromptSubmit hook，命令会写一个标记文件
 *   3. 用 `settingSources: ['user','project','local']` 跑一轮，检查：
 *      - 首条 system/init 的 `mcp_servers` 里出现 echo（说明 .mcp.json 生效）
 *      - hook 的标记文件出现（说明 hooks 生效）
 *
 * 用法：pnpm tsx scripts/verify-claude-native.ts
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { startAnthropicMock } from '../packages/testing/mock-models/src/anthropic-server.js';
import type { Plan } from '../packages/testing/mock-models/src/plan.js';
import { logLine } from './lib/fixtures.js';

const MCP_SERVER_SOURCE = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}
rl.on('line', (line) => {
  if (line.trim() === '') return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    respond(msg.id, {
      protocolVersion: msg.params && msg.params.protocolVersion ? msg.params.protocolVersion : '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'wdcc-echo', version: '0.0.0' },
    });
    return;
  }
  if (msg.method === 'tools/list') {
    respond(msg.id, {
      tools: [
        {
          name: 'echo',
          description: 'Echo the given text back.',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        },
      ],
    });
    return;
  }
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/call') {
    respond(msg.id, { content: [{ type: 'text', text: 'echo-ok' }] });
    return;
  }
  if (msg.id !== undefined) respond(msg.id, {});
});
`;

async function main(): Promise<void> {
  const plan: Plan = [{ text: '收到，这是原生配置验证的回复。', stopReason: 'end_turn' }];
  const mock = await startAnthropicMock({ plan, port: 0, log: () => undefined });
  const project = await mkdtemp(join(tmpdir(), 'wdcc-claude-native-'));
  const configDir = await mkdtemp(join(tmpdir(), 'wdcc-claude-config-'));
  const hookMarker = join(project, 'hook-fired.txt');

  await mkdir(join(project, '.claude'), { recursive: true });
  await writeFile(join(project, 'mcp-server.cjs'), MCP_SERVER_SOURCE, 'utf8');
  await writeFile(
    join(project, '.mcp.json'),
    JSON.stringify(
      { mcpServers: { wdccecho: { type: 'stdio', command: process.execPath, args: [join(project, 'mcp-server.cjs')] } } },
      null,
      2,
    ),
    'utf8',
  );
  await writeFile(
    join(project, '.claude/settings.json'),
    JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: `printf 'hook-fired\\n' >> ${hookMarker}` }] }],
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  logLine(`临时项目：${project}`);
  logLine(`mock-anthropic：${mock.url}`);

  const options: Options = {
    cwd: project,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['user', 'project', 'local'],
    includePartialMessages: true,
    permissionMode: 'default',
    model: 'mock-anthropic-1',
    env: {
      ...(process.env as Record<string, string>),
      ANTHROPIC_BASE_URL: mock.url,
      ANTHROPIC_API_KEY: 'mock-key-not-a-secret',
      CLAUDE_CONFIG_DIR: configDir,
    },
  };

  let init: Record<string, unknown> | undefined;
  const q = query({ prompt: '说一句话，验证原生配置是否加载。', options });
  try {
    for await (const message of q as AsyncIterable<SDKMessage>) {
      if (message.type === 'system' && message.subtype === 'init') {
        init = message as unknown as Record<string, unknown>;
        break;
      }
    }
  } finally {
    await q.close?.();
  }

  const mcpServers = (init?.['mcp_servers'] as { name?: string; status?: string }[] | undefined) ?? [];
  const tools = (init?.['tools'] as string[] | undefined) ?? [];
  const hookContent = await readFile(hookMarker, 'utf8').catch(() => '');

  const mcpLoaded = mcpServers.some((server) => server.name === 'wdccecho' || JSON.stringify(server).includes('wdccecho'));
  const mcpToolVisible = tools.some((tool) => tool.includes('wdccecho'));
  const hooksFired = hookContent.includes('hook-fired');

  logLine(`mcp_servers（init）：${JSON.stringify(mcpServers)}`);
  logLine(`工具里出现的 MCP 工具：${tools.filter((t) => t.includes('wdccecho')).join(', ') || '（无）'}`);
  logLine(`hooks 标记文件：${hooksFired ? '已生成（hooks 生效）' : '未生成（hooks 未生效）'}`);

  await mock.close();
  await rm(project, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });

  const ok = (mcpLoaded || mcpToolVisible) && hooksFired;
  logLine('');
  logLine(`结论：项目 .mcp.json ${mcpLoaded ? '已加载' : '未加载'}；hooks ${hooksFired ? '已执行' : '未执行'} → ${ok ? '通过' : '不通过'}`);
  if (!ok) process.exit(1);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`验证失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
}


