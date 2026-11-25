import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { AgentId } from '@webdcc/protocol';
import { nativeForkFixture } from '../packages/server/test/fixtures/native-fork-runtime.js';
import { createSourceTestApp } from './helpers.js';

it.each<AgentId>(['codex', 'claude-code', 'dsh'])('%s recovers a lost fork response, opens the actual fork and continues while preserving the source draft', async agent => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const workspace = ctx.store.createWorkspace('Browser fork', ctx.dataDir);
    const fixture = nativeForkFixture(agent, workspace.path); ctx.manager.registerAdapter(fixture.adapter);
    const source = ctx.store.createSession({ workspaceId: workspace.id, agent, model: 'fixture', title: 'Original session',
      accessMode: fixture.adapter.accessModes!()[0]!.id });
    ctx.store.updateSession(source.id, { nativeId: 'native-source' });
    const draft = '  original unsent draft🐈\nkeep this  '; ctx.store.setDraft(source.id, draft, []);
    await ctx.manager.connectNativeControls(source.id, { commandId: 'browser-connect', action: { type: 'connect' } });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    let submittedId: string | undefined;
    await page.route(`${base}/api/sessions/${source.id}/native/actions`, async route => {
      submittedId = (route.request().postDataJSON() as { commandId: string }).commandId;
      const actual = await route.fetch(); expect(actual.status()).toBe(200);
      await route.abort('failed');
    });
    await page.goto(`${base}/s/${source.id}`);
    await expect.poll(() => page.getByTestId('composer-input').inputValue()).toBe(draft);
    await page.getByRole('button', { name: '原生控制', exact: true }).click();
    await page.getByLabel('原生操作').selectOption('fork');
    await page.getByRole('button', { name: '提交分叉原生会话' }).click();
    const link = page.getByTestId('native-fork-continuation'); await link.waitFor();
    const receipt = ctx.store.nativeActions.get(submittedId!, source.id)!;
    const child = receipt.continuation!;
    expect(receipt.state).toBe('completed'); expect(child.nativeId).toBe('native-fork-1');
    expect(fixture.forkCalls()).toBe(1); expect(fixture.creates).toHaveLength(0); expect(fixture.sends).toHaveLength(0);
    expect(ctx.manager.getRuntime(child.sessionId)).toBeUndefined();
    expect(await link.getAttribute('href')).toBe(`/s/${child.sessionId}`);
    await page.reload(); await page.getByRole('button', { name: '原生控制', exact: true }).click();
    await link.waitFor(); expect(fixture.forkCalls()).toBe(1);
    await link.click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/s/${child.sessionId}`);
    expect(ctx.manager.getRuntime(child.sessionId)).toBeUndefined();
    const next = '  use the fork context🐈\n  ';
    await page.getByTestId('composer-input').fill(next); await page.getByTestId('composer-input').press('Enter');
    await expect.poll(() => fixture.sends.length).toBe(1);
    expect(fixture.resumes.find(opts => opts.sessionId === child.sessionId)).toMatchObject({ nativeId: child.nativeId, cwd: workspace.path });
    expect(fixture.sends[0]).toMatchObject({ sessionId: child.sessionId, input: { text: next } });
    expect(fixture.creates).toHaveLength(0); expect(fixture.forkCalls()).toBe(1);
    expect(ctx.store.getDraft(source.id).text).toBe(draft);
    await page.goto(`${base}/s/${source.id}`);
    await expect.poll(() => page.getByTestId('composer-input').inputValue()).toBe(draft);
  } finally { await browser?.close(); await ctx.close(); }
}, 40_000);
