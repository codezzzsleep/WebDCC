/** Current source browser/socket + controlled official approval events; no native Host or Provider. */
import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { ServerMessage } from '@webdcc/protocol';
import type { DshHostClient } from '../packages/adapters/dsh/src/host.js';
import { createSourceTestApp } from './helpers.js';
import { bindDshQuestionFixture } from '../packages/server/test/fixtures/dsh-question.js';

for (const width of [1280, 390]) it(`DSH approval at ${width}px keeps the native rejection through a late ACK and refresh`, async () => {
  const ctx = await createSourceTestApp(); const { session, native, feed } = bindDshQuestionFixture(ctx);
  native.adapter.nativeCatalog = async () => ({});
  const record = (seq: number, type: string, data: unknown) => feed({ type: 'event', event: { type, seq, time: Date.now(), data } });
  record(1, 'turn/start', { turn: 1 });
  record(2, 'approval/asked', { id: 'native-durable-id', callId: 'native-approval-call', toolName: 'write' });
  feed({ type: 'waterfall', event: 'approval/request', agentId: 'native-question-root', eventId: 'native-approval-waterfall',
    request: { callId: 'native-approval-call', toolName: 'write', reason: 'Native approval recovery' } });
  const client = (native.adapter as unknown as { client: DshHostClient }).client;
  const original = client.rpc; const calls: unknown[] = []; let release!: () => void;
  client.rpc = async <T>(endpoint: string, args: Record<string, unknown>) => {
    if (endpoint !== '$events/result') return original<T>(endpoint, args);
    calls.push(args); await new Promise<void>(resolve => { release = resolve; }); return undefined as T;
  };
  let browser: Browser | undefined;
  try {
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('approval source listener missing');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width, height: 960 } });
    page.setDefaultTimeout(10000);
    const acks: Extract<ServerMessage, { op: 'ack' }>[] = [];
    page.on('websocket', socket => socket.on('framereceived', frame => {
      const message = JSON.parse(String(frame.payload)) as ServerMessage;
      if (message.op === 'ack') acks.push(message);
    }));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${session.id}`);
    const card = page.getByTestId('approval-card');
    await expect.poll(() => card.getAttribute('data-sync')).toBe('ready');
    await card.getByRole('button', { name: '允许一次', exact: true }).click();
    await expect.poll(() => typeof release).toBe('function');
    expect(calls).toEqual([{ clientId: 'current-client', eventId: 'native-approval-waterfall', outcome: { kind: 'result', value: 'allowed-once' } }]);
    feed({ type: 'cancel', eventId: 'native-approval-waterfall' });
    await expect.poll(() => card.textContent()).toContain('提交结果待核对');
    expect(await card.getAttribute('data-state')).toBe('pending');
    record(3, 'approval/decided', { id: 'native-durable-id', outcome: 'rejected' });
    await expect.poll(() => card.getAttribute('data-state')).toBe('resolved');
    expect(await card.textContent()).toContain('原生已拒绝');
    release();
    await expect.poll(() => acks.length).toBe(1);
    expect(acks[0]!.result).toMatchObject({ ok: false, code: 'uncertain' });
    await page.reload();
    await expect.poll(() => card.getAttribute('data-state')).toBe('resolved');
    expect(await card.textContent()).toContain('原生已拒绝');
    expect(await card.getByRole('button', { name: '允许一次', exact: true }).count()).toBe(0);
    expect(calls).toHaveLength(1);
  } finally { release?.(); await browser?.close(); await ctx.close(); }
}, 60000);
