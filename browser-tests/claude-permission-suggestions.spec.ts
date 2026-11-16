import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAdapter } from '../packages/adapters/claude/src/adapter.js';
import { createSourceTestApp } from './helpers.js';

it.each([false, true])('Claude approval keeps native scope and suppression through browser refresh (%s)', async suppressed => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  let cancel: (() => Promise<void>) | undefined;
  try {
    const workspace = ctx.store.createWorkspace('native permissions', ctx.dataDir);
    const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'claude-code' });
    ctx.store.updateSession(session.id, { nativeId: 'native' });
    const native = ClaudeAdapter.replay(session.id);
    cancel = () => native.adapter.cancelPending(session.id);
    native.adapter.probe = async () => ({ installed: true, compatible: true, version: '0.3.322', pinnedVersion: '0.3.322', auth: 'unknown' });
    native.adapter.listModels = async () => [];
    native.adapter.resume = async () => undefined; native.adapter.dispose = async () => { await cancel?.(); };
    native.adapter.nativeState = async () => ({});
    const updates: PermissionUpdate[] = [{ type: 'addRules', destination: 'session', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'pwd' }] }];
    native.adapter.send = async () => { native.feed({ i: 1, t: 0, dir: 'in', ch: 'canUseTool', frame: {
      toolName: 'Bash', toolUseID: 'tool', input: { command: 'pwd' }, suggestions: updates, suppressAlwaysAllowRule: suppressed, defaultToNo: true,
    } }); };
    ctx.manager.registerAdapter(native.adapter); await ctx.manager.send(session.id, { text: 'permission fixture' }, 'PERMISSION-FIXTURE');
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`; browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${session.id}`);
    const card = page.getByTestId('approval-card').filter({ has: page.getByText('Bash · pwd', { exact: true }) });
    await expect.poll(() => card.getAttribute('data-sync')).toBe('ready');
    expect(await card.locator('.approval-command').textContent()).toBe('pwd');
    expect(await card.getByRole('button').first().textContent()).toBe('拒绝');
    const suggestion = card.getByRole('button', { name: '允许并应用原生建议（本会话）', exact: true });
    expect(await suggestion.count()).toBe(suppressed ? 0 : 1);
    await page.reload(); await expect.poll(() => card.getAttribute('data-sync')).toBe('ready');
    expect(await suggestion.count()).toBe(suppressed ? 0 : 1);
    if (suppressed) await card.getByRole('button', { name: '拒绝', exact: true }).click();
    else {
      await card.getByText('详情', { exact: true }).click();
      expect(await card.locator('pre').textContent()).toContain('nativePermissionSuggestions');
      await suggestion.click();
    }
    await expect.poll(() => native.decisions[0]).toEqual(suppressed ? { behavior: 'deny', message: '用户拒绝', interrupt: true }
      : { behavior: 'allow', updatedInput: { command: 'pwd' }, updatedPermissions: updates });
    const resolved = page.getByTestId('approval-card').filter({ has: page.getByText(suppressed ? '已拒绝' : '已允许一次并提交原生权限建议', { exact: true }) });
    await expect.poll(() => resolved.count()).toBe(1);
    await page.reload(); await expect.poll(() => resolved.count()).toBe(1);
  } finally { await cancel?.(); await browser?.close(); await ctx.close(); }
}, 60_000);
