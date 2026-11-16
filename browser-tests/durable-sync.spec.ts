import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSourceTestApp, observeSessionSnapshots } from './helpers.js';

it('aborted IndexedDB writes reconnect from the last committed event and recover the same history after reload', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const workspace = ctx.store.createWorkspace('durable sync', ctx.dataDir);
    const adapter = ctx.manager.adapter('codex')!; adapter.send = async () => undefined;
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
    const subscriptions: number[] = [];
    page.on('websocket', socket => socket.on('framesent', frame => {
      const message = JSON.parse(String(frame.payload)) as { op: string; subscribe?: { sessionId: string; afterSeq: number }[] };
      if (message.op === 'hello' || message.op === 'subscribe') for (const item of message.subscribe ?? []) {
        if (item.sessionId === session.id) subscriptions.push(item.afterSeq);
      }
    }));
    const snapshot = observeSessionSnapshots(page, session.id);
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${session.id}`);
    await expect.poll(snapshot).toBe(0);
    await page.evaluate(() => {
      const state = window as typeof window & { abortEventWrites: number; abortedEventWrites: number };
      state.abortEventWrites = 1; state.abortedEventWrites = 0;
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        const stores = typeof args[0] === 'string' ? [args[0]] : [...args[0]];
        if (this.name === 'webdcc' && args[1] === 'readwrite' && stores.includes('events') && state.abortEventWrites > 0) {
          state.abortEventWrites--; state.abortedEventWrites++;
          queueMicrotask(() => tx.abort());
        }
        return tx;
      };
    });
    await ctx.manager.send(session.id, { text: 'durable original input' }, 'durable-original');
    await browserExpect(page.getByTestId('user-message').getByText('durable original input', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as typeof window & { abortedEventWrites: number }).abortedEventWrites)).toBe(1);
    const serverEvents = ctx.store.allEvents(session.id);
    const end = ctx.store.getSession(session.id)!.lastSeq;
    expect(serverEvents.map(event => event.seq)).toEqual([1, 2]);
    const beforeDisconnect = subscriptions.length;
    for (const socket of ctx.app.websocketServer.clients) socket.terminate();
    await browserExpect(page.getByText('网络断开，正在重连', { exact: false })).toBeVisible();
    await expect.poll(() => subscriptions.length).toBeGreaterThan(beforeDisconnect);
    expect(subscriptions.at(-1)).toBe(0);
    await expect.poll(snapshot).toBe(end);
    const readCache = async () => page.evaluate(async sessionId => {
      const request = indexedDB.open('webdcc', 1);
      const database = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try {
        const reading = database.transaction('events').objectStore('events').index('bySession').getAll(sessionId);
        return await new Promise<unknown[]>((resolve, reject) => { reading.onsuccess = () => resolve(reading.result); reading.onerror = () => reject(reading.error); });
      } finally { database.close(); }
    }, session.id);
    await expect.poll(readCache).toEqual(serverEvents);
    await page.reload(); await expect.poll(() => subscriptions.at(-1)).toBe(end);
    await browserExpect(page.getByTestId('user-message').getByText('durable original input', { exact: true })).toBeVisible();
    expect(await readCache()).toEqual(serverEvents);
    const evidenceDir = process.env['WDCC_SYNC_EVIDENCE_DIR'];
    if (evidenceDir !== undefined) {
      await page.screenshot({ path: join(evidenceDir, 'sync-browser-recovered.png'), fullPage: true });
      await writeFile(join(evidenceDir, 'sync-browser-recovery.json'), JSON.stringify({ subscriptions, end, serverEvents, cachedEvents: await readCache(), pageErrors }, null, 2));
    }
    expect(pageErrors).toEqual([]);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
