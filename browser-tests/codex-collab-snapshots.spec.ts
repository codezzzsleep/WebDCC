import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { AdapterEvent, CreateOpts } from '@webdcc/protocol';
import { currentCodexSubagents } from '../packages/protocol/src/index.js';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import type { ThreadItem } from '../packages/adapters/codex/src/schema/v2/ThreadItem.js';
import type { CollabAgentState } from '../packages/adapters/codex/src/schema/v2/CollabAgentState.js';
import { createSourceTestApp, observeSessionSnapshots } from './helpers.js';

it('the source child panel persists both native collab observations and refreshes their original messages and identities', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const adapter = new FakeAdapter({ id: 'codex' });
    let emit!: (id: string, event: AdapterEvent) => void; let opts!: CreateOpts;
    adapter.onEvent = value => { emit = value; };
    const create = adapter.create.bind(adapter); adapter.create = async value => { opts = value; return create(value); };
    adapter.send = async () => { throw new Error('This observation fixture cannot submit a model input'); };
    ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('Native collab observations', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
    const replay = CodexAdapter.replay(session.id, session.nativeId); let index = 0;
    const feed = (method: string, params: Record<string, unknown>) => {
      const frame = { i: ++index, t: index, dir: 'in' as const, ch: 'rpc', frame: { method, params: { threadId: session.nativeId, ...params } } };
      const receipt = opts.nativeEvents!.record(frame);
      for (const event of replay.feed(frame)) emit(session.id, { ...event, runtime: opts.runtime, nativeEnvelopeId: receipt.envelopeId });
    };
    const call = (id: string, tool: 'spawnAgent' | 'wait', states: Record<string, CollabAgentState>, status: 'completed' | 'inProgress', receivers = Object.keys(states)) =>
      feed(status === 'inProgress' ? 'item/started' : 'item/completed', { turnId: 'parent-turn', item: {
        type: 'collabAgentToolCall', id, tool, status, senderThreadId: session.nativeId, receiverThreadIds: receivers,
        prompt: null, model: null, reasoningEffort: null, agentsStates: states,
      } satisfies ThreadItem });
    feed('turn/started', { turn: { id: 'parent-turn', status: 'inProgress' } });
    call('spawn-a', 'spawnAgent', { 'child-a': { status: 'running', message: null } }, 'completed');
    call('spawn-b', 'spawnAgent', { 'child-b': { status: 'running', message: null } }, 'completed');
    call('wait:string:id', 'wait', {}, 'inProgress', ['child-a', 'child-b']);
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = 'http://127.0.0.1:' + address.port;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const through = observeSessionSnapshots(page, session.id);
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(base + '/s/' + session.id);
    const panel = page.getByTestId('codex-subagents-panel');
    await expect.poll(() => through()).toBeDefined();
    await expect.poll(() => panel.textContent()).toContain('child-a · 运行中');
    const first = '39916800\r\n<b>原生正文 🐈</b>\n';
    const second = 'tool timeout\n原生失败原因 😺\n';
    call('wait:string:id', 'wait', { 'child-a': { status: 'completed', message: first },
      'child-b': { status: 'errored', message: second } }, 'completed');
    const verify = async () => {
      await expect.poll(() => panel.textContent()).toContain('child-a · 已完成');
      await expect.poll(() => panel.textContent()).toContain('child-b · 失败');
      for (const [childId, message] of [['child-a', first], ['child-b', second]]) {
        const child = panel.locator('details').filter({ has: page.locator('summary', { hasText: new RegExp('^' + childId + ' ·') }) }).first();
        await child.locator(':scope > summary').click();
        const observation = panel.getByTestId('codex-collab-observation').filter({ has: page.locator('[data-testid="codex-collab-message"]') })
          .and(page.locator('[data-native-call-id="wait:string:id"][data-child-id="' + childId + '"]'));
        await observation.locator(':scope > summary').click();
        expect(await observation.getByTestId('codex-collab-message').textContent()).toBe(message);
        expect(await observation.textContent()).toContain(session.nativeId);
        expect(await observation.textContent()).toContain('parent-turn');
      }
      expect(await panel.locator('b').count()).toBe(0);
    };
    await verify(); await page.reload(); await expect.poll(() => through()).toBeDefined(); await verify();
    const children = currentCodexSubagents(ctx.store.allEvents(session.id));
    expect(children.map(child => [child.childId, child.nativeStatus, child.snapshots?.at(-1)?.message])).toEqual([
      ['child-a', 'completed', first], ['child-b', 'errored', second],
    ]);
    expect(children.every(child => child.nativeTurnId === undefined && Object.keys(child.turns).length === 0)).toBe(true);
    expect(ctx.store.allEvents(session.id).filter(event => event.kind === 'turn.started')).toHaveLength(1);
    expect(ctx.store.allEvents(session.id).some(event => event.kind === 'assistant.message' || event.kind === 'user.message')).toBe(false);
    expect(errors).toEqual([]);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
