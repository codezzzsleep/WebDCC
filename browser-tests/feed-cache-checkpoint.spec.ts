import { once, type EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext } from '@playwright/test';
import { expect, it } from 'vitest';
import { createSourceTestApp } from './helpers.js';

const readCache = `(async () => {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('webdcc', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try { return await new Promise((resolve, reject) => {
    const transaction = database.transaction(['sessions', 'meta'], 'readonly');
    const sessions = transaction.objectStore('sessions').getAll(); const sequence = transaction.objectStore('meta').get('feedSeq');
    transaction.oncomplete = () => resolve({ sessions: sessions.result, feedSeq: sequence.result ?? 0 }); transaction.onabort = () => reject(transaction.error);
  }); } finally { database.close(); }
})()`;

it('actual IndexedDB session abort and own Chromium SIGKILL cannot checkpoint feed metadata beyond its session state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-feed-checkpoint-')); const profile = join(directory, 'isolated-browser'); const ctx = await createSourceTestApp();
  let context: BrowserContext | undefined; const evidence = process.env['WDCC_FEED_CHECKPOINT_EVIDENCE_DIR'];
  try {
    const workspace = ctx.store.createWorkspace('Feed cache checkpoint', ctx.dataDir); await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener'); const base = `http://127.0.0.1:${address.port}`;
    context = await chromium.launchPersistentContext(profile, { headless: true }); const version = context.browser()!.version();
    await context.addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await context.addInitScript({ content: `(() => {
      localStorage.setItem('wdcc-test-abort-session-cache', '1'); window.__feedCacheAborts = [];
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(...args) {
        const request = Reflect.apply(original, this, args);
        if (this.name === 'sessions' && localStorage.getItem('wdcc-test-abort-session-cache') === '1') {
          window.__feedCacheAborts.push({ stores: Array.from(this.transaction.objectStoreNames), id: args[0]?.id }); this.transaction.abort();
        }
        return request;
      };
    })();` });
    const page = context.pages()[0]!; const frames: unknown[] = []; const hello: unknown[] = []; const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('websocket', socket => {
      socket.on('framereceived', frame => { const item = JSON.parse(String(frame.payload)) as { op?: string }; if (item.op === 'feed') frames.push(item); });
      socket.on('framesent', frame => { const item = JSON.parse(String(frame.payload)) as { op?: string }; if (item.op === 'hello') hello.push(item); });
    });
    await page.goto(base); await expect.poll(() => hello.length).toBeGreaterThan(0);
    const sessions: { id: string; agent: string; nativeId: string }[] = [];
    for (const agent of ['codex', 'claude-code', 'dsh'] as const) {
      const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent }); sessions.push({ id: session.id, agent: session.agent, nativeId: session.nativeId! });
      await expect.poll(() => page.locator(`a[href="/s/${session.id}"]`).count()).toBeGreaterThan(0);
    }
    await expect.poll(() => page.evaluate('window.__feedCacheAborts.length')).toBeGreaterThan(0);
    const beforeCache = await page.evaluate(readCache) as { sessions: { id: string }[]; feedSeq: number };
    const before = { sessions, beforeCache, hello, frames, errors, version, aborted: await page.evaluate('window.__feedCacheAborts'), owners: sessions.map(session => ctx.store.nativeOwners.get(session.id)), feed: ctx.store.feedSince(0, 500) };
    const first = context.browser()!; const protocol = await first.newBrowserCDPSession(); const processes = await protocol.send('SystemInfo.getProcessInfo') as { processInfo: { id: number; type: string }[] };
    const processInfo = processes.processInfo.find(item => item.type === 'browser'); if (processInfo === undefined) throw new Error('Missing browser PID');
    // Verify ownership before killing the exact browser created for this test.
    expect((await readFile(`/proc/${processInfo.id}/cmdline`, 'utf8')).includes(profile)).toBe(true);
    await page.evaluate(`localStorage.setItem('wdcc-test-abort-session-cache', '0')`);
    if (evidence !== undefined) { await writeFile(join(evidence, 'before-sigkill.json'), JSON.stringify({ ...before, processInfo, killSignal: 'SIGKILL', nativeBusinessCalls: 0, providerCalls: 0 }, null, 2)); await page.screenshot({ path: join(evidence, 'before-sigkill.png'), fullPage: true }); }
    const closed = once(context as unknown as EventEmitter, 'close'); process.kill(processInfo.id, 'SIGKILL'); await closed; context = undefined;
    context = await chromium.launchPersistentContext(profile, { headless: true });
    await context.addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    const reopened = context.pages()[0]!; const restoredHello: { op?: string; feedAfter?: number }[] = [];
    reopened.on('websocket', socket => socket.on('framesent', frame => { const item = JSON.parse(String(frame.payload)) as { op?: string; feedAfter?: number }; if (item.op === 'hello') restoredHello.push(item); }));
    await reopened.goto(base); await expect.poll(() => restoredHello.length).toBeGreaterThan(0);
    const afterCache = await reopened.evaluate(readCache) as { sessions: { id: string }[]; feedSeq: number };
    const after = { afterCache, restoredHello, linkedSessions: await reopened.locator('a[href^="/s/"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('href'))), owners: sessions.map(session => ctx.store.nativeOwners.get(session.id)) };
    if (evidence !== undefined) { await writeFile(join(evidence, 'after-sigkill.json'), JSON.stringify(after, null, 2)); await reopened.screenshot({ path: join(evidence, 'after-sigkill.png'), fullPage: true }); }
    // Check the restart boundary, not only the previously live in-memory UI.
    expect(restoredHello[0]?.feedAfter).toBe(0);
    for (const session of sessions) await expect.poll(() => reopened.locator(`a[href="/s/${session.id}"]`).count()).toBeGreaterThan(0);
    await expect.poll(async () => ((await reopened.evaluate(readCache)) as { sessions: unknown[] }).sessions.length).toBe(3);
    expect(sessions.every(session => ctx.store.journal.queue(session.id).length === 0)).toBe(true);
    expect(sessions.map(session => ctx.manager.getRuntime(session.id)?.identity)).toEqual(before.owners.map(owner => ({ ownerId: owner!.ownerId, generation: owner!.generation, hostId: owner!.hostId })));
    if (evidence !== undefined) await writeFile(join(evidence, 'passed.json'), JSON.stringify({ actualChromiumSIGKILL: true, version, scopes: ['actual IndexedDB abort', 'actualSourceWS', 'threecontrolledAgent session metadata', 'persistentProfile reopen'], newOfficialNativeCalls: 0, newPaidCalls: 0 }, null, 2));
  } finally { await context?.close().catch(() => undefined); await ctx.close(); await rm(directory, { recursive: true, force: true }); }
});
