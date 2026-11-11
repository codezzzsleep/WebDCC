/**
 * SPEC-M8 7.8 停靠区与窄屏：DOCK-01/02/03、MOB-01..04、UI-01。
 */
import type { Page } from '@playwright/test';
import { expect, run, test } from './fixtures.js';
import { newSession, waitTurnDone } from './helpers.js';

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('send-button').click();
}

test.describe('7.8 停靠区', () => {
  test('DOCK-01 移到主栏、刷新与前进后退还原', async ({ app }) => {
    await app.login();
    await app.planFor('dsh', 'echo-context');
    const first = await newSession(app.page, 'dsh', '会话 A');
    await waitTurnDone(app.page);
    await app.page.goto(`${run.baseURL}/new`);
    await app.planFor('dsh', 'echo-context');
    const second = await newSession(app.page, 'dsh', '会话 B');
    await waitTurnDone(app.page);
    // A+B：主栏 A、停靠区 B
    await app.page.goto(`${run.baseURL}/s/${first}+${second}`);
    const dock = app.page.getByTestId('dock');
    await expect(dock).toBeVisible();
    await expect.poll(async () => dock.innerText()).toContain('会话 B');
    await expect.poll(async () => dock.innerText()).toMatch(/DS/);
    await dock.getByRole('button', { name: '移到主栏' }).click();
    await expect.poll(async () => app.page.url()).toContain(`${second}+${first}`);
    // 刷新后布局还原
    await app.page.reload();
    await expect(dock).toBeVisible();
    await expect.poll(async () => dock.innerText()).toContain('会话 A');
    // 浏览器后退、前进
    await app.page.goBack();
    await expect.poll(async () => app.page.url()).toContain(`${first}+${second}`);
    await app.page.goForward();
    await expect.poll(async () => app.page.url()).toContain(`${second}+${first}`);
    await expect(dock).toBeVisible();
  });

  test('DOCK-03 改动卡片打开 diff 标签、文件标签与直接地址', async ({ app }) => {
    await app.login();
    await app.planFor('claude', 'full');
    const sessionId = await newSession(app.page, 'claude', 'diff 标签');
    await waitTurnDone(app.page);
    await app.page.getByTestId('changes-card').locator('button', { hasText: 'README.md' }).first().click();
    await expect(app.page.getByTestId('dock')).toContainText('改动');
    const url = app.page.url();
    expect(url).toContain('dock=diff');
    await app.page.reload();
    await expect(app.page.getByTestId('dock')).toContainText('改动');
    await expect.poll(async () => app.page.getByTestId('dock').innerText(), { timeout: 20_000 }).toContain('line to modify');
    // 文件标签
    await app.page.goto(`${run.baseURL}/s/${sessionId}?dock=files`);
    await expect(app.page.getByTestId('dock')).toContainText('工作区文件');
    void sendMessage;
  });
});

test.describe('7.8 窄屏', () => {
  test('MOB-01 390×844 抽屉里切换会话', async ({ app }) => {
    await app.page.setViewportSize({ width: 390, height: 844 });
    await app.login();
    await app.planFor('dsh', 'echo-context');
    const first = await newSession(app.page, 'dsh', '手机会话一');
    await waitTurnDone(app.page);
    await app.page.goto(`${run.baseURL}/new`);
    await app.planFor('dsh', 'echo-context');
    const second = await newSession(app.page, 'dsh', '手机会话二');
    await waitTurnDone(app.page);
    // 抽屉默认隐藏，点会话头左侧按钮打开
    await app.page.goto(`${run.baseURL}/s/${first}`);
    await app.page.getByTestId('drawer-toggle').click();
    await expect(app.page.getByTestId('sidebar')).toBeInViewport();
    await app.page.getByTestId('session-row').filter({ hasText: '手机会话二' }).click();
    await expect.poll(async () => app.page.url()).toContain(second);
    await expect(app.page.getByTestId('drawer-backdrop')).toHaveCount(0);
  });

  test('MOB-02 390×844 新建并跑完一轮，输入框贴底', async ({ app }) => {
    await app.page.setViewportSize({ width: 390, height: 844 });
    await app.login();
    await app.planFor('dsh', 'echo-context');
    await app.page.goto(`${run.baseURL}/new`);
    await app.page.getByTestId('drawer-toggle').click().catch(() => undefined);
    await app.page.getByTestId('agent-card-dsh').click();
    await app.page.getByTestId('new-session-input').fill('手机新建');
    await app.page.getByTestId('new-session-send').click();
    await app.page.waitForURL(/\/s\/[0-9A-Z]+/, { timeout: 90_000 });
    await waitTurnDone(app.page);
    const box = await app.page.getByTestId('composer').boundingBox();
    expect(box).not.toBeNull();
    expect(844 - ((box?.y ?? 0) + (box?.height ?? 0))).toBeLessThanOrEqual(24);
  });

  test('MOB-03 390×844 截图清单', async ({ app }) => {
    await app.page.setViewportSize({ width: 390, height: 844 });
    await app.login();
    await app.planFor('dsh', 'full');
    await newSession(app.page, 'dsh', '手机截图');
    await waitTurnDone(app.page);
    await app.shot('MOB-03-chat');
    await app.page.getByTestId('drawer-toggle').click();
    await app.shot('MOB-03-drawer');
    await app.page.getByTestId('drawer-backdrop').click();
    await app.page.getByTestId('tab-chat').click();
    await app.shot('MOB-03-timeline');
    await expect(app.page.getByTestId('timeline')).toBeVisible();
  });

  test('MOB-04 900×800 侧边栏窄栏与停靠区', async ({ app }) => {
    await app.page.setViewportSize({ width: 900, height: 800 });
    await app.login();
    await app.planFor('dsh', 'echo-context');
    const first = await newSession(app.page, 'dsh', '窄栏测试');
    await waitTurnDone(app.page);
    const sidebar = app.page.getByTestId('sidebar');
    const box = await sidebar.boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(120);
    await app.page.getByTestId('session-header').getByRole('button', { name: /停靠区|▥/ }).click().catch(async () => {
      await app.page.getByRole('button', { name: '▥' }).click();
    });
    await expect(app.page.getByTestId('dock')).toBeVisible();
    void first;
  });
});

test.describe('7.8 UI 截图', () => {
  test('UI-01 1440×900 截图清单', async ({ app }) => {
    await app.page.setViewportSize({ width: 1440, height: 900 });
    await app.login();
    await app.planFor('dsh', 'full');
    await newSession(app.page, 'dsh', '界面截图');
    await waitTurnDone(app.page);
    await app.shot('UI-01-chat');
    await app.page.getByTestId('changes-card').first().click().catch(() => undefined);
    await app.shot('UI-01-changes');
    await expect(app.page.getByTestId('timeline')).toBeVisible();
  });
});
