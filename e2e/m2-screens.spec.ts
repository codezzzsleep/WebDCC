import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { createSession, login, waitForTurnComplete } from './helpers.js';

const OUT = 'docs/acceptance/M2';

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
}

test.describe('M2 / A12 界面截图', () => {
  test('1440×900 桌面截图', async ({ page }) => {
    test.setTimeout(180_000);
    await mkdir(OUT, { recursive: true });
    await login(page);

    await page.goto('/new');
    await page.waitForTimeout(300);
    await shot(page, 'new-session');

    const { sessionId } = await createSession(page, 'codex', '看一下这个仓库的结构');
    await waitForTurnComplete(page);
    await page.waitForTimeout(400);
    await shot(page, 'session-collapsed');

    // 展开这一轮
    await page.getByRole('button', { name: /已完成/ }).first().click();
    await page.waitForTimeout(300);
    await shot(page, 'session-expanded');

    // 轨迹
    await page.getByTestId('tab-trajectory').click();
    await page.waitForTimeout(300);
    await shot(page, 'trajectory');
    await page.getByTestId('tab-chat').click();

    // @ 菜单
    await page.getByTestId('composer-input').fill('@');
    await page.waitForTimeout(400);
    await shot(page, 'at-menu');
    await page.getByTestId('composer-input').fill('');

    // 停靠区：工作区文件
    await page.goto(`/s/${sessionId}?dock=files`);
    await page.waitForTimeout(500);
    await shot(page, 'dock-files');

    // 停靠区：diff（先上传一个 diff 文件）
    const diffText = [
      'diff --git a/README.md b/README.md',
      'index 1111111..2222222 100644',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1,2 +1,3 @@',
      ' # WebDCC',
      '+新增一行',
      '-删除一行',
      '',
    ].join('\n');
    const fileId = await page.evaluate(async (text) => {
      const bytes = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      const init = await (
        await fetch('/api/uploads', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'change.diff', size: bytes.byteLength, sha256, mime: 'text/x-diff' }),
        })
      ).json();
      await fetch(`/api/uploads/${init.uploadId}/chunks/0`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes,
      });
      const complete = await (await fetch(`/api/uploads/${init.uploadId}/complete`, { method: 'POST', credentials: 'same-origin' })).json();
      return complete.fileId as string;
    }, diffText);
    await page.goto(`/s/${sessionId}?dock=diff:${fileId}&path=README.md`);
    await page.waitForTimeout(1200);
    await shot(page, 'dock-diff');

    // 审批卡片与任务面板：claude-code adapter 会请求审批
    const approval = await createSession(page, 'claude-code', '帮我改个文件');
    await expect(page.getByTestId('approval-card').first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(300);
    await shot(page, 'approval-card');

    // 停靠区会话标签：把另一个会话放进右栏
    await page.goto(`/s/${sessionId}+${approval.sessionId}`);
    await page.waitForTimeout(1200);
    await shot(page, 'dock-session');
  });

  test('390×844 手机截图', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    const { sessionId } = await createSession(page, 'codex', '手机上的会话');
    await waitForTurnComplete(page);
    await page.waitForTimeout(300);
    await shot(page, 'mobile-session');
    await page.goto(`/s/${sessionId}?dock=files`);
    await page.waitForTimeout(500);
    await shot(page, 'mobile-dock');
  });
});
