import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { createSourceTestApp } from './helpers.js';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';

it('accepted queue moves use the actual source API and survive refresh; a raced cancellation refreshes authoritative order and shows the conflict', async () => {
  const ctx = await createSourceTestApp({ adapterOptions: { delayMs: 60000 } });
  let browser: Browser | undefined;
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    for (const id of ['active', 'B', 'C']) {
      const response = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie },
        payload: { command: { op: 'send', clientCommandId: id, sessionId, text: `Controlled queued ${id}`, intent: 'queue' } } });
      expect(response.json().ok).toBe(true);
    }
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    if (!address || typeof address === 'string') throw new Error('missing queue listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${sessionId}`);
    const C = page.getByTestId('user-message').filter({ hasText: 'Controlled queued C' });
    await expect.poll(() => C.getByRole('button', { name: '提前一位' }).isEnabled()).toBe(true);
    await C.getByRole('button', { name: '提前一位' }).click();
    await expect.poll(() => ctx.store.journal.queue(sessionId).map(row => row.commandId)).toEqual(['active', 'C', 'B']);
    const displayed = async () => (await page.getByTestId('user-message').allTextContents())
      .filter(text => text.includes('Controlled queued B') || text.includes('Controlled queued C'))
      .map(text => text.includes('Controlled queued C') ? 'C' : 'B');
    await expect.poll(displayed).toEqual(['C', 'B']);
    await page.reload();
    await expect.poll(displayed).toEqual(['C', 'B']);
    await expect.poll(() => C.getByRole('button', { name: '延后一位' }).isEnabled()).toBe(true);
    let cancelled: number | undefined;
    await page.route(`**/api/sessions/${sessionId}/queue`, async route => {
      if (route.request().method() === 'PATCH' && cancelled === undefined) {
        cancelled = (await ctx.app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}/queue/B`, headers: { cookie: ctx.cookie } })).statusCode;
      }
      await route.continue();
    });
    await C.getByRole('button', { name: '延后一位' }).click();
    await expect.poll(() => C.textContent()).toContain('队列已变化');
    await expect.poll(displayed).toEqual(['C']);
    expect(cancelled).toBe(204);
    expect(ctx.store.journal.queue(sessionId).map(row => row.commandId)).toEqual(['active', 'C']);
    await page.reload();
    await expect.poll(displayed).toEqual(['C']);
    expect(ctx.store.journal.get('B')?.state).toBe('cancelled');
  } finally { await browser?.close(); await ctx.close(); }
}, 60000);
