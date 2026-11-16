import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { AdapterEvent, CreateOpts, EventData } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { createSourceTestApp, observeSessionSnapshots } from './helpers.js';

it('failed parent and completed native children remain separate with their results after browser refresh', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    let callback!: (id: string, event: AdapterEvent) => void; let opts!: CreateOpts;
    const adapter = new FakeAdapter({ id: 'codex' }); adapter.onEvent = value => { callback = value; };
    const create = adapter.create.bind(adapter); adapter.create = async value => { opts = value; return create(value); };
    adapter.send = async () => undefined;
    ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('native child browser regression', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
    const replay = CodexAdapter.replay(session.id, session.nativeId);
    let index = 0;
    const feed = (method: string, params: Record<string, unknown>) => {
      const frame = { i: ++index, t: index, dir: 'in' as const, ch: 'rpc', frame: { method, params } };
      const receipt = opts.nativeEvents!.record(frame);
      for (const event of replay.feed(frame)) callback(session.id, { ...event, runtime: opts.runtime, nativeEnvelopeId: receipt.envelopeId });
    };
    await ctx.manager.send(session.id, { text: 'original parent task' });
    feed('turn/started', { threadId: session.nativeId, turn: { id: 'parent-turn', status: 'inProgress' } });
    feed('item/completed', { threadId: session.nativeId, turnId: 'parent-turn', item: { type: 'subAgentActivity', id: 'spawn', kind: 'started', agentThreadId: 'native-child', agentPath: '/root/reviewer', model: 'recorded-model' } });
    feed('turn/started', { threadId: 'native-child', turn: { id: 'child-turn', rootTurnId: 'parent-turn', status: 'inProgress' } });
    feed('turn/completed', { threadId: session.nativeId, turn: { id: 'parent-turn', status: 'failed', error: { message: 'stream disconnected before response.completed' } } });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const throughSeq = observeSessionSnapshots(page, session.id);
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${session.id}`);
    const panel = page.getByTestId('codex-subagents-panel');
    await expect.poll(() => panel.textContent()).toContain('运行中');
    await expect.poll(() => panel.textContent()).toContain('父轮次失败，子任务状态单独保留，待恢复汇总');
    feed('item/completed', { threadId: 'native-child', turnId: 'child-turn', item: { type: 'agentMessage', id: 'child-result', text: 'retained child result', phase: 'final_answer' } });
    feed('turn/completed', { threadId: 'native-child', turn: { id: 'child-turn', status: 'completed' } });
    await expect.poll(() => panel.textContent()).toContain('父轮次失败，子任务已完成，待恢复汇总');
    await page.reload();
    await expect.poll(() => throughSeq()).toBe(ctx.store.lastSeq(session.id));
    await expect.poll(() => panel.textContent()).toContain('父轮次失败，子任务已完成，待恢复汇总');
    await panel.locator('summary').click();
    await expect.poll(() => panel.getByText('retained child result', { exact: true }).isVisible()).toBe(true);
    expect(ctx.store.allEvents(session.id).filter(event => event.kind === 'turn.started')).toHaveLength(1);
    expect(ctx.store.allEvents(session.id).filter(event => event.kind === 'assistant.message')).toHaveLength(0);
    expect((ctx.store.allEvents(session.id).find(event => event.kind === 'turn.completed')?.data as EventData['turn.completed']).status).toBe('failed');
    expect(errors).toEqual([]);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
