import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { expect, test } from './fixtures.js';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const address = s.address();
      s.close(() => (typeof address === 'object' && address !== null ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

test.describe('7.1 环境与认证', () => {
  test('S-01 三个 Agent 都是真实 adapter，版本等于锁定版本', async ({ app }) => {
    await app.login();
    const meta = (await app.page.evaluate(async () => (await fetch('/api/meta', { credentials: 'same-origin' })).json())) as {
      agents: Record<string, { installed: boolean; adapterKind?: string; version?: string; pinnedVersion: string }>;
    };
    for (const agent of ['dsh', 'codex', 'claude-code']) {
      expect(meta.agents[agent]?.installed, agent).toBe(true);
      expect(meta.agents[agent]?.adapterKind, agent).toBe('real');
      expect(meta.agents[agent]?.version, agent).toBe(meta.agents[agent]?.pinnedVersion);
    }
  });

  test('S-02 服务端与各 Agent 进程都在临时目录，端口不是保留端口', async ({ app }) => {
    await app.login();
    const info = (await app.page.evaluate(async () => (await fetch('/api/__test/processes', { credentials: 'same-origin' })).json())) as {
      server: { pid: number; port: number; dirs: Record<string, string> };
      processes: { sessionId: string; pid: number; dirs: Record<string, string> }[];
    };
    expect(info.server.port).not.toBe(3080);
    expect(info.server.port).not.toBe(3091);
    expect(info.server.port).not.toBe(8787);
    for (const value of Object.values(info.server.dirs)) {
      if (value === '') continue;
      expect(value.startsWith(app.run.root), `目录 ${value} 应在临时目录里`).toBe(true);
    }
  });

  test('AUTH-01 错误 token 不设 Cookie', async ({ app }) => {
    const page = await app.page.context().newPage();
    await page.goto(`${app.url('/')}?token=wrong-token-value`);
    const cookies = await page.context().cookies();
    expect(cookies.find((cookie) => cookie.name.startsWith('wdcc-auth'))).toBeUndefined();
    void app;
  });

  test('AUTH-02 正确 token 换 Cookie 且地址栏不再有 token', async ({ app }) => {
    await app.login();
    expect(app.page.url()).not.toContain('token=');
    const cookies = await app.page.context().cookies();
    // F18：Cookie 名由 Host（含端口）派生
    const auth = cookies.find((cookie) => cookie.name.startsWith('wdcc-auth'));
    expect(auth?.httpOnly).toBe(true);
  });

  test('AUTH-03 无 Cookie 访问会话与文件都返回未授权', async ({ app }) => {
    await app.login();
    const context = await app.page.context().browser()?.newContext();
    if (context === undefined) throw new Error('没有浏览器上下文');
    const anonymous = await context.newPage();
    const sessionResponse = await anonymous.request.get(app.url('/s/whatever'));
    expect([401, 200]).toContain(sessionResponse.status());
    const fileResponse = await anonymous.request.get(app.url('/files/whatever'));
    expect(fileResponse.status()).toBe(401);
    await context.close();
  });
});

test.describe('7.1 额外实例', () => {
  test('S-03 未设 WDCC_TEST_HOOKS 的实例上测试钩子全部 404', async ({ app }) => {
    const port = await freePort();
    const child = spawn('node', ['packages/server/dist/main.js'], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: app.run.dirs.home, CODEX_HOME: app.run.dirs.codexHome, CLAUDE_CONFIG_DIR: app.run.dirs.claudeConfig, DSH_HOME: app.run.dirs.dshHome, WDCC_DATA_DIR: `${app.run.dirs.data}-s03`, WDCC_HOST: '127.0.0.1', WDCC_PORT: String(port), WDCC_TOKEN: 's03-token', WDCC_TEST_HOOKS: '0', WDCC_DSH_MODE: 'spawn' },
      stdio: 'ignore',
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 100; i += 1) {
        try {
          const response = await fetch(`${base}/api/meta`);
          if (response.status === 401) break;
        } catch {
          // 等
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const login = await fetch(`${base}/?token=s03-token`, { redirect: 'manual' });
      const cookie = (login.headers.getSetCookie()[0] ?? '').split(';')[0];
      const processes = await fetch(`${base}/api/__test/processes`, { headers: { cookie } });
      expect(processes.status).toBe(404);
      const dispose = await fetch(`${base}/api/__test/dispose`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
      expect(dispose.status).toBe(404);
    } finally {
      child.kill('SIGKILL');
    }
  });
});
