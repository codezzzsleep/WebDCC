import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import { expect, it } from 'vitest';
import { join } from 'node:path';
import { createSourceTestApp } from './helpers.js';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';

async function reachable(control: Locator): Promise<boolean> {
  return control.evaluate(element => {
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2; const y = box.top + box.height / 2;
    const hit = document.elementFromPoint(x, y);
    return box.width > 0 && box.height > 0 && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight
      && hit !== null && (hit === element || element.contains(hit));
  });
}
async function screenshot(page: Page, name: string): Promise<void> {
  const directory = process.env['WDCC_EXPERIENCE_EVIDENCE_DIR'];
  if (directory) await page.screenshot({ path: join(directory, name + '.png'), fullPage: true });
}

it.each([{ width: 390, height: 844 }, { width: 1366, height: 650 }, { width: 390, height: 420 }])('new page workspace and composer stay reachable with a long draft and attachment at $width×$height', async viewport => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const { workspaceId } = await seedWorkspaceAndSession(ctx, 'codex');
    ctx.store.createWorkspace('另一个工作区', ctx.dataDir);
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport });
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/new?w=${workspaceId}&agent=codex`);
    const input = page.getByTestId('new-session-input'); await expect.poll(() => input.isEnabled()).toBe(true);
    const main = page.getByTestId('new-session'); const chooser = page.getByTestId('workspace-chip');
    await main.evaluate(el => { el.scrollTop = 0; });
    await expect.poll(() => reachable(chooser)).toBe(true);
    await chooser.click(); await page.getByRole('menuitemradio').filter({ hasText: '另一个工作区' }).click();
    await expect.poll(() => input.isEnabled()).toBe(true);
    expect(await chooser.innerText()).toBe('另一个工作区');
    await chooser.click(); await page.getByRole('menuitemradio').filter({ hasText: '测试工作区' }).click();
    await expect.poll(() => input.isEnabled()).toBe(true);
    await input.fill('请检查文件，正文应保留。\n'.repeat(36));
    await page.getByTestId('add-file-input').setInputFiles({ name: 'Model-Agent-RAG-参赛推文.md', mimeType: 'text/markdown', buffer: Buffer.from('# layout original') });
    await expect.poll(() => input.inputValue()).toContain('.webdcc/uploads/');
    const draft = await input.inputValue();
    await main.evaluate(el => { el.scrollTop = 0; });
    await expect.poll(() => reachable(chooser)).toBe(true);
    await screenshot(page, `new-${viewport.width}-${viewport.height}-workspace`);
    await chooser.click(); await page.getByRole('menuitemradio').filter({ hasText: '另一个工作区' }).click();
    await expect.poll(() => input.isEnabled()).toBe(true); await chooser.click();
    await page.getByRole('menuitemradio').filter({ hasText: '测试工作区' }).click();
    await expect.poll(() => input.inputValue()).toBe(draft);
    await main.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect.poll(() => reachable(page.getByTestId('new-session-send'))).toBe(true);
    await page.getByTestId('model-menu').click(); await page.getByRole('menu').last().waitFor();
    await screenshot(page, `new-${viewport.width}-${viewport.height}-composer`);
    await page.keyboard.press('Escape'); await page.reload();
    await expect.poll(() => input.inputValue()).toBe(draft);
    await main.evaluate(el => { el.scrollTop = 0; }); await expect.poll(() => reachable(chooser)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(new URL(page.url()).pathname).toBe('/new');
  } finally { await browser?.close(); await ctx.close(); }
}, 40_000);

it('mobile drawers open from a new page and a resized collapsed tablet, navigate and close without losing drafts', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const { workspaceId, sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/new?w=${workspaceId}&agent=codex`);
    const input = page.getByTestId('new-session-input'); await expect.poll(() => input.isEnabled()).toBe(true);
    await input.fill('抽屉打开与切换会话后应保留');
    await page.getByTestId('drawer-toggle').click();
    const history = page.locator(`[data-testid="session-row"][href="/s/${sessionId}"]`);
    await expect.poll(() => page.getByTestId('sidebar').evaluate(el => Math.abs(el.getBoundingClientRect().left) < 1)).toBe(true);
    await expect.poll(() => reachable(history)).toBe(true);
    await screenshot(page, 'new-mobile-drawer'); await history.click();
    await page.getByTestId('composer-input').waitFor(); await expect.poll(() => page.getByTestId('drawer-backdrop').count()).toBe(0);
    await page.getByTestId('drawer-toggle').click(); await page.getByRole('button', { name: '收起侧边栏', exact: true }).click();
    await expect.poll(() => page.getByTestId('drawer-backdrop').count()).toBe(0);
    await page.setViewportSize({ width: 900, height: 760 }); await page.reload();
    await page.getByRole('button', { name: '展开侧边栏', exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 }); await page.getByTestId('drawer-toggle').click();
    await expect.poll(() => page.getByTestId('sidebar').evaluate(el => Math.abs(el.getBoundingClientRect().left) < 1)).toBe(true);
    await expect.poll(() => reachable(history)).toBe(true); await screenshot(page, 'tablet-to-mobile-drawer');
    await page.getByTestId('nav-new').click(); await expect.poll(() => input.inputValue()).toBe('抽屉打开与切换会话后应保留');
    await expect.poll(() => page.getByTestId('drawer-backdrop').count()).toBe(0);
    await page.getByTestId('drawer-toggle').click();
    await page.getByTestId('nav-providers').click(); await page.waitForURL('**/settings/providers');
    await expect.poll(() => page.getByTestId('drawer-backdrop').count()).toBe(0);
  } finally { await browser?.close(); await ctx.close(); }
}, 40_000);
