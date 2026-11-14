import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { AdapterEvent, CreateOpts } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { createSourceTestApp } from './helpers.js';

it('NP-23 goal statistics coalesce in the actual timeline; orphan pause and clear update the session panel live and after refresh', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    let callback!: (id: string, event: AdapterEvent) => void; let opts!: CreateOpts;
    const adapter = new FakeAdapter({ id: 'codex' }); adapter.onEvent = value => { callback = value; };
    const create = adapter.create.bind(adapter); adapter.create = async value => { opts = value; return create(value); };
    ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('goals', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
    callback(session.id, { type: 'turn.start', nativeTurnId: 'native-turn', runtime: opts.runtime });
    const replay = CodexAdapter.replay(session.id, session.nativeId);
    let index = 0;
    const emitGoal = (status: string): void => {
      const frame = { i: ++index, t: index, dir: 'in' as const, ch: 'rpc', frame: { method: 'thread/goal/updated', params: { threadId: session.nativeId, turnId: 'native-turn', goal: { threadId: session.nativeId, objective: '目标原文', status, createdAt: 1, updatedAt: index, tokensUsed: index, tokenBudget: 1000 } } } };
      const receipt = opts.nativeEvents!.record(frame);
      for (const event of replay.feed(frame)) callback(session.id, { ...event, runtime: opts.runtime, nativeEnvelopeId: receipt.envelopeId });
    };
    for (let i = 0; i < 321; i++) emitGoal('active');
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const diagnostics: unknown[] = [];
    page.on('pageerror', error => diagnostics.push({ pageerror: error.message }));
    page.on('websocket', socket => {
      socket.on('framesent', event => diagnostics.push({ sent: JSON.parse(event.payload.toString()) }));
      socket.on('framereceived', event => {
        const frame = JSON.parse(event.payload.toString()) as { op: string; event?: { seq: number; data: unknown } };
        if (frame.op !== 'event' || (frame.event?.seq ?? 0) > 320) diagnostics.push({ received: frame });
      });
      socket.on('close', () => diagnostics.push({ socket: 'closed' }));
    });
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${session.id}`);
    await expect.poll(() => page.getByTestId('goal-panel').textContent()).toContain('目标进行中');
    await expect.poll(() => page.getByTestId('timeline').getByText('目标进行中', { exact: true }).count()).toBe(1);
    expect(await page.getByText('更新了目标', { exact: true }).count()).toBe(0);
    emitGoal('paused');
    await expect.poll(() => page.getByTestId('goal-panel').textContent()).toContain('目标已暂停');
    await page.reload();
    try { await expect.poll(() => page.getByTestId('goal-panel').textContent()).toContain('目标已暂停'); }
    catch (error) { process.stdout.write(`${JSON.stringify({ diagnostics, serverSeq: ctx.store.lastSeq(session.id), storedPause: ctx.store.allEvents(session.id).at(-1) })}\n`); throw error; }
    // A session-scoped clear must hide an earlier turn's active goal.
    const frame = { i: ++index, t: index, dir: 'in' as const, ch: 'rpc', frame: { method: 'thread/goal/cleared', params: { threadId: session.nativeId } } };
    const receipt = opts.nativeEvents!.record(frame);
    for (const event of replay.feed(frame)) callback(session.id, { ...event, runtime: opts.runtime, nativeEnvelopeId: receipt.envelopeId });
    await expect.poll(() => page.getByTestId('goal-panel').count()).toBe(0);
    expect(ctx.store.allEvents(session.id).findLast(event => event.kind === 'goal')?.turnId).toBeNull();
    expect(ctx.store.nativeEvents.list(session.id, 0, 1000).filter(record => record.source === 'transport')).toHaveLength(323);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
