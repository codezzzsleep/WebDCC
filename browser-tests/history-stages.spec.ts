import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdapterEvent, NativeHistoryRecord } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { createSourceTestApp } from './helpers.js';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';

it('actual UI receives a later historical tool failure and retains its output after reload', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  const adapter = new FakeAdapter({ id: 'dsh' }); let receive!: (id: string, event: AdapterEvent) => void;
  adapter.onEvent = callback => { receive = callback; }; ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'dsh'); const nativeId = ctx.store.getSession(sessionId)!.nativeId!;
    const record = (nativeSeq: number, event: NativeHistoryRecord['events'][number]): NativeHistoryRecord => ({
      nativeSeq, nativeTurnId: 'native-turn', at: new Date(1000 + nativeSeq * 1000).toISOString(), native: { nativeSeq, event }, events: [event],
    });
    const opening = [record(0, { type: 'turn.start' }), record(1, { type: 'item.start', itemKey: 'tool', kind: 'command', data: { command: 'staged command', status: 'running' } })];
    receive(sessionId, { type: 'history', nativeId, records: opening });
    const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: address }]);
    await page.goto(`${address}/s/${sessionId}`);
    await browserExpect(page.getByText('staged command', { exact: true })).toBeVisible();
    const result = record(2, { type: 'item.complete', itemKey: 'tool', kind: 'command', data: { command: 'staged command', status: 'failed', outputTail: 'Actual staged failure output' } });
    receive(sessionId, { type: 'history', nativeId, records: [result] });
    expect(ctx.store.allEvents(sessionId).filter(event => event.kind === 'command').at(-1)?.data).toMatchObject({ status: 'failed', outputTail: 'Actual staged failure output' });
    await page.getByText('staged command', { exact: true }).click();
    await browserExpect(page.getByText('Actual staged failure output', { exact: true })).toBeVisible();
    expect(ctx.store.allEvents(sessionId).some(event => event.kind === 'turn.completed')).toBe(false);
    const before = ctx.store.allEvents(sessionId);
    receive(sessionId, { type: 'history', nativeId, records: [...opening, result] }); expect(ctx.store.allEvents(sessionId)).toEqual(before);
    await page.reload(); await page.getByText('staged command', { exact: true }).click();
    await browserExpect(page.getByText('Actual staged failure output', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    const evidence = process.env['WDCC_HISTORY_STAGES_EVIDENCE_DIR'];
    if (evidence !== undefined) {
      await page.screenshot({ path: join(evidence, 'browser-staged-history.png'), fullPage: true });
      await writeFile(join(evidence, 'browser-staged-history.json'), JSON.stringify({ opening, result, events: before, pageErrors: errors }, null, 2));
    }
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
