/** M8 验收套件的公共 fixture：登录、mock 控制、全局断言、截图（SPEC-M8 6.5） */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';
import type { RunInfo } from './globalSetup.js';
import { isolatedDirsAt } from '../packages/server/src/test-isolation.js';

/** 仓库根目录从 import.meta.url 推出，换机器复跑时不依赖 cwd（SPEC-M8 0.1 Q10） */
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const run = JSON.parse(readFileSync(join(process.cwd(), 'e2e-real/.run.json'), 'utf8')) as RunInfo & { root: string; userHashes: Record<string, string> };

export { run };

export interface Mocks {
  responses: string;
  anthClaude: string;
  anthDsh: string;
}

export interface MockApi {
  reset: () => Promise<void>;
  plan: (name: string) => Promise<void>;
  requests: () => Promise<{ path: string; headers: Record<string, string>; body: unknown; failed?: boolean; helper?: boolean }[]>;
}

function mockApi(base: string): MockApi {
  return {
    async reset() {
      await fetch(`${base}/__reset`, { method: 'POST' });
    },
    async plan(name) {
      const response = await fetch(`${base}/__plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
      if (!response.ok) throw new Error(`设置计划失败：${name} ${response.status}`);
    },
    async requests() {
      const response = await fetch(`${base}/__requests`);
      return ((await response.json()) as { requests: [] }).requests;
    },
  };
}

export interface ExtraServer {
  baseURL: string;
  token: string;
  pid: number;
  stop: () => Promise<void>;
}

/**
 * 起一个额外的服务实例（独立数据目录 / 独立 DSH 目录），用于多实例用例。
 * `node` 一律用 `process.execPath`，工作目录用从 import.meta.url 推出的仓库根目录，
 * 保证在另一台机器上复跑时也能起来（SPEC-M8 0.1 Q10）。
 */
export async function spawnServer(overrides: {
  dataDir?: string;
  dshHome?: string;
  dshMode?: 'attach' | 'spawn';
  dshUrl?: string;
  testHooks?: boolean;
  home?: string;
  codexHome?: string;
  claudeConfig?: string;
  env?: Record<string, string>;
}): Promise<ExtraServer> {
  const { spawn } = await import('node:child_process');
  const { createServer } = await import('node:net');
  const port = await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address !== null ? resolvePort(address.port) : reject(new Error('no port'))));
    });
  });
  // 四个目录永远指向隔离目录：默认沿用主实例的临时目录（SPEC-M8 1.6.2）。
  // 独立实例（PRV / NEW / Q3）用 isolatedDirsAt 在临时根下另开一套。
  const isolated = overrides.dataDir === undefined ? undefined : isolatedDirsAt(join(run.root, `instance-${Date.now().toString(36)}`));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: overrides.home ?? isolated?.HOME ?? run.dirs.home,
    CODEX_HOME: overrides.codexHome ?? isolated?.CODEX_HOME ?? run.dirs.codexHome,
    CLAUDE_CONFIG_DIR: overrides.claudeConfig ?? isolated?.CLAUDE_CONFIG_DIR ?? run.dirs.claudeConfig,
    DSH_HOME: overrides.dshHome ?? isolated?.DSH_HOME ?? run.dirs.dshHome,
    WDCC_DATA_DIR: overrides.dataDir ?? isolated?.data ?? run.dirs.data,
    WDCC_HOST: '127.0.0.1',
    WDCC_PORT: String(port),
    WDCC_TOKEN: overrides.env?.['WDCC_TOKEN'] ?? run.token,
    WDCC_DSH_MODE: overrides.dshMode ?? 'attach',
    ...(overrides.dshUrl === undefined ? {} : { WDCC_DSH_URL: overrides.dshUrl }),
    WDCC_TEST_HOOKS: overrides.testHooks === false ? '0' : '1',
    DEEPSEEK_BASE_URL: run.mocks.anthDsh,
    NO_COLOR: '1',
    ...(process.env['WDCC_WEB_DIST'] === undefined ? {} : { WDCC_WEB_DIST: process.env['WDCC_WEB_DIST'] }),
    ...(overrides.env ?? {}),
  };
  const child = spawn(process.execPath, [process.env['WDCC_SERVER_ENTRY'] ?? join(REPO_ROOT, 'packages/server/dist/main.js')], {
    cwd: REPO_ROOT,
    env,
    stdio: 'ignore',
  });
  const baseURL = `http://127.0.0.1:${port}`;
  const started = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`额外实例提前退出：code=${child.exitCode}`);
    try {
      const response = await fetch(`${baseURL}/api/meta`);
      if (response.status === 401) break;
    } catch {
      // 等
    }
    if (Date.now() - started > 30_000) {
      child.kill('SIGKILL');
      throw new Error('额外实例 30 秒内没有起来');
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return {
    baseURL,
    token: env['WDCC_TOKEN'] as string,
    pid: child.pid ?? 0,
    stop: async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

/** 用额外实例换 Cookie 并登录（每个实例的 Cookie 名按 Host 派生，互不覆盖 F18） */
export async function loginTo(instance: ExtraServer): Promise<string> {
  const response = await fetch(`${instance.baseURL}/?token=${instance.token}`, { redirect: 'manual' });
  const setCookie = response.headers.getSetCookie()[0] ?? '';
  return setCookie.split(';')[0] ?? '';
}

export interface AppFixtures {
  app: {
    page: Page;
    run: RunInfo & { root: string };
    /** 本用例里自动点过的审批（工具名与时间，F 见 SPEC 第 7 节开头的规则） */
    approvals: { tool: string; at: number }[];
    mockResponses: MockApi;
    mockClaude: MockApi;
    mockDsh: MockApi;
    planFor: (agent: 'codex' | 'claude' | 'dsh', name: string) => Promise<void>;
    login: () => Promise<void>;
    shot: (name: string) => Promise<string>;
    url: (path: string) => string;
  };
}

const approvals: { tool: string; at: number }[] = [];

/** 工作区 fixture 复位：git reset --hard && git clean -xfd（SPEC-M8 6.2） */
export function resetWorkspace(): void {
  const repo = join(run.root, 'ws/sample-repo');
  try {
    execFileSync('git', ['reset', '--hard', '-q'], { cwd: repo });
    execFileSync('git', ['clean', '-xfdq'], { cwd: repo });
  } catch {
    // 工作区还没建好时忽略
  }
}

export const test = base.extend<AppFixtures>({
  app: async ({ page, context }, use, testInfo) => {
    const errors: string[] = [];
    const secrets: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      // 浏览器自己打印的网络错误（断网/服务重启用例里必然出现，不是应用错误）
      const IGNORED = [/WebSocket connection to .* failed/, /Failed to load resource: net::ERR_INTERNET_DISCONNECTED/, /Failed to load resource: net::ERR_CONNECTION_REFUSED/];
      if (message.type() === 'error' && !IGNORED.some((pattern) => pattern.test(message.text()))) {
        errors.push(`console.error: ${message.text()}`);
      }
      const text = message.text();
      if (text.includes('sk-wdcc-test-')) secrets.push(`console: ${text.slice(0, 120)}`);
    });
    page.on('response', (response) => {
      if (response.status() >= 500) errors.push(`http ${response.status()}: ${response.url()}`);
    });

    const mockResponses = mockApi(run.mocks.responses);
    const mockClaude = mockApi(run.mocks.anthClaude);
    const mockDsh = mockApi(run.mocks.anthDsh);
    // 每个用例独立检查自己的上游请求。Codex 请求包含完整上下文，若跨用例
    // 保留会让 mock 进程和 Playwright 主进程的内存线性增长。
    await Promise.all([mockResponses.reset(), mockClaude.reset(), mockDsh.reset()]);

    const login = async (): Promise<void> => {
      await page.goto(`${run.baseURL}/?token=${run.token}`);
      await page.waitForURL((url) => url.pathname === '/', { timeout: 30_000 });
    };

    const shotDir = join(run.root, 'shots');
    const shot = async (name: string): Promise<string> => {
      await mkdir(shotDir, { recursive: true });
      const file = join(shotDir, `${name}.jpg`);
      await page.screenshot({ path: file, type: 'jpeg', quality: 70 });
      return file;
    };

    const planFor = async (agent: 'codex' | 'claude' | 'dsh', name: string): Promise<void> => {
      const api = agent === 'codex' ? mockResponses : agent === 'claude' ? mockClaude : mockDsh;
      await api.plan(name);
    };

    // 预期之外的审批一律点"允许一次"（SPEC 第 7 节开头的约定；05/06 与 MODE 用例除外）。
    // 规则：只点 data-state="pending" 的卡片，每次点击记录工具名，用例结束时与预期列表严格比较。
    // 09 用例本身就要"审批保持挂起时打断"，自动批准会让它无法成立，因此一并排除
    const autoApprove =
      !/-(0[569])(\s|$)/.test(testInfo.title) && !/^MODE-/.test(testInfo.title) && !/AG-\w+-09/.test(testInfo.title);
    let stopped = false;
    const autoLoop = autoApprove
      ? (async () => {
          while (!stopped) {
            // 只点可见的待处理卡片：收起轮次里的卡片点不到，会白白占住循环
            const pending = page.locator('[data-testid="approval-card"][data-state="pending"]:visible');
            const count = await pending.count().catch(() => 0);
            if (count > 0) {
              const card = pending.first();
              const tool = (await card.getAttribute('data-tool').catch(() => null)) ?? '';
              const button = card.getByRole('button', { name: '允许一次' });
              if ((await button.count().catch(() => 0)) > 0) {
                await button.click({ timeout: 3000 }).catch((error: unknown) => {
                  console.log(`auto-approve 点击失败：${String(error).slice(0, 120)}`);
                });
                approvals.push({ tool, at: Date.now() });
              }
            }
            // 条件等待：等卡片出现，或 250ms 后重新检查（不用于断言）
            await Promise.race([
              pending.first().waitFor({ state: 'attached', timeout: 250 }).catch(() => undefined),
              new Promise((resolveWait) => setTimeout(resolveWait, 250)),
            ]);
          }
        })()
      : null;

    // 每个用例开始前把工作区恢复原样（SPEC-M8 6.2）
    resetWorkspace();
    // 每个用例开始时清掉审批记录
    approvals.length = 0;
    await use({ page, run, approvals, mockResponses, mockClaude, mockDsh, planFor, login, shot, url: (path: string) => `${run.baseURL}${path}` });
    stopped = true;
    await autoLoop;

    // 全局断言（用例不能关闭）
    const shotPath = await shot(`${testInfo.title.split(' ')[0]}-end`);
    testInfo.attachments.push({ name: `${testInfo.title.split(' ')[0]}-end`, path: shotPath, contentType: 'image/jpeg' });
    expect(errors, '页面不应有错误').toEqual([]);
    expect(secrets, '响应/控制台里不应出现测试 Key').toEqual([]);
    void context;
  },
});

export { expect };
