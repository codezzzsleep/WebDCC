import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { AgentAdapter } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { createSourceTestApp } from './helpers.js';

it('source native controls require an explicit connection, preserve exact form values, and restore receipts after refresh', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  const workspace = ctx.store.createWorkspace('native controls', ctx.dataDir);
  const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex', title: 'Native target' });
  ctx.store.updateSession(session.id, { nativeId: 'native' });
  const adapter: AgentAdapter = new FakeAdapter({ id: 'codex' });
  let controls = 0; let sent: unknown; let stateRevision = 1;
  adapter.nativeState = () => ({ revision: stateRevision, nativeId: 'native', turnActive: false });
  adapter.nativeCatalog = async () => ({ actions: [{ type: 'rename', label: '修改原生标题', supported: true,
    schema: { type: 'object', properties: { title: { type: 'string', title: '原生标题' } }, required: ['title'] } }] });
  adapter.executeNativeControl = async (_id, action) => { controls++; sent = action; stateRevision++; return { updated: true }; };
  ctx.manager.registerAdapter(adapter);
  try {
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${session.id}`);
    await page.getByRole('button', { name: '原生控制', exact: true }).click();
    const panel = page.getByRole('region', { name: '原生控制', exact: true });
    await expect.poll(() => panel.getByRole('button', { name: '连接原生控制' }).isVisible()).toBe(true);
    expect(ctx.manager.getRuntime(session.id)).toBeUndefined(); expect(controls).toBe(0);
    await panel.getByRole('button', { name: '连接原生控制' }).click();
    await panel.getByLabel('原生操作').selectOption('rename');
    await panel.getByLabel('原生标题（必填）').fill('  exact title 中文  ');
    await panel.getByRole('button', { name: '提交修改原生标题' }).click();
    await expect.poll(() => controls).toBe(1); expect(sent).toEqual({ type: 'rename', title: '  exact title 中文  ' });
    await expect.poll(() => panel.getByTestId('native-action-receipt').textContent()).toContain('原生调用已返回');
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('native-action:')).map(key => sessionStorage.getItem(key)))).not.toContain('  exact title 中文  ');
    await page.reload(); await page.getByRole('button', { name: '原生控制', exact: true }).click();
    await expect.poll(() => page.getByTestId('native-action-receipt').textContent()).toContain('rename');
    expect(controls).toBe(1);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
