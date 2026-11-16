import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdapterEvent, NativeHistoryRecord } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { createSourceTestApp } from './helpers.js';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';

it('history shows the external user and unfinished command with reused keys after actual browser reload', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  const adapter = new FakeAdapter({ id: 'dsh' }); let receive!: (id: string, event: AdapterEvent) => void;
  adapter.onEvent = callback => { receive = callback; }; ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'dsh'); const nativeId = ctx.store.getSession(sessionId)!.nativeId!;
    ctx.store.appendEvent({ sessionId, turnId: 'local-turn', itemKey: 'local-user', kind: 'user.message', data: { text: 'Local original input', clientCommandId: 'local-request' } });
    const record = (nativeSeq: number, nativeTurnId: string, event: NativeHistoryRecord['events'][number]): NativeHistoryRecord => ({
      nativeSeq, nativeTurnId, at: new Date(1000 + nativeSeq * 1000).toISOString(), native: { nativeSeq, nativeTurnId, event }, events: [event],
    });
    const records = [
      record(1, 'A', { type: 'item.complete', itemKey: 'shared-user', kind: 'user.message', data: { text: 'Local original input', clientCommandId: 'local-request' } }),
      record(2, 'B', { type: 'turn.start' }),
      record(3, 'B', { type: 'item.complete', itemKey: 'shared-user', kind: 'user.message', data: { text: 'External native input', clientCommandId: 'external-request' } }),
      record(4, 'B', { type: 'item.complete', itemKey: 'shared-tool', kind: 'command', data: { command: 'old command', status: 'completed', outputTail: 'done' } }),
      record(5, 'B', { type: 'turn.end', status: 'completed' }),
      record(6, 'A', { type: 'turn.start' }),
      record(7, 'A', { type: 'item.start', itemKey: 'shared-tool', kind: 'command', data: { command: 'current unfinished command', status: 'running' } }),
    ];
    receive(sessionId, { type: 'history', nativeId, records });
    const events = ctx.store.allEvents(sessionId);
    expect(events.filter(event => event.kind === 'user.message')).toHaveLength(2);
    expect(events.filter(event => event.kind === 'command')).toHaveLength(2);
    const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: address }]);
    const check = async () => {
      await browserExpect(page.getByText('Local original input', { exact: true })).toBeVisible();
      await browserExpect(page.getByText('External native input', { exact: true })).toBeVisible();
      await browserExpect(page.getByText('current unfinished command', { exact: true })).toBeVisible();
      expect(await page.locator('.turn-running').count()).toBe(1);
    };
    await page.goto(`${address}/s/${sessionId}`); await check();
    receive(sessionId, { type: 'history', nativeId, records }); expect(ctx.store.allEvents(sessionId)).toEqual(events);
    await page.reload(); await check();
    expect(errors).toEqual([]);
    const evidence = process.env['WDCC_HISTORY_IDENTITY_EVIDENCE_DIR'];
    if (evidence !== undefined) {
      await page.screenshot({ path: join(evidence, 'browser-history-identity.png'), fullPage: true });
      await writeFile(join(evidence, 'browser-history-identity.json'), JSON.stringify({ records, events, pageErrors: errors }, null, 2));
    }
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
