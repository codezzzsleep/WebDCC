import { chromium, type Browser } from '@playwright/test';
import { expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { AgentAdapter } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { DshNativeSurface } from '../packages/server/src/dsh-native-surface.js';
import { createSourceTestApp } from './helpers.js';

it('Composer /export reports a failed file read, retries the actual download and restores the receipt without another native execution', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    let commands = 0;
    const adapter: AgentAdapter = new FakeAdapter({ id: 'dsh' });
    adapter.slashCommands = async () => [{ name: '/export', route: 'native-control' }];
    adapter.executeSlashControl = async id => { commands++; return { form: 'dsh-export', confirmed: true, text: 'Session log download requested.', download: { kind: 'dsh-session-log', nativeId: ctx.manager.requireSession(id).nativeId! } }; };
    ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('export browser', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'dsh' });
    const bytes = Buffer.from('504b030400000000ff0013', 'hex'); let reads = 0;
    vi.spyOn(DshNativeSurface.prototype, 'sessionExport').mockImplementation(async nativeId => {
      expect(nativeId).toBe(session.nativeId); reads++;
      return reads === 1 ? new Response('native export unavailable', { status: 503 }) : new Response(bytes, { headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="native-session.zip"' } });
    });
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ acceptDownloads: true });
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${session.id}`);
    const input = page.getByTestId('composer-input'); await input.waitFor(); await input.fill('/export');
    await page.getByTestId('slash-menu').getByRole('button', { name: /^\/export\b/ }).waitFor(); await input.press('Enter');
    const panel = page.getByRole('region', { name: '原生指令结果' });
    await panel.getByRole('alert').filter({ hasText: '503' }).waitFor();
    expect(reads).toBe(1); expect(commands).toBe(1); expect(await panel.textContent()).not.toContain('文件已交给浏览器');
    const downloadEvent = page.waitForEvent('download'); await panel.getByRole('button', { name: '下载会话日志', exact: true }).click();
    const downloaded = await downloadEvent; expect(downloaded.suggestedFilename()).toBe('native-session.zip'); expect(await downloaded.failure()).toBeNull(); expect(await readFile((await downloaded.path())!)).toEqual(bytes);
    await panel.getByText('文件已交给浏览器下载。').waitFor();
    await page.reload(); await panel.getByRole('button', { name: '下载会话日志', exact: true }).waitFor();
    expect(reads).toBe(2); expect(commands).toBe(1);
    const restoredDownload = page.waitForEvent('download'); await panel.getByRole('button', { name: '下载会话日志', exact: true }).click();
    expect(await (await restoredDownload).failure()).toBeNull(); expect(reads).toBe(3); expect(commands).toBe(1);
  } finally { vi.restoreAllMocks(); await browser?.close(); await ctx.close(); }
}, 30_000);
