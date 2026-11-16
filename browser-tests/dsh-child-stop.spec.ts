import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { createSourceTestApp } from './helpers.js';
import { childRecord, createDshSubagentFixture } from '../packages/adapters/dsh/test/subagent-fixture.js';

for (const width of [1280, 390]) it(`DSH child Stop at ${width}px restores a lost browser receipt without resending or claiming a stopped child`, async () => {
  const ctx = await createSourceTestApp();
  const workspace = ctx.store.createWorkspace('Cold native child Stop browser', ctx.dataDir);
  const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'dsh' });
  const native = await createDshSubagentFixture(session.id); native.cold();
  ctx.store.updateSession(session.id, { nativeId: native.parentId }); ctx.manager.registerAdapter(native.adapter);
  const state = native.states.get('reviewer')!; Object.assign(state, { active: true, running: true });
  let browser: Browser | undefined;
  try {
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('Stop browser listener missing');
    const base = `http://127.0.0.1:${address.port}`; browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width, height: 960 } });
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${session.id}`);
    const panel = page.getByTestId('dsh-subagents-panel'); await panel.getByRole('button', { name: '子 Agent', exact: true }).click();
    const row = panel.locator('[data-child-id="reviewer"]'); await row.getByRole('button').click();
    const controls = page.getByTestId('dsh-child-stop');
    const stop = controls.getByRole('button', { name: '停止子 Agent · reviewer', exact: true });
    await expect.poll(() => stop.isEnabled()).toBe(true);
    let commandId: string | undefined;
    await page.route('**/subagents/reviewer/interrupt', async route => {
      commandId = (route.request().postDataJSON() as { commandId: string }).commandId;
      const response = await route.fetch(); expect(response.status()).toBe(200);
      await route.abort('failed');
    });
    await stop.click();
    await expect.poll(() => native.calls.filter(call => call.method === 'subagents/interruptByUser').length).toBe(1);
    await expect.poll(() => controls.textContent()).toContain('停止结果需核对');
    expect(await row.getAttribute('data-state')).toBe('running');
    expect(ctx.store.nativeActions.get(commandId!, session.id)?.state).toBe('submitted');
    await page.reload();
    await expect.poll(() => controls.textContent()).toContain('停止请求已被原生接受');
    expect(await row.getAttribute('data-state')).toBe('running');
    expect(await stop.isEnabled()).toBe(false);
    expect(native.calls.filter(call => call.method === 'subagents/interruptByUser')).toHaveLength(1);
    state.running = false; state.cursor = 7;
    native.records.get('reviewer')!.push(childRecord(7, 'turn/end', { turn: 1, reason: { kind: 'interrupted' } }));
    await panel.getByRole('button', { name: '刷新子 Agent', exact: true }).click();
    await expect.poll(() => row.getAttribute('data-state')).toBe('stopped');
    expect(await row.textContent()).toContain('REVIEWER CHILD ONLY FINAL');
    expect(await controls.textContent()).toContain('停止请求已被原生接受');
    expect(ctx.manager.getRuntime(session.id)).toBeUndefined(); expect(ctx.store.nativeOwners.get(session.id)).toBeUndefined();
    expect(ctx.store.allEvents(session.id)).toEqual([]);
    expect(native.calls.filter(call => /prompt|interrupt|cancel/.test(call.method)).map(call => ({ method: call.method, args: call.args })))
      .toEqual([{ method: 'subagents/interruptByUser', args: { childSessionId: 'reviewer' } }]);
  } finally { await browser?.close(); await ctx.close(); await native.close(); }
}, 60000);
