import { chromium } from '@playwright/test';
import { expect, it } from 'vitest';
import { DshAdapter } from '../packages/adapters/dsh/src/adapter.js';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import type { AdapterEvent, CreateOpts, TraceFrame } from '../packages/protocol/src/index.js';
import { createSourceTestApp } from './helpers.js';

it('the browser shows the captured native max-tokens cause as incomplete work', async () => {
  const ctx = await createSourceTestApp();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const adapter = new FakeAdapter({ id: 'dsh' });
  let callback!: (sessionId: string, event: AdapterEvent) => void;
  let opts!: CreateOpts;
  adapter.onEvent = listener => { callback = listener; };
  const create = adapter.create.bind(adapter);
  adapter.create = async value => { opts = value; return create(value); };
  adapter.send = async sessionId => {
    const replay = DshAdapter.replay(sessionId);
    for (const [seq, type, data] of [
      [41, 'turn/start', { turn: 2 }],
      [42, 'turn/end', { turn: 2, reason: { kind: 'max-tokens' } }],
    ] as const) {
      const frame: TraceFrame = { i: seq, t: seq, dir: 'in', ch: 'mux:session/follow', frame: {
        value: { type: 'event', event: { type, seq, time: 1794774032717, data } },
      } };
      const receipt = opts.nativeEvents!.record(frame);
      for (const event of replay.feed(frame)) callback(sessionId, { ...event, runtime: opts.runtime, nativeEnvelopeId: receipt.envelopeId });
    }
  };
  ctx.manager.registerAdapter(adapter);
  try {
    const workspace = ctx.store.createWorkspace('captured max-tokens regression', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'dsh' });
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const separator = ctx.cookie.indexOf('=');
    await page.context().addCookies([{ name: ctx.cookie.slice(0, separator), value: ctx.cookie.slice(separator + 1), url: base }]);
    await page.goto(`${base}/s/${session.id}`);
    await page.getByTestId('composer-input').fill('token limit regression');
    await page.getByTestId('send-button').click();
    await expect.poll(() => ctx.store.allEvents(session.id).find(event => event.kind === 'turn.completed')?.data).toMatchObject({ status: 'failed' });
    await expect.poll(() => page.getByTestId('timeline').innerText()).toContain('出错');
    expect(await page.getByTestId('timeline').innerText()).not.toContain('已完成，用时');
    await page.getByRole('button', { name: /出错，用时/ }).click();
    await page.getByText('DSH 达到原生输出 Token 上限（max-tokens）；输出或工具调用可能未完成。', { exact: true }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: /出错，用时/ }).click();
    await page.getByText('DSH 达到原生输出 Token 上限（max-tokens）；输出或工具调用可能未完成。', { exact: true }).waitFor();
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
