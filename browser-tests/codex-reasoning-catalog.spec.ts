import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { AgentAdapter, CreateOpts, ModelOption } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { createSourceTestApp } from './helpers.js';

const models: ModelOption[] = [
  { id: 'thinking', label: 'Thinking', isDefault: true, reasoningEfforts: ['low', 'high', 'ultra'], defaultReasoningEffort: 'high', source: 'codex:0.169.0:model/list' },
  { id: 'limited', label: 'Limited', reasoningEfforts: ['low'] },
  { id: 'plain', label: 'Undeclared' },
];

async function open(ctx: Awaited<ReturnType<typeof createSourceTestApp>>, browser: Browser) {
  await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
  const base = `http://127.0.0.1:${address.port}`; const page = await browser.newPage();
  await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
  return { page, base };
}

it('Codex native efforts include ultra, submit it unchanged and follow the existing session model after refresh', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const adapter: AgentAdapter = new FakeAdapter({ id: 'codex' }); const requested: string[] = [];
    adapter.listModels = async () => models;
    adapter.setReasoningEffort = async (_id, effort) => { requested.push(effort); };
    ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('catalog', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex', model: 'thinking', reasoningEffort: 'high' });
    browser = await chromium.launch({ headless: true }); const { page, base } = await open(ctx, browser);
    await page.goto(`${base}/s/${session.id}`);
    await page.getByTestId('reasoning-menu').click();
    await expect.poll(() => page.getByRole('menuitemradio').allTextContents()).toEqual(['low', 'high', 'ultra']);
    await page.getByRole('menuitemradio', { name: 'ultra', exact: true }).click();
    await expect.poll(() => requested).toEqual(['ultra']);
    await expect.poll(() => ctx.store.getSession(session.id)?.reasoningEffort).toBe('ultra');
    await page.reload(); await expect.poll(() => page.getByTestId('reasoning-menu').textContent()).toBe('思考 ultra');
    await page.getByTestId('model-menu').click(); await page.getByTestId('model-option').filter({ hasText: 'limited' }).click();
    await expect.poll(() => ctx.store.getSession(session.id)?.model).toBe('limited');
    await page.getByTestId('reasoning-menu').click();
    await expect.poll(() => page.getByRole('menuitemradio').allTextContents()).toEqual(['low']);
    expect(ctx.store.getSession(session.id)?.reasoningEffort).toBe('ultra');
    expect(await page.getByTestId('reasoning-catalog-note').textContent()).toContain('未在当前模型目录中声明');
    expect(await page.getByTestId('composer-settings-help').textContent()).toContain('上游模型');
  } finally { await browser?.close(); await ctx.close(); }
}, 60_000);

it.each([false, true])('Codex new sessions preserve native ultra preferences with stored metadata=%s, clear on switch and omit inherited effort', async (withMetadata) => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const adapter: AgentAdapter = new FakeAdapter({ id: 'codex' }); const starts: CreateOpts[] = [];
    adapter.listModels = async () => models;
    const create = adapter.create.bind(adapter); adapter.create = async options => { starts.push(options); return create(options); };
    ctx.manager.registerAdapter(adapter);
    const provider = await ctx.app.inject({ method: 'POST', url: '/api/providers', headers: { cookie: ctx.cookie }, payload: {
      name: 'Configured catalog', baseUrl: 'https://fixture.invalid', protocols: ['openai-responses'], models: ['thinking', 'limited', 'plain'],
      ...(withMetadata ? { modelDetails: models.map(model => ({ id: model.id, name: model.label, reasoningEfforts: model.reasoningEfforts })) } : {}),
    } });
    expect(provider.statusCode).toBe(200);
    const workspace = ctx.store.createWorkspace('new catalog', ctx.dataDir);
    browser = await chromium.launch({ headless: true }); const { page, base } = await open(ctx, browser);
    await page.goto(`${base}/new?w=${workspace.id}&agent=codex`);
    await page.getByTestId('reasoning-menu').click();
    await expect.poll(() => page.getByRole('menuitemradio').allTextContents()).toEqual(['沿用原生', 'low', 'high', 'ultra']);
    await page.getByRole('menuitemradio', { name: 'ultra', exact: true }).click();
    await page.reload(); await expect.poll(() => page.getByTestId('reasoning-menu').textContent()).toBe('思考 ultra');
    await page.getByTestId('model-menu').click(); await page.getByTestId('model-option').filter({ hasText: 'limited' }).click();
    await expect.poll(() => page.getByTestId('reasoning-menu').textContent()).toContain('沿用原生');
    await page.getByTestId('reasoning-menu').click();
    await expect.poll(() => page.getByRole('menuitemradio').allTextContents()).toEqual(['沿用原生', 'low']);
    await page.getByRole('menuitemradio', { name: '沿用原生', exact: true }).click();
    await page.reload(); await expect.poll(() => page.getByTestId('reasoning-menu').textContent()).toContain('沿用原生');
    await page.getByTestId('new-session-input').fill('Unchanged input'); await page.getByTestId('new-session-send').click(); await page.waitForURL('**/s/**');
    expect(starts).toHaveLength(1); expect(starts[0]?.model).toBe('limited'); expect(starts[0]?.reasoningEffort).toBeUndefined();
  } finally { await browser?.close(); await ctx.close(); }
}, 60_000);

it.each([false, true])('Codex never invents efforts when a native model is undeclared or the catalog fails (%s)', async (failed) => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const adapter: AgentAdapter = new FakeAdapter({ id: 'codex' });
    adapter.listModels = async () => { if (failed) throw new Error('Catalog unavailable'); return models; };
    ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('unavailable', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex', model: 'plain' });
    browser = await chromium.launch({ headless: true }); const { page, base } = await open(ctx, browser);
    await page.goto(`${base}/s/${session.id}`); await page.getByTestId('reasoning-menu').click();
    await page.getByTestId('reasoning-catalog-note').waitFor();
    expect(await page.getByRole('menuitemradio').allTextContents()).toEqual([]);
    expect(await page.getByTestId('reasoning-menu').textContent()).toBe('思考 待确认');
  } finally { await browser?.close(); await ctx.close(); }
}, 60_000);

it('new Codex native sessions use the declared default model catalog and pass ultra through creation', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const adapter: AgentAdapter = new FakeAdapter({ id: 'codex' }); const starts: CreateOpts[] = [];
    adapter.listModels = async () => models;
    const create = adapter.create.bind(adapter); adapter.create = async options => { starts.push(options); return create(options); };
    ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('native new', ctx.dataDir);
    browser = await chromium.launch({ headless: true }); const { page, base } = await open(ctx, browser);
    await page.goto(`${base}/new?w=${workspace.id}&agent=codex`); await page.getByTestId('reasoning-menu').click();
    await expect.poll(() => page.getByRole('menuitemradio').allTextContents()).toEqual(['沿用原生', 'low', 'high', 'ultra']);
    await page.getByRole('menuitemradio', { name: 'ultra', exact: true }).click();
    await page.getByTestId('new-session-input').fill('Exact native choice'); await page.getByTestId('new-session-send').click(); await page.waitForURL('**/s/**');
    expect(starts).toHaveLength(1); expect(starts[0]).toMatchObject({ providerId: null, reasoningEffort: 'ultra' });
    await page.reload(); await expect.poll(() => page.getByTestId('reasoning-menu').textContent()).toBe('思考 ultra');
  } finally { await browser?.close(); await ctx.close(); }
}, 60_000);
