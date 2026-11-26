import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { AgentId } from '@webdcc/protocol';
import { nativeForkFixture } from '../packages/server/test/fixtures/native-fork-runtime.js';
import { createSourceTestApp } from './helpers.js';

it.each<{ agent: AgentId; hostname: string }>([
  { agent: 'codex', hostname: '127.0.0.1' },
  { agent: 'claude-code', hostname: '127.0.0.1' },
  { agent: 'dsh', hostname: '127.0.0.1' },
  { agent: 'codex', hostname: 'webdcc-http.test' },
])('$agent on $hostname opens the actual fork and continues while preserving the source draft', async ({ agent, hostname }) => {
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
    const base = `http://${hostname}:${address.port}`;
    const ordinaryHttp = hostname !== '127.0.0.1';
    if (ordinaryHttp) ctx.config.publicOrigins = [base];
    browser = await chromium.launch({ headless: true, ...(ordinaryHttp ? { args: [`--host-resolver-rules=MAP ${hostname} 127.0.0.1`, '--no-proxy-server'] } : {}) });
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    let submittedId: string | undefined;
    await page.route(`${base}/api/sessions/${source.id}/native/actions`, async route => {
      submittedId = (route.request().postDataJSON() as { commandId: string }).commandId;
      if (ordinaryHttp) { await route.continue(); return; }
      const actual = await route.fetch(); expect(actual.status()).toBe(200);
      await route.abort('failed');
    });
    await page.goto(`${base}/s/${source.id}`);
    if (ordinaryHttp) expect(await page.evaluate(() => [isSecureContext, typeof crypto.randomUUID])).toEqual([false, 'undefined']);
    await expect.poll(() => page.getByTestId('composer-input').inputValue()).toBe(draft);
    await page.getByRole('button', { name: '原生控制', exact: true }).click();
    await page.getByLabel('原生操作').selectOption('fork');
    await page.getByRole('button', { name: '提交分叉原生会话' }).click();
    await expect.poll(() => submittedId === undefined ? pageErrors.at(-1) ?? 'pending' : 'submitted').toBe('submitted');
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
