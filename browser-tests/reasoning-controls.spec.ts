import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { AdapterEvent, AgentAdapter, CreateOpts, UserInput } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { createSourceTestApp } from './helpers.js';

async function pageFor(ctx: Awaited<ReturnType<typeof createSourceTestApp>>, browser: Browser) {
  await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('No test listener');
  const base = `http://127.0.0.1:${address.port}`; const page = await browser.newPage();
  await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
  return { page, base };
}

function dshControls() {
  const adapter: AgentAdapter = new FakeAdapter({ id: 'dsh' });
  let actual: { provider: string; model: string; reasoningEffort?: string } = { provider: 'native-provider', model: 'thinking', reasoningEffort: 'off' };
  let release: (() => void) | undefined; let reject = false;
  const create = adapter.create.bind(adapter); const starts: CreateOpts[] = [];
  adapter.create = async options => { starts.push(options); actual = { provider: 'native-provider', model: options.model ?? 'thinking', ...(options.reasoningEffort === undefined ? { reasoningEffort: 'off' } : { reasoningEffort: options.reasoningEffort }) }; return create(options); };
  adapter.listModels = async () => [
    { id: 'thinking', label: 'Native thinking model', isDefault: true, reasoningEfforts: ['off', 'high', 'max'], defaultReasoningEffort: 'off' },
    { id: 'plain', label: 'Native plain model' },
  ];
  adapter.nativeState = async () => ({ selected: actual });
  adapter.setReasoningEffort = async (_id, effort) => {
    await new Promise<void>(resolve => { release = resolve; });
    if (reject) throw new Error('Native model rejected the reasoning switch');
    actual = { ...actual, reasoningEffort: effort };
  };
  adapter.setModel = async (_id, model) => { actual = { provider: 'native-provider', model }; };
  return { adapter, starts, hasPending: () => release !== undefined, finish(failed = false) { reject = failed; release?.(); release = undefined; } };
}

it('DSH new-session reasoning uses only the exact native model levels and carries the choice to creation', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const controls = dshControls(); ctx.manager.registerAdapter(controls.adapter);
    const workspace = ctx.store.createWorkspace('reasoning', ctx.dataDir);
    browser = await chromium.launch({ headless: true }); const { page, base } = await pageFor(ctx, browser);
    await page.goto(`${base}/new?w=${workspace.id}&agent=dsh`);
    await expect.poll(() => page.getByTestId('reasoning-menu').isEnabled(), { timeout: 10_000 }).toBe(true);
    await page.getByTestId('reasoning-menu').click();
    expect(await page.getByRole('menuitemradio').allTextContents()).toEqual(['沿用原生', 'off', 'high', 'max']);
    await page.getByRole('menuitemradio', { name: 'high', exact: true }).click();
    await page.getByTestId('new-session-input').fill('New reasoning choice'); await page.getByTestId('new-session-send').click();
    await page.waitForURL('**/s/**'); expect(controls.starts).toHaveLength(1);
    expect(controls.starts[0]).toMatchObject({ model: 'thinking', reasoningEffort: 'high' });
    await expect.poll(() => page.getByTestId('reasoning-menu').textContent(), { timeout: 10_000 }).toBe('思考 high');
    await page.reload(); await expect.poll(() => page.getByTestId('reasoning-menu').textContent(), { timeout: 10_000 }).toBe('思考 high');
  } finally { await browser?.close(); await ctx.close(); }
}, 60_000);

it('DSH existing-session reasoning waits for native confirmation and a rejection preserves the actual display', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  const controls = dshControls();
  try {
    ctx.manager.registerAdapter(controls.adapter); const workspace = ctx.store.createWorkspace('existing reasoning', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'dsh', model: 'thinking', reasoningEffort: 'off' });
    browser = await chromium.launch({ headless: true }); const { page, base } = await pageFor(ctx, browser);
    await page.goto(`${base}/s/${session.id}`);
    await expect.poll(() => page.getByTestId('reasoning-menu').textContent(), { timeout: 10_000 }).toBe('思考 off');
    await page.getByTestId('reasoning-menu').click(); await page.getByRole('menuitemradio', { name: 'max', exact: true }).click();
    await expect.poll(controls.hasPending, { timeout: 10_000 }).toBe(true);
    expect(await page.getByTestId('reasoning-menu').textContent()).toBe('思考 off');
    expect(ctx.store.getSession(session.id)?.reasoningEffort).toBe('off');
    controls.finish(); await expect.poll(() => page.getByTestId('reasoning-menu').textContent(), { timeout: 10_000 }).toBe('思考 max');
    await page.reload(); await expect.poll(() => page.getByTestId('reasoning-menu').textContent(), { timeout: 10_000 }).toBe('思考 max');
    await page.getByTestId('reasoning-menu').click(); await page.getByRole('menuitemradio', { name: 'high', exact: true }).click();
    await expect.poll(controls.hasPending, { timeout: 10_000 }).toBe(true); controls.finish(true);
    await expect.poll(() => page.getByText('Native model rejected the reasoning switch', { exact: true }).count(), { timeout: 10_000 }).toBeGreaterThan(0);
    expect(await page.getByTestId('reasoning-menu').textContent()).toBe('思考 max'); expect(ctx.store.getSession(session.id)?.reasoningEffort).toBe('max');
  } finally { controls.finish(); await browser?.close(); await ctx.close(); }
}, 60_000);

