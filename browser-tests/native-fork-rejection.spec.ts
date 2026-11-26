import { chromium, expect, type Browser } from '@playwright/test';
import { it } from 'vitest';
import { createSourceTestApp } from './helpers.js';
import { codexForkRejectionFixture } from '../packages/server/test/fixtures/codex-fork-rejection.js';

it('keeps the native rejection retryable, then opens the actual fork after refresh without replaying source input', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const workspace = ctx.store.createWorkspace('Retry native fork', ctx.dataDir);
    const source = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex', model: 'fixture', accessMode: 'inherit', title: 'Original context' });
    ctx.store.updateSession(source.id, { nativeId: 'native-source' }); ctx.store.setDraft(source.id, 'Keep original draft', []);
    const fixture = codexForkRejectionFixture(workspace.path); ctx.manager.registerAdapter(fixture.adapter);
    await ctx.manager.connectNativeControls(source.id, { commandId: 'connect-retry-browser', action: { type: 'connect' } });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('Missing audit listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${source.id}`); await page.getByTestId('composer-input').waitFor();
    await page.getByRole('button', { name: '原生控制', exact: true }).click();
    await page.getByLabel('原生操作').selectOption('fork'); await page.getByRole('button', { name: '提交分叉原生会话', exact: true }).click();
    await expect(page.getByTestId('native-action-receipt')).toContainText('原生已拒绝');
    expect(fixture.controlCalls()).toBe(1); expect(fixture.forkCalls()).toBe(0);
    fixture.setReady(); await page.reload();
    await page.getByRole('button', { name: '原生控制', exact: true }).click();
    await expect(page.getByTestId('native-action-receipt')).toContainText('原生已拒绝');
    await page.getByLabel('原生操作').selectOption('fork'); await page.getByRole('button', { name: '提交分叉原生会话', exact: true }).click();
    const link = page.getByTestId('native-fork-continuation'); await link.waitFor();
    expect(fixture.controlCalls()).toBe(2); expect(fixture.forkCalls()).toBe(1); expect(fixture.sends).toHaveLength(0);
    await link.click(); await page.getByTestId('composer-input').fill('Use corrected fork'); await page.getByTestId('composer-input').press('Enter');
    await expect.poll(() => fixture.sends.length).toBe(1);
    const childId = fixture.sends[0]!.sessionId;
    expect(ctx.store.getSession(childId)).toMatchObject({ nativeId: 'native-fork-1', parentId: source.id, handoffKind: 'native-fork' });
    expect(ctx.store.getDraft(source.id).text).toBe('Keep original draft');
    expect(ctx.store.getSession(source.id)?.nativeId).toBe('native-source');
    expect(fixture.forkCalls()).toBe(1);
  } finally { await browser?.close(); await ctx.close(); }
}, 40_000);
