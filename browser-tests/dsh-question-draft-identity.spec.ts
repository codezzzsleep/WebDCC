/** Source DOM over real HTTP; cached question/feed ordering is controlled, no native Host/Provider. */
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
import { expect, it } from 'vitest';

async function sourcePage(secret = false) {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-dsh-draft-identity-'));
  await build({ entryPoints: ['browser-tests/fixtures/dsh-question-draft-identity.tsx'], outfile: join(directory, 'ui.js'),
    bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', nodePaths: [join(process.cwd(), 'packages/web/node_modules')],
    external: ['/fonts/*'], define: { 'import.meta.env': JSON.stringify({ DEV: true, MODE: 'test' }) } });
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/ui.js')) { response.setHeader('content-type', 'text/javascript'); void readFile(join(directory, 'ui.js')).then(body => response.end(body)); }
    else response.end('<html><body><div id="root"></div><script type="module" src="/ui.js"></script></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('source listener absent');
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(10000);
  await page.goto(`http://127.0.0.1:${address.port}/${secret ? '?secret=1' : ''}`);
  return { page, async close() { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); } };
}

it('hydrates saved selected/custom after cached questions render before the DSH session identity', async () => {
  const ctx = await sourcePage();
  try {
    const card = ctx.page.getByTestId('question-card'); const text = card.getByRole('textbox', { name: '其他回答' });
    await expect.poll(() => card.getAttribute('data-sync')).toBe('loading');
    expect(await text.inputValue()).toBe('');
    await ctx.page.evaluate(() => window.draftFixture.publishSession());
    await expect.poll(() => ctx.page.getByTestId('dsh-question-wait').getAttribute('data-wait-state')).toBe('editing');
    await expect.poll(() => text.inputValue()).toBe('saved original draft');
    expect(await card.getByRole('radio', { name: 'Continue' }).isChecked()).toBe(true);
    await ctx.page.evaluate(() => window.draftFixture.continueQuestion());
    await text.fill('currently editing'); await ctx.page.evaluate(() => window.draftFixture.duplicateDelivery());
    expect(await text.inputValue()).toBe('currently editing');
  } finally { await ctx.close(); }
}, 30000);

it('does not hydrate a sensitive answer from a prior persisted draft when native identity becomes available', async () => {
  const ctx = await sourcePage(true);
  try {
    const card = ctx.page.getByTestId('question-card'); await expect.poll(() => card.getAttribute('data-sync')).toBe('loading');
    await ctx.page.evaluate(() => window.draftFixture.publishSession());
    await expect.poll(() => card.getAttribute('data-sync')).toBe('ready');
    expect(await card.getByRole('textbox', { name: '其他回答' }).inputValue()).toBe('');
    expect(await card.getByRole('radio', { name: 'Continue' }).isChecked()).toBe(false);
  } finally { await ctx.close(); }
}, 30000);
