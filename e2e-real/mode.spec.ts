/**
 * SPEC-M8 7.5 访问模式：MODE-{dsh,codex,claude}-01/02/03。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, run, test } from './fixtures.js';
import { newSession, waitTurnDone, type AgentKey } from './helpers.js';

const AGENTS: AgentKey[] = ['dsh', 'codex', 'claude'];
const REPO = (): string => join(run.root, 'ws/sample-repo');

const READ_ONLY_MODE: Record<AgentKey, string> = { dsh: 'read-only', codex: ':read-only', claude: 'plan' };
const WRITABLE_MODE: Record<AgentKey, string> = { dsh: 'danger-full-access', codex: ':danger-full-access', claude: 'acceptEdits' };

async function openModeMenu(page: Page): Promise<string[]> {
  await page.getByTestId('access-mode').click();
  const menu = page.locator('.menu').filter({ has: page.locator('[data-testid^="access-mode-"]') }).first();
  await expect(menu).toBeVisible({ timeout: 15_000 });
  return menu.locator('[data-testid^="access-mode-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid') ?? ''));
}

async function pickMode(page: Page, mode: string): Promise<void> {
  await page.getByTestId('access-mode').click();
  await page.getByTestId(`access-mode-${mode}`).click();
  // 菜单收起（避免盖住输入框里的按钮）
  await expect(page.getByTestId(`access-mode-${mode}`)).toHaveCount(0);
  await expect(page.getByTestId('access-mode')).toContainText(/只读|仅可查看|工作区|完全|计划|接受|默认|自动/, { timeout: 30_000 });
}

test.describe('7.5 访问模式', () => {
  for (const agent of AGENTS) {
    test(`MODE-${agent}-01 访问模式菜单`, async ({ app }) => {
      await app.login();
      await app.planFor(agent, 'echo-context');
      await newSession(app.page, agent, '看访问模式菜单');
      const ids = await openModeMenu(app.page);
      if (agent === 'dsh') {
        expect(ids.map((id) => id.replace('access-mode-', ''))).toEqual(['read-only', 'workspace-write', 'danger-full-access', 'auto']);
      } else if (agent === 'claude') {
        const values = ids.map((id) => id.replace('access-mode-', ''));
        for (const mode of ['default', 'acceptEdits', 'plan', 'bypassPermissions']) expect(values).toContain(mode);
        // 以 root 运行时 bypassPermissions 灰显并写明原因（SPEC-M8 0.1 第 7 条）
        const meta = (await app.page.evaluate(async () => (await fetch('/api/meta', { credentials: 'same-origin' })).json())) as { runningAsRoot?: boolean };
        if (meta.runningAsRoot === true) {
          await expect(app.page.getByTestId('access-mode-bypassPermissions')).toBeDisabled();
          await expect(app.page.getByTestId('access-mode-bypassPermissions')).toContainText('以 root 运行时 Claude Code 不允许此模式');
        }
      } else {
        // Codex：与直接调用 app-server permissionProfile/list 的结果一致
        const direct = await app.page.evaluate(async () => {
          const response = await fetch('/api/meta', { credentials: 'same-origin' });
          return (await response.json()) as { agents: Record<string, { accessModes: { id: string }[] }> };
        });
        const codexIds = direct.agents['codex']?.accessModes.map((mode) => mode.id) ?? [];
        expect(ids.map((id) => id.replace('access-mode-', '')).sort()).toEqual([...codexIds].sort());
        expect(codexIds).toContain(':read-only');
        expect(codexIds).toContain(':workspace');
        expect(codexIds).toContain(':danger-full-access');
      }
    });

    test(`MODE-${agent}-02 只读模式写不了文件`, async ({ app }) => {
      await app.login();
      await app.planFor(agent, 'full');
      await newSession(app.page, agent, '只读模式');
      // 先切到只读，再发消息
      await pickMode(app.page, READ_ONLY_MODE[agent]);
      // 轨迹里能看到切换事件
      await app.page.getByTestId('tab-trajectory').click();
      await expect.poll(async () => app.page.getByTestId('trajectory').innerText(), { timeout: 30_000 }).toContain('access-mode');
      await app.page.getByTestId('tab-chat').click();
      await app.page.getByTestId('composer-input').fill('只读模式下跑一轮');
      await app.page.getByTestId('send-button').click();
      // 遇到审批一律拒绝
      const deny = app.page.getByTestId('approval-card').getByRole('button', { name: '拒绝' });
      for (let index = 0; index < 120; index += 1) {
        if ((await deny.count()) > 0) await deny.first().click().catch(() => undefined);
        if ((await app.page.getByTestId('stop-button').count()) === 0 && (await deny.count()) === 0) break;
        await app.page.waitForTimeout(500);
      }
      await waitTurnDone(app.page);
      // 文件没有变化
      expect(existsSync(join(REPO(), 'notes.txt')), '只读模式下不应该写出 notes.txt').toBe(false);
      expect(readFileSync(join(REPO(), 'README.md'), 'utf8')).toContain('line to modify: ORIGINAL');
    });

    test(`MODE-${agent}-03 可写模式直接写文件、不弹审批`, async ({ app }) => {
      await app.login();
      await app.planFor(agent, 'echo-context');
      await newSession(app.page, agent, '可写模式');
      await pickMode(app.page, WRITABLE_MODE[agent]);
      // 清掉上一轮留下的文件
      await app.planFor(agent, 'full');
      await app.page.getByTestId('composer-input').fill('可写模式下跑一轮');
      await app.page.getByTestId('send-button').click();
      await waitTurnDone(app.page);
      expect(readFileSync(join(REPO(), 'notes.txt'), 'utf8')).toBe('第一行\n第二行\n');
      // 没有出现审批卡片
      await expect(app.page.getByTestId('approval-card')).toHaveCount(0);
    });
  }
});
