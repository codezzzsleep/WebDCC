import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { AdapterEvent, AgentAdapter, CreateOpts } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { codexNativeActions } from '../packages/adapters/codex/src/native.js';
import { createSourceTestApp } from './helpers.js';

it('shows original native Review result and interrupted fallback without expanding generic tool JSON and keeps both after refresh', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    let emit!: (id: string, event: AdapterEvent) => void; let opts!: CreateOpts;
    const adapter = new FakeAdapter({ id: 'codex' }); adapter.onEvent = value => { emit = value; };
    const create = adapter.create.bind(adapter); adapter.create = async value => { opts = value; return create(value); };
    adapter.send = async () => { throw new Error('Native Review must not send a chat prompt'); }; ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('Native Review', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
    const replay = CodexAdapter.replay(session.id, session.nativeId); let sequence = 0;
    const feed = (method: string, params: Record<string, unknown>) => {
      const frame = { i: ++sequence, t: sequence, dir: 'in' as const, ch: 'rpc', frame: { method, params: { threadId: session.nativeId, ...params } } };
      const receipt = opts.nativeEvents!.record(frame);
      for (const event of replay.feed(frame)) emit(session.id, { ...event, runtime: opts.runtime, nativeEnvelopeId: receipt.envelopeId });
    };
    const result = '# Native Review\n\n- **Original finding** 😀\n';
    feed('item/completed', { turnId: 'review-a', item: { type: 'enteredReviewMode', id: 'enter-a', review: 'uncommitted changes' } });
    feed('turn/started', { turn: { id: 'execution-a', rootTurnId: 'review-a' } });
    feed('item/completed', { turnId: 'review-a', item: { type: 'agentMessage', id: 'commentary-a', text: result, phase: 'commentary' } });
    feed('item/completed', { turnId: 'review-a', item: { type: 'exitedReviewMode', id: 'result-a', review: result } });
    feed('item/completed', { turnId: 'review-a', item: { type: 'agentMessage', id: 'message-a', text: result } });
    feed('turn/completed', { turn: { id: 'review-a', status: 'completed' } });
    feed('item/completed', { turnId: 'review-b', item: { type: 'enteredReviewMode', id: 'enter-b', review: 'changes against baseline' } });
    feed('turn/started', { turn: { id: 'execution-b', rootTurnId: 'review-b' } });
    const fallback = 'Native Review ended without a result.';
    feed('item/completed', { turnId: 'review-b', item: { type: 'exitedReviewMode', id: 'result-b', review: fallback } });
    feed('turn/completed', { turn: { id: 'review-b', status: 'interrupted' } });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = 'http://127.0.0.1:' + address.port;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(base + '/s/' + session.id);
    const verify = async () => {
      await expect.poll(() => page.getByTestId('codex-review-result').count(), { timeout: 5000 }).toBe(2);
      expect(await page.getByTestId('codex-review-result').first().getAttribute('data-raw-text')).toBe(result);
      expect(await page.getByTestId('codex-review-result').last().getAttribute('data-raw-text')).toBe(fallback);
      expect(await page.locator('.turn').last().textContent()).toContain('已中断');
      expect(await page.getByTestId('assistant-message').count()).toBeLessThanOrEqual(1);
      const first = page.locator('.turn').first(); const title = first.locator('.turn-title');
      if (await title.getAttribute('aria-expanded') === 'false') await title.click();
      await expect.poll(() => first.getByTestId('assistant-message').count()).toBe(1);
    };
    await verify(); await page.reload(); await verify();
    expect(ctx.store.allEvents(session.id).filter(event => (event.native as { type?: string } | undefined)?.type === 'exitedReviewMode')).toHaveLength(2);
    expect(ctx.store.allEvents(session.id).find(event => event.itemKey === 'commentary-a')?.data).toMatchObject({ nativePhase: 'commentary' });
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);

it('submits all three native Review targets from real source controls without a chat send and restores the last receipt', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  const workspace = ctx.store.createWorkspace('Review controls', ctx.dataDir);
  const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' });
  ctx.store.updateSession(session.id, { nativeId: 'native' });
  const adapter: AgentAdapter = new FakeAdapter({ id: 'codex' }); const actions: unknown[] = []; let revision = 1; let sends = 0;
  adapter.nativeState = () => ({ nativeId: 'native', thread: { id: 'native', cwd: ctx.dataDir }, turnActive: false, revision });
  adapter.nativeCatalog = async () => ({ actions: codexNativeActions });
  adapter.executeNativeControl = async (_id, action) => { actions.push(action); revision++; return { reviewThreadId: 'native', turn: { id: 'review-' + revision } }; };
  adapter.send = async () => { sends++; }; ctx.manager.registerAdapter(adapter);
  try {
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = 'http://127.0.0.1:' + address.port;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(base + '/s/' + session.id);
    await page.getByRole('button', { name: '原生控制', exact: true }).click();
    const panel = page.getByRole('region', { name: '原生控制', exact: true });
    await panel.getByRole('button', { name: '连接原生控制' }).click();
    await panel.getByLabel('原生操作').selectOption('review');
    await expect.poll(() => panel.getByTestId('review-workspace').textContent()).toContain(ctx.dataDir);
    const submit = panel.getByRole('button', { name: '提交启动原生 Review' });
    await submit.click(); await expect.poll(() => actions.length).toBe(1);
    await expect.poll(() => submit.isEnabled()).toBe(true);
    await panel.getByLabel('Review 目标').selectOption('baseBranch');
    await panel.getByLabel('基线分支', { exact: true }).fill(' baseline branch ');
    await submit.click(); await expect.poll(() => actions.length).toBe(2);
    await expect.poll(() => submit.isEnabled()).toBe(true);
    await panel.getByLabel('Review 目标').selectOption('commit');
    await panel.getByLabel('Commit SHA', { exact: true }).fill('abcdef1234567890');
    await submit.click(); await expect.poll(() => actions.length).toBe(3);
    expect(actions).toEqual([{ type: 'review', target: { type: 'uncommittedChanges' } },
      { type: 'review', target: { type: 'baseBranch', branch: ' baseline branch ' } },
      { type: 'review', target: { type: 'commit', sha: 'abcdef1234567890', title: null } }]);
    expect(sends).toBe(0);
    await page.reload(); await page.getByRole('button', { name: '原生控制', exact: true }).click();
    await expect.poll(() => panel.getByTestId('native-action-receipt').textContent()).toContain('review');
    expect(actions).toHaveLength(3);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
