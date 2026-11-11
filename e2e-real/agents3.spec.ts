/**
 * SPEC-M8 7.4 的审批与打断用例：AG-{dsh,codex,claude}-05 / 06 / 09。
 */
import { existsSync, rmSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, run, test } from './fixtures.js';
import { newSession, waitTurnDone, type AgentKey } from './helpers.js';

const AGENTS: AgentKey[] = ['dsh', 'codex', 'claude'];
const APPROVAL_FILE = '/tmp/wdcc-m8-approval.txt';

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('send-button').click();
}

test.describe('7.4 审批', () => {
  for (const agent of AGENTS) {
    test(`AG-${agent}-05 允许一次`, async ({ app }) => {
      rmSync(APPROVAL_FILE, { force: true });
      await app.login();
      await app.planFor(agent, 'approval');
      await newSession(app.page, agent, '审批：允许一次');
      const card = app.page.getByTestId('approval-card').first();
      await expect(card).toBeVisible({ timeout: 90_000 });
      await expect(card).toHaveAttribute('data-state', 'pending');
      // 标题里包含命令原文
      await expect.poll(async () => card.innerText()).toContain('wdcc-m8-approval');
      // 正文不直接显示原始 JSON（JSON 在"详情"里折叠）
      const details = card.locator('details');
      await expect(details).toHaveCount(1);
      await expect(details).not.toHaveAttribute('open', '');
      // 等待审批时侧边栏显示"待批准"
      await expect.poll(async () => app.page.getByTestId('sidebar').innerText(), { timeout: 30_000 }).toContain('待批准');
      await card.getByRole('button', { name: '允许一次' }).click();
      await expect.poll(async () => card.innerText(), { timeout: 30_000 }).toContain('已允许一次');
      await waitTurnDone(app.page);
      expect(existsSync(APPROVAL_FILE), '允许之后命令应该真的执行').toBe(true);
      rmSync(APPROVAL_FILE, { force: true });
    });

    test(`AG-${agent}-06 拒绝`, async ({ app }) => {
      rmSync(APPROVAL_FILE, { force: true });
      await app.login();
      await app.planFor(agent, 'approval');
      await newSession(app.page, agent, '审批：拒绝');
      const card = app.page.getByTestId('approval-card').first();
      await expect(card).toBeVisible({ timeout: 90_000 });
      await card.getByRole('button', { name: '拒绝' }).click();
      await expect.poll(async () => card.innerText(), { timeout: 30_000 }).toContain('已拒绝');
      await waitTurnDone(app.page);
      expect(existsSync(APPROVAL_FILE), '拒绝后文件不应该存在').toBe(false);
      // mock 收到的下一个请求里带有"被拒绝"的工具结果
      const api = agent === 'codex' ? app.mockResponses : agent === 'claude' ? app.mockClaude : app.mockDsh;
      await expect
        .poll(
          async () => {
            const requests = await api.requests();
            return JSON.stringify(requests.at(-1)?.body ?? {});
          },
          { timeout: 60_000 },
        )
        .toMatch(/拒绝|denied|deny|reject/i);
    });

    test(`AG-${agent}-09 停止与挂起审批取消`, async ({ app }) => {
      rmSync(APPROVAL_FILE, { force: true });
      await app.login();
      await app.planFor(agent, 'slow');
      await newSession(app.page, agent, '停止测试');
      const timeline = app.page.getByTestId('timeline');
      await expect.poll(async () => timeline.innerText(), { timeout: 60_000 }).toContain('第1块流式文本');
      await app.page.getByTestId('stop-button').click();
      // 3 秒内显示"已中断"
      await expect.poll(async () => timeline.innerText(), { timeout: 3_000 }).toMatch(/已中断|已打断/);
      // 助手文本不再增长（只比较助手内容，避免"用时"这类计时文字干扰）
      const assistantLength = async (): Promise<number> => {
        const text = await timeline.innerText();
        const index = text.lastIndexOf('第1块流式文本');
        return index === -1 ? 0 : text.length - index;
      };
      await app.page.waitForTimeout(2_000); // 用例本身要验证"文本不再增长"，需要固定等待
      const before = await assistantLength();
      await app.page.waitForTimeout(1_000); // 同上
      expect(await assistantLength()).toBeLessThanOrEqual(before + 2);

      // 挂起的审批在打断后显示"已取消"
      await app.planFor(agent, 'approval');
      await sendMessage(app.page, '审批中停止');
      const card = app.page.getByTestId('approval-card').first();
      await expect(card).toBeVisible({ timeout: 90_000 });
      await app.page.getByTestId('stop-button').click();
      await expect.poll(async () => card.innerText(), { timeout: 30_000 }).toMatch(/已取消|已中断|已拒绝/);
      expect(existsSync(APPROVAL_FILE), '打断之后命令不应该执行').toBe(false);

      // 再发一条，正常完成
      await app.planFor(agent, 'echo-context');
      await expect(app.page.getByTestId('send-button')).toBeVisible({ timeout: 60_000 });
      const turnsBefore = await app.page.getByTestId('composer').innerText();
      const countBefore = Number(/(\d+) 轮/.exec(turnsBefore)?.[1] ?? '0');
      await sendMessage(app.page, '停止之后还能继续');
      await expect
        .poll(async () => Number(/(\d+) 轮/.exec(await app.page.getByTestId('composer').innerText())?.[1] ?? '0'), { timeout: 120_000 })
        .toBeGreaterThanOrEqual(countBefore + 1);
      await expect.poll(async () => timeline.innerText(), { timeout: 120_000 }).toMatch(/已完成|已中断/);
    });
  }
});

void run;
