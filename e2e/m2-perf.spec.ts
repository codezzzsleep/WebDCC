import { expect, test } from '@playwright/test';
import { createSession, login, waitForTurnComplete } from './helpers.js';

test.describe('M2 / A5 切换性能', () => {
  test('5,000 事件的会话：未缓存首屏与已缓存切换', async ({ page, context }) => {
    await login(page);
    const big = await createSession(page, 'dsh', '五千事件会话');
    const small = await createSession(page, 'codex', '小会话');
    await waitForTurnComplete(page);

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
    await freshPage.waitForFunction(() => document.querySelectorAll('.turn').length > 0, undefined, { timeout: 15_000, polling: 25 });
    const firstPaintMs = await freshPage.evaluate(() => performance.getEntriesByName('wdcc:first-turns')[0]?.startTime ?? -1);
    console.log(`A5 未缓存：DOM ${domMs}ms，limit=${limit}，首屏（应用内计时）${Math.round(firstPaintMs)}ms`);
    expect(limit).toBeLessThanOrEqual(200);
    expect(firstPaintMs).toBeGreaterThan(0);
    expect(firstPaintMs).toBeLessThanOrEqual(1000);

    // ---- 已缓存：同一页面里从另一个会话切过去（SPA 导航，不重载） ----
    await freshPage.goto(`/s/${small.sessionId}`, { waitUntil: 'domcontentloaded' });
    await freshPage.waitForSelector('.turn', { timeout: 20_000 });
    await freshPage.waitForTimeout(1500); // 让大会话的 200 条缓存落盘

    const samples: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      // 在同一个页面里来回切（不重载），这才是 SPEC 说的"从另一个会话切过去"
      await freshPage.getByTestId('session-row').filter({ hasText: '小会话' }).click();
      await freshPage.waitForFunction(
        () => (document.querySelector('[data-testid="timeline"]')?.textContent ?? '').includes('小会话'),
        undefined,
        { timeout: 10_000, polling: 10 },
      );
      const switchStart = Date.now();
      await freshPage.getByTestId('session-row').filter({ hasText: '五千事件会话' }).click();
      await freshPage.waitForFunction(
        () => (document.querySelector('[data-testid="timeline"]')?.textContent ?? '').includes('第 49 轮'),
        undefined,
        { timeout: 10_000, polling: 10 },
      );
      samples.push(Date.now() - switchStart);
    }
    samples.sort((a, b) => a - b);
    const median = samples[1] ?? samples[0] ?? 0;
    console.log(`A5 已缓存：同一页面切换首屏 3 次 ${samples.join('/')}ms，中位数 ${median}ms`);
    expect(median).toBeLessThanOrEqual(150);
    await fresh.close();
  });
});
