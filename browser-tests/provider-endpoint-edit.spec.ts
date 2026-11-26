import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { createSourceTestApp } from './helpers.js';

it('edits Provider details and protocol URLs without changing other routes', async () => {
  const ctx = await createSourceTestApp();
  let browser: Browser | undefined;
  try {
    const baseUrl = 'https://fallback.invalid';
    const endpoints = {
      'openai-responses': 'https://responses.invalid/v1',
      'anthropic-messages': 'https://messages.invalid',
    };
    const provider = ctx.store.createProvider({
      id: 'shared-provider', name: 'Shared Provider', baseUrl,
      protocols: Object.keys(endpoints), endpoints: JSON.stringify(endpoints),
      secretRef: 'provider:shared-provider', codexCatalogPath: null, models: ['fixture-model'],
    });
    const workspace = ctx.store.createWorkspace('fixture', ctx.dataDir);
    const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'claude-code', providerId: provider.id });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener');
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: origin }]);
    await page.goto(`${origin}/settings/providers`);
    const card = page.getByTestId(`provider-${provider.id}`);
    await card.locator('.provider-tree-head').click();
    const openForm = () => card.getByRole('button', { name: '编辑 Provider', exact: true }).click();
    const saveForm = () => card.getByRole('button', { name: '保存 Provider', exact: true }).click();

    await openForm();
    await card.getByLabel('Provider 名称').fill('Renamed Provider');
    await card.getByLabel('替换 API Key（留空不修改）').fill('fixture-replacement-key');
    await saveForm();
    await expect.poll(() => ctx.store.getProvider(provider.id)?.name).toBe('Renamed Provider');
    expect(ctx.store.getProvider(provider.id)).toMatchObject({ baseUrl, endpoints: JSON.stringify(endpoints) });
    await expect.poll(() => card.locator('.provider-tree-head').textContent()).toContain('Renamed Provider');

    await openForm();
    const edited = 'https://new-responses.invalid/v1';
    await card.getByLabel('Base URL').fill(edited);
    await saveForm();
    await expect.poll(() => card.locator('.provider-tree-head').textContent()).toContain(edited);
    expect(ctx.store.getProvider(provider.id)).toMatchObject({
      baseUrl, endpoints: JSON.stringify({ ...endpoints, 'openai-responses': edited }),
    });
    await openForm();
    await card.getByLabel('OpenAI Responses Base URL').fill('https://unsaved.invalid');
    await page.getByRole('tab', { name: /Claude Code/ }).click();
    await expect.poll(() => card.locator('.provider-tree-head').textContent()).toContain(endpoints['anthropic-messages']);
    expect(await card.getByLabel('Anthropic Messages Base URL').inputValue()).toBe(endpoints['anthropic-messages']);
    expect(ctx.store.getSession(session.id)?.providerId).toBe(provider.id);
  } finally {
    await browser?.close();
    await ctx.close();
  }
});
