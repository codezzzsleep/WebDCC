import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { expect, it } from 'vitest';
import { createSourceTestApp } from './helpers.js';

it('startup reads one IndexedDB snapshot while another connection commits a newer feed checkpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-feed-read-'));
  const ctx = await createSourceTestApp();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const evidence = process.env['WDCC_FEED_READ_EVIDENCE_DIR'];
  try {
    const workspace = ctx.store.createWorkspace('Cache snapshot reader', ctx.dataDir);
    const older = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex', title: 'Older session' });
    const olderSequence = ctx.store.feedSince(0, 500).at(-1)!.feedSeq;
    const newer = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'dsh', title: 'Newer session' });
    const newerSequence = ctx.store.feedSince(0, 500).at(-1)!.feedSeq;
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    await context.addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    const page = await context.newPage();
    await page.goto(`${base}/api/feed`);
    const cached = { id: older.id, workspaceId: workspace.id, agent: older.agent, status: 'idle', title: 'Older session', updatedAt: older.updatedAt };
    await page.evaluate(`(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('webdcc', 1);
        request.onupgradeneeded = () => {
          const db = request.result; const events = db.createObjectStore('events', { keyPath: ['sessionId', 'seq'] }); events.createIndex('bySession', 'sessionId');
          db.createObjectStore('sessions', { keyPath: 'id' }); db.createObjectStore('meta'); db.createObjectStore('drafts', { keyPath: 'sessionId' }); db.createObjectStore('outbox', { keyPath: 'clientCommandId' });
        };
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const tx = database.transaction(['sessions', 'meta'], 'readwrite');
      tx.objectStore('sessions').put(${JSON.stringify(cached)}); tx.objectStore('meta').put(${olderSequence}, 'feedSeq');
      tx.objectStore('meta').put({ formatVersion: 1, feedSeq: ${olderSequence} }, 'feedCheckpoint');
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); database.close();
    })()`);
    const cachedNewer = { id: newer.id, workspaceId: workspace.id, agent: newer.agent, status: 'idle', title: 'Newer session', updatedAt: newer.updatedAt };
    await page.addInitScript({ content: `(() => {
      window.__cacheReadRace = { triggered: false, writerCommitted: false, twoConnections: false };
      let writer; const opening = indexedDB.open('webdcc', 1); opening.onsuccess = () => { writer = opening.result; };
      const original = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.getAll = function(...args) {
        const request = Reflect.apply(original, this, args);
        if (this.name === 'sessions' && !window.__cacheReadRace.triggered) {
          window.__cacheReadRace.triggered = true;
          window.__cacheReadRace.readerStores = Array.from(this.transaction.objectStoreNames);
          request.addEventListener('success', () => {
            if (!writer) throw new Error('Independent writer connection not ready');
            window.__cacheReadRace.twoConnections = writer !== this.transaction.db;
            const tx = writer.transaction(['sessions', 'meta'], 'readwrite');
            tx.objectStore('sessions').put(${JSON.stringify(cachedNewer)}); tx.objectStore('meta').put(${newerSequence}, 'feedSeq');
            tx.objectStore('meta').put({ formatVersion: 1, feedSeq: ${newerSequence} }, 'feedCheckpoint');
            tx.oncomplete = () => { window.__cacheReadRace.writerCommitted = true; writer.close(); };
          });
        }
        return request;
      };
    })();` });
    const hello: { feedAfter?: number }[] = []; const frames: unknown[] = []; const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', socket => {
      socket.on('framesent', frame => { const value = JSON.parse(String(frame.payload)) as { op?: string; feedAfter?: number }; if (value.op === 'hello') hello.push(value); });
      socket.on('framereceived', frame => { const value = JSON.parse(String(frame.payload)) as { op?: string }; if (value.op === 'feed') frames.push(value); });
    });
    await page.goto(base); await expect.poll(() => hello.length).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate('window.__cacheReadRace.writerCommitted')).toBe(true);
    const race = await page.evaluate('window.__cacheReadRace') as { twoConnections: boolean; readerStores: string[] };
    const report = { olderSequence, newerSequence, hello, frames, errors, race, visibleOlder: await page.locator(`a[href="/s/${older.id}"]`).count(), visibleNewer: await page.locator(`a[href="/s/${newer.id}"]`).count(), browserVersion: browser.version(), newOfficialNativeCalls: 0, newProviderCalls: 0, newPaidCalls: 0 };
    if (evidence !== undefined) { await writeFile(join(evidence, 'read-race.json'), JSON.stringify(report, null, 2)); await page.screenshot({ path: join(evidence, 'read-race.png'), fullPage: true }); }
    expect(race.twoConnections).toBe(true); expect(errors).toEqual([]);
    expect(hello[0]?.feedAfter).toBe(olderSequence);
    await expect.poll(() => page.locator(`a[href="/s/${newer.id}"]`).count()).toBe(1);
    expect(race.readerStores.sort()).toEqual(['meta', 'sessions']);
    expect(ctx.store.journal.queue(older.id)).toEqual([]); expect(ctx.store.journal.queue(newer.id)).toEqual([]);
    if (evidence !== undefined) await writeFile(join(evidence, 'passed.json'), JSON.stringify({ ...report, visibleNewer: 1, actualTwoIndexedDBConnections: true }, null, 2));
  } finally { await browser.close(); await ctx.close(); await rm(directory, { recursive: true, force: true }); }
});
