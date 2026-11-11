import { expect, test } from '@playwright/test';
import { createSession, login, waitForTurnComplete } from './helpers.js';

test.describe('M6：Provider / 交接 / 提醒 / 文件', () => {
  test('A7 Provider 注册与兼容矩阵，Key 不回显', async ({ page, request }) => {
    await login(page);
    await page.goto('/settings/providers');
    await expect(page.getByTestId('providers-page')).toBeVisible();
    await page.getByTestId('provider-form-toggle').click();
    await page.getByTestId('provider-name').fill('测试 Provider');
    await page.getByTestId('provider-baseurl').fill('http://127.0.0.1:9/v1');
    await page.getByTestId('provider-key').fill('super-secret-key');
    await page.getByTestId('provider-models').fill('mock-a,mock-b');
    await page.getByText('OpenAI Responses（Codex 用）').click();
    await page.getByTestId('provider-create').click();
    await expect(page.getByTestId('provider-list')).toContainText('测试 Provider');
    // 新 UI：Key 只显示后 4 位（不显示"已保存"）
    await expect(page.getByTestId('provider-list')).toContainText('…-key');

    // 接口响应里不能出现 Key 原文
    const providers = await page.evaluate(async () => (await fetch('/api/providers', { credentials: 'same-origin' })).text());
    expect(providers).not.toContain('super-secret-key');
    expect(providers).toContain('测试 Provider');

    // 新建会话页：Codex 可选这个 Provider 的模型，Claude 那边同一 Provider 灰显并写明原因
    await page.goto('/new');
    await page.getByTestId('agent-card-codex').click();
    await page.getByTestId('model-menu').click();
    const codexOption = page.locator('[data-testid="model-option"][data-provider-name="测试 Provider"][data-model="mock-b"]');
    await expect(codexOption).toBeEnabled();
    await codexOption.click();
    await expect(page.getByTestId('model-menu')).toHaveAttribute('data-provider', '测试 Provider');
    await expect(page.getByTestId('model-menu')).toHaveAttribute('data-model', 'mock-b');
    await page.getByTestId('agent-card-claude-code').click();
    await page.getByTestId('model-menu').click();
    const claudeGroup = page.getByRole('group', { name: '测试 Provider' });
    await expect(claudeGroup).toContainText('Claude Code 用不了');
    await expect(claudeGroup.getByTestId('model-option').first()).toBeDisabled();
    void request;
  });

  test('A8 带到…逐字节插入且不自动发送', async ({ page }) => {
    await login(page);
    const source = await createSession(page, 'codex', '交接来源');
    await waitForTurnComplete(page);
    const target = await createSession(page, 'codex', '交接目标');
    await waitForTurnComplete(page);
    await page.goto(`/s/${source.sessionId}`);
    await waitForTurnComplete(page);

    const finalText = await page.evaluate(() => {
      const messages = [...document.querySelectorAll('[data-testid="timeline"] .assistant')];
      return messages.at(-1)?.textContent ?? '';
    });
    expect(finalText.length).toBeGreaterThan(0);

    await page.getByRole('button', { name: '带到…' }).first().click();
    await expect(page.getByTestId('handoff-dialog')).toBeVisible();
    await page.getByRole('button', { name: /交接目标/ }).click();
    await expect(page.getByTestId('toast')).toContainText('还没发送');

    // 目标会话的输入框里是原文；并且没有新的用户消息被自动发出
    await page.goto(`/s/${target.sessionId}`);
    await expect.poll(async () => page.getByTestId('composer-input').inputValue(), { timeout: 20_000 }).toBe(finalText);
    const userEvents = await page.evaluate(async (id) => {
      const response = await fetch(`/api/sessions/${id}/export`, { credentials: 'same-origin' });
      const lines = (await response.text()).trim().split('\n');
      return lines.filter((line) => line.includes('"kind":"user.message"')).length;
    }, target.sessionId);
    expect(userEvents).toBe(1); // 只有创建时的第一条，没有自动发送
  });

  test('A13 后台会话完成时标题显示未读数', async ({ page }) => {
    await login(page);
    const first = await createSession(page, 'codex', '后台会话');
    await waitForTurnComplete(page);
    const second = await createSession(page, 'codex', '当前会话');
    await waitForTurnComplete(page);

    // 在 first 会话里再发一条，然后切到 second 等它完成
    await page.goto(`/s/${first.sessionId}`);
    await page.getByTestId('composer-input').fill('后台再跑一轮');
    await page.getByTestId('send-button').click();
    await page.goto(`/s/${second.sessionId}`);
    await expect.poll(async () => page.title(), { timeout: 60_000 }).toContain('WebDCC');
    await waitForTurnComplete(page);
    await expect.poll(async () => page.title(), { timeout: 60_000 }).toMatch(/^\(\d+\)/);
  });

  test('A4 上传文件：immutable + ETag，无 Cookie 401', async ({ page, browser }) => {
    await login(page);
    const { fileId } = await page.evaluate(async () => {
      const bytes = new TextEncoder().encode('hello webdcc');
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      const init = await (await fetch('/api/uploads', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'a.txt', size: bytes.byteLength, sha256, mime: 'text/plain' }),
      })).json();
      await fetch(`/api/uploads/${init.uploadId}/chunks/0`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes,
      });
      const complete = await (await fetch(`/api/uploads/${init.uploadId}/complete`, { method: 'POST', credentials: 'same-origin' })).json();
      return { fileId: complete.fileId as string };
    });

    const response = await page.request.get(`/files/${fileId}`, { headers: { cookie: (await page.context().cookies()).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') } });
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toContain('immutable');
    expect(response.headers()['etag']).toBeTruthy();

    const anon = await browser.newContext();
    const anonPage = await anon.newPage();
    const unauth = await anonPage.request.get(`/files/${fileId}`);
    expect(unauth.status()).toBe(401);
    await anon.close();
  });
});
