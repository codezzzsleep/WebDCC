/**
 * M8 真实界面验收套件的环境（SPEC-M8 6.2）。
 * 所有目录都在 $TMPDIR/wdcc-accept-<runId>/ 下；端口动态分配。
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile as readText, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { FullConfig } from '@playwright/test';
import { startAnthropicMock } from '../packages/testing/mock-models/src/anthropic-server.js';
import { startResponsesMock } from '../packages/testing/mock-models/src/responses-server.js';
import { MockControl } from '../packages/testing/mock-models/src/mock-control.js';
import { DshHostClient, startSidecar } from '../packages/adapters/dsh/src/host.js';

export interface RunInfo {
  runId: string;
  root?: string;
  baseURL: string;
  token: string;
  dirs: Record<string, string>;
  mocks: { responses: string; anthClaude: string; anthDsh: string };
  slugs: { a: string; b: string };
  serverPid: number;
  externalDsh?: { url: string; port: number; home: string; sessionId: string; workspaceId: string; pid: number };
}

const PLANS_DIR = join(process.cwd(), 'packages/testing/mock-models/plans');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address !== null ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

async function hashFile(path: string): Promise<string> {
  try {
    return createHash('sha256').update(await readText(path)).digest('hex');
  } catch {
    return 'missing';
  }
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const runId = `r${Date.now().toString(36)}`;
  const root = await mkdtemp(join(tmpdir(), `wdcc-accept-${runId}-`));
  const dirs = {
    home: join(root, 'home'),
    codexHome: join(root, 'codex'),
    claudeConfig: join(root, 'claude'),
    dshHome: join(root, 'dsh'),
    data: join(root, 'data'),
    ws: join(root, 'ws'),
    shots: join(root, 'shots'),
  };
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });

  // 工作区 fixture
  const repo = join(dirs.ws, 'sample-repo');
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(
    join(repo, 'README.md'),
    ['# Sample Repo', '', 'WDCC-M8 sample workspace.', 'line to modify: ORIGINAL', 'src/hello.ts contains a greeting.', ''].join('\n'),
  );
  await writeFile(join(repo, 'SPEC.md'), '# Spec\n\n样例项目。\n');
  await writeFile(join(repo, 'src/hello.ts'), 'export const hello = (): string => "hello";\n');
  await writeFile(join(repo, 'AGENTS.md'), `# Agents\n\n回答里必须包含标记 WDCC-AGENTS-MARKER-${runId}。\n`);
  await writeFile(join(repo, 'CLAUDE.md'), `# Claude\n\n回答里必须包含标记 WDCC-CLAUDE-MARKER-${runId}。\n`);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'WebDCC Test'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });

  // 假模型
  const responses = await startResponsesMock({ plan: [], port: 0, plansDir: PLANS_DIR, control: new MockControl([], PLANS_DIR), log: () => undefined });
  const anthClaude = await startAnthropicMock({ plan: [], port: 0, plansDir: PLANS_DIR, control: new MockControl([], PLANS_DIR), log: () => undefined });
  const anthDsh = await startAnthropicMock({ plan: [], port: 0, plansDir: PLANS_DIR, control: new MockControl([], PLANS_DIR), log: () => undefined });

  const slugs = { a: 'gpt-5', b: 'gpt-5-mini' };
  await writeFile(
    join(dirs.codexHome, 'config.toml'),
    `model = "${slugs.a}"\nmodel_provider = "mockr"\n\n[model_providers.mockr]\nname = "Mock Responses"\nbase_url = "${responses.url}/v1"\nwire_api = "responses"\nenv_key = "WDCC_TEST_MOCKR_KEY"\n\n[model_providers.mockr2]\nname = "Mock Responses 2"\nbase_url = "${responses.url}/v2"\nwire_api = "responses"\nenv_key = "WDCC_TEST_MOCKR2_KEY_MISSING"\n\n[profiles.alt]\nmodel_provider = "mockr"\nmodel = "${slugs.b}"\n`,
  );
  await writeFile(
    join(dirs.claudeConfig, 'settings.json'),
    JSON.stringify(
      { env: { ANTHROPIC_BASE_URL: anthClaude.url, ANTHROPIC_AUTH_TOKEN: `sk-wdcc-test-claude-${runId}`, ANTHROPIC_MODEL: 'mock-claude-a' } },
      null,
      2,
    ),
  );

  // 外部 DSH（模拟用户自己正在跑的那个），用临时 DSH_HOME
  const externalHome = join(root, 'external-dsh');
  await mkdir(externalHome, { recursive: true });
  const external = await startSidecar({
    port: await freePort(),
    env: { ...process.env, DSH_HOME: externalHome, DEEPSEEK_BASE_URL: anthDsh.url, DEEPSEEK_API_KEY: `sk-wdcc-test-dsh-${runId}` },
  });
  const externalClient = new DshHostClient(external.port);
  await externalClient.authenticate(external.tokenUrl);
  const externalWorkspace = await externalClient.rpc<{ workspace: { workspaceId: string } }>('workspace/create', { request: { path: repo } });
  const externalSession = await externalClient.rpc<{ sessionId: string }>('session/create', {
    request: { workspaceId: externalWorkspace.workspace.workspaceId },
  });
  await externalClient.close();

  // 服务端（attach 模式连外部 DSH）
  const port = await freePort();
  const dshPort = await freePort();
  const token = `t${createHash('sha256').update(runId).digest('hex').slice(0, 24)}`;
  const env = {
    ...process.env,
    HOME: dirs.home,
    CODEX_HOME: dirs.codexHome,
    CLAUDE_CONFIG_DIR: dirs.claudeConfig,
    DSH_HOME: dirs.dshHome,
    WDCC_DATA_DIR: dirs.data,
    WDCC_HOST: '127.0.0.1',
    WDCC_PORT: String(port),
    WDCC_TOKEN: token,
    WDCC_DSH_MODE: 'attach',
    WDCC_DSH_URL: `http://127.0.0.1:${external.port}`,
    WDCC_DSH_PORT: String(dshPort),
    WDCC_TEST_HOOKS: '1',
    WDCC_TEST_MOCKR_KEY: `sk-wdcc-test-mockr-${runId}`,
    WDCC_TEST_MOCKR2_KEY_MISSING: '',
    DEEPSEEK_BASE_URL: anthDsh.url,
    DEEPSEEK_API_KEY: `sk-wdcc-test-dsh-${runId}`,
    NO_COLOR: '1',
  };
  const { spawn } = await import('node:child_process');
  const serverLog = await import('node:fs').then((fs) => fs.openSync(join(root, 'server.log'), 'a'));
  const child = spawn('node', ['packages/server/dist/main.js'], { cwd: process.cwd(), env, stdio: ['ignore', serverLog, serverLog] });
  const baseURL = `http://127.0.0.1:${port}`;
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(`${baseURL}/api/meta`, { headers: { cookie: '' } });
      if (response.status === 401) break;
    } catch {
      // 继续等
    }
    if (Date.now() - started > 30_000) throw new Error('服务端 30 秒内没有起来');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // 把工作区注册进 WebDCC
  const authResponse = await fetch(`${baseURL}/?token=${token}`, { redirect: 'manual' });
  const cookie = (authResponse.headers.getSetCookie()[0] ?? '').split(';')[0] ?? '';
  // 首次连接外部 DSH（DSHX-00 里也会再走一遍设置页）
  const connectResponse = await fetch(`${baseURL}/api/dsh/connect`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ link: external.tokenUrl }),
  });
  if (!connectResponse.ok) throw new Error(`连接外部 DSH 失败：${connectResponse.status} ${await connectResponse.text()}`);
  const created = await fetch(`${baseURL}/api/workspaces`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'sample-repo', path: repo }),
  });
  if (!created.ok) throw new Error(`注册工作区失败：${created.status}`);

  // 用户真实配置的哈希（FIN-04）
  const userHashes = {
    codex: await hashFile(join(homedir(), '.codex/config.toml')),
    claude: await hashFile(join(homedir(), '.claude/settings.json')),
    dshProfile: await hashFile(join(homedir(), '.dsh/cordis.patch.yml')),
    dshCreds: await hashFile(join(homedir(), '.dsh/.credentials.yaml')),
  };
  const info: RunInfo = {
    runId,
    baseURL,
    token,
    dirs,
    mocks: { responses: responses.url, anthClaude: anthClaude.url, anthDsh: anthDsh.url },
    slugs,
    serverPid: child.pid ?? 0,
    externalDsh: { url: external.tokenUrl, port: external.port, home: externalHome, sessionId: externalSession.sessionId, workspaceId: externalWorkspace.workspace.workspaceId, pid: external.child.pid ?? 0 },
  };
  await writeFile(join(root, 'run.json'), JSON.stringify({ ...info, userHashes }, null, 2));
  await writeFile(join(process.cwd(), 'e2e-real/.run.json'), JSON.stringify({ root, ...info, userHashes }, null, 2));
  process.env['WDCC_ACCEPT_ROOT'] = root;
  process.stdout.write(`[m8] runId=${runId} root=${root} baseURL=${baseURL}\n`);

  // 关闭动作交给 globalTeardown（按 PID 结束本套件自己启动的进程）
  void [responses.close, anthClaude.close, anthDsh.close];
}
