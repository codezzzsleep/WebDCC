import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';
import { createSourceTestApp } from './helpers.js';

it.each([true, false])('two tabs sharing one local draft do not conflict with their own accepted save while its response is delayed (Web Locks %s)', async locks => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const context = await browser.newContext();
    if (!locks) await context.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }));
    await context.addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    const a = await context.newPage(); const b = await context.newPage();
    await a.goto(`${base}/s/${sessionId}`);
    await expect.poll(() => a.getByTestId('composer-input').isEnabled()).toBe(true);
    let accepted!: () => void; const saved = new Promise<void>(resolve => { accepted = resolve; });
    const statuses: number[] = []; let first = true;
    await context.route(`**/api/sessions/${sessionId}/draft`, async route => {
      if (route.request().method() !== 'PUT') return route.continue();
      const response = await route.fetch(); statuses.push(response.status());
      if (first) { first = false; accepted(); await gate; }
      await route.fulfill({ response });
    });
    const text = '本地共同草稿'; await a.getByTestId('composer-input').fill(text); await saved;
    expect(ctx.store.getDraft(sessionId).text).toBe(text);
    await b.goto(`${base}/s/${sessionId}`);
    await expect.poll(() => b.getByTestId('composer-input').inputValue()).toBe(text);
    await b.waitForTimeout(300); release();
    await expect.poll(() => b.getByTestId('draft-sync-state').getAttribute('data-pending')).toBe('false');
    expect(statuses).toEqual([200]);
    expect(await b.getByRole('button', { name: '使用本机草稿', exact: true }).count()).toBe(0);
    await b.getByTestId('composer-input').fill(text + '继续输入');
    await expect.poll(() => ctx.store.getDraft(sessionId).text).toBe(text + '继续输入');
    await expect.poll(() => b.getByTestId('draft-sync-state').getAttribute('data-pending')).toBe('false');
    expect(ctx.store.allEvents(sessionId).filter(event => event.kind === 'user.message')).toHaveLength(0);
  } finally { release(); await browser?.close(); await ctx.close(); }
}, 30_000);

it('a server-accepted draft whose response was lost recovers after refresh and preserves later typing', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${sessionId}`);
    await expect.poll(() => page.getByTestId('composer-input').isEnabled()).toBe(true);
    let lost = false, reconnect = false;
    await page.route(`**/api/sessions/${sessionId}/draft`, async route => {
      if (route.request().method() === 'GET' && lost && !reconnect) return route.abort('connectionreset');
      if (route.request().method() !== 'PUT' || lost) return route.continue();
      const response = await route.fetch(); expect(response.status()).toBe(200); lost = true;
      await route.abort('connectionreset');
    });
    const text = '服务器保存成功，响应丢失'; await page.getByTestId('composer-input').fill(text);
    await expect.poll(() => ctx.store.getDraft(sessionId).text).toBe(text);
    await page.getByRole('button', { name: '重试同步', exact: true }).waitFor();
    reconnect = true;
    await page.reload();
    await expect.poll(() => page.getByTestId('composer-input').inputValue()).toBe(text);
    await expect.poll(() => page.getByTestId('draft-sync-state').getAttribute('data-pending')).toBe('false');
    await page.getByTestId('composer-input').fill(text + '，继续输入');
    await expect.poll(() => ctx.store.getDraft(sessionId).text).toBe(text + '，继续输入');
    expect(await page.getByRole('button', { name: '使用本机草稿', exact: true }).count()).toBe(0);
    expect(ctx.store.allEvents(sessionId).filter(event => event.kind === 'user.message')).toHaveLength(0);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);

it('a pre-existing obsolete revision with unchanged remote content heals on typing without a manual choice', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${sessionId}`);
    await expect.poll(() => page.getByTestId('composer-input').isEnabled()).toBe(true);
    for (let i = 0; i < 3; i++) ctx.store.setDraft(sessionId, '', [], { contentParts: { version: 1, parts: [] } });
    const statuses: number[] = [];
    page.on('response', response => { if (response.request().method() === 'PUT' && response.url().endsWith(`/${sessionId}/draft`)) statuses.push(response.status()); });
    await page.getByTestId('composer-input').fill('本地');
    await expect.poll(() => ctx.store.getDraft(sessionId).text).toBe('本地');
    await expect.poll(() => page.getByTestId('draft-sync-state').getAttribute('data-pending')).toBe('false');
    expect(statuses).toEqual([409, 200]);
    expect(await page.getByTestId('composer-input').inputValue()).toBe('本地');
    expect(await page.getByRole('button', { name: '使用本机草稿', exact: true }).count()).toBe(0);
    expect(ctx.store.allEvents(sessionId).filter(event => event.kind === 'user.message')).toHaveLength(0);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
