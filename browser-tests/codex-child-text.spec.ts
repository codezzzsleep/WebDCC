import { chromium, type Browser, type Page } from '@playwright/test';
import { expect, it } from 'vitest';
import type { AdapterEvent, CreateOpts, EventData } from '@webdcc/protocol';
import { currentCodexSubagents } from '../packages/protocol/src/index.js';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { createSourceTestApp, observeSessionSnapshots } from './helpers.js';

it('the source child panel restores live partial and interrupted text, authoritative final text and native identities on fresh connections', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    let emit!: (id: string, event: AdapterEvent) => void; let opts!: CreateOpts;
    const adapter = new FakeAdapter({ id: 'codex' }); adapter.onEvent = value => { emit = value; };
    const create = adapter.create.bind(adapter); adapter.create = async value => { opts = value; return create(value); };
    adapter.send = async () => { throw new Error('This observation test cannot submit native/model input'); };
    ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('Native child streamed text', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
    if (session.nativeId === undefined) throw new Error('Missing controlled parent identity');
    const replay = CodexAdapter.replay(session.id, session.nativeId); let index = 0;
    const feed = (method: string, params: Record<string, unknown>) => {
      const frame = { i: ++index, t: index, dir: 'in' as const, ch: 'rpc', frame: { method, params } };
      const receipt = opts.nativeEvents!.record(frame);
      for (const event of replay.feed(frame)) emit(session.id, { ...event, runtime: opts.runtime, nativeEnvelopeId: receipt.envelopeId });
    };
    feed('turn/started', { threadId: session.nativeId, turn: { id: 'parent-turn', status: 'inProgress' } });
    for (const childId of ['child-a', 'child-b']) {
      feed('item/completed', { threadId: session.nativeId, turnId: 'parent-turn', item: {
        type: 'collabAgentToolCall', id: 'spawn-' + childId, tool: 'spawnAgent', status: 'completed', senderThreadId: session.nativeId,
        receiverThreadIds: [childId], prompt: null, model: null, reasoningEffort: null, agentsStates: {},
      } });
      feed('turn/started', { threadId: childId, turn: { id: childId + '-turn', rootTurnId: 'parent-turn', status: 'inProgress' } });
    }
    const delta = (childId: string, text: string) => feed('item/agentMessage/delta', {
      threadId: childId, turnId: childId + '-turn', itemId: 'shared:original:item', delta: text,
    });
    const alpha = ' Alpha🐈\r\n'; const beta = '<b>Beta部分正文</b>\t';
    delta('child-a', alpha); delta('child-b', beta);
    feed('item/completed', { threadId: session.nativeId, turnId: 'parent-turn', item: {
      type: 'agentMessage', id: 'parent-answer', text: 'parent-only answer', phase: 'final_answer',
    } });
    feed('turn/completed', { threadId: session.nativeId, turn: { id: 'parent-turn', status: 'completed' } });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = 'http://127.0.0.1:' + address.port;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const through = observeSessionSnapshots(page, session.id);
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(base + '/s/' + session.id);
    const panel = page.getByTestId('codex-subagents-panel');
    const result = (childId: string) => panel.getByTestId('codex-child-result').and(page.locator('[data-child-id="' + childId + '"]'));
    const openChildren = async (activePage: Page) => {
      for (const childId of ['child-a', 'child-b']) {
        const detail = panel.locator(':scope > details').filter({ has: activePage.locator('summary', { hasText: new RegExp('^' + childId + ' ·') }) });
        if (await detail.getAttribute('open') === null) await detail.locator(':scope > summary').click();
      }
    };
    const verify = async (first: string, firstIncomplete: boolean) => {
      await expect.poll(() => through()).toBeDefined(); await openChildren(page);
      for (const [childId, text, incomplete] of [['child-a', first, firstIncomplete], ['child-b', beta, true]] as const) {
        await expect.poll(() => result(childId).locator('pre').textContent()).toBe(text);
        expect(await result(childId).getAttribute('data-native-turn-id')).toBe(childId + '-turn');
        expect(await result(childId).getAttribute('data-native-item-id')).toBe('shared:original:item');
        expect(await result(childId).getByRole('status').count()).toBe(incomplete ? 1 : 0);
      }
      expect(await panel.locator('b').count()).toBe(0);
    };
    await verify(alpha, true); await page.reload();
    await expect.poll(() => through() === ctx.store.lastSeq(session.id)).toBe(true); await verify(alpha, true);
    delta('child-a', '重复重复 '); await verify(alpha + '重复重复 ', true);
    feed('turn/completed', { threadId: 'child-b', turn: { id: 'child-b-turn', status: 'interrupted' } });
    feed('item/completed', { threadId: 'child-a', turnId: 'child-a-turn', item: {
      type: 'agentMessage', id: 'shared:original:item', text: 'Authoritative Alpha final\n', phase: 'final_answer',
    } });
    feed('turn/completed', { threadId: 'child-a', turn: { id: 'child-a-turn', status: 'completed' } });
    delta('child-a', 'old after completion'); delta('child-b', 'old after interrupt');
    await verify('Authoritative Alpha final\n', false);
    await expect.poll(() => panel.textContent()).toContain('child-a · 已完成');
    await expect.poll(() => panel.textContent()).toContain('child-b · 已中断');
    await page.reload(); await expect.poll(() => through() === ctx.store.lastSeq(session.id)).toBe(true); await verify('Authoritative Alpha final\n', false);
    const children = currentCodexSubagents(ctx.store.allEvents(session.id));
    expect(children.map(child => [child.childId, child.results.length, child.results[0]?.text, child.results[0]?.incomplete])).toEqual([
      ['child-a', 1, 'Authoritative Alpha final\n', undefined], ['child-b', 1, beta, true],
    ]);
    const events = ctx.store.allEvents(session.id);
    expect(events.filter(event => event.kind === 'turn.started')).toHaveLength(1);
    const answers = events.filter(event => event.kind === 'assistant.message'); expect(answers).toHaveLength(1);
    expect((answers[0]?.data as EventData['assistant.message']).text).toBe('parent-only answer');
    expect((events.find(event => event.kind === 'turn.completed')?.data as EventData['turn.completed']).status).toBe('completed');
    expect(errors).toEqual([]);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
