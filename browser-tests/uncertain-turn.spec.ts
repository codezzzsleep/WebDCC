import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdapterEvent } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { createSourceTestApp } from './helpers.js';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';

it('unknown send keeps stop, native streaming and unfinished state through actual browser HTTP/WS and reload', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  const adapter = new FakeAdapter({ id: 'codex' }); let emit!: (id: string, event: AdapterEvent) => void;
  adapter.onEvent = callback => { emit = callback; }; let sends = 0;
  adapter.send = async id => { sends++; emit(id, { type: 'turn.start', nativeTurnId: 'native-current' });
    emit(id, { type: 'item.start', itemKey: 'answer', kind: 'assistant.message', nativeTurnId: 'native-current', data: { text: 'Native stream', phase: 'final' } });
    throw new Error('lost send response'); };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex'); const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: address }]);
    await page.goto(`${address}/s/${sessionId}`); await browserExpect(page.getByTestId('timeline')).toBeVisible();
    const command = { op: 'send', clientCommandId: 'browser-unknown-send', sessionId, text: 'Original input' };
    const send = () => page.evaluate(async command => (await fetch('/api/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command }) })).json(), command);
    expect(await send()).toMatchObject({ ok: false, code: 'uncertain' });
    await browserExpect(page.getByText('Native stream', { exact: true })).toBeVisible();
    await browserExpect(page.getByTestId('stop-button')).toBeVisible();
    expect(ctx.store.allEvents(sessionId).some(event => event.kind === 'turn.completed')).toBe(false);
    expect(await send()).toMatchObject({ ok: false, code: 'uncertain' }); expect(sends).toBe(1);
    emit(sessionId, { type: 'item.delta', itemKey: 'answer', field: 'text', append: ' continues', nativeTurnId: 'native-current' });
    await browserExpect(page.getByText('Native stream continues', { exact: true })).toBeVisible();
    await page.reload(); await browserExpect(page.getByText('Native stream continues', { exact: true })).toBeVisible();
    await browserExpect(page.getByTestId('stop-button')).toBeVisible(); expect(await page.locator('.turn-running').count()).toBe(1);
    emit(sessionId, { type: 'item.complete', itemKey: 'answer', kind: 'assistant.message', data: { text: 'Native stream continues', phase: 'final' }, nativeTurnId: 'native-current' });
    emit(sessionId, { type: 'turn.end', nativeTurnId: 'native-current', status: 'completed' });
    await expect.poll(() => ctx.store.journal.get(command.clientCommandId)?.state, { timeout: 5000 }).toBe('completed');
    await browserExpect(page.getByTestId('stop-button')).toHaveCount(0); expect(ctx.store.allEvents(sessionId).filter(event => event.kind === 'turn.completed')).toHaveLength(1);
    expect(errors).toEqual([]);
    const directory = process.env['WDCC_UNCERTAIN_TURN_EVIDENCE_DIR'];
    if (directory !== undefined) {
      await page.screenshot({ path: join(directory, 'browser-uncertain-turn.png'), fullPage: true });
      await writeFile(join(directory, 'browser-uncertain-turn.json'), JSON.stringify({ command, sends, owner: ctx.store.nativeOwners.get(sessionId), events: ctx.store.allEvents(sessionId), record: ctx.store.journal.get(command.clientCommandId), pageErrors: errors }, null, 2));
    }
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
