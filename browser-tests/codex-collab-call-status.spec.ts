import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { AdapterEvent, CreateOpts } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import type { ThreadItem } from '../packages/adapters/codex/src/schema/v2/ThreadItem.js';
import capture from '../packages/adapters/codex/test/fixtures/collab-call-native.json' with { type: 'json' };
import { createSourceTestApp } from './helpers.js';

it('the source Codex timeline retains native call interruption and old native statuses after refresh without changing persisted legacy rows', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    let receive!: (id: string, event: AdapterEvent) => void; let opts!: CreateOpts;
    const adapter = new FakeAdapter({ id: 'codex' }); adapter.onEvent = callback => { receive = callback; };
    const create = adapter.create.bind(adapter);
    adapter.create = async value => { opts = value; return { ...await create(value), nativeId: capture.nativeId }; };
    adapter.send = async () => undefined; ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('Native collab call states', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
    await ctx.manager.send(session.id, { text: 'Controlled source call-status test' }, 'collab-call-source-input');
    const replay = CodexAdapter.replay(session.id, capture.nativeId); let seq = 0;
    const feed = (frame: Record<string, unknown>) => {
      const trace = { i: ++seq, t: seq, dir: 'in' as const, ch: 'rpc', frame };
      const receipt = opts.nativeEvents!.record(trace);
      for (const event of replay.feed(trace)) receive(session.id, { ...event, runtime: opts.runtime, nativeEnvelopeId: receipt.envelopeId });
    };
    for (const row of capture.frames) feed(row.payload);
    const root = capture.frames[0]!.payload.params as { turn: { id: string } };
    const call = (id: string, status: 'inProgress' | 'interrupted') => ({ type: 'collabAgentToolCall', id, tool: 'wait', status,
      senderThreadId: capture.nativeId, receiverThreadIds: [], prompt: null, model: null, reasoningEffort: null, agentsStates: {} } satisfies ThreadItem);
    feed({ method: 'item/started', params: { threadId: capture.nativeId, turnId: root.turn.id, item: call('native:interrupted:wait', 'inProgress') } });
    feed({ method: 'item/completed', params: { threadId: capture.nativeId, turnId: root.turn.id, item: call('native:interrupted:wait', 'interrupted') } });
    for (const [id, nativeStatus] of [['legacy:interrupted', 'interrupted'], ['legacy:running', 'inProgress']] as const) {
      const item = call(id, nativeStatus);
      receive(session.id, { type: 'item.complete', itemKey: id, nativeTurnId: root.turn.id, kind: 'tool.call',
        data: { name: 'collabAgentToolCall', status: 'completed', input: item }, native: item, runtime: opts.runtime });
    }
    feed({ method: 'turn/completed', params: { threadId: capture.nativeId, turn: { id: root.turn.id, status: 'interrupted' } } });
    await expect.poll(() => ctx.store.allEvents(session.id).filter(value => value.kind === 'tool.call' && value.itemKey?.startsWith('legacy:')).length).toBe(2);
    const originalRows = ctx.store.allEvents(session.id).filter(value => value.itemKey?.startsWith('legacy:'));
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing source listener');
    const base = 'http://127.0.0.1:' + address.port;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(base + '/s/' + session.id);
    const check = async () => {
      const summary = page.locator('.turn-summary').first(); await summary.waitFor(); await summary.click();
      const status = (id: string) => page.locator('[data-testid="codex-collab-call-status"][data-native-call-id="' + id + '"]');
      await expect.poll(() => status('native:interrupted:wait').textContent()).toContain('已中断');
      expect(await status('legacy:interrupted').textContent()).toContain('已中断');
      expect(await status('legacy:running').textContent()).toContain('运行中');
      expect(await page.getByTestId('codex-collab-call-status').count()).toBe(5);
    };
    await check(); await page.reload(); await check();
    expect(ctx.store.allEvents(session.id).filter(value => value.itemKey?.startsWith('legacy:'))).toEqual(originalRows);
    expect(originalRows.every(row => (row.data as { status: string }).status === 'completed')).toBe(true);
    const event = ctx.store.allEvents(session.id).find(value => value.itemKey === 'native:interrupted:wait');
    expect(event?.data).toMatchObject({ status: 'stopped', input: { status: 'interrupted', id: 'native:interrupted:wait' } });
    expect(event?.nativeEnvelopeId).toBeDefined();
    const mapping = ctx.store.nativeEvents.get(event!.nativeEnvelopeId!)!;
    expect(mapping.source).toBe('mapping');
    expect(ctx.store.nativeEvents.get(mapping.rawEnvelopeId!)?.payload).toMatchObject({ params: { item: { id: 'native:interrupted:wait', status: 'interrupted' } } });
    expect(errors).toEqual([]);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);

it.each(['claude-code', 'dsh'] as const)('keeps %s ordinary tool display unchanged even when its input resembles a Codex native call', async agent => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    let receive!: (id: string, event: AdapterEvent) => void; let opts!: CreateOpts;
    const adapter = new FakeAdapter({ id: agent }); adapter.onEvent = callback => { receive = callback; };
    const create = adapter.create.bind(adapter); adapter.create = async value => { opts = value; return create(value); };
    adapter.send = async () => undefined; ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('Ordinary tool source control', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent });
    await ctx.manager.send(session.id, { text: 'Controlled ordinary tool display' }, 'ordinary-tool-' + agent);
    receive(session.id, { type: 'turn.start', nativeTurnId: 'ordinary-root', native: {}, runtime: opts.runtime });
    receive(session.id, { type: 'item.complete', itemKey: 'ordinary-native-shape', nativeTurnId: 'ordinary-root', kind: 'tool.call',
      data: { name: 'collabAgentToolCall', status: 'completed', input: { type: 'collabAgentToolCall', id: 'ordinary-native-shape', tool: 'wait', status: 'interrupted' } },
      native: {}, runtime: opts.runtime });
    receive(session.id, { type: 'turn.end', nativeTurnId: 'ordinary-root', status: 'completed', native: {}, runtime: opts.runtime });
    await expect.poll(() => ctx.store.allEvents(session.id).some(value => value.itemKey === 'ordinary-native-shape')).toBe(true);
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing source listener');
    const base = 'http://127.0.0.1:' + address.port;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    const check = async () => {
      const summary = page.locator('.turn-summary').first(); await summary.waitFor(); await summary.click();
      expect(await page.getByTestId('codex-collab-call-status').count()).toBe(0);
      expect(await page.getByTestId('timeline').getByText('collabAgentToolCall', { exact: true }).count()).toBe(1);
    };
    await page.goto(base + '/s/' + session.id); await check(); await page.reload(); await check();
    expect(ctx.store.allEvents(session.id).find(value => value.itemKey === 'ordinary-native-shape')?.data).toMatchObject({ status: 'completed' });
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
