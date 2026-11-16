import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdapterEvent } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { createSourceTestApp } from './helpers.js';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';

it('an old control failure preserves the recovered native stream through actual WS and browser reload', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let emit!: (id: string, event: AdapterEvent) => void; let entered = false; let closes = 0;
  const adapter = new FakeAdapter({ id: 'claude-code' }); adapter.onEvent = callback => { emit = callback; };
  adapter.dispose = async () => { closes++; };
  adapter.setModel = async () => { entered = true; await gate; throw Object.assign(new Error('old query unavailable'), { code: 'native-runtime-unavailable', statusCode: 503 }); };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'claude-code');
    const command = { op: 'set-model', clientCommandId: 'old-browser-control', sessionId, model: 'unconfirmed' };
    const pending = ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } });
    await expect.poll(() => entered).toBe(true); await ctx.manager.dispose(sessionId); await ctx.manager.slashCommands(sessionId);
    const current = ctx.manager.getRuntime(sessionId)!;
    const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const errors: string[] = []; const frames: Record<string, unknown>[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', socket => socket.on('framereceived', event => frames.push(JSON.parse(event.payload.toString()) as Record<string, unknown>)));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: address }]);
    await page.goto(`${address}/s/${sessionId}`);
    await expect.poll(() => frames.some(frame => frame['op'] === 'snapshot')).toBe(true);
    const sendFrame = (event: AdapterEvent) => emit(sessionId, { ...event, runtime: current.identity, nativeTurnId: 'recovered-native-turn' });
    sendFrame({ type: 'turn.start' });
    sendFrame({ type: 'item.start', itemKey: 'current-answer', kind: 'assistant.message', data: { text: 'Recovered stream', phase: 'final' } });
    await browserExpect(page.getByText('Recovered stream', { exact: true })).toBeVisible();
    release(); expect((await pending).json()).toMatchObject({ ok: false, error: 'old query unavailable' });
    expect(closes).toBe(1); expect(ctx.manager.getRuntime(sessionId)).toBe(current);
    expect(await page.locator('.turn-running').count()).toBe(1);
    sendFrame({ type: 'item.delta', itemKey: 'current-answer', field: 'text', append: ' continues' });
    await browserExpect(page.getByText('Recovered stream continues', { exact: true })).toBeVisible();
    sendFrame({ type: 'item.complete', itemKey: 'current-answer', kind: 'assistant.message', data: { text: 'Recovered stream continues', phase: 'final' } });
    await page.reload(); await browserExpect(page.getByText('Recovered stream continues', { exact: true })).toBeVisible();
    expect(await page.locator('.turn-running').count()).toBe(1);
    sendFrame({ type: 'turn.end', status: 'completed' });
    await expect.poll(() => page.locator('.turn-running').count()).toBe(0);
    const terminal = ctx.store.allEvents(sessionId).filter(event => event.kind === 'turn.completed');
    expect(terminal).toHaveLength(1); expect(terminal[0]?.data).toMatchObject({ status: 'completed' });
    expect(ctx.store.journal.get(command.clientCommandId)?.state).toBe('uncertain');
    expect(errors).toEqual([]);
    const evidenceDir = process.env['WDCC_CONTROL_FENCE_EVIDENCE_DIR'];
    if (evidenceDir !== undefined) {
      await page.screenshot({ path: join(evidenceDir, 'browser-control-recovered.png'), fullPage: true });
      await writeFile(join(evidenceDir, 'browser-control-stream.json'), JSON.stringify({ command, current: current.identity, closes,
        record: ctx.store.journal.get(command.clientCommandId), owner: ctx.store.nativeOwners.get(sessionId), events: ctx.store.allEvents(sessionId), frames, pageErrors: errors }, null, 2));
    }
  } finally { release(); await browser?.close(); await ctx.close(); }
}, 30_000);
