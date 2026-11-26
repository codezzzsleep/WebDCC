import { chromium, type Browser } from '@playwright/test';
import { expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../packages/adapters/claude/src/adapter.js';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';
import { createChildActiveOutputFixture } from '../packages/adapters/dsh/test/child-active-output-fixture.js';
import { bindDshSubagentFixture, childRecord } from '../packages/adapters/dsh/test/subagent-fixture.js';
import { createSourceTestApp } from './helpers.js';

it('hands off the displayed complete final answer while a later turn remains unfinished, without synthesizing missing usage', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    ctx.manager.registerAdapter(new FakeAdapter({ id: 'codex' }));
    const source = await seedWorkspaceAndSession(ctx, 'codex');
    ctx.store.updateSession(source.sessionId, { title: 'Source answer' });
    const target = await ctx.manager.createSession({ workspaceId: source.workspaceId, agent: 'codex', title: 'Target input' });
    const first = '  First native part 🐈  ', second = 'Second native part.\n';
    for (const [turnId, itemKey, kind, data] of [
      ['completed-turn', 'user', 'user.message', { text: 'original task' }],
      ['completed-turn', 'start', 'turn.started', {}],
      ['completed-turn', 'first', 'assistant.message', { text: first, nativePhase: 'final_answer' }],
      ['completed-turn', 'second', 'assistant.message', { text: second, nativePhase: 'final_answer' }],
      ['completed-turn', 'usage1', 'usage', { scope: 'attempt', outputTokens: 7 }],
      ['completed-turn', 'usage2', 'usage', { scope: 'attempt', outputTokens: 9 }],
      ['completed-turn', 'done', 'turn.completed', { status: 'completed', durationMs: 1, answerItemKeys: ['first', 'second'] }],
      ['unfinished-turn', 'later-user', 'user.message', { text: 'later task' }],
      ['unfinished-turn', 'later-start', 'turn.started', {}],
      ['unfinished-turn', 'commentary', 'assistant.message', { text: 'UNFINISHED COMMENTARY', nativePhase: 'commentary' }],
    ] as const) ctx.store.appendEvent({ sessionId: source.sessionId, turnId, itemKey, kind, data: data as never });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${source.sessionId}`);
    await expect.poll(() => page.locator('body').textContent()).toContain('First native part');
    await expect.poll(() => page.locator('body').textContent()).toContain('输入 未提供 / 输出 16 tok');
    await expect.poll(() => page.getByTestId('session-token-count').textContent()).toBe('已观测 16 tok（部分用量）');
    await page.goto(`${base}/s/${target.id}`);
    const input = page.getByTestId('composer-input'); await input.fill('@');
    await page.getByTestId('at-menu').getByRole('button').filter({ hasText: 'Source answer' }).click();
    await expect.poll(() => input.inputValue()).toBe(`${first}\n${second}`);
    expect(ctx.store.allEvents(target.id).some(event => event.kind === 'user.message')).toBe(false);
  } finally { await browser?.close(); await ctx.close(); }
}, 60_000);

it('offers detached native history without pretending automatic recovery or resending the old queue', async () => {
  const ctx = await createSourceTestApp(); const adapter = new ClaudeAdapter(); let browser: Browser | undefined;
  const read = vi.spyOn(adapter.nativeHistory, 'messages').mockResolvedValue({ source: 'claude-sdk', entries: [
    { type: 'assistant', uuid: 'original-message', message: { role: 'assistant', content: 'OBSERVED NATIVE HISTORY' } },
  ] as never, nextOffset: 1, hasMore: false, revision: 'original-native-revision' });
  const create = vi.spyOn(adapter, 'create'); const resume = vi.spyOn(adapter, 'resume');
  ctx.manager.registerAdapter(adapter);
  try {
    const workspace = ctx.store.createWorkspace('Recovery reader', ctx.dataDir);
    const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'claude-code' });
    ctx.store.updateSession(session.id, { nativeId: 'old-native', status: 'error' });
    ctx.store.journal.enqueue('uncertain-input', session.id, 'uncertain-turn', { text: 'original unconfirmed input' });
    ctx.store.journal.inputState('uncertain-turn', 'uncertain');
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/settings/native-events?sessionId=${session.id}`);
    await expect.poll(() => page.getByRole('button', { name: '读取原生状态', exact: true }).isDisabled()).toBe(true);
    await page.getByRole('button', { name: '读取原生历史（仅查看）', exact: true }).click();
    await expect.poll(() => page.locator('body').textContent()).toContain('OBSERVED NATIVE HISTORY');
    expect(await page.locator('body').textContent()).toContain('自动恢复暂不可用');
    expect(await page.getByRole('link', { name: '新建独立会话' }).getAttribute('href')).toContain('/new?');
    expect(read).toHaveBeenCalledWith(workspace.path, 'old-native', 0, 50);
    expect(create).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
    expect(ctx.store.journal.queue(session.id)).toContainEqual(expect.objectContaining({ commandId: 'uncertain-input', state: 'uncertain', input: { text: 'original unconfirmed input' } }));
    expect(ctx.store.getSession(session.id)?.status).toBe('error');
  } finally { await browser?.close(); await ctx.close(); }
}, 60_000);

it('shows passive child output, refreshes its prefix and settles to one committed child record across reload', async () => {
  const ctx = await createSourceTestApp(); const native = await createChildActiveOutputFixture();
  let browser: Browser | undefined;
  try {
    const workspace = ctx.store.createWorkspace('Active child browser', ctx.dataDir);
    const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'dsh' });
    ctx.store.updateSession(session.id, { nativeId: native.parentId });
    bindDshSubagentFixture(ctx.manager, ctx.store.getSession(session.id)!, workspace.path, native.adapter, native.parentId);
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${session.id}`);
    const panel = page.getByTestId('dsh-subagents-panel');
    await panel.getByRole('button', { name: '子 Agent', exact: true }).click();
    await panel.locator('[data-child-id="reviewer"]').getByRole('button', { name: '查看子会话 · reviewer', exact: true }).click();
    const active = page.getByTestId('dsh-child-active-output');
    await expect.poll(() => active.textContent()).toContain('reviewer partial🐈\r\n ');
    const baseline = native.assistants.get('reviewer')!; baseline.revision++;
    baseline.activeAttempt!.nextIndex++;
    baseline.activeAttempt!.stream.push({ type: 'text-chunks', time0: 2002, index: 0, dt: [], texts: ['updated prefix'] });
    await expect.poll(() => active.textContent(), { timeout: 10_000 }).toContain('updated prefix');
    native.states.get('reviewer')!.running = false; native.states.get('reviewer')!.cursor = 9;
    native.records.get('reviewer')!.push(childRecord(8, 'assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'CHILD COMMITTED FINAL' }] } }),
      childRecord(9, 'turn/end', { turn: 2, reason: { kind: 'completed' } }));
    await expect.poll(() => active.count(), { timeout: 10_000 }).toBe(0);
    const history = page.getByTestId('dsh-child-history');
    expect(await history.locator('[data-native-seq="8"]').count()).toBe(1);
    await page.reload();
    await expect.poll(() => history.textContent()).toContain('CHILD COMMITTED FINAL');
    expect(await history.locator('[data-native-seq="8"]').count()).toBe(1);
    expect(ctx.store.allEvents(session.id).some(event => ['user.message', 'assistant.message'].includes(event.kind))).toBe(false);
    expect(native.calls.some(call => /prompt|cancel|interrupt/.test(call.method))).toBe(false);
  } finally { await browser?.close(); await ctx.close(); await native.close(); }
}, 60_000);
