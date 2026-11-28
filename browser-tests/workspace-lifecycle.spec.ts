import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createSourceTestApp } from './helpers.js';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';

async function drawer(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 1000) < 768 && !await page.getByTestId('drawer-backdrop').count()) await page.getByRole('button', { name: '会话列表', exact: true }).first().click();
}
async function shot(page: Page, name: string): Promise<void> {
  if (process.env['WDCC_EXPERIENCE_EVIDENCE_DIR']) await page.screenshot({ path: join(process.env['WDCC_EXPERIENCE_EVIDENCE_DIR'], name + '.png') });
}

it.each(['codex', 'claude-code', 'dsh'])('%s workspace can be archived and restored on desktop/phone while session links and drafts stay intact', async agent => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const { workspaceId, sessionId } = await seedWorkspaceAndSession(ctx, agent);
    ctx.store.appendEvent({ sessionId, turnId: 'turn', itemKey: 'reply', kind: 'assistant.message', data: { text: '三家各自保留的历史' } });
    const nativeId = ctx.store.getSession(sessionId)?.nativeId;
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 420 }]) {
      await page.setViewportSize(viewport); await page.goto(`${base}/s/${sessionId}`);
      const input = page.getByTestId('composer-input'); await input.fill('会话草稿\n第二行');
      await drawer(page); await page.getByRole('button', { name: '管理工作区 测试工作区', exact: true }).click();
      const dialog = page.getByRole('dialog'); await browserExpect(dialog).toBeVisible();
      await page.keyboard.press('Escape'); await browserExpect(dialog).toHaveCount(0);
      await browserExpect(page.getByRole('button', { name: '管理工作区 测试工作区', exact: true })).toBeFocused();
      await page.getByRole('button', { name: '管理工作区 测试工作区', exact: true }).click();
      await dialog.getByRole('button', { name: '归档工作区', exact: true }).click();
      await browserExpect(dialog).toHaveCount(0);
      await browserExpect(page.getByTestId('sidebar').locator('[data-testid="session-row"]')).toHaveCount(0);
      expect(ctx.store.getSession(sessionId)?.nativeId).toBe(nativeId);
      await shot(page, `workspace-${agent}-${viewport.width}-archived`);
      await page.reload(); await drawer(page); await page.getByTestId('workspace-archive-toggle').click();
      await page.getByRole('button', { name: '管理工作区 测试工作区', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: '恢复工作区', exact: true }).click();
      await browserExpect(page.getByTestId(`workspace-${workspaceId}`).getByTestId('session-row')).toHaveCount(1);
      await browserExpect(input).toHaveValue('会话草稿\n第二行');
      await shot(page, `workspace-${agent}-${viewport.width}-restored`);
    }
  } finally { await browser?.close(); await ctx.close(); }
});

it('empty workspace removal can be cancelled and confirmed, preserving files and clearing the selector', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const path = join(ctx.dataDir, 'project'); await mkdir(path); await writeFile(join(path, 'keep.md'), 'keep');
    const workspace = ctx.store.createWorkspace('临时项目', path);
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/new?w=${workspace.id}&agent=codex`); await page.getByTestId('new-session-input').fill('保留输入');
    await drawer(page); await page.getByRole('button', { name: '管理工作区 临时项目', exact: true }).click();
    const dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: '移除工作区', exact: true }).click();
    await dialog.getByRole('button', { name: '取消移除', exact: true }).click(); expect(ctx.store.getWorkspace(workspace.id)).toBeDefined();
    await dialog.getByRole('button', { name: '移除工作区', exact: true }).click();
    await dialog.getByRole('button', { name: '确认移除', exact: true }).click(); await browserExpect(dialog).toHaveCount(0);
    expect(ctx.store.getWorkspace(workspace.id)).toBeUndefined(); expect(await readFile(join(path, 'keep.md'), 'utf8')).toBe('keep');
    await browserExpect(page.getByTestId('new-session-input')).toHaveValue('保留输入');
    await browserExpect(page.getByTestId('new-session-send')).toBeDisabled();
    await browserExpect(page.getByTestId('workspace-chip')).toContainText('选择工作区');
  } finally { await browser?.close(); await ctx.close(); }
});

it('archiving the selected workspace keeps its new draft bound to it until an explicit choice or restore', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const workspace = ctx.store.createWorkspace('原项目', ctx.dataDir);
    const otherPath = join(ctx.dataDir, 'other'); await mkdir(otherPath); const other = ctx.store.createWorkspace('另一个项目', otherPath);
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/new?w=${workspace.id}&agent=codex`); const input = page.getByTestId('new-session-input'); await input.fill('只属于原项目的草稿');
    await page.getByRole('button', { name: '管理工作区 原项目', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '归档工作区', exact: true }).click();
    await browserExpect(input).toHaveValue('只属于原项目的草稿'); await browserExpect(page.getByTestId('new-session-send')).toBeDisabled();
    await page.getByTestId('workspace-chip').click(); await browserExpect(page.getByRole('menuitemradio').filter({ hasText: '原项目' })).toHaveCount(0);
    await page.getByRole('menuitemradio').filter({ hasText: '另一个项目' }).click(); await browserExpect(input).toHaveValue('');
    expect(ctx.store.getWorkspace(other.id)?.archived).not.toBe(true);
    await page.getByRole('button', { name: '管理工作区 原项目', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '恢复工作区', exact: true }).click();
    await page.getByTestId('workspace-chip').click(); await page.getByRole('menuitemradio').filter({ hasText: '原项目' }).click();
    await browserExpect(input).toHaveValue('只属于原项目的草稿');
  } finally { await browser?.close(); await ctx.close(); }
});
