import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { createSourceTestApp } from './helpers.js';
import { bindDshApprovalRetry } from '../packages/server/test/fixtures/dsh-approval-retry.js';

for (const width of [1280, 390]) it(`restores and retries the original approval after failure and refresh at ${width}px`, async () => {
  const ctx = await createSourceTestApp(); const native = bindDshApprovalRetry(ctx); let browser: Browser | undefined;
  try {
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('source listener missing');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width, height: 960 } }); page.setDefaultTimeout(10000);
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${native.session.id}`); const card = page.getByTestId('approval-card');
    await expect.poll(() => card.getAttribute('data-sync')).toBe('ready');
    await card.getByRole('button', { name: '允许一次', exact: true }).click();
    await expect.poll(() => card.textContent()).toContain('提交结果待核对');
    native.reoffer(); await page.reload();
    await expect.poll(() => card.getAttribute('data-sync')).toBe('ready');
    expect(native.replies).toHaveLength(1);
    await expect.poll(() => card.getByRole('button', { name: '重试原回应', exact: true }).count()).toBe(1);
    expect(await card.textContent()).toContain('原回应：允许一次');
    await card.getByRole('button', { name: '重试原回应', exact: true }).click();
    await expect.poll(() => native.replies.length).toBe(2);
    await expect.poll(() => card.textContent()).toContain('已提交，等待原生结果');
    native.record('approval/decided', { id: 'durable-approval', outcome: 'allowed-once' });
    await expect.poll(() => card.getAttribute('data-state')).toBe('resolved');
    expect(await card.textContent()).toContain('原生已允许一次');
    await page.reload();
    await expect.poll(() => card.getAttribute('data-state')).toBe('resolved');
    expect(await card.getByRole('button').count()).toBe(0);
    expect(native.replies).toHaveLength(2);
  } finally { await browser?.close(); await ctx.close(); }
}, 60000);

it('allows another explicit check after a cached recovery token is rejected without a new native event', async () => {
  const ctx = await createSourceTestApp(); const native = bindDshApprovalRetry(ctx); let browser: Browser | undefined;
  try {
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('source listener missing');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(10000);
    let rejectedCommand: string | undefined;
    page.on('websocket', socket => socket.on('framereceived', frame => {
      const message = JSON.parse(String(frame.payload)) as { op?: string; clientCommandId?: string; result?: { ok: boolean; code?: string } };
      if (message.op === 'ack' && message.result?.ok === false && message.result.code !== 'uncertain') rejectedCommand = message.clientCommandId;
    }));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${native.session.id}`); const card = page.getByTestId('approval-card');
    await expect.poll(() => card.getAttribute('data-sync')).toBe('ready');
    await card.getByRole('button', { name: '允许一次', exact: true }).click();
    await expect.poll(() => card.textContent()).toContain('提交结果待核对');
    native.reoffer(); await page.reload();
    await expect.poll(() => card.getByRole('button', { name: '重试原回应', exact: true }).count()).toBe(1);
    const identity = native.native.adapter.hostIdentity;
    native.native.adapter.hostIdentity = async () => ({ ...await identity(), fingerprint: 'changed-host-without-new-event' });
    const originalCommand = ctx.store.interactions.get(native.session.id, 'approve', native.approvalId)!.command_id!;
    await card.getByRole('button', { name: '重试原回应', exact: true }).click();
    await expect.poll(() => rejectedCommand).not.toBeUndefined();
    expect(ctx.store.journal.get(rejectedCommand!)?.state).toBe('failed');
    expect(native.replies).toHaveLength(1);
    try { await expect.poll(() => card.getByRole('button', { name: '重新核对审批', exact: true }).count()).toBe(1); }
    catch (error) { throw new Error(`Rejected recovery card: ${await card.textContent()}`, { cause: error }); }
    native.native.adapter.hostIdentity = identity;
    await card.getByRole('button', { name: '重新核对审批', exact: true }).click();
    await expect.poll(() => card.getByRole('button', { name: '重试原回应', exact: true }).isEnabled()).toBe(true);
    await card.getByRole('button', { name: '重试原回应', exact: true }).click();
    await expect.poll(() => native.replies.length).toBe(2);
    expect(ctx.store.journal.get(originalCommand)?.state).toBe('uncertain');
    expect(ctx.store.journal.get(rejectedCommand!)?.state).toBe('failed');
    expect(ctx.store.interactions.get(native.session.id, 'approve', native.approvalId)?.state).toBe('sent');
  } finally { await browser?.close(); await ctx.close(); }
}, 60000);
