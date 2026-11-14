import { chromium } from '@playwright/test';
import { expect, it } from 'vitest';
import { createSourceTestApp } from './helpers.js';
import { settingsHost } from '../packages/server/test/fixtures/dsh-settings.js';

it('NP-12 browser edits preserve draft on a stale save, preview the Host and separate model capability from default selection', async () => {
  const host = await settingsHost();
  const ctx = await createSourceTestApp();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await ctx.dsh.save({ url: host.url, cookie: 'fixture-cookie', connectedAt: new Date().toISOString() });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('Missing test address');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/settings/providers`);
    await page.getByRole('tab').nth(0).waitFor();
    await page.getByRole('tab').filter({ hasText: 'DeepSeek' }).click();
    const model = page.locator('.model-row').filter({ hasText: 'Model B' });
    await model.getByRole('button', { name: '编辑', exact: true }).click();
    const context = page.getByLabel('上下文长度');
    await context.fill('333');
    await page.getByRole('button', { name: '查看变更' }).click();
    const preview = page.getByTestId('dsh-settings-preview');
    await preview.waitFor();
    expect(await preview.textContent()).toContain(host.url);
    expect(host.calls.filter(call => call.method === 'settings/mutate')).toEqual([]);
    await preview.getByRole('button', { name: '取消', exact: true }).click();
    expect(await context.inputValue()).toBe('333');
    await page.getByRole('button', { name: '查看变更' }).click();
    await preview.waitFor();
    host.state.namespaces[0]!.revision++;
    await preview.getByRole('button', { name: '确认保存' }).click();
    await expect.poll(() => page.getByRole('alert').textContent()).toContain('其他客户端');
    expect(await context.inputValue()).toBe('333');
    expect(host.calls.filter(call => call.method === 'settings/mutate')).toEqual([]);
    await page.getByRole('button', { name: '刷新并重新核对' }).click();
    await expect.poll(() => page.getByRole('alert').count()).toBe(0);
    await page.getByRole('button', { name: '查看变更' }).click();
    await preview.waitFor();
    await preview.getByRole('button', { name: '确认保存' }).click();
    await expect.poll(() => preview.count()).toBe(0);
    const providers = host.state.namespaces[0]!.value['providers'] as Record<string, { models: Record<string, unknown>[] }>;
    expect(providers['target']?.models).toEqual([
      { id: 'a', name: 'Model A', reasoningEfforts: { high: 'high' }, contextWindow: 111, unknown: 'keep A' },
      { id: 'b', name: 'Model B', reasoningEfforts: { low: 'low', high: 'high' }, maxTokens: 222, unknown: 'keep B', contextWindow: 333 },
    ]);
    expect(host.state.namespaces[1]!.value['model']).toBe('a');
    await page.getByRole('button', { name: '将 b 设为默认' }).click();
    await preview.waitFor();
    expect(await preview.textContent()).toContain('新会话默认模型');
    await preview.getByRole('button', { name: '确认保存' }).click();
    await expect.poll(() => host.state.namespaces[1]!.value['model']).toBe('b');
    expect(host.state.namespaces[1]!.value['reasoningEffort']).toBe('high');
    await page.reload();
    await page.getByRole('tab').filter({ hasText: 'DeepSeek' }).click();
    await expect.poll(() => page.locator('.model-tree-head .badge').textContent()).toBe('b');
  } finally { await browser?.close(); await ctx.close(); await host.close(); }
}, 30_000);
