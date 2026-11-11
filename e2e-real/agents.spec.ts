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
      void timeline;
      console.log(`AG-${agent}-02：${Date.now() - start}ms 内文本增长 ${increases} 次`);
      expect(increases).toBeGreaterThanOrEqual(3);
      expect(Date.now() - start).toBeLessThan(60_000);
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
