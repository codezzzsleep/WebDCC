import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { expect, it } from 'vitest';
import type { AdapterEvent, CreateOpts } from '@webdcc/protocol';
import { DshAdapter } from '../packages/adapters/dsh/src/adapter.js';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { createSourceTestApp } from './helpers.js';

it('DSH native retries are readable in Chromium through HTTP/WS, cancellation, exhaustion and refreshed history', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    let receive!: (id: string, event: AdapterEvent) => void;
    const options = new Map<string, CreateOpts>();
    const handlers = new Map<string, ReturnType<typeof DshAdapter.replay>>();
    const sequences = new Map<string, number>();
    const adapter = new FakeAdapter({ id: 'dsh' });
    adapter.onEvent = callback => { receive = callback; };
    const create = adapter.create.bind(adapter);
    adapter.create = async opts => { options.set(opts.sessionId, opts); handlers.set(opts.sessionId, DshAdapter.replay()); return create(opts); };
    adapter.send = async () => undefined;
    const feed = (sessionId: string, type: string, data: Record<string, unknown>) => {
      const seq = (sequences.get(sessionId) ?? 0) + 1; sequences.set(sessionId, seq);
      const events = handlers.get(sessionId)!.feed({ i: seq, t: seq, dir: 'in', ch: 'mux:session/follow', frame: { value: { type: 'event', event: { type, seq, time: seq, data } } } });
      for (const event of events) receive(sessionId, { ...event, runtime: options.get(sessionId)!.runtime });
    };
    adapter.interrupt = async sessionId => { feed(sessionId, 'turn/end', { turn: 1, reason: { kind: 'interrupted' } }); };
    ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('DSH retry fixture', ctx.dataDir);
    const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: address }]);
    const start = async () => {
      const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'dsh' });
      await page.goto(`${address}/s/${session.id}`);
      await browserExpect(page.getByTestId('timeline')).toBeVisible();
      await ctx.manager.send(session.id, { text: 'native retry fixture' });
      feed(session.id, 'turn/start', { turn: 1 });
      return session.id;
    };
    const limited = { code: 'RATE_LIMIT', status: 429, message: 'concurrency limit' };
    const wait = (sessionId: string, retry: number, maxRetries = 5) => feed(sessionId, 'llm/retry', { turn: 1, step: 1, retryId: 'series', provider: 'coarena', mode: 'normal', policyKey: 'normal', retry, maxRetries, delayMs: 1000, failure: limited });
    const begin = (sessionId: string, retry: number) => feed(sessionId, 'llm/retry-started', { turn: 1, step: 1, retryId: 'series', retry });
    const openCompleted = async (page: Page) => {
      await expect.poll(() => page.locator('.turn-running').count(), { timeout: 5000 }).toBe(0);
      if (await page.getByTestId('notice-card').count() === 0) await page.locator('.turn-summary').click();
    };

    const success = await start();
    const prefix = ' exact prefix\n<img src=x onerror="window.retryXss=1">';
    feed(success, 'assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [], texts: [prefix] }] });
    wait(success, 1);
    await browserExpect(page.getByTestId('notice-card').filter({ hasText: '约 1.0 秒后重试（1/5）' })).toBeVisible();
    await page.getByText('查看失败尝试的部分输出', { exact: true }).click();
    await browserExpect(page.locator('.notice-card pre')).toHaveText(`部分回答：\n${prefix}`);
    expect(await page.evaluate(() => (window as unknown as { retryXss?: number }).retryXss)).toBeUndefined();
    begin(success, 1);
    await browserExpect(page.getByTestId('notice-card').filter({ hasText: '正在重试（1/5）' })).toBeVisible();
    wait(success, 2); begin(success, 2);
    feed(success, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Recovered final answer' }] } });
    feed(success, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    await openCompleted(page);
    await browserExpect(page.getByTestId('notice-card').filter({ hasText: '模型重试成功（2/5）' })).toBeVisible();
    expect(await page.getByTestId('unknown-card').count()).toBe(0);
    await browserExpect(page.getByTestId('assistant-message')).toContainText('Recovered final answer');
    expect(await page.getByTestId('assistant-message').getAttribute('data-raw-text')).toBe('Recovered final answer');
    const before = await page.getByTestId('notice-card').allTextContents();
    await page.reload(); await openCompleted(page);
    expect(await page.getByTestId('notice-card').allTextContents()).toEqual(before);

    const cancel = await start(); wait(cancel, 1);
    await browserExpect(page.getByTestId('notice-card').filter({ hasText: '约 1.0 秒后重试' })).toBeVisible();
    await page.getByTestId('stop-button').click(); await openCompleted(page);
    await browserExpect(page.getByTestId('notice-card')).toContainText('已取消等待重试（1/5）');
    await page.reload(); await openCompleted(page);
    await browserExpect(page.getByTestId('notice-card')).toContainText('已取消等待重试（1/5）');

    const exhausted = await start(); wait(exhausted, 1, 2); begin(exhausted, 1); wait(exhausted, 2, 2); begin(exhausted, 2);
    feed(exhausted, 'turn/end', { turn: 1, reason: { kind: 'error', error: limited } });
    await openCompleted(page);
    await browserExpect(page.getByTestId('notice-card')).toContainText('模型重试失败，已达重试上限（2/2）');
    await page.reload(); await openCompleted(page);
    await browserExpect(page.getByTestId('notice-card')).toContainText('模型重试失败，已达重试上限（2/2）');
    expect(await page.getByTestId('unknown-card').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally { await browser?.close(); await ctx.close(); }
}, 60_000);
