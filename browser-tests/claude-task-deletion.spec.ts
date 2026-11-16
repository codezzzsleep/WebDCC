import { chromium, type Browser } from '@playwright/test';
import type { AdapterEvent, EventData } from '@webdcc/protocol';
import { expect, it } from 'vitest';
import { ClaudeAdapter } from '../packages/adapters/claude/src/adapter.js';
import { createSourceTestApp, observeSessionSnapshots } from './helpers.js';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';

it('successful native task deletion clears the current plan and stays deleted after refresh while failures and original results remain', async () => {
  const ctx = await createSourceTestApp();
  let browser: Browser | undefined;
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'claude-code');
    const emitter = ctx.manager.adapter('claude-code') as unknown as { emit(id: string, event: AdapterEvent): void };
    emitter.emit(sessionId, { type: 'turn.start', nativeTurnId: 'task-results-turn' });
    const replay = ClaudeAdapter.replay(sessionId);
    let i = 0;
    const tool = (id: string, name: string, input: unknown, result: unknown, isError = false) => {
      for (const event of replay.feed({ i: ++i, t: i, dir: 'in', ch: 'sdk', frame: { type: 'assistant', session_id: 'controlled-native',
        message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } } })) emitter.emit(sessionId, event);
      const native = { type: 'user', session_id: 'controlled-native', parent_tool_use_id: null, tool_use_result: result,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(result), is_error: isError }] } };
      for (const event of replay.feed({ i: ++i, t: i, dir: 'in', ch: 'sdk', frame: native })) emitter.emit(sessionId, event);
      return native;
    };
    const subject = 'Task that must disappear on confirmed deletion';
    tool('create', 'TaskCreate', { subject }, { task: { id: '1', subject } });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    if (!address || typeof address === 'string') throw new Error('missing browser listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const throughSeq = observeSessionSnapshots(page, sessionId);
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${sessionId}`);
    const panel = page.getByTestId('plan-panel');
    await panel.waitFor();
    await panel.getByRole('button').click();
    await expect.poll(() => panel.textContent()).toContain(subject);
    await expect.poll(() => panel.textContent()).toContain('1 待处理');
    tool('failed-delete', 'TaskUpdate', { taskId: '1', status: 'deleted' }, { success: false, taskId: '1', updatedFields: [], error: 'controlled failed deletion' }, true);
    await expect.poll(() => panel.textContent()).toContain(subject);
    const original = tool('delete', 'TaskUpdate', { taskId: '1', status: 'deleted' }, { success: true, taskId: '1', updatedFields: ['status'], statusChange: { from: 'pending', to: 'deleted' } });
    await expect.poll(() => panel.textContent()).not.toContain(subject);
    await expect.poll(() => panel.textContent()).toContain('0 待处理');
    emitter.emit(sessionId, { type: 'turn.end', nativeTurnId: 'task-results-turn', status: 'completed' });
    await page.reload();
    await panel.waitFor();
    const cachedPanel = await panel.textContent();
    const expectedSeq = ctx.store.lastSeq(sessionId);
    await expect.poll(() => throughSeq()).toBe(expectedSeq);
    console.log('task deletion refresh boundary', JSON.stringify({ cachedPanel, throughSeq: throughSeq(), expectedSeq, currentPanel: await panel.textContent() }));
    // Receiving the snapshot frame precedes applying it to the React view.
    await expect.poll(() => panel.textContent()).toContain('0 待处理');
    await expect.poll(() => panel.textContent()).not.toContain(subject);
    const stored = ctx.store.allEvents(sessionId);
    expect(stored.findLast(event => event.kind === 'plan')?.data).toEqual({ items: [] });
    expect(stored.some(event => event.kind === 'tool.call' && (event.data as EventData['tool.call']).name === 'TaskUpdate' && JSON.stringify(event.native) === JSON.stringify(original))).toBe(true);
    expect(stored.some(event => event.kind === 'tool.call' && (event.data as EventData['tool.call']).output?.includes('controlled failed deletion'))).toBe(true);
  } finally { await browser?.close(); await ctx.close(); }
}, 60000);