it('switching a new DSH model clears an incompatible choice and undeclared reasoning cannot invent levels', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const controls = dshControls(); ctx.manager.registerAdapter(controls.adapter); const workspace = ctx.store.createWorkspace('no reasoning', ctx.dataDir);
    browser = await chromium.launch({ headless: true }); const { page, base } = await pageFor(ctx, browser);
    await page.goto(`${base}/new?w=${workspace.id}&agent=dsh`);
    await expect.poll(() => page.getByTestId('reasoning-menu').isEnabled(), { timeout: 10_000 }).toBe(true);
    await page.getByTestId('reasoning-menu').click(); await page.getByRole('menuitemradio', { name: 'high', exact: true }).click();
    await page.getByTestId('model-menu').click(); await page.getByTestId('model-option').filter({ hasText: 'plain' }).click();
    await expect.poll(() => page.getByTestId('reasoning-menu').isDisabled(), { timeout: 10_000 }).toBe(true);
    expect(await page.getByTestId('reasoning-menu').textContent()).toBe('思考 沿用原生');
    await page.getByTestId('new-session-input').fill('Plain model'); await page.getByTestId('new-session-send').click(); await page.waitForURL('**/s/**');
    expect(controls.starts[0]?.reasoningEffort).toBeUndefined();
  } finally { await browser?.close(); await ctx.close(); }
}, 60_000);

it('DSH existing-session efforts follow the observed native Provider when another route advertises the same model ID', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const route = (provider: string) => `dsh:${Buffer.from(JSON.stringify([provider, 'same'])).toString('base64url')}`;
    const adapter: AgentAdapter = new FakeAdapter({ id: 'dsh' });
    adapter.listModels = async () => [{ id: route('one'), label: 'Same · one', reasoningEfforts: ['high'] }, { id: route('two'), label: 'Same · two', reasoningEfforts: ['off', 'max'] }];
    const observers: ((id: string, event: AdapterEvent) => void)[] = []; const subscribe = adapter.onEvent.bind(adapter); let synchronized = false;
    adapter.onEvent = callback => { subscribe(callback); observers.push(callback); };
    adapter.nativeState = async id => {
      const selected = { provider: 'two', model: 'same', publicModelId: route('two'), reasoningEffort: 'max', source: 'session/projections:modelSelection.next' };
      if (!synchronized) { synchronized = true; for (const callback of observers) callback(id, { type: 'item.complete', itemKey: 'native-external-model', kind: 'internal', scope: 'session', data: { nativeType: 'modelSelection' }, native: selected }); }
      return { selected };
    };
    ctx.manager.registerAdapter(adapter); const workspace = ctx.store.createWorkspace('native route', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'dsh', model: route('one'), reasoningEffort: 'high' });
    browser = await chromium.launch({ headless: true }); const { page, base } = await pageFor(ctx, browser);
    await page.goto(`${base}/s/${session.id}`);
    await expect.poll(() => page.getByTestId('reasoning-menu').textContent(), { timeout: 10_000 }).toBe('思考 max');
    await page.getByTestId('reasoning-menu').click();
    await page.getByRole('menuitemradio').first().waitFor();
    expect(await page.getByRole('menuitemradio').allTextContents()).toEqual(['off', 'max']);
    expect(ctx.store.getSession(session.id)?.model).toBe(route('two'));
    expect(await page.getByTestId('model-menu').getAttribute('data-model')).toBe(route('two'));
    await page.reload(); await expect.poll(() => page.getByTestId('model-menu').getAttribute('data-model'), { timeout: 10_000 }).toBe(route('two'));
    await expect.poll(() => page.getByTestId('reasoning-menu').textContent(), { timeout: 10_000 }).toBe('思考 max');
  } finally { await browser?.close(); await ctx.close(); }
}, 60_000);

it('Codex work-style copy distinguishes configured next input from confirmed native mode and explains both can ask', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const adapter: AgentAdapter = new FakeAdapter({ id: 'codex' }); let actual: 'default' | 'plan' | null = null;
    adapter.inputModes = async () => ({ modes: [{ id: 'default', label: 'Default' }, { id: 'plan', label: 'Plan' }], observedMode: actual });
    const send = adapter.send.bind(adapter);
    adapter.send = async (id, input: UserInput) => { actual = input.contentParts?.collaborationMode ?? 'default'; return send(id, input); };
    ctx.manager.registerAdapter(adapter); const workspace = ctx.store.createWorkspace('work style', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
    browser = await chromium.launch({ headless: true }); const { page, base } = await pageFor(ctx, browser);
    await page.goto(`${base}/s/${session.id}`);
    const selector = page.getByRole('combobox', { name: 'Codex 工作方式', exact: true });
    await expect.poll(() => selector.locator('option[value="plan"]').isEnabled(), { timeout: 10_000 }).toBe(true);
    expect(await selector.inputValue()).toBe(''); expect(await selector.locator('option[value=""]').textContent()).toBe('沿用原生（待确认）');
    await selector.selectOption('plan'); expect(await page.getByTestId('codex-work-mode-state').textContent()).toContain('原生实际：待确认');
    await page.getByTestId('composer-settings-help').getByText('设置说明', { exact: true }).click();
    expect(await page.getByTestId('composer-settings-help').textContent()).toContain('两种方式都可提问');
    await page.getByTestId('composer-input').fill('Plan style input'); await page.getByTestId('send-button').click();
    await expect.poll(() => page.getByTestId('codex-work-mode-state').textContent(), { timeout: 10_000 }).toContain('原生实际：先做计划');
    await page.reload(); await expect.poll(() => selector.inputValue(), { timeout: 10_000 }).toBe('plan');
    await expect.poll(() => selector.locator('option[value=""]').textContent(), { timeout: 10_000 }).toBe('沿用原生（先做计划 · 已确认）');
  } finally { await browser?.close(); await ctx.close(); }
}, 60_000);
