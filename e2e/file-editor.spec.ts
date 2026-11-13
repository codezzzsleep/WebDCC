import { test, expect } from '@playwright/test';
import { createSession, login, waitForTurnComplete } from './helpers.js';
test('Web editing saves real bytes, retains navigation drafts and rejects stale versions', async ({ page }) => {
  await login(page); const { sessionId } = await createSession(page, 'codex'); await waitForTurnComplete(page);
  const session = await (await page.request.get(`/api/sessions/${sessionId}`)).json();
  const endpoint = `/api/workspaces/${session.workspaceId}/fs`;
  const name = `editor-${Date.now()}.txt`;
  expect((await page.request.post(endpoint, { data: { path: name, kind: 'file', content: '原始内容\r\n' } })).ok()).toBe(true);
  const open = async (): Promise<void> => { await page.goto(`/s/${sessionId}?dock=files`); await page.getByTestId('dock').getByRole('button', { name, exact: true }).click(); };
  await open(); await page.getByTestId('file-preview').getByRole('button', { name: '编辑', exact: true }).click();
  const text = page.getByRole('textbox', { name: `编辑 ${name}` });
  await text.fill('网页修改\n'); await text.press('Control+s'); await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  const disk = await (await page.request.get(endpoint, { params: { path: name } })).json(); expect(disk.content).toBe('网页修改\r\n');
  await text.fill('未保存草稿\n'); await page.getByTestId('dock-close').click();
  await open(); await expect(text).toHaveValue('未保存草稿\n');
  expect((await page.request.put(endpoint, { data: { path: name, content: '外部修改\n', version: disk.version } })).status()).toBe(200);
  await text.press('Control+s'); await expect(page.getByRole('alert')).toContainText('文件已被外部修改');
  await expect(text).toHaveValue('未保存草稿\n');
  expect((await (await page.request.get(endpoint, { params: { path: name } })).json()).content).toBe('外部修改\r\n');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: '重新加载', exact: true }).click(); await expect(text).toHaveValue('外部修改\n');
});
test('tab badge counts background completion once and clears on viewing/reload', async ({ page }) => {
  await login(page); const first = await createSession(page, 'codex', '第一会话'); await waitForTurnComplete(page);
  await createSession(page, 'codex', '第二会话'); await waitForTurnComplete(page); await expect(page).toHaveTitle('WebDCC');
  const response = await page.request.post('/api/commands', { data: { op: 'send', sessionId: first.sessionId, text: '后台完成提醒', clientCommandId: `badge-${Date.now()}` } }); expect((await response.json()).ok).toBe(true);
  await expect(page).toHaveTitle('(1) WebDCC');
  await page.goto(`/s/${first.sessionId}`); await expect(page).toHaveTitle('WebDCC'); await page.reload(); await expect(page).toHaveTitle('WebDCC');
});
