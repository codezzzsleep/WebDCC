import { expect, test } from '@playwright/test';
import { createSession, login, waitForTurnComplete } from './helpers.js';

test.describe('M2 / A3 URL 与布局还原', () => {
  test('新建会话后 URL 是 /s/{id}，刷新与另开浏览器都回到同一状态', async ({ page, context }) => {
    await login(page);
    const { sessionId, url } = await createSession(page, 'codex', 'URL 深链测试');
    expect(url).toContain(`/s/${sessionId}`);
    await waitForTurnComplete(page);

    await page.reload();
    await expect(page.getByTestId('session-header')).toContainText('Codex');
    await expect(page.getByTestId('timeline')).toContainText('URL 深链测试');

    // 另一个已认证的上下文打开同一 URL
    const other = await context.browser()?.newContext();
    if (other === undefined) throw new Error('没有浏览器上下文');
    const otherPage = await other.newPage();
    await login(otherPage);
    await otherPage.goto(url);
    await expect(otherPage.getByTestId('timeline')).toContainText('URL 深链测试');
    await other.close();
  });

  test('停靠区可以用 URL 表达并还原', async ({ page }) => {
    await login(page);
    const { sessionId } = await createSession(page, 'codex', '停靠区测试');
    await waitForTurnComplete(page);

    await page.goto(`/s/${sessionId}?dock=files`);
    await expect(page.getByTestId('dock')).toBeVisible();
    await page.getByRole('button', { name: '×' }).click();
    await expect(page.getByTestId('dock')).toBeHidden();

    // 后退能回到带停靠区的状态
    await page.goBack();
    await expect(page.getByTestId('dock')).toBeVisible();
  });

  test('两个标签页同时打开同一会话，流式输出同步', async ({ page, context }) => {
    await login(page);
    const { sessionId } = await createSession(page, 'codex', '双标签同步');
    const other = await context.newPage();
    await other.goto(`/s/${sessionId}`);
    await waitForTurnComplete(page);
    await waitForTurnComplete(other);
    await expect(other.getByTestId('timeline')).toContainText('双标签同步');
  });
});
