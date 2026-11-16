import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StoredEvent } from '@webdcc/protocol';
import { createSourceTestApp, observeSessionSnapshots } from './helpers.js';
import { seedWorkspaceAndSession, type TestApp } from '../packages/server/test/helpers.js';

async function seedHistory(ctx: TestApp): Promise<{ sessionId: string; events: StoredEvent[] }> {
  const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
  for (let turn = 1; turn <= 200; turn++) {
    const identity = { nativeSessionId: `native-${sessionId}`, nativeTurnId: `native-turn-${turn}`, nativeItemId: `native-item-${turn}` };
    const common = { sessionId, turnId: `turn-${turn}`, native: identity };
    ctx.store.appendEvent({ ...common, itemKey: `start-${turn}`, kind: 'turn.started', data: {} });
    ctx.store.appendEvent({ ...common, itemKey: `user-${turn}`, kind: 'user.message', data: { text: `History input ${turn}`, clientCommandId: `original-${turn}` } });
    ctx.store.appendEvent({ ...common, itemKey: `end-${turn}`, kind: 'turn.completed', data: { status: 'completed' } });
  }
  return { sessionId, events: ctx.store.allEvents(sessionId) };
}

async function readCache(page: Page, sessionId: string): Promise<StoredEvent[]> {
  return page.evaluate(async id => {
    const opening = indexedDB.open('webdcc', 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error);
    });
    try {
      const reading = database.transaction('events').objectStore('events').index('bySession').getAll(id);
      return await new Promise<StoredEvent[]>((resolve, reject) => {
        reading.onsuccess = () => resolve(reading.result); reading.onerror = () => reject(reading.error);
      });
    } finally { database.close(); }
  }, sessionId);
}
async function scrollToHistory(page: Page): Promise<void> {
  await page.getByTestId('timeline').evaluate(element => {
    element.scrollTop = 0; element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
}

it('real IndexedDB abort retains the pagination boundary and visible retry restores the identical HTTP history', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const { sessionId, events } = await seedHistory(ctx);
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const errors: string[] = []; const requests: number[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname === `/api/sessions/${sessionId}/events`) requests.push(Number(url.searchParams.get('before')));
    });
    const snapshot = observeSessionSnapshots(page, sessionId);
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${sessionId}`); await expect.poll(snapshot).toBe(600);
    await expect.poll(() => readCache(page, sessionId)).toEqual(events.slice(400));
    await page.evaluate(() => {
      const state = window as typeof window & { remainingOlderAborts: number; olderAborts: number; remainingReadAborts: number; readAborts: number };
      state.remainingOlderAborts = 1; state.olderAborts = 0; state.remainingReadAborts = 1; state.readAborts = 0;
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        const names = typeof args[0] === 'string' ? [args[0]] : [...args[0]];
        if (this.name === 'webdcc' && args[1] === 'readwrite' && names.includes('events') && state.remainingOlderAborts > 0) {
          state.remainingOlderAborts--; state.olderAborts++; queueMicrotask(() => tx.abort());
        }
        if (this.name === 'webdcc' && args[1] !== 'readwrite' && names.includes('events') && state.remainingReadAborts > 0) {
          state.remainingReadAborts--; state.readAborts++; queueMicrotask(() => tx.abort());
        }
        return tx;
      };
    });
    await scrollToHistory(page);
    await browserExpect(page.getByTestId('older-history-recovery')).toBeVisible();
    expect(await page.evaluate(() => {
      const state = window as typeof window & { olderAborts: number; readAborts: number };
      return { reads: state.readAborts, writes: state.olderAborts };
    })).toEqual({ reads: 1, writes: 1 });
    expect(await readCache(page, sessionId)).toEqual(events.slice(400));
    expect(requests).toEqual([601, 401]);
    const evidence = process.env['WDCC_OLDER_HISTORY_EVIDENCE_DIR'];
    if (evidence !== undefined) await page.screenshot({ path: join(evidence, 'older-history-aborted.png'), fullPage: true });
    await scrollToHistory(page);
    // An error requires the explicit recovery action, rather than a scroll loop.
    expect(requests).toEqual([601, 401]);
    await page.getByRole('button', { name: '重新加载历史', exact: true }).click();
    await expect.poll(() => readCache(page, sessionId)).toEqual(events.slice(200));
    expect(requests).toEqual([601, 401, 401]);
    await browserExpect(page.getByTestId('older-history-recovery')).toHaveCount(0);
    await page.reload(); await expect.poll(snapshot).toBe(600);
    expect(await readCache(page, sessionId)).toEqual(events.slice(200));
    await scrollToHistory(page); await expect.poll(() => readCache(page, sessionId)).toEqual(events);
    await browserExpect(page.getByText('History input 1', { exact: true })).toBeVisible();
    expect(requests).toEqual([601, 401, 401, 201]);
    expect(ctx.store.allEvents(sessionId)).toEqual(events); expect(ctx.store.journal.queue(sessionId)).toEqual([]);
    expect(errors).toEqual([]);
    if (evidence !== undefined) {
      await page.screenshot({ path: join(evidence, 'older-history-recovered.png'), fullPage: true });
      await writeFile(join(evidence, 'older-history-browser-retry.json'), JSON.stringify({ source: 'controlled StoredEvent/real HTTP+WS+Chromium+IndexedDB', requests,
        abortedTransactions: { reads: 1, writes: 1 }, serverEvents: events, cachedEvents: await readCache(page, sessionId), pageErrors: errors, newNativeCalls: 0, newProviderCalls: 0 }, null, 2));
    }
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);

it('a reloaded browser recovers older committed events offline without another history request', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const { sessionId, events } = await seedHistory(ctx);
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const snapshot = observeSessionSnapshots(page, sessionId);
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${sessionId}`); await expect.poll(snapshot).toBe(600);
    await expect.poll(() => readCache(page, sessionId)).toEqual(events.slice(400));
    // Seed previously committed pages using an actual completed transaction.
    // Reload closes the previous document and its database connection.
    await page.evaluate(async older => {
      const opening = indexedDB.open('webdcc', 1);
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error);
      });
      try {
        const tx = database.transaction('events', 'readwrite');
        const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
        for (const event of older) tx.objectStore('events').put(event);
        await done;
      } finally { database.close(); }
    }, events.slice(0, 400));
    await page.reload(); await expect.poll(snapshot).toBe(600);
    await page.context().setOffline(true);
    let attemptedHistory = 0;
    page.on('request', request => { if (new URL(request.url()).pathname === `/api/sessions/${sessionId}/events`) attemptedHistory++; });
    await scrollToHistory(page);
    await browserExpect(page.getByText('History input 1', { exact: true })).toBeVisible();
    expect(attemptedHistory).toBe(0); expect(await readCache(page, sessionId)).toEqual(events); expect(errors).toEqual([]);
    const evidence = process.env['WDCC_OLDER_HISTORY_EVIDENCE_DIR'];
    if (evidence !== undefined) {
      await page.screenshot({ path: join(evidence, 'older-history-offline.png'), fullPage: true });
      await writeFile(join(evidence, 'older-history-browser-offline.json'), JSON.stringify({ databaseReopened: true, offline: true, attemptedHistory,
        serverEvents: events, cachedEvents: await readCache(page, sessionId), pageErrors: errors, newNativeCalls: 0, newProviderCalls: 0 }, null, 2));
    }
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
