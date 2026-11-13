import { test, expect } from '@playwright/test';
import { createSession, login } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await login(page);
  const result = await page.request.patch('/api/watchdog', { data: { enabled: true, baseDelaySeconds: 5, maxDelaySeconds: 30, maxAttempts: 3, maxHandoffs: 1 } });
  expect(result.ok()).toBe(true);
});

test('全局开关可关闭/开启，刷新保持设置，手机显示无横向溢出', async ({ page }, testInfo) => {
  await page.getByTestId('nav-watchdog').click();
  const toggle = page.getByRole('switch', { name: '启用 Codex Watchdog' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true'); await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false'); await page.reload();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await page.getByLabel('初始等待（秒）').fill('10'); await page.getByRole('button', { name: '保存恢复设置' }).click();
  await expect.poll(async () => (await (await page.request.get('/api/watchdog')).json()).settings.baseDelaySeconds).toBe(10);
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.getByLabel('不限续跑次数').check();
  await page.getByLabel('不限转交次数').check();
  await page.getByRole('button', { name: '保存恢复设置' }).click();
  await expect.poll(async () => (await (await page.request.get('/api/watchdog')).json()).settings.maxAttempts).toBeNull();
  await expect.poll(async () => (await (await page.request.get('/api/watchdog')).json()).settings.maxHandoffs).toBeNull();
  await page.reload(); await expect(page.getByLabel('不限续跑次数')).toBeChecked();
  await expect(page.getByLabel('不限转交次数')).toBeChecked();
  await expect(page.getByLabel('续跑上限')).toBeDisabled();
  await page.getByLabel('不限续跑次数').uncheck(); await page.getByLabel('续跑上限').fill('100');
  await page.getByLabel('不限转交次数').uncheck(); await page.getByLabel('转交上限').fill('1000');
  await page.getByRole('button', { name: '保存恢复设置' }).click();
  await expect.poll(async () => (await (await page.request.get('/api/watchdog')).json()).settings.maxHandoffs).toBe(1000);
  await page.getByLabel('不限续跑次数').check(); await page.getByLabel('不限转交次数').check();
  await page.getByRole('button', { name: '保存恢复设置' }).click();
  await expect(toggle).toBeEnabled();
  await page.reload(); await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: testInfo.outputPath('settings-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByTestId('watchdog-page')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('settings-mobile.png'), fullPage: true });
});

test('真实失败生命周期驱动原会话自动续跑，UI 可查看恢复状态', async ({ page }) => {
  const { sessionId } = await createSession(page, 'codex', '[watchdog-rate-limit] 开发任务，暂不上线');
  const original = (await (await page.request.get(`/api/sessions/${sessionId}`)).json()).nativeId;
  await expect(page.getByTestId('watchdog-bar')).toBeVisible();
  await expect.poll(async () => (await (await page.request.get('/api/watchdog')).json()).jobs.find((job: { sessionId: string }) => job.sessionId === sessionId)?.status, { timeout: 30_000 }).toBe('recovered');
  expect((await (await page.request.get(`/api/sessions/${sessionId}`)).json()).nativeId).toBe(original);
  const events = (await (await page.request.get(`/api/sessions/${sessionId}/events`)).json()).events;
  expect(events.filter((event: { kind: string }) => event.kind === 'user.message')).toHaveLength(2);
  await expect(page.getByTestId('watchdog-bar')).toContainText('恢复完成');
});

test('资源不匹配自动创建新会话，页面能沿关联打开接续任务', async ({ page }, testInfo) => {
  const { sessionId } = await createSession(page, 'codex', '[watchdog-resource] 实现功能，暂不上线');
  await expect(page.getByTestId('watchdog-bar').getByRole('link', { name: '打开接续会话' })).toBeVisible({ timeout: 30_000 });
  const jobs = (await (await page.request.get('/api/watchdog')).json()).jobs;
  const targetId = jobs.find((job: { sessionId: string }) => job.sessionId === sessionId).targetSessionId;
  const child = (await (await page.request.get(`/api/sessions/${targetId}`)).json()); expect(child.parentId).toBe(sessionId); expect(child.handoffKind).toBe('watchdog');
  const events = (await (await page.request.get(`/api/sessions/${targetId}/events`)).json()).events;
  const handoff = events.find((event: { kind: string }) => event.kind === 'user.message').data.text;
  expect(handoff).toContain('旧 Codex 会话 ID：');
  expect(handoff).toContain('看一下这个会话的完整上下文，然后继续做');
  expect(handoff.length).toBeLessThan(350);
  const sourceRow = page.getByTestId('sidebar').locator(`a.session-row[href="/s/${sessionId}"]`);
  const targetRow = page.getByTestId('sidebar').locator(`a.session-row[href="/s/${targetId}"]`);
  await expect(sourceRow).toBeVisible(); await expect(targetRow).toBeVisible();
  expect(await targetRow.evaluate((row) => getComputedStyle(row).paddingLeft)).toBe(await sourceRow.evaluate((row) => getComputedStyle(row).paddingLeft));
  await page.getByTestId('watchdog-bar').getByRole('link', { name: '打开接续会话' }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${targetId}$`)); await expect(page.getByTestId('relay-bar')).toContainText('接续自');
  await page.screenshot({ path: testInfo.outputPath('handoff-session.png'), fullPage: true });
});

test('会话状态栏可以取消等待中的恢复', async ({ page }) => {
  await page.request.patch('/api/watchdog', { data: { baseDelaySeconds: 30 } });
  const { sessionId } = await createSession(page, 'codex', '[watchdog-rate-limit] 等待中的任务');
  await page.getByTestId('watchdog-bar').getByRole('button', { name: '取消后续恢复' }).click();
  await expect.poll(async () => (await (await page.request.get('/api/watchdog')).json()).jobs.find((job: { sessionId: string }) => job.sessionId === sessionId)?.status).toBe('cancelled');
});
