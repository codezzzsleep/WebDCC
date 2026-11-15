import { chromium } from '@playwright/test';
import { expect, it } from 'vitest';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import type { AdapterEvent, CreateOpts } from '../packages/protocol/src/index.js';
import { createSourceTestApp } from './helpers.js';

it('NP-05 a real browser locates null-turn internal events, follows native evidence and renders active HTML as text', async () => {
  const ctx = await createSourceTestApp();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const adapter = new FakeAdapter({ id: 'codex' });
    let callback!: (id: string, event: AdapterEvent) => void; let opts!: CreateOpts;
    adapter.onEvent = cb => { callback = cb; };
    const create = adapter.create.bind(adapter);
    adapter.create = async value => { opts = value; return create(value); };
    ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('inspector', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
    const html = '<img src=x onerror="window.nativeInspectorExecuted=true">';
    const receipt = opts.nativeEvents!.record({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { method: 'unknown/native', params: { html } } });
    callback(session.id, { type: 'item.complete', itemKey: 'internal', kind: 'internal', data: { nativeType: 'unknown/native' }, runtime: opts.runtime, nativeEnvelopeId: receipt.envelopeId });
    const stored = ctx.store.allEvents(session.id)[0]!;
    const legacy = ctx.store.appendEvent({ sessionId: session.id, turnId: null, itemKey: 'legacy', kind: 'unknown', data: { nativeType: 'legacy' } });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('Missing test listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/settings/native-events?sessionId=${session.id}`);
    await page.getByRole('heading', { name: '原生记录', exact: true }).waitFor();
    await page.getByRole('button', { name: String(stored.nativeEnvelopeId), exact: true }).click();
    await page.getByRole('button', { name: '查看原始接口记录' }).click();
    await expect.poll(async () => {
      const text = await page.getByRole('region', { name: '记录详情' }).locator('pre').innerText();
      return (JSON.parse(text) as { payload?: { params?: { html?: string } } }).payload?.params?.html;
    }).toBe(html);
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>)['nativeInspectorExecuted'])).toBeUndefined();
    await page.getByRole('textbox', { name: 'Web 事件序号' }).fill(String(stored.seq));
    await page.getByRole('button', { name: '定位事件' }).click();
    await expect.poll(() => page.getByRole('region', { name: 'Web 事件详情' }).textContent()).toContain('unknown/native');
    await page.getByRole('textbox', { name: 'Web 事件序号' }).fill(String(legacy.seq));
    await page.getByRole('button', { name: '定位事件' }).click();
    await expect.poll(() => page.getByRole('region', { name: 'Web 事件详情' }).textContent()).toContain('未关联原生信封');
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
