import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { AdapterEvent, CreateOpts } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import type { JsonRpcStdio } from '../packages/adapters/codex/src/rpc.js';
import type { ThreadGoal } from '../packages/adapters/codex/src/schema/v2/ThreadGoal.js';
import { createSourceTestApp } from './helpers.js';

it('the source native control snapshot rereads a changed goal and retains the new goal after refresh', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const adapter = new FakeAdapter({ id: 'codex' });
    let emit!: (id: string, event: AdapterEvent) => void; let opts!: CreateOpts;
    adapter.onEvent = value => { emit = value; };
    const create = adapter.create.bind(adapter); adapter.create = async value => { opts = value; return create(value); };
    adapter.send = async () => { throw new Error('This read-only test cannot submit a model input'); };
    ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('Goal read race', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
    const replay = CodexAdapter.replay(session.id, session.nativeId);
    const runtime = (replay.adapter as unknown as { sessions: Map<string, { rpc: JsonRpcStdio; nativeId: string; goalObservation?: number }> }).sessions.get(session.id)!;
    const diagnostics: unknown[] = [];
    const thread = { id: session.nativeId, cwd: ctx.dataDir, preview: '', ephemeral: false, modelProvider: 'fixture',
      createdAt: 1, updatedAt: 1, status: { type: 'idle' }, cliVersion: '0.169.0', source: 'appServer', projectId: null, sessionId: 'native-session', turns: [] };
    let goal: ThreadGoal = { threadId: session.nativeId, objective: 'Obsolete native goal', status: 'active', tokenBudget: 100,
      tokensUsed: 0, timeUsedSeconds: 0, createdAt: 100, updatedAt: 101 };
    let release!: (value: { thread: typeof thread }) => void;
    let started = false; let armed = false; let activeReads = 0; let reads = 0;
    runtime.rpc = { isClosed: false, request: async (method: string) => {
      diagnostics.push({ method, goal: goal.objective, observation: runtime.goalObservation });
      if (method === 'thread/read') {
        reads++;
        if (armed && !started) { started = true; return await new Promise(resolve => { release = resolve; }); }
        return { thread };
      }
      if (method === 'thread/goal/get') return { goal };
      throw new Error('Unexpected native source fixture method ' + method);
    } } as unknown as JsonRpcStdio;
    adapter.nativeState = async () => {
      activeReads++;
      try {
        const state = await replay.adapter.nativeState(session.id);
        diagnostics.push({ returned: state.goal?.objective, observation: runtime.goalObservation });
        return state;
      } finally { activeReads--; }
    };
    adapter.nativeCatalog = async () => ({ actions: [] });
    let index = 0;
    const observe = () => {
      const frame = { i: ++index, t: index, dir: 'in' as const, ch: 'rpc', frame: { method: 'thread/goal/updated', params: { threadId: session.nativeId, turnId: null, goal } } };
      const receipt = opts.nativeEvents!.record(frame);
      const translated = replay.feed(frame);
      diagnostics.push({ emitted: translated, nativeId: runtime.nativeId, observation: runtime.goalObservation });
      for (const event of translated) emit(session.id, { ...event, runtime: opts.runtime, nativeEnvelopeId: receipt.envelopeId });
    };
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = 'http://127.0.0.1:' + address.port;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(base + '/s/' + session.id);
    await page.getByRole('button', { name: '原生控制', exact: true }).click();
    const panel = page.getByRole('region', { name: '原生控制', exact: true });
    await panel.locator('summary').filter({ hasText: /^原生状态与能力$/ }).click();
    await expect.poll(() => panel.locator('pre').first().textContent()).toContain('Obsolete native goal');
    await expect.poll(() => activeReads).toBe(0);
    const initialReads = reads;
    armed = true;
    await panel.getByRole('button', { name: '刷新原生状态', exact: true }).click();
    await expect.poll(() => started).toBe(true);
    goal = { ...goal, objective: 'Current native goal after read race', status: 'paused', createdAt: 200, updatedAt: 201 };
    observe(); release({ thread });
    try { await expect.poll(() => panel.locator('pre').first().textContent()).toContain(goal.objective); }
    catch (error) { process.stdout.write(JSON.stringify({ goalReadDiagnostics: diagnostics }) + '\n'); throw error; }
    expect(await panel.locator('pre').first().textContent()).not.toContain('Obsolete native goal');
    await expect.poll(() => page.getByTestId('goal-panel').textContent()).toContain('目标已暂停');
    expect(reads - initialReads).toBeGreaterThanOrEqual(2);
    await page.reload();
    await page.getByRole('button', { name: '原生控制', exact: true }).click();
    await panel.locator('summary').filter({ hasText: /^原生状态与能力$/ }).click();
    await expect.poll(() => panel.locator('pre').first().textContent()).toContain(goal.objective);
    await expect.poll(() => page.getByTestId('goal-panel').textContent()).toContain('目标已暂停');
    expect(ctx.store.allEvents(session.id).filter(event => event.kind === 'turn.started')).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
