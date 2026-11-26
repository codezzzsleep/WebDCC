import { chromium, type Browser, type Route } from '@playwright/test';
import { expect, it } from 'vitest';
import { createSourceTestApp } from './helpers.js';

it('recovers Agent, workspace, and Provider choices after a transient initial HTTP failure', async () => {
  const ctx = await createSourceTestApp();
  let browser: Browser | undefined;
  try {
    ctx.store.createWorkspace('Available workspace', ctx.dataDir);
    ctx.store.createProvider({
      id: 'retry-provider', name: 'Available Provider', baseUrl: 'https://fixture.invalid', protocols: ['openai-responses'],
      models: ['retry-model'], secretRef: 'provider:retry-provider', codexCatalogPath: null,
    });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener');
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: origin }]);
    const reads = new Map(['/api/meta', '/api/workspaces', '/api/providers', '/api/dsh'].map(path => [path, 0]));
    await page.route(/^http:\/\/127\.0\.0\.1:\d+\/api\/(meta|workspaces|providers|dsh)$/, async route => {
      const path = new URL(route.request().url()).pathname;
      const attempts = (reads.get(path) ?? 0) + 1;
      reads.set(path, attempts);
      if (path !== '/api/dsh' && attempts === 1) await route.fulfill({ status: 503, json: { error: 'temporarily unavailable' } });
      else await route.continue();
    });
    await page.goto(`${origin}/new?agent=codex`);

    await expect.poll(() => page.getByTestId('agent-card-codex').isEnabled()).toBe(true);
    await expect.poll(() => page.getByTestId('workspace-chip').textContent()).toContain('Available workspace');
    await expect.poll(() => page.getByTestId('model-menu').getAttribute('data-model')).toBe('retry-model');
    expect([...reads.values()]).toEqual([2, 2, 2, 1]);
    await page.getByTestId('new-session-input').fill('Continue after the connection recovers');
    await page.getByTestId('new-session-send').click();
    await page.waitForURL(/\/s\//);
    expect(ctx.store.listSessions().find(session => session.providerId === 'retry-provider')).toMatchObject({ agent: 'codex', model: 'retry-model' });
  } finally {
    await browser?.close();
    await ctx.close();
  }
});

it('ignores an older Provider response that arrives after the next refresh', async () => {
  const ctx = await createSourceTestApp();
  let browser: Browser | undefined;
  try {
    const provider = ctx.store.createProvider({
      id: 'current-provider', name: 'Current Provider', baseUrl: 'https://fixture.invalid', protocols: ['openai-responses'],
      models: ['fixture-model'], secretRef: 'provider:current-provider', codexCatalogPath: null,
    });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener');
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: origin }]);
    let delayed: Route | undefined;
    await page.route(`${origin}/api/providers`, route => {
      if (delayed === undefined) { delayed = route; return; }
      return route.continue();
    });
    await page.goto(`${origin}/settings/providers`);
    const card = page.getByTestId(`provider-${provider.id}`);
    await expect.poll(() => card.isVisible()).toBe(true);
    expect(delayed).toBeDefined();

    const obsolete = page.waitForResponse(response => response.url() === `${origin}/api/providers`);
    await delayed!.fulfill({ json: [] });
    await (await obsolete).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await card.isVisible()).toBe(true);
  } finally {
    await browser?.close();
    await ctx.close();
  }
});
