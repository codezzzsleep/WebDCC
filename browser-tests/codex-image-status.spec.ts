import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { AdapterEvent, CreateOpts, EventData } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { createSourceTestApp } from './helpers.js';

const image = (id: string, status: string) => ({ type: 'imageGeneration', id, status, result: '', revisedPrompt: null,
  generationId: null, failure: status === 'failed' ? { type: 'usageLimitExceeded', limitId: 'native:limit', resetsAt: null } : null });

it('source image status cards preserve progress, native failure and original result identity after refresh without rewriting legacy rows', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const adapter = new FakeAdapter({ id: 'codex' }); let receive!: (id: string, event: AdapterEvent) => void; let opts!: CreateOpts;
    adapter.onEvent = value => { receive = value; }; const create = adapter.create.bind(adapter);
    adapter.create = async value => { opts = value; return create(value); }; adapter.send = async () => undefined;
    ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('Controlled native image status', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
    await ctx.manager.send(session.id, { text: 'Native image notifications only; no provider execution' }, 'image-source-input');
    const replay = CodexAdapter.replay(session.id, session.nativeId); let seq = 0;
    const feed = (method: string, params: Record<string, unknown>) => {
      const frame = { i: ++seq, t: seq, dir: 'in' as const, ch: 'rpc', frame: { method, params: { threadId: session.nativeId, ...params } } };
      const receipt = opts.nativeEvents!.record(frame);
      for (const event of replay.feed(frame)) receive(session.id, { ...event, runtime: opts.runtime, nativeEnvelopeId: receipt.envelopeId });
    };
    feed('turn/started', { turn: { id: 'image:original:turn', status: 'inProgress' } });
    for (const id of ['image:result', 'image:file', 'image:failure']) feed('item/started', {
      turnId: 'image:original:turn', startedAtMs: 1, item: image(id, 'in_progress'),
    });
    for (const status of ['in_progress', '', 'future-status']) {
      const original = image('legacy:' + status, status);
      receive(session.id, { type: 'item.complete', itemKey: original.id, kind: 'tool.call', nativeTurnId: 'image:original:turn',
        data: { name: 'imageGeneration', input: original, status: 'completed' }, native: original, runtime: opts.runtime });
    }
    await expect.poll(() => ctx.store.allEvents(session.id).filter(value => value.itemKey.startsWith('legacy:')).length).toBe(3);
    const legacyRows = ctx.store.allEvents(session.id).filter(value => value.itemKey.startsWith('legacy:'));
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener'); const base = 'http://127.0.0.1:' + address.port;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    const status = (id: string) => page.locator('[data-testid="codex-native-tool-status"][data-native-call-id="' + id + '"]');
    await page.goto(base + '/s/' + session.id);
    for (const id of ['image:result', 'image:file', 'image:failure', 'legacy:in_progress']) await expect.poll(() => status(id).textContent()).toContain('运行中');
    for (const id of ['legacy:', 'legacy:future-status']) await expect.poll(() => status(id).textContent()).toContain('状态待确认');
    const result = { ...image('image:result', 'completed'), result: 'original encoded result\r\n🐈', revisedPrompt: '原生提示 🐈', generationId: 'native:generation:result' };
    const file = { type: 'imageGeneration', id: 'image:file', status: 'completed', fileId: 'native:file:result', savedPath: '/native/output.png',
      inputImages: [{ path: '/native/input.png', sha256: 'a'.repeat(64) }], revisedPrompt: null, transparentBackground: true, failure: null, generationId: 'native:generation:file' };
    const failure = image('image:failure', 'failed');
    const finals = [result, file, failure];
    for (const item of finals) {
      feed('item/completed', { turnId: 'image:original:turn', completedAtMs: 2, item });
      await expect.poll(() => status(item.id).textContent()).toContain(item.status === 'failed' ? '失败' : '已完成');
    }
    feed('turn/completed', { turn: { id: 'image:original:turn', status: 'completed' } });
    await page.reload(); const summary = page.locator('.turn-summary').first(); await summary.waitFor(); await summary.click();
    for (const item of finals) {
      await expect.poll(() => status(item.id).textContent()).toContain(item.status === 'failed' ? '失败' : '已完成');
      const event = ctx.store.allEvents(session.id).find(value => value.itemKey === item.id)!;
      expect(event.data).toEqual({ name: 'imageGeneration', input: item, status: item.status }); expect(event.native).toEqual(item);
      const mapping = ctx.store.nativeEvents.get(event.nativeEnvelopeId!)!; expect(mapping.nativeTurnId).toBe('image:original:turn');
      expect(ctx.store.nativeEvents.get(mapping.rawEnvelopeId!)?.payload).toMatchObject({ method: 'item/completed', params: { item, turnId: 'image:original:turn' } });
      expect((event.data as EventData['tool.call']).input).toEqual(item);
    }
    await expect.poll(() => status('legacy:in_progress').textContent()).toContain('运行中');
    for (const id of ['legacy:', 'legacy:future-status']) await expect.poll(() => status(id).textContent()).toContain('状态待确认');
    expect(ctx.store.allEvents(session.id).filter(value => value.itemKey.startsWith('legacy:'))).toEqual(legacyRows); expect(errors).toEqual([]);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);

it.each(['claude-code', 'dsh'] as const)('keeps %s ordinary imageGeneration-named tools outside the native Codex display', async agent => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const adapter = new FakeAdapter({ id: agent }); let receive!: (id: string, event: AdapterEvent) => void; let opts!: CreateOpts;
    adapter.onEvent = value => { receive = value; }; const create = adapter.create.bind(adapter);
    adapter.create = async value => { opts = value; return create(value); }; adapter.send = async () => undefined;
    ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('Ordinary image-named tool', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent });
    await ctx.manager.send(session.id, { text: 'Controlled cross Agent compatibility' }, 'ordinary-image-' + agent);
    receive(session.id, { type: 'turn.start', nativeTurnId: 'ordinary-turn', runtime: opts.runtime });
    receive(session.id, { type: 'item.complete', itemKey: 'ordinary-image', kind: 'tool.call', nativeTurnId: 'ordinary-turn',
      data: { name: 'imageGeneration', input: image('ordinary-image', 'in_progress'), status: 'completed' }, native: {}, runtime: opts.runtime });
    receive(session.id, { type: 'turn.end', nativeTurnId: 'ordinary-turn', status: 'completed', runtime: opts.runtime });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener'); const base = 'http://127.0.0.1:' + address.port;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    const check = async () => { const summary = page.locator('.turn-summary').first(); await summary.waitFor(); await summary.click();
      expect(await page.getByTestId('codex-native-tool-status').count()).toBe(0); expect(await page.getByTestId('timeline').getByText('imageGeneration', { exact: true }).count()).toBe(1); };
    await page.goto(base + '/s/' + session.id); await check(); await page.reload(); await check();
    expect(ctx.store.allEvents(session.id).find(value => value.itemKey === 'ordinary-image')?.data).toMatchObject({ status: 'completed' });
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
