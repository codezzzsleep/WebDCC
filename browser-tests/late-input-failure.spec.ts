import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdapterEvent } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { createSourceTestApp } from './helpers.js';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';

it('an old send error does not stop the current native stream in the actual UI', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let emit!: (id: string, event: AdapterEvent) => void;
  const adapter = new FakeAdapter({ id: 'codex' }); adapter.onEvent = callback => { emit = callback; };
  adapter.send = async id => {
    emit(id, { type: 'turn.start', nativeTurnId: 'native-A' });
    emit(id, { type: 'turn.start', nativeTurnId: 'native-B' });
    await gate; throw new Error('old send response lost');
  };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    const command = { op: 'send', clientCommandId: 'old-browser-send', sessionId, text: 'Input A' };
    const pending = ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } });
    await expect.poll(() => ctx.store.nativeOwners.get(sessionId)?.activeNativeTurnId).toBe('native-B');
    const currentTurn = ctx.manager.getRuntime(sessionId)!.turnId!;
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener'); const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${sessionId}`);
    emit(sessionId, { type: 'item.start', nativeTurnId: 'native-B', itemKey: 'current-answer', kind: 'assistant.message', data: { text: 'B is streaming', phase: 'final' } });
    await browserExpect(page.getByText('B is streaming', { exact: true })).toBeVisible();
    release(); expect((await pending).json()).toMatchObject({ ok: false, code: 'uncertain' });
    expect(ctx.manager.getRuntime(sessionId)?.turnId).toBe(currentTurn);
    expect(ctx.store.allEvents(sessionId).some(event => event.kind === 'turn.completed' && event.turnId === currentTurn)).toBe(false);
    emit(sessionId, { type: 'item.delta', nativeTurnId: 'native-B', itemKey: 'current-answer', field: 'text', append: ' after old failure' });
    await browserExpect(page.getByText('B is streaming after old failure', { exact: true })).toBeVisible();
    emit(sessionId, { type: 'item.complete', nativeTurnId: 'native-B', itemKey: 'current-answer', kind: 'assistant.message', data: { text: 'B is streaming after old failure', phase: 'final' } });
    emit(sessionId, { type: 'turn.end', nativeTurnId: 'native-B', status: 'completed' });
    await expect.poll(() => ctx.store.allEvents(sessionId).find(event => event.kind === 'turn.completed' && event.turnId === currentTurn)?.data).toMatchObject({ status: 'completed' });
    await page.reload(); await browserExpect(page.getByText('B is streaming after old failure', { exact: true })).toBeVisible();
    expect(ctx.store.journal.get(command.clientCommandId)?.state).toBe('uncertain'); expect(errors).toEqual([]);
    const evidenceDir = process.env['WDCC_LATE_FAILURE_EVIDENCE_DIR'];
    if (evidenceDir !== undefined) {
      await page.screenshot({ path: join(evidenceDir, 'browser-stream-recovered.png'), fullPage: true });
      await writeFile(join(evidenceDir, 'browser-stream.json'), JSON.stringify({ command, currentTurn, record: ctx.store.journal.get(command.clientCommandId), events: ctx.store.allEvents(sessionId), pageErrors: errors }, null, 2));
    }
  } finally { release(); await browser?.close(); await ctx.close(); }
}, 30_000);
