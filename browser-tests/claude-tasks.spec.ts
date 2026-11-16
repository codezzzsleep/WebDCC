import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { ClaudeAdapter } from '../packages/adapters/claude/src/adapter.js';
import type { AdapterEvent, EventData } from '@webdcc/protocol';
import { createSourceTestApp, observeSessionSnapshots } from './helpers.js';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';

it('Claude task hierarchy, run outputs and unknown states survive source UI refresh, reconnect and session switching', async () => {
  const ctx = await createSourceTestApp();
  let browser: Browser | undefined;
  try {
    const first = await seedWorkspaceAndSession(ctx, 'claude-code');
    const otherSession = await ctx.manager.createSession({ workspaceId: first.workspaceId, agent: 'claude-code' });
    const other = { sessionId: otherSession.id };
    ctx.store.updateSession(first.sessionId, { title: 'Claude task session' });
    ctx.store.updateSession(other.sessionId, { title: 'Other Claude session' });
    const emitter = ctx.manager.adapter('claude-code') as unknown as { emit(id: string, event: AdapterEvent): void };
    const replay = ClaudeAdapter.replay(first.sessionId);
    let i = 0;
    const feed = (frame: unknown) => {
      for (const event of replay.feed({ i: ++i, t: i, dir: 'in', ch: 'sdk', frame })) emitter.emit(first.sessionId, event);
    };
    const start = (task: string, run = '001', tool = `${task}-tool`, parent?: string) => feed({ type: 'system', subtype: 'task_started',
      session_id: 'controlled-native', uuid: `${task}-${run}`, task_id: task, run_id: run, tool_use_id: tool, parent_task_id: parent,
      description: `${task} task`, is_backgrounded: true, task_type: 'local_agent' });
    const output = (tool: string, id: string, text: string) => feed({ type: 'assistant', uuid: id, session_id: 'controlled-native', parent_tool_use_id: tool,
      message: { id, stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
    emitter.emit(first.sessionId, { type: 'turn.start', nativeTurnId: 'parent-turn' });
    start('parent'); start('first', '001', 'first-tool', 'parent'); start('second', '001', 'second-tool', 'parent');
    output('first-tool', 'first-message', 'FIRST CHILD OUTPUT');
    output('second-tool', 'second-message', 'SECOND CHILD OUTPUT');
    feed({ type: 'assistant', uuid: 'main', session_id: 'controlled-native', parent_tool_use_id: null,
      message: { id: 'main', stop_reason: 'end_turn', content: [{ type: 'text', text: 'MAIN ANSWER ONLY' }] } });
    emitter.emit(first.sessionId, { type: 'turn.end', nativeTurnId: 'parent-turn', status: 'completed' });
    const otherReplay = ClaudeAdapter.replay(other.sessionId);
    for (const event of otherReplay.feed({ i: 1, t: 1, dir: 'in', ch: 'sdk', frame: { type: 'system', subtype: 'task_started',
      session_id: 'other-native', uuid: 'other', task_id: 'other', run_id: '001', description: 'OTHER SESSION TASK', is_backgrounded: true } })) emitter.emit(other.sessionId, event);
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    if (!address || typeof address === 'string') throw new Error('missing task browser listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const throughSeq = observeSessionSnapshots(page, first.sessionId);
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${first.sessionId}`);
    const panel = page.getByTestId('claude-tasks-panel');
    await panel.waitFor();
    await panel.locator('summary').first().click();
    const row = (task: string) => panel.locator(`[data-task-id="${task}"]`);
    await expect.poll(() => row('first').textContent()).toContain('FIRST CHILD OUTPUT');
    await expect.poll(() => row('second').textContent()).toContain('SECOND CHILD OUTPUT');
    expect(await row('first').textContent()).not.toContain('SECOND CHILD OUTPUT');
    expect(await row('parent').locator(':scope > ul > li').count()).toBe(2);
    expect(await page.getByTestId('assistant-message').allTextContents()).toEqual(['MAIN ANSWER ONLY']);
    expect(await panel.getByRole('button', { name: /停止|继续|发送/ }).count()).toBe(0);
    feed({ type: 'system', subtype: 'task_notification', session_id: 'controlled-native', uuid: 'stopped-first', task_id: 'first', run_id: '001',
      status: 'stopped', summary: 'FIRST STOPPED', output_file: '/tmp/first-output' });
    start('first', '002', 'new-first-tool', 'parent');
    output('new-first-tool', 'new-first-message', 'NEW FIRST RUN OUTPUT');
    feed({ type: 'system', subtype: 'task_notification', session_id: 'controlled-native', uuid: 'failed-second', task_id: 'second', run_id: '001',
      status: 'failed', summary: 'SECOND FAILED', output_file: '/tmp/second-output' });
    feed({ type: 'system', subtype: 'background_tasks_changed', session_id: 'controlled-native', uuid: 'empty-level', tasks: [] });
    await expect.poll(() => row('first').getAttribute('data-run-id')).toBe('002');
    await expect.poll(() => row('first').textContent()).toContain('结果待确认');
    await expect.poll(() => row('second').textContent()).toContain('失败');
    await page.reload();
    await panel.waitFor();
    await expect.poll(() => throughSeq()).toBe(ctx.store.lastSeq(first.sessionId));
    await panel.locator('summary').first().click();
    expect(await row('first').textContent()).toContain('NEW FIRST RUN OUTPUT');
    expect(await row('first').getByTestId('claude-task-prior-run').textContent()).toContain('FIRST CHILD OUTPUT');
    expect(await row('second').textContent()).toContain('SECOND FAILED');
    console.log('task session navigation identities', JSON.stringify(await page.getByTestId('session-row').evaluateAll(rows => rows.map(row => ({ href: row.getAttribute('href'), text: row.textContent })))));
    await page.locator(`a[href="/s/${other.sessionId}"]`).click();
    await expect.poll(() => page.getByTestId('claude-tasks-panel').textContent()).toContain('OTHER SESSION TASK');
    expect(await page.getByTestId('claude-tasks-panel').textContent()).not.toContain('FIRST CHILD OUTPUT');
    await page.locator(`a[href="/s/${first.sessionId}"]`).click();
    await expect.poll(() => panel.textContent()).toContain('NEW FIRST RUN OUTPUT');
    for (const client of ctx.app.websocketServer.clients) client.terminate();
    feed({ type: 'system', subtype: 'task_updated', session_id: 'controlled-native', uuid: 'reconnected-description', task_id: 'first', run_id: '002',
      patch: { description: 'FIRST RECOVERED TASK' } });
    await expect.poll(() => throughSeq()).toBe(ctx.store.lastSeq(first.sessionId));
    await expect.poll(() => panel.textContent()).toContain('FIRST RECOVERED TASK');
    if (await panel.locator('details').first().getAttribute('open') === null) await panel.locator('summary').first().click();
    await page.screenshot({ path: '/root/.codex/project-state/WebDCC/claude-native-tasks-20261116/view-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: '/root/.codex/project-state/WebDCC/claude-native-tasks-20261116/view-mobile.png', fullPage: true });
    const events = ctx.store.allEvents(first.sessionId);
    const childEvents = events.filter(event => event.kind === 'assistant.message' && (event.data as EventData['assistant.message']).claudeActor !== undefined);
    expect(childEvents).toHaveLength(3);
    expect(childEvents.every(event => event.turnId === null && event.native !== undefined)).toBe(true);
    console.log('Claude task source browser proof', JSON.stringify({ evidence: 'controlled SDK-shaped producer into actual handler/server/SQLite/WebSocket/Chromium',
      parentAnswer: 'MAIN ANSWER ONLY', childOutputs: childEvents.length, refreshedThroughSeq: throughSeq(), persistedThroughSeq: ctx.store.lastSeq(first.sessionId),
      refresh: true, websocketReconnect: true, sessionSwitch: true, realProvider: false, actualStopControl: false }));
  } finally { await browser?.close(); await ctx.close(); }
}, 60000);
