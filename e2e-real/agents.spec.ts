import { expect, test } from './fixtures.js';
import { agentMarkInHeader, newSession, waitTurnDone } from './helpers.js';

test.describe('7.4 三个 Agent 的核心流程', () => {
  for (const agent of ['dsh', 'codex', 'claude'] as const) {
    test(`AG-${agent}-01 新建会话：标识与访问模式`, async ({ app }) => {
      await app.login();
      await app.planFor(agent, 'full');
      await newSession(app.page, agent, '跑一遍 full');
      await expect(app.page).toHaveURL(/\/s\/[0-9A-Z]+$/);
      const mark = agent === 'dsh' ? 'DS' : agent === 'codex' ? 'CX' : 'CC';
      await expect.poll(async () => agentMarkInHeader(app.page), { timeout: 20_000 }).toBe(mark);
      await expect.poll(async () => app.page.getByTestId('sidebar').innerText(), { timeout: 20_000 }).toContain(mark);
      await expect.poll(async () => app.page.getByTestId('access-mode').innerText(), { timeout: 20_000 }).not.toBe('');
    });

    test(`AG-${agent}-02 流式输出`, async ({ app }) => {
      await app.login();
      await app.planFor(agent, 'slow');
      await newSession(app.page, agent, '流式');
      const timeline = app.page.getByTestId('timeline');
      const start = Date.now();
      let previous = 0;
      let increases = 0;
      let firstAt = 0;
      while (Date.now() - start < 30_000 && increases < 3) {
        const length = (await timeline.innerText()).length;
        if (length > previous) {
          increases += 1;
          if (firstAt === 0) firstAt = Date.now() - start;
          previous = length;
        }
        if (increases < 3) await app.page.waitForTimeout(100);
      }
      console.log(`AG-${agent}-02：首个字 ${firstAt}ms，增长 ${increases} 次，共 ${Date.now() - start}ms`);
      expect(firstAt).toBeLessThanOrEqual(5_000);
      expect(increases).toBeGreaterThanOrEqual(3);
    });

    test(`AG-${agent}-04 任务面板`, async ({ app }) => {
      await app.login();
      await app.planFor(agent, 'full');
      await newSession(app.page, agent, '任务清单');
      await waitTurnDone(app.page);
      await expect(app.page.getByTestId('plan-panel')).toBeVisible({ timeout: 30_000 });
      await expect(app.page.getByTestId('plan-panel')).toContainText('1 已完成');
      await expect(app.page.getByTestId('plan-panel')).toContainText('1 进行中');
    });
  }
});
