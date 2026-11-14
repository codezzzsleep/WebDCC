import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { AdapterEvent, CreateOpts } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { createSourceTestApp } from './helpers.js';

it('real Chromium timeline keeps same-key reasoning isolated through WS delta/update, autonomous next turn, late frames and refresh', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    let receive!: (id: string, event: AdapterEvent) => void; let opts!: CreateOpts;
    const adapter = new FakeAdapter({ id: 'codex' }); adapter.onEvent = callback => { receive = callback; };
    const create = adapter.create.bind(adapter); adapter.create = async value => { opts = value; return create(value); };
    adapter.send = async () => undefined;
    ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('stream identity', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
    const emit = (event: AdapterEvent) => receive(session.id, { ...event, runtime: opts.runtime });
    const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const frames: Record<string, unknown>[] = []; const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', socket => socket.on('framereceived', event => frames.push(JSON.parse(event.payload.toString()) as Record<string, unknown>)));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: address }]);
    await page.goto(`${address}/s/${session.id}`);
    await expect.poll(() => page.getByTestId('timeline').count()).toBe(1);
    await expect.poll(() => frames.some(frame => frame['op'] === 'snapshot')).toBe(true);
    const first = await ctx.manager.send(session.id, { text: 'First timeline turn' });
    emit({ type: 'turn.start', nativeTurnId: 'a' });
    emit({ type: 'item.start', nativeTurnId: 'a', itemKey: 'shared', kind: 'reasoning', data: { text: '' } });
    emit({ type: 'item.delta', nativeTurnId: 'a', itemKey: 'shared', field: 'text', append: 'A partial' });
    await expect.poll(() => page.locator('.reasoning-live-text').allTextContents()).toEqual(['A partial']);
    // The second delta is still buffered when the authoritative update is sent.
    emit({ type: 'item.delta', nativeTurnId: 'a', itemKey: 'shared', field: 'text', append: ' pending' });
    emit({ type: 'item.update', nativeTurnId: 'a', itemKey: 'shared', data: { text: 'A authoritative' } });
    await expect.poll(() => page.locator('.reasoning-live-text').allTextContents()).toEqual(['A authoritative']);
    const oldComplete: AdapterEvent = { type: 'item.complete', nativeTurnId: 'a', itemKey: 'shared', kind: 'reasoning', data: { text: 'A final' },
      native: { type: 'reasoning', id: 'shared', summary: ['A final'], content: [] } };
    emit(oldComplete);
    emit({ type: 'turn.end', nativeTurnId: 'a', status: 'completed' });
    // An autonomous native turn begins before the 1500 ms settle timer fires.
    emit({ type: 'turn.start', nativeTurnId: 'b' });
    emit({ type: 'item.start', nativeTurnId: 'b', itemKey: 'shared', kind: 'reasoning', data: { text: 'B partial' } });
    await expect.poll(() => page.locator('.reasoning-live-text').allTextContents()).toEqual(['B partial']);
    emit({ type: 'item.delta', nativeTurnId: 'a', itemKey: 'shared', field: 'text', append: ' POISON' });
    emit({ type: 'item.update', nativeTurnId: 'a', itemKey: 'shared', data: { text: 'POISON' } });
    emit(oldComplete);
    emit({ type: 'turn.end', nativeTurnId: 'a', status: 'interrupted' });
    emit({ type: 'item.delta', nativeTurnId: 'b', itemKey: 'shared', field: 'text', append: ' live' });
    await expect.poll(() => page.locator('.reasoning-live-text').allTextContents()).toEqual(['B partial live']);
    expect(await page.locator('.turn-running').count()).toBe(1);
    expect(await page.getByTestId('timeline').textContent()).not.toContain('POISON');
    emit({ type: 'item.update', nativeTurnId: 'b', itemKey: 'shared', data: { text: 'B authoritative' } });
    await expect.poll(() => page.locator('.reasoning-live-text').allTextContents()).toEqual(['B authoritative']);
    emit({ type: 'item.complete', nativeTurnId: 'b', itemKey: 'shared', kind: 'reasoning', data: { text: 'B final' },
      native: { type: 'reasoning', id: 'shared', summary: ['B final'], content: [] } });
    emit({ type: 'turn.end', nativeTurnId: 'b', status: 'completed' });
    await expect.poll(() => page.locator('.turn-running').count(), { timeout: 5000 }).toBe(0);
    const viewFinals = async () => {
      await expect.poll(() => page.locator('.turn').count()).toBe(2);
      for (let index = 0; index < 2; index++) {
        const turn = page.locator('.turn').nth(index);
        await turn.locator('.turn-summary').click();
        await turn.getByText('思考', { exact: true }).click();
      }
      return page.locator('.step-detail').allTextContents();
    };
    const beforeRefresh = await viewFinals();
    expect(beforeRefresh).toEqual(['A final', 'B final']);
    expect(await page.locator('.reasoning-live-text').count()).toBe(0);
    expect(frames.filter(frame => frame['op'] === 'delta' && frame['itemKey'] === 'shared').every(frame => typeof frame['turnId'] === 'string')).toBe(true);
    expect(new Set(frames.filter(frame => frame['op'] === 'delta').map(frame => frame['turnId'])).size).toBe(2);
    const stored = ctx.store.allEvents(session.id).filter(event => event.kind === 'reasoning');
    expect(stored).toHaveLength(2);
    expect(stored[0]?.turnId).toBe(first.turnId);
    expect(stored[1]?.turnId).not.toBe(first.turnId);
    await page.reload();
    expect(await viewFinals()).toEqual(beforeRefresh);
    expect(errors).toEqual([]);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
