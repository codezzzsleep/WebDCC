import { chromium } from '@playwright/test';
import { expect, it } from 'vitest';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import type { AdapterEvent, AgentAdapter } from '../packages/protocol/src/index.js';
import { createSourceTestApp } from './helpers.js';

it('NP-07 the browser shows current native permission while a requested change is pending and disables forbidden profiles', async () => {
  const ctx = await createSourceTestApp();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const adapter: AgentAdapter = new FakeAdapter({ id: 'codex' });
  Object.defineProperty(adapter, 'kind', { value: 'real' });
  let callback!: (id: string, event: AdapterEvent) => void;
  let requested: string | undefined;
  adapter.onEvent = cb => { callback = cb; };
  adapter.create = async opts => { callback(opts.sessionId, { type: 'permissions', observation: { effective: 'read-only', source: 'native-fixture', scope: 'thread' } }); return { nativeId: 'native' }; };
  adapter.dispose = async () => undefined;
  adapter.listAccessModes = async () => [{ id: 'read-only', label: '只读', allowed: true }, { id: 'workspace', label: '工作区可写', allowed: true }, { id: 'danger-full-access', label: '完全访问', allowed: false, reason: '原生策略禁止' }];
  adapter.setAccessMode = async (_id, mode) => { requested = mode; await gate; return { accessMode: mode }; };
  ctx.manager.registerAdapter(adapter);
  try {
    const workspace = ctx.store.createWorkspace('permission', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('Missing test listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${session.id}`);
    const pill = page.getByTestId('access-mode');
    await pill.waitFor();
    await expect.poll(() => pill.textContent()).toContain('只读');
    await pill.click();
    expect(await page.getByTestId('access-mode-danger-full-access').isDisabled()).toBe(true);
    await page.getByTestId('access-mode-workspace').click();
    await expect.poll(() => requested).toBe('workspace');
    await expect.poll(() => pill.textContent()).toContain('待生效');
    expect(await pill.textContent()).toContain('只读');
    finish();
    callback(session.id, { type: 'permissions', observation: { effective: 'workspace', source: 'native-fixture', scope: 'turn' } });
    await expect.poll(() => pill.textContent()).toBe('工作区可写');
  } finally { finish(); await browser?.close(); await ctx.close(); }
}, 30_000);
