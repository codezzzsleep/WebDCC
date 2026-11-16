import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { createSourceTestApp } from './helpers.js';
import { createDshSubagentFixture } from '../packages/adapters/dsh/test/subagent-fixture.js';

for (const width of [1280, 390]) it(`DSH child input at ${width}px retains its draft and restores acceptance after a browser reply is lost`, async () => {
  const ctx = await createSourceTestApp(); const workspace = ctx.store.createWorkspace('Native child messages browser', ctx.dataDir);
  const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'dsh' });
  const native = await createDshSubagentFixture(session.id); native.cold();
  ctx.store.updateSession(session.id, { nativeId: native.parentId }); ctx.manager.registerAdapter(native.adapter);
  Object.assign(native.states.get('reviewer')!, { active: true, running: true });
  let browser: Browser | undefined;
  try {
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('child message browser listener missing');
    const base = `http://127.0.0.1:${address.port}`; browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width, height: 960 } });
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${session.id}`); const panel = page.getByTestId('dsh-subagents-panel');
    await panel.getByRole('button', { name: '子 Agent', exact: true }).click();
    const row = panel.locator('[data-child-id="reviewer"]'); await row.getByRole('button').click();
    const composer = page.getByTestId('dsh-child-composer'); const input = composer.getByRole('textbox', { name: '子消息 · reviewer', exact: true });
    const text = '  原样子消息\n第二行  '; await input.fill(text); await page.reload();
    await expect.poll(() => input.inputValue()).toBe(text);
    const failed: string[] = []; let commandId: string | undefined;
    page.on('requestfailed', request => { if (request.url().endsWith('/subagents/reviewer/prompt')) failed.push(request.failure()?.errorText ?? 'failed'); });
    await page.route('**/subagents/reviewer/prompt', async route => {
      const body = route.request().postDataJSON() as { commandId: string; text: string; delivery: string };
      commandId = body.commandId; expect(body.text).toBe(text); expect(body.delivery).toBe('steer');
      const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed');
    });
    await composer.getByRole('button', { name: '介入子 Agent 当前轮', exact: true }).click();
    await expect.poll(() => failed.length).toBe(1);
    await page.reload(); await expect.poll(() => composer.textContent()).toContain('原生已接收这条子消息');
    expect(await input.inputValue()).toBe(''); expect(await row.getAttribute('data-state')).toBe('running');
    const writes = native.calls.filter(call => call.method === 'subagents/prompt'); expect(writes).toHaveLength(1);
    expect(writes[0]?.args['request']).toMatchObject({ requestId: commandId, childSessionId: 'reviewer', delivery: 'steer', content: [{ type: 'text', text }] });
    expect(ctx.store.nativeActions.get(commandId!, session.id)).toMatchObject({ state: 'completed', reference: { dshChild: { nativeRequestId: commandId, childSessionId: 'reviewer' } } });
    expect(ctx.store.getDraft(session.id).text).toBe(''); expect(ctx.store.allEvents(session.id)).toEqual([]);
    expect(ctx.manager.getRuntime(session.id)).toBeUndefined(); expect(ctx.store.nativeOwners.get(session.id)).toBeUndefined();
    expect(native.calls.some(call => call.method === 'session/prompt')).toBe(false);
  } finally { await browser?.close(); await ctx.close(); await native.close(); }
}, 60000);

it('native pre-acceptance rejection retains the child text and reason across refresh, while a new user retry gets a new input identity', async () => {
  const ctx = await createSourceTestApp(); const workspace = ctx.store.createWorkspace('Rejected child message', ctx.dataDir);
  const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'dsh' });
  const native = await createDshSubagentFixture(session.id); native.cold(); ctx.store.updateSession(session.id, { nativeId: native.parentId }); ctx.manager.registerAdapter(native.adapter);
  native.rejectNextPrompt('subagent/delivery-unavailable');
  let browser: Browser | undefined;
  try {
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('rejected child browser listener missing');
    const base = `http://127.0.0.1:${address.port}`; browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]); await page.goto(`${base}/s/${session.id}`);
    const panel = page.getByTestId('dsh-subagents-panel'); await panel.getByRole('button', { name: '子 Agent', exact: true }).click();
    await panel.locator('[data-child-id="reviewer"]').getByRole('button').click();
    const composer = page.getByTestId('dsh-child-composer'); const input = composer.getByRole('textbox', { name: '子消息 · reviewer', exact: true });
    await input.fill('retained rejected child text'); await composer.getByRole('button', { name: '发送到子 Agent 队列', exact: true }).click();
    await expect.poll(() => composer.textContent()).toContain('原生当前无法交付子消息');
    await page.reload(); await expect.poll(() => composer.textContent()).toContain('原生当前无法交付子消息');
    expect(await input.inputValue()).toBe('retained rejected child text');
    expect(native.calls.filter(call => call.method === 'subagents/prompt')).toHaveLength(1);
    await composer.getByRole('button', { name: '发送到子 Agent 队列', exact: true }).click();
    await expect.poll(() => composer.textContent()).toContain('原生已接收这条子消息');
    const requests = native.calls.filter(call => call.method === 'subagents/prompt').map(call => call.args['request'] as { requestId: string });
    expect(requests).toHaveLength(2); expect(requests[0]?.requestId).not.toBe(requests[1]?.requestId);
    expect(await input.inputValue()).toBe(''); expect(ctx.manager.getRuntime(session.id)).toBeUndefined();
  } finally { await browser?.close(); await ctx.close(); await native.close(); }
}, 60000);
