/**
 * A2（Codex 部分）：平台用的启动参数不会改变 Codex 的能力清单。
 * 对比"直接运行 codex app-server"与"用 adapter 的 buildLaunchSpec 参数"：
 *   skills/list、mcpServerStatus/list、thread/start 的 instructionSources 三者应一致。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { JsonRpcStdio } from '../packages/adapters/codex/src/rpc.js';

const workspace = await mkdtemp(join(tmpdir(), 'wdcc-a2-ws-'));
const codexHome = await mkdtemp(join(tmpdir(), 'wdcc-a2-home-'));
await writeFile(join(workspace, 'AGENTS.md'), '# 本仓库约定\n\n回答时必须以 MARKER-A2 开头。\n', 'utf8');

const adapter = new CodexAdapter();
const baseOpts = { sessionId: 'a2', cwd: workspace, providerId: null, accessMode: 'workspace' };
const adapterSpec = adapter.buildLaunchSpec(baseOpts);

async function probe(command: string, args: string[]): Promise<{ skills: unknown; mcp: unknown; instructions: string[] }> {
  const rpc = JsonRpcStdio.start({ command, args, cwd: workspace, env: { ...process.env, CODEX_HOME: codexHome } });
  await rpc.request('initialize', { clientInfo: { name: 'webdcc', title: 'A2', version: '0' }, capabilities: null });
  rpc.notify('initialized');
  const skills = await rpc.request('skills/list', { cwds: [workspace] }).catch((error: unknown) => ({ error: String(error) }));
  const mcp = await rpc.request('mcpServerStatus/list', {}).catch((error: unknown) => ({ error: String(error) }));
  const started = await rpc.request<{ instructionSources?: string[] }>('thread/start', { cwd: workspace });
  await rpc.kill();
  return { skills, mcp, instructions: started.instructionSources ?? [] };
}

const plain = await probe('codex', ['app-server']);
const viaAdapter = await probe(adapterSpec.command ?? 'codex', adapterSpec.args ?? []);

const sameSkills = JSON.stringify(plain.skills) === JSON.stringify(viaAdapter.skills);
const sameMcp = JSON.stringify(plain.mcp) === JSON.stringify(viaAdapter.mcp);
const sameInstructions = JSON.stringify(plain.instructions) === JSON.stringify(viaAdapter.instructions);
const hasAgentsMd = viaAdapter.instructions.some((path) => path.includes('AGENTS.md'));

console.log(`skills/list 一致：${sameSkills}`);
console.log(`mcpServerStatus/list 一致：${sameMcp}`);
console.log(`instructionSources 一致：${sameInstructions}（${viaAdapter.instructions.length} 项）`);
console.log(`AGENTS.md 被加载：${hasAgentsMd}`);
console.log(`adapter 启动参数：${(adapterSpec.args ?? []).join(' ')}`);

await rm(workspace, { recursive: true, force: true });
await rm(codexHome, { recursive: true, force: true });
process.exit(sameSkills && sameMcp && sameInstructions && hasAgentsMd ? 0 : 1);
