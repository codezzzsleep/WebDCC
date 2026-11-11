/** M8 验收套件的公共 fixture：登录、mock 控制、全局断言、截图（SPEC-M8 6.5） */
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';
import type { RunInfo } from './globalSetup.js';

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
  stop: () => void;
}

/** 起一个额外的服务实例（同一数据目录或独立目录），用于重启/多实例用例 */
export async function spawnServer(overrides: {
  dataDir?: string;
  dshHome?: string;
  dshMode?: 'attach' | 'spawn';
  dshUrl?: string;
  testHooks?: boolean;
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
  const env = {
    ...process.env,
    HOME: run.dirs.home,
    CODEX_HOME: run.dirs.codexHome,
    CLAUDE_CONFIG_DIR: run.dirs.claudeConfig,
    DSH_HOME: overrides.dshHome ?? run.dirs.dshHome,
    WDCC_DATA_DIR: overrides.dataDir ?? run.dirs.data,
    WDCC_HOST: '127.0.0.1',
    WDCC_PORT: String(port),
    WDCC_TOKEN: run.token,
    WDCC_DSH_MODE: overrides.dshMode ?? 'attach',
    ...(overrides.dshUrl === undefined ? {} : { WDCC_DSH_URL: overrides.dshUrl }),
    ...(overrides.testHooks === true ? { WDCC_TEST_HOOKS: '1' } : {}),
    DEEPSEEK_BASE_URL: run.mocks.anthDsh,
  };
  const child = spawn('node', ['packages/server/dist/main.js'], { cwd: process.cwd(), env, stdio: 'ignore' });
  const baseURL = `http://127.0.0.1:${port}`;
  const started = Date.now();
  for (;;) {
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
  return { baseURL, token: run.token, stop: () => child.kill('SIGKILL') };
}

export interface AppFixtures {
  app: {
    page: Page;
    run: RunInfo & { root: string };
    mockResponses: MockApi;
    mockClaude: MockApi;
    mockDsh: MockApi;
    planFor: (agent: 'codex' | 'claude' | 'dsh', name: string) => Promise<void>;
    login: () => Promise<void>;
    shot: (name: string) => Promise<string>;
    url: (path: string) => string;
  };
}

export const test = base.extend<AppFixtures>({
  app: async ({ page, context }, use, testInfo) => {
    const errors: string[] = [];
    const secrets: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
      const text = message.text();
      if (text.includes('sk-wdcc-test-')) secrets.push(`console: ${text.slice(0, 120)}`);
    });
    page.on('response', async (response) => {
      if (response.status() >= 500) errors.push(`http ${response.status()}: ${response.url()}`);
      const type = response.headers()['content-type'] ?? '';
      if (type.includes('json') || type.includes('text')) {
        const body = await response.text().catch(() => '');
        if (body.includes('sk-wdcc-test-')) secrets.push(`response: ${response.url()}`);
      }
    });

    const mockResponses = mockApi(run.mocks.responses);
    const mockClaude = mockApi(run.mocks.anthClaude);
    const mockDsh = mockApi(run.mocks.anthDsh);

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

    // 预期之外的审批一律点"允许一次"（SPEC 第 7 节开头的约定；05/06 两个审批用例除外）
    const autoApprove = !/-(0[56])(\s|$)/.test(testInfo.title);
    const timer = autoApprove
      ? setInterval(() => {
          void page
            .getByTestId('approval-card')
            .getByRole('button', { name: '允许一次' })
            .first()
            .click({ timeout: 500 })
            .catch(() => undefined);
        }, 400)
      : null;

    await use({ page, run, mockResponses, mockClaude, mockDsh, planFor, login, shot, url: (path: string) => `${run.baseURL}${path}` });
    if (timer !== null) clearInterval(timer);

    // 全局断言（用例不能关闭）
    const shotPath = await shot(`${testInfo.title.split(' ')[0]}-end`);
    testInfo.attachments.push({ name: `${testInfo.title.split(' ')[0]}-end`, path: shotPath, contentType: 'image/jpeg' });
    expect(errors, '页面不应有错误').toEqual([]);
    expect(secrets, '响应/控制台里不应出现测试 Key').toEqual([]);
    void context;
  },
});

export { expect };
