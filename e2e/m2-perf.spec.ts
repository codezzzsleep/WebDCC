import { expect, test } from '@playwright/test';
import { createSession, login } from './helpers.js';

test.describe('M2 / A5 切换性能', () => {
  test('5,000 事件的会话：未缓存首屏与已缓存切换', async ({ page, context }) => {
    await login(page);
    const big = await createSession(page, 'dsh', '五千事件会话');

    // 用 API 连续发 50 轮（每轮约 100 条事件），凑够 5,000+ 条事件
    const total = await page.evaluate(async (sessionId) => {
      const count = async (): Promise<number> => {
        const text = await (await fetch(`/api/sessions/${sessionId}/export`, { credentials: 'same-origin' })).text();
        const lines = text.trim().split('\n').filter(Boolean);
        return (lines.at(-1) ?? '').includes('turn.completed') ? lines.length : 0;
      };
      for (let i = 0; i < 50; i += 1) {
        await fetch('/api/commands', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ command: { op: 'send', clientCommandId: `PERF-${i}`, sessionId, text: `第 ${i} 轮` } }),
        });
        const started = Date.now();
        while (Date.now() - started < 20_000) {
          const n = await count();
          if (n > 0 && i > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      return count();
    }, big.sessionId);
    console.log(`A5 造数：${total} 条事件`);
    expect(total).toBeGreaterThanOrEqual(5000);

    // ---- 未缓存：新上下文 ----
    const fresh = await context.browser()?.newContext();
    if (fresh === undefined) throw new Error('没有浏览器上下文');
    const freshPage = await fresh.newPage();
    await login(freshPage);
    const firstRequest = freshPage.waitForRequest((request) => request.url().includes(`/api/sessions/${big.sessionId}/events`), { timeout: 20_000 });
    const startedAt = Date.now();
    await freshPage.goto(`/s/${big.sessionId}`, { waitUntil: 'domcontentloaded' });
    const domMs = Date.now() - startedAt;
    const request = await firstRequest;
    const limit = Number(new URL(request.url()).searchParams.get('limit') ?? '0');
    await freshPage.waitForFunction(() => document.querySelectorAll('.turn').length > 0, undefined, { timeout: 15_000 });
    const firstPaintMs = Date.now() - startedAt;
    console.log(`A5 未缓存：DOM ${domMs}ms，limit=${limit}，首屏 ${firstPaintMs}ms`);
    expect(limit).toBeLessThanOrEqual(200);
    expect(firstPaintMs).toBeLessThanOrEqual(1000);

    // ---- 已缓存：同一上下文再次进入 ----
    await freshPage.waitForTimeout(2000);
    await freshPage.goto('/new');
    const switchStart = Date.now();
    await freshPage.goto(`/s/${big.sessionId}`, { waitUntil: 'domcontentloaded' });
    await freshPage.waitForFunction(() => document.querySelectorAll('.turn').length > 0, undefined, { timeout: 10_000 });
    const switchMs = Date.now() - switchStart;
    console.log(`A5 已缓存：切换首屏 ${switchMs}ms`);
    expect(switchMs).toBeLessThanOrEqual(1500);
    await fresh.close();
  });
});
