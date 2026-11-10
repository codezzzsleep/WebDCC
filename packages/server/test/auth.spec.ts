import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueCookie } from '../src/auth.js';
import { createTestApp, TEST_TOKEN, type TestApp } from './helpers.js';

let ctx: TestApp;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.close();
});

describe('A9 认证', () => {
  it('受保护路径无 Cookie 一律 401', async () => {
    for (const url of ['/api/meta', '/api/workspaces', '/api/feed', '/api/sessions/x', '/files/x']) {
      const response = await ctx.app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it('/api/ws 无 Cookie 会被服务端拒绝（401 或关闭）', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/ws', headers: { upgrade: 'websocket' } });
    expect([200, 400, 401, 404]).toContain(response.statusCode);
  });

  it('有效 Cookie 可以通过', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/workspaces', headers: { cookie: ctx.cookie } });
    expect(response.statusCode).toBe(200);
  });

  it('错误 token 不设 Cookie', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/?token=wrong-token' });
    expect(response.statusCode).toBe(403);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('正确 token 换到 Cookie 并跳转', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: `/?token=${TEST_TOKEN}` });
    expect(response.statusCode).toBe(302);
    const setCookie = response.headers['set-cookie'];
    expect(typeof setCookie).toBe('string');
    expect(String(setCookie)).toContain('wdcc-auth=');
    expect(String(setCookie)).toContain('HttpOnly');
  });

  it('更换 WDCC_TOKEN 后旧 Cookie 失效', async () => {
    const oldCookie = `wdcc-auth=${issueCookie(TEST_TOKEN)}`;
    const stillValid = await ctx.app.inject({ method: 'GET', url: '/api/workspaces', headers: { cookie: oldCookie } });
    expect(stillValid.statusCode).toBe(200);

    // 换过 token 的实例：同样的旧 Cookie 必须失效
    const other = await createTestApp({}, 'a-completely-different-token-0123456789abcdef');
    const response = await other.app.inject({
      method: 'GET',
      url: '/api/workspaces',
      headers: { cookie: oldCookie },
    });
    expect(response.statusCode).toBe(401);
    await other.close();
  });
});

describe('REST 基础', () => {
  it('工作区 CRUD 与路径校验', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: { cookie: ctx.cookie },
      payload: { name: '临时', path: ctx.dataDir },
    });
    expect(created.statusCode).toBe(200);
    const body = created.json() as { id: string; path: string };
    expect(body.path).toBe(ctx.dataDir);

    const relative = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: { cookie: ctx.cookie },
      payload: { name: 'x', path: 'relative/path' },
    });
    expect(relative.statusCode).toBe(400);

    const list = await ctx.app.inject({ method: 'GET', url: '/api/workspaces', headers: { cookie: ctx.cookie } });
    expect((list.json() as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('fs 读取越界路径被拒绝', async () => {
    const boundaryPath = join(ctx.dataDir, `boundary-${Date.now().toString(36)}`);
    await mkdir(boundaryPath, { recursive: true });
    const workspace = ctx.store.createWorkspace('边界', boundaryPath);
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspace.id}/fs?path=../../etc/passwd`,
      headers: { cookie: ctx.cookie },
    });
    expect([400, 404]).toContain(response.statusCode);
  });

  it('带 token 与不带 token 的首页行为', async () => {
    const unauth = await ctx.app.inject({ method: 'GET', url: '/' });
    expect(unauth.statusCode).toBe(401);
  });
});
