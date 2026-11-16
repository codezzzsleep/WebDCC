import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StoredEvent } from '@webdcc/protocol';
import { createSourceTestApp, observeSessionSnapshots } from './helpers.js';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';

async function cached(page: Page, sessionId: string): Promise<StoredEvent[]> {
  return page.evaluate(async id => {
    const request = indexedDB.open('webdcc', 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      const read = db.transaction('events').objectStore('events').index('bySession').getAll(id);
      return await new Promise<StoredEvent[]>((resolve, reject) => { read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); });
    } finally { db.close(); }
  }, sessionId);
}

it.each(['foreign', 'malformed'] as const)('a %s recent HTTP page cannot contaminate another session or prevent actual replay/reload recovery', async kind => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const first = await seedWorkspaceAndSession(ctx, 'codex'); const other = await seedWorkspaceAndSession(ctx, 'codex');
    const seed = (sessionId: string, text: string) => {
      const native = { originalSessionId: sessionId, originalTurnId: `native-${sessionId}` };
      ctx.store.appendEvent({ sessionId, turnId: 'turn', itemKey: 'start', kind: 'turn.started', data: {}, native });
      ctx.store.appendEvent({ sessionId, turnId: 'turn', itemKey: 'input', kind: 'user.message', data: { text, clientCommandId: `original-${sessionId}` }, native });
      ctx.store.appendEvent({ sessionId, turnId: 'turn', itemKey: 'end', kind: 'turn.completed', data: { status: 'completed' }, native });
      return ctx.store.allEvents(sessionId);
    };
    const original = seed(first.sessionId, 'Original requested session');
    const foreign = seed(other.sessionId, 'Foreign session content');
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const errors: string[] = []; const subscriptions: number[] = []; let replacedResponses = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', socket => socket.on('framesent', frame => {
      const request = JSON.parse(String(frame.payload)) as { subscribe?: { sessionId: string; afterSeq: number }[] };
      for (const item of request.subscribe ?? []) if (item.sessionId === first.sessionId) subscriptions.push(item.afterSeq);
    }));
    const snapshot = observeSessionSnapshots(page, first.sessionId);
    await page.route(`${base}/api/sessions/${first.sessionId}/events?*`, async route => {
      const response = await route.fetch();
      if (replacedResponses++ === 0) {
        await route.fulfill({ response, json: { events: kind === 'foreign' ? foreign : null, hasMore: false } });
      } else await route.fulfill({ response });
    });
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${first.sessionId}`);
    await expect.poll(snapshot).toBe(3);
    await browserExpect(page.getByText('Original requested session', { exact: true })).toBeVisible();
    await expect.poll(() => cached(page, first.sessionId)).toEqual(original);
    expect(subscriptions[0]).toBe(0); expect(replacedResponses).toBe(1);
    expect(await cached(page, other.sessionId)).toEqual([]);
    await browserExpect(page.getByText('Foreign session content', { exact: true })).toHaveCount(0);
    await page.reload(); await expect.poll(snapshot).toBe(3);
    await browserExpect(page.getByText('Original requested session', { exact: true })).toBeVisible();
    await expect.poll(() => subscriptions.at(-1)).toBe(3); expect(await cached(page, first.sessionId)).toEqual(original);
    expect(await cached(page, other.sessionId)).toEqual([]); expect(errors).toEqual([]);
    expect(ctx.store.allEvents(first.sessionId)).toEqual(original); expect(ctx.store.allEvents(other.sessionId)).toEqual(foreign);
    const evidence = process.env['WDCC_RECENT_HISTORY_EVIDENCE_DIR'];
    if (evidence !== undefined) {
      await page.screenshot({ path: join(evidence, `recent-history-${kind}.png`), fullPage: true });
      await writeFile(join(evidence, `recent-history-${kind}.json`), JSON.stringify({ source: 'controlled invalid HTTP response/actual source WS+Chromium+IndexedDB',
        kind, replacedResponses, subscriptions, original, foreign, requestedCache: await cached(page, first.sessionId),
        unopenedForeignCache: await cached(page, other.sessionId), pageErrors: errors, newOfficialAgentCalls: 0, newProviderCalls: 0 }, null, 2));
    }
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
