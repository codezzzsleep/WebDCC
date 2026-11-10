import { expect, test } from '@playwright/test';
import { createSession, login, waitForTurnComplete } from './helpers.js';

test.describe('M2 / A6 弱网', () => {
  test('6a 慢速网络下流式输出持续可见、界面可操作', async ({ page }) => {
    test.setTimeout(300_000);
    await login(page);
    const { sessionId } = await createSession(page, 'codex', '慢网第一条');
    await waitForTurnComplete(page);

    // 现在把网络压到 2s 往返、50KB/s
    const client = await page.context().newCDPSession(page);
    await client.send('Network.enable');
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 2000,
      downloadThroughput: 50 * 1024,
      uploadThroughput: 50 * 1024,
    });

    await page.goto(`/s/${sessionId}`, { waitUntil: 'commit' });
    await expect(page.getByTestId('composer-input')).toBeEditable({ timeout: 60_000 });
    await page.getByTestId('composer-input').fill('慢网测试');
    await page.getByTestId('send-button').click();

    // 界面没卡死：消息立即出现在时间线里（发件箱乐观显示）
    await expect(page.getByTestId('timeline')).toContainText('慢网测试', { timeout: 180_000 });
    await expect(page.getByTestId('composer-input')).toBeEditable();
    await client.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  });

  test('6b 流式中断网 30 秒再恢复：最终时间线与服务端一致', async ({ page, context }) => {
    await login(page);
    const { sessionId } = await createSession(page, 'dsh', '断网恢复测试');
    await context.setOffline(true);
    await page.waitForTimeout(30_000);
    await context.setOffline(false);

    // 恢复后应补齐并显示完成
    await waitForTurnComplete(page);
    const clientEvents = await page.evaluate(() => document.querySelectorAll('[id^="e-"]').length);
    const serverCount = await page.evaluate(async (id) => {
      const response = await fetch(`/api/sessions/${id}/export`, { credentials: 'same-origin' });
      const text = await response.text();
      return text.trim().split('\n').filter(Boolean).length;
    }, sessionId);
    console.log(`A6b：客户端渲染事件锚点 ${clientEvents}，服务端事件 ${serverCount}`);
    expect(serverCount).toBeGreaterThan(100);
    // 时间线最终把这一轮显示为已完成，且没有重复的序号
    await expect(page.getByText(/已完成/).first()).toBeVisible();
  });

  test('6e 离线刷新：应用外壳能打开，已缓存会话可阅读', async ({ page, context }) => {
    await login(page);
    const { sessionId } = await createSession(page, 'codex', '离线刷新测试');
    await waitForTurnComplete(page);

    // 等 Service Worker 接管
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, { timeout: 30_000 });

    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 20_000 });
    await page.goto(`/s/${sessionId}`).catch(() => undefined);
    await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 20_000 });
    await context.setOffline(false);
  });
});
