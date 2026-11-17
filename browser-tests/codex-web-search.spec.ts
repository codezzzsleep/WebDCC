import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { AdapterEvent, CreateOpts, EventData } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { createSourceTestApp } from './helpers.js';

it('the source WebSearch cards keep native live/completed phases and leave legacy phase unknown after refresh', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const adapter = new FakeAdapter({ id: 'codex' }); let receive!: (id: string, event: AdapterEvent) => void; let opts!: CreateOpts;
    adapter.onEvent = callback => { receive = callback; }; const create = adapter.create.bind(adapter);
    adapter.create = async value => { opts = value; return create(value); }; adapter.send = async () => undefined;
    ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('Controlled WebSearch lifecycle', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
    await ctx.manager.send(session.id, { text: 'Controlled native WebSearch notifications only' }, 'web-search-source-input');
    const replay = CodexAdapter.replay(session.id, session.nativeId); let seq = 0;
    const feed = (method: string, params: Record<string, unknown>) => {
      const frame = { i: ++seq, t: seq, dir: 'in' as const, ch: 'rpc', frame: { method, params: { threadId: session.nativeId, ...params } } };
      const receipt = opts.nativeEvents!.record(frame);
      for (const event of replay.feed(frame)) receive(session.id, { ...event, runtime: opts.runtime, nativeEnvelopeId: receipt.envelopeId });
    };
    feed('turn/started', { turn: { id: 'search:original:turn', status: 'inProgress' } });
    const actions = [{ type: 'search', query: null, queries: [' 原生🐈\r\n', 'same same'] },
      { type: 'openPage', url: 'https://example.com/native' }, { type: 'findInPage', url: null, pattern: '<b>原文</b>' }, { type: 'other' }];
    const items = actions.map((action, index) => ({ type: 'webSearch', id: 'search:string:' + index, query: '原生检索 🐈', action, results: null }));
    for (const item of items) feed('item/started', { turnId: 'search:original:turn', startedAtMs: 1, item });
    const legacy = { ...items[0], id: 'legacy:search', results: [{ futureResultType: 'opaque', text: '已存在结果不等于完成' }] };
    receive(session.id, { type: 'item.complete', kind: 'tool.call', itemKey: legacy.id, nativeTurnId: 'search:original:turn',
      data: { name: 'webSearch', status: 'completed', input: legacy }, native: legacy, runtime: opts.runtime });
    await expect.poll(() => ctx.store.allEvents(session.id).filter(value => value.itemKey === legacy.id).length).toBe(1);
    const legacyRows = ctx.store.allEvents(session.id).filter(value => value.itemKey === legacy.id);
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener'); const base = 'http://127.0.0.1:' + address.port;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    const status = (id: string) => page.locator('[data-testid="codex-native-tool-status"][data-native-call-id="' + id + '"]');
    await page.goto(base + '/s/' + session.id);
    for (const item of items) await expect.poll(() => status(item.id).textContent()).toContain('运行中');
    await expect.poll(() => status(legacy.id).textContent()).toContain('状态待确认');
    const finals = items.map(item => ({ ...item, results: [{ futureResultType: 'opaque', title: ' 原结果🐈\r\n', url: null, extra: { nested: [1, false, null] } }] }));
    for (const item of finals) {
      feed('item/completed', { turnId: 'search:original:turn', completedAtMs: 2, item });
      await expect.poll(() => status(item.id).textContent()).toContain('已完成');
    }
    feed('turn/completed', { turn: { id: 'search:original:turn', status: 'completed' } });
    await page.reload(); const summary = page.locator('.turn-summary').first(); await summary.waitFor(); await summary.click();
    for (const item of finals) {
      await expect.poll(() => status(item.id).textContent()).toContain('已完成');
      const event = ctx.store.allEvents(session.id).find(value => value.itemKey === item.id); expect(event).toBeDefined();
      expect(event?.data).toEqual({ name: 'webSearch', input: item, status: 'completed', codexItemPhase: 'completed' });
      expect(event?.native).toEqual(item);
      const mapping = ctx.store.nativeEvents.get(event!.nativeEnvelopeId!)!;
      expect(mapping.nativeTurnId).toBe('search:original:turn');
      const raw = ctx.store.nativeEvents.get(mapping.rawEnvelopeId!)!;
      expect(raw.payload).toMatchObject({ method: 'item/completed', params: { turnId: 'search:original:turn', item } });
      expect((event!.data as EventData['tool.call']).input).toEqual(item);
    }
    await expect.poll(() => status(legacy.id).textContent()).toContain('状态待确认');
    expect(ctx.store.allEvents(session.id).filter(value => value.itemKey === legacy.id)).toEqual(legacyRows);
    expect(errors).toEqual([]);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);

it.each(['claude-code', 'dsh'] as const)('keeps %s ordinary WebSearch cards outside the Codex item phase display', async agent => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const adapter = new FakeAdapter({ id: agent }); let receive!: (id: string, event: AdapterEvent) => void; let opts!: CreateOpts;
    adapter.onEvent = callback => { receive = callback; }; const create = adapter.create.bind(adapter);
    adapter.create = async value => { opts = value; return create(value); }; adapter.send = async () => undefined;
    ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('Ordinary WebSearch tool', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent });
    await ctx.manager.send(session.id, { text: 'Controlled other Agent compatibility' }, 'ordinary-search-' + agent);
    receive(session.id, { type: 'turn.start', nativeTurnId: 'ordinary-turn', runtime: opts.runtime });
    receive(session.id, { type: 'item.complete', kind: 'tool.call', itemKey: 'ordinary-search', nativeTurnId: 'ordinary-turn',
      data: { name: 'webSearch', input: { type: 'webSearch', id: 'ordinary-search' }, status: 'completed' }, native: {}, runtime: opts.runtime });
    receive(session.id, { type: 'turn.end', nativeTurnId: 'ordinary-turn', status: 'completed', runtime: opts.runtime });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener'); const base = 'http://127.0.0.1:' + address.port;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    const check = async () => {
      const summary = page.locator('.turn-summary').first(); await summary.waitFor(); await summary.click();
      expect(await page.getByTestId('codex-native-tool-status').count()).toBe(0);
      expect(await page.getByTestId('timeline').getByText('webSearch', { exact: true }).count()).toBe(1);
    };
    await page.goto(base + '/s/' + session.id); await check(); await page.reload(); await check();
    expect(ctx.store.allEvents(session.id).find(value => value.itemKey === 'ordinary-search')?.data).toMatchObject({ status: 'completed' });
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
