import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { createSourceTestApp, observeSessionSnapshots } from './helpers.js';
import { bindDshSubagentFixture, createDshSubagentFixture, childRecord } from '../packages/adapters/dsh/test/subagent-fixture.js';

it('DSH child state and actual history remain separate from the parent across paging, refresh and browser reconnect', async () => {
  const ctx = await createSourceTestApp();
  const workspace = ctx.store.createWorkspace('DSH child browser', ctx.dataDir);
  const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'dsh' });
  const native = await createDshSubagentFixture(session.id);
  ctx.store.updateSession(session.id, { nativeId: native.parentId });
  bindDshSubagentFixture(ctx.manager, ctx.store.getSession(session.id)!, workspace.path, native.adapter, native.parentId);
  let browser: Browser | undefined;
  try {
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('browser listener missing');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    let closedSockets = 0;
    page.on('websocket', socket => socket.on('close', () => { closedSockets++; }));
    const snapshot = observeSessionSnapshots(page, session.id);
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${session.id}`);
    const panel = page.getByTestId('dsh-subagents-panel');
    await panel.getByRole('button', { name: '子 Agent', exact: true }).click();
    await expect.poll(() => panel.getByTestId('dsh-child').count()).toBe(4);
    expect(snapshot()).toBeGreaterThanOrEqual(ctx.store.getSession(session.id)!.lastSeq);
    const reviewer = panel.locator('[data-child-id="reviewer"]');
    const failed = panel.locator('[data-child-id="failing"]');
    expect(await reviewer.getAttribute('data-state')).toBe('completed');
    expect(await failed.getAttribute('data-state')).toBe('failed');
    expect(await failed.textContent()).toContain('PARTIAL CHILD OUTPUT');
    expect(await failed.textContent()).toContain('max-tokens');
    expect(await panel.locator('[data-child-id="external"]').getByRole('button').count()).toBe(0);
    await reviewer.getByRole('button', { name: '查看子会话 · reviewer', exact: true }).click();
    const history = page.getByTestId('dsh-child-history');
    await expect.poll(() => history.textContent()).toContain('REVIEWER CHILD ONLY FINAL');
    await history.getByRole('button', { name: '加载更早的子会话记录' }).click();
    await expect.poll(() => history.textContent()).toContain('reviewer original input');
    await history.getByText('工具 · read', { exact: true }).click();
    await expect.poll(() => history.textContent()).toContain('reviewer-tool');
    await history.getByRole('button', { name: '加载更早的子会话记录' }).click();
    await expect.poll(() => history.getByRole('button', { name: '加载更早的子会话记录' }).count()).toBe(0);
    expect(await history.locator('[data-native-seq="5"]').count()).toBe(1);
    // A later turn must not change the cut of an older-history read.
    native.records.get('reviewer')!.push(childRecord(7, 'turn/start', { turn: 2 }),
      childRecord(8, 'assistant/message', { turn: 2, message: { id: 'reviewer-new', content: [{ type: 'text', text: 'NEW STOPPED CHILD OUTPUT' }] } }),
      childRecord(9, 'turn/end', { turn: 2, reason: { kind: 'interrupted' } }));
    native.states.get('reviewer')!.cursor = 9;
    await panel.getByRole('button', { name: '刷新子 Agent' }).click();
    await expect.poll(() => reviewer.getAttribute('data-state')).toBe('stopped');
    expect(await history.textContent()).not.toContain('NEW STOPPED CHILD OUTPUT');
    await history.getByRole('button', { name: '查看最新', exact: true }).click();
    await expect.poll(() => history.textContent()).toContain('NEW STOPPED CHILD OUTPUT');
    await page.context().setOffline(true);
    for (const socket of ctx.app.websocketServer.clients) socket.terminate();
    await expect.poll(() => closedSockets).toBeGreaterThan(0);
    await page.context().setOffline(false);
    await expect.poll(() => snapshot()).toBeGreaterThanOrEqual(ctx.store.getSession(session.id)!.lastSeq);
    await expect.poll(() => reviewer.getAttribute('data-state')).toBe('stopped');
    await page.reload();
    await expect.poll(() => reviewer.getAttribute('data-state')).toBe('stopped');
    await expect.poll(() => history.textContent()).toContain('NEW STOPPED CHILD OUTPUT');
    expect(await history.locator('[data-native-seq="8"]').count()).toBe(1);
    expect(ctx.store.allEvents(session.id).filter(event => ['user.message', 'assistant.message'].includes(event.kind))).toEqual([]);
    expect(native.calls.some(call => /prompt|cancel|interrupt/.test(call.method))).toBe(false);
  } finally { await browser?.close(); await ctx.close(); await native.close(); }
}, 60000);

it('DSH mobile child selection ignores late results for the previous child and the previous parent page', async () => {
  const ctx = await createSourceTestApp();
  const workspace = ctx.store.createWorkspace('DSH child mobile', ctx.dataDir);
  const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'dsh' });
  const other = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' });
  const native = await createDshSubagentFixture(session.id);
  ctx.store.updateSession(session.id, { nativeId: native.parentId });
  bindDshSubagentFixture(ctx.manager, ctx.store.getSession(session.id)!, workspace.path, native.adapter, native.parentId);
  let browser: Browser | undefined;
  try {
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('mobile listener missing');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${session.id}`);
    const panel = page.getByTestId('dsh-subagents-panel');
    await panel.getByRole('button', { name: '子 Agent', exact: true }).click();
    await expect.poll(() => panel.getByTestId('dsh-child').count()).toBe(4);
    const bounds = await panel.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
    const held = native.hold('session/page', 'reviewer');
    await panel.locator('[data-child-id="reviewer"]').getByRole('button').click();
    await held.seen;
    await panel.locator('[data-child-id="failing"]').getByRole('button').click();
    const history = page.getByTestId('dsh-child-history');
    await expect.poll(() => history.textContent()).toContain('PARTIAL CHILD OUTPUT');
    held.release();
    await expect.poll(() => native.calls.filter(call => call.method === 'session/page').length).toBeGreaterThanOrEqual(5);
    expect(await history.textContent()).not.toContain('REVIEWER CHILD ONLY FINAL');
    const late = native.hold('session/page', 'failing');
    await history.getByRole('button', { name: '查看最新', exact: true }).click();
    await late.seen;
    await page.goto(`${base}/s/${other.id}`);
    late.release();
    await expect.poll(() => page.getByTestId('dsh-child-history').count()).toBe(0);
    expect(await page.getByTestId('main-column').textContent()).not.toContain('PARTIAL CHILD OUTPUT');
  } finally { await browser?.close(); await ctx.close(); await native.close(); }
}, 60000);
