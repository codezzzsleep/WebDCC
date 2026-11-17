/** Actual Source DOM/WS/SQLite, controlled native question batch/transport. */
import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { createSourceTestApp } from './helpers.js';
import { bindDshQuestionOriginalRetry } from '../packages/server/test/fixtures/dsh-question-original-retry.js';

for (const width of [1280, 390]) it(`restores and explicitly retries the complete original question group at ${width}px`, async () => {
  const ctx = await createSourceTestApp(); const group = bindDshQuestionOriginalRetry(ctx); let browser: Browser | undefined;
  try {
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('source listener missing');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width, height: 960 } }); page.setDefaultTimeout(10000);
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${group.session.id}`);
    const cards = page.getByTestId('question-card'); const first = cards.filter({ hasText: 'Original first choice' }); const last = cards.filter({ hasText: 'Original second choice' });
    await expect.poll(() => last.getAttribute('data-sync')).toBe('ready');
    await first.getByRole('radio', { name: 'Keep', exact: true }).check(); await first.getByRole('button', { name: '提交', exact: true }).click();
    await expect.poll(() => first.textContent()).toContain('等待其他问题');
    await last.getByRole('checkbox', { name: 'Second', exact: true }).check(); await last.getByRole('button', { name: '提交', exact: true }).click();
    await expect.poll(() => last.textContent()).toContain('提交结果待核对'); group.reoffer(); await page.reload();
    await expect.poll(() => last.getAttribute('data-sync')).toBe('ready'); expect(group.replies).toHaveLength(1);
    await expect.poll(() => last.getByRole('button', { name: '重试本组原回答', exact: true }).count()).toBe(1);
    const recovery = last.getByTestId('dsh-question-recovery');
    expect(await recovery.textContent()).toContain('Original first choice'); expect(await recovery.textContent()).toContain('Original second choice');
    expect(await recovery.textContent()).toContain('Keep'); expect(await recovery.textContent()).toContain('Second');
    expect(group.replies).toHaveLength(1);
    const original = ctx.store.interactions.get(group.session.id, 'answer', group.ids[1]!)!.command_id!;
    await last.getByRole('button', { name: '重试本组原回答', exact: true }).click();
    await expect.poll(() => group.replies.length).toBe(2);
    await expect.poll(() => last.textContent()).toContain('已提交，等待原生结果');
    const retried = ctx.store.interactions.get(group.session.id, 'answer', group.ids[1]!)!.command_id!;
    const value = (group.replies[0]!['outcome'] as { value: unknown }).value;
    expect(group.replies[1]).toEqual({ ...group.replies[0], clientId: 'replacement-question-client' });
    group.record('tool/result', { message: { toolCallId: group.callId, isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] } });
    await expect.poll(() => last.getAttribute('data-state')).toBe('resolved'); expect(await last.textContent()).toContain('原生已回答');
    await page.reload(); await expect.poll(() => last.getAttribute('data-state')).toBe('resolved');
    expect(await last.getByRole('button').count()).toBe(0); expect(group.replies).toHaveLength(2);
    expect(ctx.store.journal.get(original)?.state).toBe('uncertain'); expect(ctx.store.journal.get(retried)?.state).toBe('uncertain');
  } finally { await browser?.close(); await ctx.close(); }
}, 60000);

it('keeps an explicit same-page recovery check after a cached question token is rejected', async () => {
  const ctx = await createSourceTestApp(); const group = bindDshQuestionOriginalRetry(ctx); let browser: Browser | undefined;
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
    await page.goto(`${base}/s/${group.session.id}`);
    const cards = page.getByTestId('question-card'); const first = cards.filter({ hasText: 'Original first choice' }); const last = cards.filter({ hasText: 'Original second choice' });
    await expect.poll(() => last.getAttribute('data-sync')).toBe('ready');
    await first.getByRole('radio', { name: 'Keep', exact: true }).check(); await first.getByRole('button', { name: '提交', exact: true }).click();
    await expect.poll(() => first.textContent()).toContain('等待其他问题');
    await last.getByRole('checkbox', { name: 'Second', exact: true }).check(); await last.getByRole('button', { name: '提交', exact: true }).click();
    await expect.poll(() => last.textContent()).toContain('提交结果待核对'); group.reoffer(); await page.reload();
    await expect.poll(() => last.getByRole('button', { name: '重试本组原回答', exact: true }).count()).toBe(1);
    const identity = group.native.adapter.hostIdentity;
    group.native.adapter.hostIdentity = async () => ({ ...await identity(), fingerprint: 'f'.repeat(64) });
    await last.getByRole('button', { name: '重试本组原回答', exact: true }).click();
    await expect.poll(() => rejectedCommand).not.toBeUndefined(); expect(ctx.store.journal.get(rejectedCommand!)?.state).toBe('failed');
    expect(group.replies).toHaveLength(1);
    await expect.poll(() => last.getByRole('button', { name: '重新核对问题组', exact: true }).count()).toBe(1);
    group.native.adapter.hostIdentity = identity;
    await last.getByRole('button', { name: '重新核对问题组', exact: true }).click();
    await expect.poll(() => last.getByRole('button', { name: '重试本组原回答', exact: true }).isEnabled()).toBe(true);
    await last.getByRole('button', { name: '重试本组原回答', exact: true }).click();
    await expect.poll(() => group.replies.length).toBe(2); expect(ctx.store.journal.get(rejectedCommand!)?.state).toBe('failed');
  } finally { await browser?.close(); await ctx.close(); }
}, 60000);
