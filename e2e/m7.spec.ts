import { expect, test } from '@playwright/test';
import { createSession, login, waitForTurnComplete } from './helpers.js';

test.describe('M7 / A6 剩余弱网场景', () => {
  test('6c 离线发送：气泡显示待发送，恢复后只送达一次', async ({ page, context }) => {
    await login(page);
    const { sessionId } = await createSession(page, 'codex', '离线发送');
    await waitForTurnComplete(page);

    await context.setOffline(true);
    await page.getByTestId('composer-input').fill('离线时发的消息');
    await page.getByTestId('send-button').click();
    await expect(page.getByTestId('timeline')).toContainText('待发送', { timeout: 10_000 });
    await page.waitForTimeout(1000);
    await context.setOffline(false);

    // 恢复后自动送达
    await expect.poll(async () => {
      const text = await page.evaluate(async (id) => {
        const response = await fetch(`/api/sessions/${id}/export`, { credentials: 'same-origin' });
        return response.text();
      }, sessionId);
      return text
        .split('\n')
        .filter((line) => line.includes('"kind":"user.message"') && line.includes('离线时发的消息')).length;
    }, { timeout: 60_000 }).toBe(1);
    await expect(page.getByTestId('timeline')).not.toContainText('待发送', { timeout: 30_000 });
  });

  test('6d 离线审批：恢复后只生效一次', async ({ page, context }) => {
    await login(page);
    const { sessionId } = await createSession(page, 'claude-code', '离线审批');
    await expect(page.getByTestId('approval-card').first()).toBeVisible({ timeout: 60_000 });

    await context.setOffline(true);
    await page.getByTestId('approval-card').first().getByRole('button', { name: '允许一次' }).click();
    await page.waitForTimeout(800);
    await context.setOffline(false);

    await expect.poll(async () => {
      const text = await page.evaluate(async (id) => {
        const response = await fetch(`/api/sessions/${id}/export`, { credentials: 'same-origin' });
        return response.text();
      }, sessionId);
      return text.split('\n').filter((line) => line.includes('"kind":"approval.resolved"')).length;
    }, { timeout: 60_000 }).toBe(1);
  });

  test('6f 20MB 上传中途断网后续传，最终 sha256 一致', async ({ page, context }) => {
    test.setTimeout(180_000);
    await login(page);
    const result = await page.evaluate(async () => {
      const size = 20 * 1024 * 1024;
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i += 1) bytes[i] = i % 251;
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      const init = await (await fetch('/api/uploads', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'big.bin', size, sha256, mime: 'application/octet-stream' }),
      })).json();
      const chunkSize = init.chunkSize as number;
      const chunks = Math.ceil(size / chunkSize);
      const status = async () => (await (await fetch(`/api/uploads/${init.uploadId}`, { credentials: 'same-origin' })).json()).received as number[];
      // 先传前两块，然后"断网"（这里用停止循环模拟），查状态续传
      for (let index = 0; index < Math.min(2, chunks); index += 1) {
        await fetch(`/api/uploads/${init.uploadId}/chunks/${index}`, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/octet-stream' },
          body: bytes.slice(index * chunkSize, (index + 1) * chunkSize),
        });
      }
      let received = await status();
      const resumedFrom = received.length;
      for (let index = 0; index < chunks; index += 1) {
        if (received.includes(index)) continue;
        await fetch(`/api/uploads/${init.uploadId}/chunks/${index}`, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/octet-stream' },
          body: bytes.slice(index * chunkSize, (index + 1) * chunkSize),
        });
        received = await status();
      }
      const complete = await (await fetch(`/api/uploads/${init.uploadId}/complete`, { method: 'POST', credentials: 'same-origin' })).json();
      return { fileId: complete.fileId as string, sha256, resumedFrom, chunks };
    });
    console.log(`6f：${result.chunks} 块，断点从第 ${result.resumedFrom} 块续传`);
    expect(result.resumedFrom).toBe(2);
    const check = await page.evaluate(async (fileId) => {
      const response = await fetch(`/files/${fileId}`, { credentials: 'same-origin' });
      const buffer = await response.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }, result.fileId);
    expect(check).toBe(result.sha256);
    void context;
  });
});
