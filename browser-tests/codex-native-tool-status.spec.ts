import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { AdapterEvent, CreateOpts } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { nativeToolItem } from '../packages/adapters/codex/test/fixtures/native-tool-items.js';
import { createSourceTestApp } from './helpers.js';

it('the source Codex timeline preserves live MCP/dynamic progress, final contents and immutable legacy status after refresh', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    let receive!: (id: string, event: AdapterEvent) => void; let opts!: CreateOpts;
    const adapter = new FakeAdapter({ id: 'codex' }); adapter.onEvent = callback => { receive = callback; };
    const create = adapter.create.bind(adapter); adapter.create = async value => { opts = value; return create(value); };
    adapter.send = async () => undefined; ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('Controlled native tool lifecycle', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
    await ctx.manager.send(session.id, { text: 'Controlled tool lifecycle source evidence' }, 'native-tool-source-input');
    const replay = CodexAdapter.replay(session.id, session.nativeId); let seq = 0;
    const feed = (method: string, params: Record<string, unknown>) => {
      const frame = { i: ++seq, t: seq, dir: 'in' as const, ch: 'rpc', frame: { method, params: { threadId: session.nativeId, ...params } } };
      const receipt = opts.nativeEvents!.record(frame);
      for (const event of replay.feed(frame)) receive(session.id, { ...event, runtime: opts.runtime, nativeEnvelopeId: receipt.envelopeId });
    };
    feed('turn/started', { turn: { id: 'native-tool-turn', status: 'inProgress' } });
    for (const type of ['mcpToolCall', 'dynamicToolCall'] as const) {
      feed('item/started', { turnId: 'native-tool-turn', item: nativeToolItem(type, 'inProgress') });
      const legacy = { ...nativeToolItem(type, 'inProgress'), id: 'legacy:' + type };
      receive(session.id, { type: 'item.complete', kind: 'tool.call', itemKey: legacy.id, nativeTurnId: 'native-tool-turn',
        data: { name: type, status: 'completed', input: legacy }, native: legacy, runtime: opts.runtime });
    }
    await expect.poll(() => ctx.store.allEvents(session.id).filter(value => value.itemKey?.startsWith('legacy:')).length).toBe(2);
    const legacyRows = ctx.store.allEvents(session.id).filter(value => value.itemKey?.startsWith('legacy:'));
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing source listener');
    const base = 'http://127.0.0.1:' + address.port;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(base + '/s/' + session.id);
    const status = (id: string) => page.locator('[data-testid="codex-native-tool-status"][data-native-call-id="' + id + '"]');
    for (const type of ['mcpToolCall', 'dynamicToolCall'] as const) {
      await expect.poll(() => status(type + ':original:string:call').textContent()).toContain('运行中');
      expect(await status('legacy:' + type).textContent()).toContain('运行中');
      feed('item/completed', { turnId: 'native-tool-turn', item: nativeToolItem(type, 'completed') });
      await expect.poll(() => status(type + ':original:string:call').textContent()).toContain('已完成');
    }
    feed('turn/completed', { turn: { id: 'native-tool-turn', status: 'completed' } });
    await page.reload();
    const summary = page.locator('.turn-summary').first(); await summary.waitFor(); await summary.click();
    for (const type of ['mcpToolCall', 'dynamicToolCall'] as const) {
      await expect.poll(() => status(type + ':original:string:call').textContent()).toContain('已完成');
      expect(await status('legacy:' + type).textContent()).toContain('运行中');
      const event = ctx.store.allEvents(session.id).find(value => value.itemKey === type + ':original:string:call');
      expect(event?.data).toMatchObject({ status: 'completed', input: nativeToolItem(type, 'completed') });
      expect(event?.native).toEqual(nativeToolItem(type, 'completed'));
      const mapping = ctx.store.nativeEvents.get(event!.nativeEnvelopeId!)!;
      expect(ctx.store.nativeEvents.get(mapping.rawEnvelopeId!)?.payload).toMatchObject({ params: { item: nativeToolItem(type, 'completed') } });
    }
    expect(ctx.store.allEvents(session.id).filter(value => value.itemKey?.startsWith('legacy:'))).toEqual(legacyRows);
    expect(legacyRows.every(row => (row.data as { status: string }).status === 'completed')).toBe(true);
    expect(errors).toEqual([]);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
