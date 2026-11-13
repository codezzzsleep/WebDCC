import { chromium } from '@playwright/test';
import { expect, it } from 'vitest';
import { createTestApp, TEST_TOKEN } from '../packages/server/test/helpers.js';

it('NP-13 a browser downloads hostile documents without running authenticated mutations', async () => {
  const ctx = await createTestApp();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('Missing test listener');
    const base = `http://127.0.0.1:${address.port}`;
    const page = await browser.newPage();
    await page.goto(`${base}/?token=${TEST_TOKEN}`);
    const mutations: string[] = [];
    page.on('request', request => { if (request.url().endsWith('/api/workspaces') && request.method() === 'POST') mutations.push(request.url()); });
    for (const mime of ['text/html', 'image/svg+xml', 'image/png']) {
      const script = `fetch('/api/workspaces',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'attack',path:${JSON.stringify(ctx.dataDir)}})})`;
      const content = mime === 'image/svg+xml' ? `<svg xmlns="http://www.w3.org/2000/svg"><script>${script}</script></svg>` : `<script>${script}</script><!--${mime}-->`;
      const file = await ctx.files.putBuffer(Buffer.from(content), 'hostile.html', mime);
      const download = page.waitForEvent('download');
      await page.goto(`${base}/files/${file.id}`).catch(error => { if (!String(error).includes('ERR_ABORTED') && !String(error).includes('Download is starting')) throw error; });
      expect((await download).suggestedFilename()).toBe('hostile.html');
      expect(mutations).toEqual([]);
      expect(ctx.store.listWorkspaces()).toEqual([]);
    }
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
