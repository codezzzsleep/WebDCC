import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSourceTestApp } from './helpers.js';

it('global native records retain the Agent scope and exact payload in the inspector after a browser reload', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const frame = { type: 'stream-frame', streamId: 'events', value: { type: 'waterfall', event: 'approval/request',
      eventId: 'actual-waterfall-id', agentId: 'actual-native-agent', request: { callId: 'actual-tool-call' } } };
    const id = ctx.store.nativeEvents.frame({ sessionId: '@native-host:dsh:controlled', agent: 'dsh' },
      { i: 1, t: 0, dir: 'in', ch: 'mux:$events', frame }, true);
    const original = ctx.store.nativeEvents.get(id)!;
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    const inspect = async () => {
      await page.getByRole('button', { name: String(id), exact: true }).click();
      const details = page.getByRole('region', { name: '记录详情', exact: true });
      await browserExpect(details).toBeVisible();
      await expect.poll(async () => JSON.parse(await details.locator('pre').innerText()) as unknown).toEqual(original);
      expect(original).toMatchObject({ nativeId: 'actual-native-agent', actorId: 'actual-native-agent', ownerId: null, generation: null, payload: frame });
    };
    await page.goto(`${base}/settings/native-events`); await inspect();
    await page.reload(); await inspect();
    expect(ctx.store.getSession(original.sessionId)).toBeUndefined(); expect(errors).toEqual([]);
    const evidence = process.env['WDCC_NATIVE_ACTOR_EVIDENCE_DIR'];
    if (evidence !== undefined) {
      await page.screenshot({ path: join(evidence, 'native-actor-inspector.png'), fullPage: true });
      await writeFile(join(evidence, 'native-actor-inspector.json'), JSON.stringify({ source: 'controlled frame/actual source HTTP and Chromium',
        originalFrame: frame, storedAndReloadedRecord: original, pageErrors: errors, newOfficialAgentCalls: 0, newProviderCalls: 0 }, null, 2));
    }
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
