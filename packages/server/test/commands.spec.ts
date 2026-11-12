import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, seedWorkspaceAndSession, type TestApp } from './helpers.js';

let ctx: TestApp;
let approvalCtx: TestApp;

beforeAll(async () => {
  ctx = await createTestApp();
  approvalCtx = await createTestApp({ injectApproval: true });
});

afterAll(async () => {
  await ctx.close();
  await approvalCtx.close();
});

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('A6-6c / A6-6d 命令与审批的幂等', () => {
  it('离线重放的发送命令只生效一次（6c）', async () => {
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    const command = { op: 'send' as const, sessionId, text: '重放一次', clientCommandId: 'REPLAY-1' };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/commands',
        headers: { cookie: ctx.cookie },
        payload: { command },
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { ok: boolean }).ok).toBe(true);
    }
    await waitFor(() => ctx.store.listEvents(sessionId, { limit: 500 }).some((event) => event.kind === 'turn.completed'));
    expect(ctx.store.allEvents(sessionId).filter((event) => event.kind === 'user.message')).toHaveLength(1);
  });

  it('重复审批返回 already-resolved（6d）', async () => {
    const { sessionId } = await seedWorkspaceAndSession(approvalCtx);
    await approvalCtx.manager.send(sessionId, { text: '请求一次审批' });
    await waitFor(() => approvalCtx.store.allEvents(sessionId).some((event) => event.kind === 'approval.request'));
    const request = approvalCtx.store.allEvents(sessionId).find((event) => event.kind === 'approval.request');
    const approvalId = (request?.data as { approvalId: string }).approvalId;

    const first = await approvalCtx.app.inject({
      method: 'POST',
      url: '/api/commands',
      headers: { cookie: approvalCtx.cookie },
      payload: {
        command: { op: 'approve', sessionId, approvalId, optionId: 'allow', clientCommandId: 'APPROVE-1' },
      },
    });
    expect((first.json() as { ok: boolean }).ok).toBe(true);

    const second = await approvalCtx.app.inject({
      method: 'POST',
      url: '/api/commands',
      headers: { cookie: approvalCtx.cookie },
      payload: {
        command: { op: 'approve', sessionId, approvalId, optionId: 'allow', clientCommandId: 'APPROVE-2' },
      },
    });
    const body = second.json() as { ok: boolean; code?: string; error?: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe('already-resolved');

    // 同一个 clientCommandId 重放则返回第一次的结果
    const replay = await approvalCtx.app.inject({
      method: 'POST',
      url: '/api/commands',
      headers: { cookie: approvalCtx.cookie },
      payload: {
        command: { op: 'approve', sessionId, approvalId, optionId: 'allow', clientCommandId: 'APPROVE-1' },
      },
    });
    expect((replay.json() as { ok: boolean }).ok).toBe(true);
  });

  it('过期的打断命令被丢弃', async () => {
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/commands',
      headers: { cookie: ctx.cookie },
      payload: {
        command: {
          op: 'interrupt',
          sessionId,
          createdAt: Date.now() - 120_000,
          clientCommandId: 'INTERRUPT-EXPIRED',
        },
      },
    });
    const body = response.json() as { ok: boolean; code?: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe('interrupt-expired');
  });

  it('改名与归档写入侧边栏日志', async () => {
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    await ctx.app.inject({
      method: 'POST',
      url: '/api/commands',
      headers: { cookie: ctx.cookie },
      payload: { command: { op: 'rename', sessionId, title: '新标题', clientCommandId: 'RENAME-1' } },
    });
    expect(ctx.store.getSession(sessionId)?.title).toBe('新标题');
    const feed = ctx.store.feedSince(0, 1000).filter((entry) => entry.sessionId === sessionId);
    expect(feed.some((entry) => entry.patch.title === '新标题')).toBe(true);
  });

  it('Codex 思考强度随会话保存并同步给页面', async () => {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex', 'high');
    expect(ctx.store.getSession(sessionId)?.reasoningEffort).toBe('high');

    const detail = await ctx.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}`, headers: { cookie: ctx.cookie } });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { reasoningEffort?: string }).reasoningEffort).toBe('high');

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/commands',
      headers: { cookie: ctx.cookie },
      payload: { command: { op: 'set-reasoning-effort', sessionId, reasoningEffort: 'xhigh', clientCommandId: 'REASONING-1' } },
    });
    expect((response.json() as { ok: boolean }).ok).toBe(true);
    expect(ctx.store.getSession(sessionId)?.reasoningEffort).toBe('xhigh');
    expect(ctx.store.feedSince(0, 1000).some((entry) => entry.sessionId === sessionId && entry.patch.reasoningEffort === 'xhigh')).toBe(true);
  });
});
