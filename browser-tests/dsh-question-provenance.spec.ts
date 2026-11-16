/** Real Source DOM/WS/SQLite with a controlled native result and transport failure. */
import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { DshHostClient } from '../packages/adapters/dsh/src/host.js';
import { createSourceTestApp } from './helpers.js';
import { bindDshQuestionFixture } from '../packages/server/test/fixtures/dsh-question.js';

for (const width of [1280, 390]) it(`native answered at ${width}px survives a failed local reply and refresh without another submission`, async () => {
  const ctx = await createSourceTestApp(); const { native, session, ask, result, feed } = bindDshQuestionFixture(ctx); const id = ask();
  let browser: Browser | undefined; let replies = 0;
  try {
    const client = (native.adapter as unknown as { client: DshHostClient }).client; const rpc = client.rpc.bind(client);
    client.rpc = async <T>(endpoint: string, args: Record<string, unknown>) => {
      if (endpoint !== '$events/result') return rpc<T>(endpoint, args);
      replies++; feed({ type: 'cancel', eventId: 'native-question-waterfall' }); result(['Continue']);
      throw Object.assign(new Error('controlled local reply transport loss'), { code: 'uncertain' });
    };
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('source listener missing');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width, height: 960 } }); page.setDefaultTimeout(10000);
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${session.id}`); const card = page.getByTestId('question-card');
    await expect.poll(() => card.getAttribute('data-sync')).toBe('ready');
    await card.getByRole('radio', { name: 'Continue', exact: true }).check();
    await card.getByRole('button', { name: '提交', exact: true }).click();
    await expect.poll(() => card.getAttribute('data-state')).toBe('resolved');
    expect(await card.textContent()).toContain('原生已回答');
    const commandId = ctx.store.interactions.get(session.id, 'answer', id)!.command_id!;
    await expect.poll(() => ctx.store.journal.get(commandId)?.state).toBe('uncertain');
    expect(replies).toBe(1);
    await page.reload();
    await expect.poll(() => card.getAttribute('data-state')).toBe('resolved');
    expect(await card.textContent()).toContain('原生已回答');
    expect(await card.getByRole('button', { name: '提交', exact: true }).count()).toBe(0);
    expect(ctx.store.journal.get(commandId)?.state).toBe('uncertain'); expect(replies).toBe(1);
  } finally { await browser?.close(); await ctx.close(); }
}, 60000);
