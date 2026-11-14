import { chromium, expect as browserExpect, type Browser, type Route } from '@playwright/test';
import { expect, it } from 'vitest';
import type { StoredEvent } from '@webdcc/protocol';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { createSourceTestApp, observeSessionSnapshots } from './helpers.js';

it('a cached old MCP card stays disabled through history gaps and recovers the actual native resolution by ID', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  let historyRoute: Route | undefined; let lookupRoute: Route | undefined;
  try {
    const workspace = ctx.store.createWorkspace('interaction synchronization', ctx.dataDir);
    const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' }); ctx.store.updateSession(session.id, { nativeId: 'native' });
    const native = CodexAdapter.replay(session.id, 'native'); native.adapter.resume = async () => undefined; native.adapter.dispose = async () => undefined;
    native.adapter.send = async () => { native.feed({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { id: 'old-form', method: 'mcpServer/elicitation/request', params: { threadId: 'native', turnId: null, serverName: 'MCP', mode: 'openai/form', _meta: null, message: 'Old native form', requestedSchema: { type: 'object', properties: { name: { type: 'string', title: 'Name' } } } } } }); };
    ctx.manager.registerAdapter(native.adapter); await ctx.manager.send(session.id, { text: 'ask' });
    const pending = ctx.store.allEvents(session.id).findLast(event => event.kind === 'question'); if (pending === undefined) throw new Error('Missing actual native question');
    native.feed({ i: 2, t: 0, dir: 'in', ch: 'rpc', frame: { method: 'serverRequest/resolved', params: { threadId: 'native', requestId: 'old-form' } } });
    const resolved = ctx.store.allEvents(session.id).findLast(event => event.kind === 'question'); expect(resolved?.data).toMatchObject({ status: 'skipped', resolution: 'external' });
    for (let index = 0; index < 225; index++) ctx.store.appendEvent({ sessionId: session.id, turnId: null, itemKey: `history-padding-${index}`, kind: 'internal', data: { nativeType: 'history-padding' } });
    const end = ctx.store.getSession(session.id)!.lastSeq;
    expect(ctx.store.listEvents(session.id, { before: end + 1, limit: 200 }).some(event => event.kind === 'question')).toBe(false);
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener'); const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const observedSnapshot = observeSessionSnapshots(page, session.id);
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/settings`);
    await page.evaluate(async ({ pending, sessionId }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('webdcc', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = database.transaction(['events', 'meta'], 'readwrite'); tx.objectStore('events').put(pending); tx.objectStore('meta').put({ from: pending.seq, to: pending.seq }, `coveredWindow:${sessionId}`);
          tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
        });
      } finally { database.close(); }
    }, { pending, sessionId: session.id });
    let historyReceived!: () => void; let lookupReceived!: () => void;
    const historyStarted = new Promise<void>(resolve => { historyReceived = resolve; });
    const lookupStarted = new Promise<void>(resolve => { lookupReceived = resolve; });
    await page.route(`**/api/sessions/${session.id}/events*`, route => { historyRoute = route; historyReceived(); });
    await page.route(`**/api/sessions/${session.id}/interactions/answer?*`, route => { lookupRoute = route; lookupReceived(); });
    await page.goto(`${base}/s/${session.id}`); await historyStarted;
    const card = page.getByTestId('question-card'); await card.waitFor();
    await browserExpect(card.getByLabel('Name', { exact: false })).toBeDisabled(); await browserExpect(card.getByRole('button', { name: '确认提交' })).toBeDisabled();
    expect(native.replies).toHaveLength(0);
    const history = await historyRoute!.fetch(); await historyRoute!.fulfill({ response: history }); historyRoute = undefined;
    await lookupStarted;
    expect(observedSnapshot()).toBe(end);
    await browserExpect(card).toHaveAttribute('data-state', 'pending'); await browserExpect(card.getByRole('button', { name: '确认提交' })).toBeDisabled();
    const lookup = await lookupRoute!.fetch(); const response = await lookup.json() as { event: StoredEvent; throughSeq: number };
    expect(response).toEqual({ event: resolved, throughSeq: end });
    await lookupRoute!.fulfill({ response: lookup }); lookupRoute = undefined;
    await browserExpect(card).toHaveAttribute('data-state', 'resolved'); expect(native.replies).toHaveLength(0);
  } finally { await historyRoute?.abort().catch(() => undefined); await lookupRoute?.abort().catch(() => undefined); await browser?.close(); await ctx.close(); }
}, 30_000);
