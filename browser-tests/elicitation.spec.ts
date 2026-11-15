import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { createSourceTestApp, observeSessionSnapshots } from './helpers.js';

it('NP-06 a standalone MCP form validates, retries, preserves a secret native value, confirms from native and blocks active URLs', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const workspace = ctx.store.createWorkspace('MCP', ctx.dataDir); const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' }); ctx.store.updateSession(session.id, { nativeId: 'native' });
    const native = CodexAdapter.replay(session.id, 'native'); native.adapter.resume = async () => undefined; native.adapter.dispose = async () => undefined;
    native.adapter.send = async () => { native.feed({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { id: 'form', method: 'mcpServer/elicitation/request', params: { threadId: 'native', turnId: null, serverName: 'MCP server', mode: 'openai/form', _meta: null, message: 'Required native details',
      requestedSchema: { type: 'object', required: ['name', 'count', 'pin'], properties: { name: { type: 'string', title: 'Name', minLength: 1 }, count: { type: 'integer', title: 'Count', minimum: 2 }, pin: { type: 'string', title: 'PIN', writeOnly: true } }, additionalProperties: false } } } }); };
    ctx.manager.registerAdapter(native.adapter); await ctx.manager.send(session.id, { text: 'ask' }); expect(ctx.manager.getRuntime(session.id)?.status).toBe('waiting');
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('missing listener'); const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); const snapshotThrough = observeSessionSnapshots(page, session.id); await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]); await page.goto(`${base}/s/${session.id}`);
    const card = page.getByTestId('question-card'); await card.and(page.locator('[data-sync="ready"]')).waitFor(); expect(snapshotThrough()).toBeGreaterThanOrEqual(ctx.store.getSession(session.id)!.lastSeq); expect(await card.getAttribute('data-sync')).toBe('ready'); await card.getByLabel(/Name/).fill('  exact name  '); await card.getByLabel(/Count/).fill('1'); await card.getByLabel(/PIN/).fill('wrong attempt');
    expect(await card.getByLabel(/PIN/).getAttribute('type')).toBe('password'); await card.getByRole('button', { name: '确认提交' }).click();
    await expect.poll(() => card.getByRole('alert').textContent()).toContain('原生要求'); expect(native.replies).toHaveLength(0);
    await card.getByLabel(/Count/).fill('3'); const secret = 'sensitive MCP value 中文'; await card.getByLabel(/PIN/).fill(secret); await card.getByRole('button', { name: '确认提交' }).click();
    await expect.poll(() => native.replies.length).toBe(1); expect(native.replies).toEqual([{ id: 'form', result: { action: 'accept', content: { name: '  exact name  ', count: 3, pin: secret }, _meta: null } }]);
    expect(await card.getByRole('button', { name: '确认提交' }).isDisabled()).toBe(true); expect(await card.getByLabel(/PIN/).inputValue()).toBe('');
    native.feed({ i: 2, t: 0, dir: 'in', ch: 'rpc', frame: { method: 'serverRequest/resolved', params: { threadId: 'native', requestId: 'form' } } }); await expect.poll(() => card.getAttribute('data-state')).toBe('resolved');
    await page.reload(); await card.and(page.locator('[data-sync="ready"]')).waitFor(); expect(snapshotThrough()).toBeGreaterThanOrEqual(ctx.store.getSession(session.id)!.lastSeq); expect(await card.getAttribute('data-state')).toBe('resolved'); expect(JSON.stringify(ctx.store.allEvents(session.id))).not.toContain(secret);
    native.feed({ i: 3, t: 0, dir: 'in', ch: 'rpc', frame: { id: 'url', method: 'mcpServer/elicitation/request', params: { threadId: 'native', turnId: null, serverName: 'URL server', mode: 'url', _meta: null, message: 'External auth', url: 'javascript:alert(1)', elicitationId: 'e' } } });
    const urlCard = page.getByTestId('question-card').filter({ hasText: 'External auth' }); await urlCard.and(page.locator('[data-sync="ready"]')).waitFor(); expect(await urlCard.getByRole('link').count()).toBe(0); expect(await urlCard.getByRole('button', { name: '确认提交' }).isDisabled()).toBe(true);
    await urlCard.getByRole('button', { name: '取消', exact: true }).click(); await expect.poll(() => native.replies.length).toBe(2); expect(native.replies[1]).toEqual({ id: 'url', result: { action: 'cancel', content: null, _meta: null } });
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
