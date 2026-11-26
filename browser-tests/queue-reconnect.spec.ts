import { chromium, type Browser, type Locator } from '@playwright/test';
import { expect, it, vi } from 'vitest';
import { createSourceTestApp, observeSessionSnapshots } from './helpers.js';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';

it('refreshes main and dock queues after reconnect covers failed queue reads', async () => {
  const ctx = await createSourceTestApp({ adapterOptions: { delayMs: 60_000 } });
  const send = vi.spyOn(FakeAdapter.prototype, 'send');
  let browser: Browser | undefined;
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    const { sessionId: dockId } = await seedWorkspaceAndSession(ctx, 'claude-code');
    const queuePath = `/api/sessions/${sessionId}/queue`;
    const dockQueuePath = `/api/sessions/${dockId}/queue`;
    for (const [target, active, ...queued] of [[sessionId, 'active', 'B', 'C'], [dockId, 'dock-active', 'D', 'E']] as const) {
      for (const id of [active, ...queued]) {
        const response = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie },
          payload: { command: { op: 'send', clientCommandId: id, sessionId: target, text: `Queue fixture ${id}`, intent: 'queue' } } });
        expect(response.json()).toMatchObject({ ok: true, value: { queued: id !== active } });
      }
    }
    const readQueues = () => [...ctx.store.journal.queue(sessionId), ...ctx.store.journal.queue(dockId)];
    const originalInputs = readQueues().filter(row => ['B', 'C', 'E'].includes(row.commandId));
    expect(originalInputs).toHaveLength(3);
    expect(send).toHaveBeenCalledTimes(2);
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    const hellos: number[] = [];
    page.on('websocket', socket => socket.on('framesent', frame => {
      const message = JSON.parse(String(frame.payload)) as { op: string; feedAfter: number };
      if (message.op === 'hello') hellos.push(message.feedAfter);
    }));
    const snapshot = observeSessionSnapshots(page, sessionId);
    const dockSnapshot = observeSessionSnapshots(page, dockId);
    const displayed = async (panel: Locator) => (await panel.getByTestId('user-message').allTextContents())
      .flatMap(text => text.match(/Queue fixture ([B-E])\b/)?.[1] ?? []);
    const main = page.getByTestId('main-column');
    const dock = page.getByTestId('dock');
    let failQueueRead = false;
    const failedQueueReads = new Set<string>();
    await page.route(url => [queuePath, dockQueuePath].includes(url.pathname), async route => {
      if (failQueueRead && route.request().method() === 'GET') {
        failedQueueReads.add(new URL(route.request().url()).pathname);
        await route.fulfill({ status: 503, json: { error: 'temporary queue read failure' } });
      } else await route.continue();
    });
    await page.goto(`${base}/s/${sessionId}+${dockId}`);
    await expect.poll(snapshot).toBeDefined();
    await expect.poll(dockSnapshot).toBeDefined();
    await expect.poll(() => displayed(main)).toEqual(['B', 'C']);
    await expect.poll(() => displayed(dock)).toEqual(['D', 'E']);
    failQueueRead = true;

    const reorder = await page.request.patch(`${base}${queuePath}`, { data: {
      commandIds: ['C', 'B'], expectedRevision: ctx.store.queueSnapshot(sessionId).orderRevision,
    } });
    expect(reorder.status()).toBe(200);
    const { revision } = await reorder.json() as { revision: number };
    expect(ctx.store.journal.queue(sessionId).map(row => row.commandId)).toEqual(['active', 'C', 'B']);
    const cancel = await page.request.delete(`${base}${dockQueuePath}/D`);
    expect(cancel.status()).toBe(204);
    const dockRevision = ctx.store.queueSnapshot(dockId).revision;
    await expect.poll(() => failedQueueReads.size).toBe(2);
    await expect.poll(() => page.evaluate(() => new Promise<number>((resolve, reject) => {
      const open = indexedDB.open('webdcc', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const read = db.transaction('meta').objectStore('meta').get('feedSeq');
        read.onsuccess = () => { db.close(); resolve(Number(read.result ?? 0)); };
        read.onerror = () => { db.close(); reject(read.error); };
      };
    }))).toBeGreaterThanOrEqual(Math.max(revision, dockRevision));
    expect(await displayed(main)).toEqual(['B', 'C']);
    expect(await displayed(dock)).toEqual(['D', 'E']);

    failQueueRead = false;
    for (const socket of ctx.app.websocketServer.clients) socket.close(1012, 'queue reconnect fixture');
    await expect.poll(() => hellos.length).toBe(2);
    expect(hellos[1]).toBeGreaterThanOrEqual(Math.max(revision, dockRevision));
    await expect.poll(snapshot).toBeDefined();
    await expect.poll(dockSnapshot).toBeDefined();
    await expect.poll(() => displayed(main), { timeout: 4_000 }).toEqual(['C', 'B']);
    await expect.poll(() => displayed(dock), { timeout: 4_000 }).toEqual(['E']);
    expect(ctx.store.journal.queue(sessionId).map(row => row.commandId)).toEqual(['active', 'C', 'B']);
    expect(ctx.store.journal.queue(dockId).map(row => row.commandId)).toEqual(['dock-active', 'E']);
    expect(ctx.store.journal.get('D')?.state).toBe('cancelled');
    expect(readQueues()).toEqual(expect.arrayContaining(originalInputs.map(({ commandId, input, turnId }) =>
      expect.objectContaining({ commandId, input, turnId, state: 'queued' }))));
    expect(send).toHaveBeenCalledTimes(2);
  } finally { send.mockRestore(); await browser?.close(); await ctx.close(); }
}, 30_000);
