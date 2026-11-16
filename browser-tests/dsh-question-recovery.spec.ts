import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { createSourceTestApp } from './helpers.js';
import { bindDshQuestionFixture } from '../packages/server/test/fixtures/dsh-question.js';

for (const width of [1280, 390]) it(`DSH question at ${width}px waits through a browser refresh for the actual native business result`, async () => {
  const ctx = await createSourceTestApp(); const { ask, result, session } = bindDshQuestionFixture(ctx); ask();
  let browser: Browser | undefined;
  try {
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('question browser listener missing');
    const base = `http://127.0.0.1:${address.port}`; browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width, height: 960 } });
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${session.id}`);
    const card = page.getByTestId('question-card');
    await expect.poll(() => card.getAttribute('data-sync')).toBe('ready');
    await card.getByRole('radio', { name: 'Continue', exact: true }).check();
    await card.getByRole('button', { name: '提交', exact: true }).click();
    await expect.poll(() => card.textContent()).toContain('已提交，等待原生结果');
    expect(await card.getAttribute('data-state')).toBe('pending');
    await page.reload();
    await expect.poll(() => card.textContent()).toContain('已提交，等待原生结果');
    expect(await card.getAttribute('data-state')).toBe('pending');
    expect(await card.getByRole('button', { name: '提交', exact: true }).isDisabled()).toBe(true);
    result(['Continue']);
    await expect.poll(() => card.getAttribute('data-state')).toBe('resolved');
    expect(await card.textContent()).toContain('已回答');
    await page.reload(); await expect.poll(() => card.getAttribute('data-state')).toBe('resolved');
  } finally { await browser?.close(); await ctx.close(); }
}, 60000);
