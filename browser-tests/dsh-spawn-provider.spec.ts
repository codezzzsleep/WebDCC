import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { createSourceTestApp } from './helpers.js';
import { settingsHost } from '../packages/server/test/fixtures/dsh-settings.js';

it('opening the DSH tab refreshes a cold cached status and exposes the running owned Host Provider', async () => {
  const host = await settingsHost();
  const ctx = await createSourceTestApp();
  let browser: Browser | undefined;
  let runtime: { url: string; browserCookie: string; connectedAt: string } | null = null;
  Object.assign(ctx.manager.adapter('dsh')!, { nativeBrowserConnection: () => runtime });
  try {
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener');
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: origin }]);
    const initial = page.waitForResponse(response => response.url().endsWith('/api/dsh'));
    await page.goto(origin + '/settings/providers');
    expect((await (await initial).json()).connected).toBe(false);
    runtime = { url: host.url, browserCookie: 'fixture-cookie', connectedAt: '2026-11-28T12:00:00Z' };
    await page.getByRole('tab', { name: /DeepSeek Harness/ }).click();
    const provider = page.getByLabel('DSH Provider', { exact: true });
    await browserExpect(provider).toBeVisible();
    await browserExpect(provider).toHaveValue('target');
    await provider.selectOption('other');
    await browserExpect(provider).toHaveValue('other');
    expect(ctx.dsh.connection).toBeNull();
    expect(host.calls.some(call => call.method === 'settings/describe')).toBe(true);
    await browserExpect(page.getByRole('tab', { name: /DeepSeek Harness/ })).toContainText('已连接');
  } finally {
    await browser?.close();
    await ctx.close();
    await host.close();
  }
});
