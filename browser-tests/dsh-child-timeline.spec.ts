import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { createSourceTestApp } from './helpers.js';
import { createDshSubagentFixture } from '../packages/adapters/dsh/test/subagent-fixture.js';

async function setup() {
  const ctx = await createSourceTestApp(); const workspace = ctx.store.createWorkspace('Timeline child input', ctx.dataDir);
  const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'dsh' });
  const other = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
  const native = await createDshSubagentFixture(session.id); native.cold();
  ctx.store.updateSession(session.id, { nativeId: native.parentId }); ctx.manager.registerAdapter(native.adapter);
  Object.assign(native.states.get('reviewer')!, { active: true, running: true });
  const turnId = 'observed-parent-turn';
  ctx.store.appendEvent({ sessionId: session.id, turnId, itemKey: 'observed-start', kind: 'turn.started', data: {} });
  ctx.store.appendEvent({ sessionId: session.id, turnId, itemKey: 'observed-child', kind: 'tool.call',
    data: { name: 'subagent', input: { childId: 'reviewer', parentSessionId: native.parentId, mode: 'continuable' }, status: 'completed' } });
  ctx.store.appendEvent({ sessionId: session.id, turnId, itemKey: 'observed-end', kind: 'turn.completed', data: { status: 'completed', durationMs: 1 } });
  return { ctx, session, other, native, close: async () => { await ctx.close(); await native.close(); } };
}

it('timeline child navigation uses one persistent input receipt through lost reply, refresh, reconnect and session switch', async () => {
  const { ctx, session, other, native, close } = await setup(); let browser: Browser | undefined;
  try {
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 }); browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } }); let sockets = 0;
    page.on('websocket', () => { sockets++; });
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${session.id}`); await page.locator('.turn-summary').click();
    expect(await page.getByPlaceholder('给子 Agent 发送消息').count()).toBe(0);
    await page.getByTestId('dsh-timeline-child-open').click();
    const composer = page.getByTestId('dsh-child-composer'); const input = composer.getByRole('textbox', { name: '子消息 · reviewer', exact: true });
    await input.waitFor(); expect(native.calls.filter(call => /prompt|interrupt|activate/.test(call.method))).toEqual([]);
    const text = '  exact timeline child input\n第二行  '; await input.fill(text);
    let lost = 0; let commandId = '';
    await page.route('**/subagents/reviewer/prompt', async route => {
      commandId = (route.request().postDataJSON() as { commandId: string }).commandId;
      const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed'); lost++;
    });
    await composer.getByRole('button', { name: '发送到子 Agent 队列', exact: true }).click();
    await expect.poll(() => lost).toBe(1); await page.reload();
    await expect.poll(() => composer.textContent()).toContain('原生已接收这条子消息'); expect(await input.inputValue()).toBe('');
    const previous = sockets; for (const socket of ctx.app.websocketServer.clients) socket.terminate();
    await expect.poll(() => sockets).toBeGreaterThan(previous);
    await expect.poll(() => composer.textContent()).toContain('原生已接收这条子消息');
    await page.locator(`a[href="/s/${other.id}"]`).click(); await expect.poll(() => page.url()).toContain(`/s/${other.id}`);
    await page.locator(`a[href="/s/${session.id}"]`).click(); await expect.poll(() => composer.textContent()).toContain('原生已接收这条子消息');
    const writes = native.calls.filter(call => call.method === 'subagents/prompt'); expect(writes).toHaveLength(1);
    expect(writes[0]?.args['request']).toMatchObject({ requestId: commandId, childSessionId: 'reviewer', delivery: 'queue', content: [{ type: 'text', text }] });
    expect(ctx.store.nativeActions.get(commandId, session.id)).toMatchObject({ state: 'completed', reference: { dshChild: { parentSessionId: native.parentId, childSessionId: 'reviewer', nativeRequestId: commandId } } });
    expect(await page.locator('[data-child-id="reviewer"]').getAttribute('data-state')).toBe('running');
    expect(ctx.manager.getRuntime(session.id)).toBeUndefined(); expect(ctx.store.nativeOwners.get(session.id)).toBeUndefined();
  } finally { await browser?.close(); await close(); }
}, 60000);

it('an old parent tool record and navigation request cannot open controls in a different current parent', async () => {
  const { ctx, session, native, close } = await setup(); let browser: Browser | undefined;
  try {
    ctx.store.updateSession(session.id, { nativeId: 'replaced-native-parent' });
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 }); browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${session.id}`); await page.locator('.turn-summary').click();
    expect(await page.getByTestId('dsh-timeline-child-open').count()).toBe(0); expect(await page.getByPlaceholder('给子 Agent 发送消息').count()).toBe(0);
    await page.evaluate(target => window.dispatchEvent(new CustomEvent('wdcc:dsh-child-open', { detail: target })),
      { sessionId: session.id, parentSessionId: native.parentId, childSessionId: 'reviewer' });
    expect(await page.getByTestId('dsh-subagents-panel').getByRole('button', { name: '子 Agent', exact: true }).getAttribute('aria-expanded')).toBe('false');
    expect(await page.getByTestId('dsh-child-composer').count()).toBe(0);
    expect(native.calls.filter(call => /prompt|interrupt|activate/.test(call.method))).toEqual([]); expect(ctx.manager.getRuntime(session.id)).toBeUndefined();
  } finally { await browser?.close(); await close(); }
}, 60000);
