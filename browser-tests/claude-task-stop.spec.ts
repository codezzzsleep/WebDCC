import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { ClaudeAdapter } from '../packages/adapters/claude/src/adapter.js';
import { claudeNativeActionCatalog, nativeValidationError, parseClaudeNativeAction } from '../packages/adapters/claude/src/native.js';
import { canStopClaudeTask, type AdapterEvent, type ClaudeTask } from '../packages/protocol/src/index.js';
import { createSourceTestApp } from './helpers.js';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';

it('keeps one Claude stop command while its receipt is unavailable, restores it after reload and confirms only its native task', async () => {
  const step = (name: string) => console.log('Claude stop source stage', JSON.stringify({ name, at: new Date().toISOString() }));
  step('building-current-source');
  const ctx = await createSourceTestApp();
  let browser: Browser | undefined;
  try {
    const first = await seedWorkspaceAndSession(ctx, 'claude-code');
    const other = await ctx.manager.createSession({ workspaceId: first.workspaceId, agent: 'claude-code' });
    const nativeId = ctx.store.getSession(first.sessionId)!.nativeId!;
    const tasks = new Map<string, ClaudeTask>(['a', 'b'].map(taskId => [taskId, { taskId, runId: '001', nativeSessionId: nativeId,
      description: `Task ${taskId}`, status: 'running', nativeStatus: 'running', background: true, backgroundPresence: 'present', native: {} }]));
    tasks.set('c', { taskId: 'c', nativeSessionId: nativeId, description: 'Snapshot-only task', status: 'unknown', background: true, backgroundPresence: 'present', native: {} });
    const calls: { sessionId: string; taskId: string; runId: string | null }[] = [];
    const producer = ctx.manager.adapter('claude-code') as unknown as { emit(sessionId: string, event: AdapterEvent): void };
    Object.assign(producer, {
      nativeState: (sessionId: string) => ({ revision: `controlled-query:${sessionId}`, nativeId: ctx.store.getSession(sessionId)!.nativeId,
        transport: 'live', tasks: sessionId === first.sessionId ? [...tasks.values()] : [], controls: { perTaskStopAffordance: true } }),
      nativeCatalog: () => ({ actions: claudeNativeActionCatalog([]).filter(action => action.type === 'stop-task').map(action => ({ ...action, supported: true })) }),
      executeNativeControl: (sessionId: string, value: unknown) => {
        const action = parseClaudeNativeAction(value);
        if (action.type !== 'stop-task') throw nativeValidationError('Unexpected controlled action');
        const task = tasks.get(action.taskId);
        if (sessionId !== first.sessionId || task === undefined || (task.runId ?? null) !== action.runId || !canStopClaudeTask(task)) throw nativeValidationError('Task/run changed');
        calls.push({ sessionId, taskId: action.taskId, runId: action.runId });
        return { id: action.taskId, runId: action.runId, submitted: true, confirmed: false };
      },
    });
    const replay = ClaudeAdapter.replay(first.sessionId);
    let sequence = 0;
    const feed = (frame: unknown) => {
      for (const event of replay.feed({ i: ++sequence, t: sequence, dir: 'in', ch: 'sdk', frame })) producer.emit(first.sessionId, event);
    };
    feed({ type: 'system', subtype: 'init', uuid: 'controlled-init', session_id: nativeId, model: 'controlled-model' });
    for (const task of [tasks.get('a')!, tasks.get('b')!]) feed({ type: 'system', subtype: 'task_started', uuid: task.taskId, session_id: nativeId,
      task_id: task.taskId, run_id: task.runId, description: task.description, is_backgrounded: true });
    feed({ type: 'system', subtype: 'background_tasks_changed', uuid: 'controlled-level', session_id: nativeId,
      tasks: [...tasks.values()].map(task => ({ task_id: task.taskId, run_id: task.runId, description: task.description, task_type: 'local_agent' })) });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing source listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    let hideReceipt = true;
    let commandId = '';
    await page.route(`**/api/sessions/${first.sessionId}/native/actions`, async route => {
      const request = route.request().postDataJSON() as { commandId: string };
      commandId = request.commandId;
      await route.fetch(); // The actual source server admits the control before the browser loses its reply.
      await route.abort('failed');
    });
    await page.route(`**/api/sessions/${first.sessionId}/native/actions/*`, async route => {
      if (hideReceipt) await route.abort('failed'); else await route.continue();
    });
    await page.goto(`${base}/s/${first.sessionId}`);
    step('source-ui-open');
    const panel = page.getByTestId('claude-tasks-panel');
    await panel.waitFor(); await panel.locator('summary').first().click();
    const row = (taskId: string) => panel.locator(`[data-task-id="${taskId}"]`);
    const stopA = row('a').getByRole('button', { name: '停止此任务' });
    await expect.poll(() => stopA.isEnabled()).toBe(true);
    await stopA.click();
    await expect.poll(() => calls.length).toBe(1);
    await expect.poll(() => row('a').getByRole('alert').count()).toBe(1);
    await expect.poll(() => stopA.isDisabled()).toBe(true);
    step('lost-reply-retains-command');
    expect(ctx.store.nativeActions.get(commandId, first.sessionId)).toMatchObject({ state: 'submitted', callReturnedAt: expect.any(String), reference: { id: 'a', runId: '001' } });
    expect(await row('b').getByRole('button', { name: '停止此任务' }).isEnabled()).toBe(true);
    await page.reload(); await panel.waitFor(); await panel.locator('summary').first().click();
    await expect.poll(() => stopA.isDisabled()).toBe(true);
    expect(calls).toEqual([{ sessionId: first.sessionId, taskId: 'a', runId: '001' }]);
    hideReceipt = false;
    await page.reload(); await panel.waitFor(); await panel.locator('summary').first().click();
    await expect.poll(() => row('a').getByTestId('claude-task-stop-receipt').textContent()).toContain('等待原生停止通知');
    expect(await row('a').getByTestId('claude-task-stop-receipt').textContent()).toContain('调用已返回');
    await page.locator(`a[href="/s/${other.id}"]`).click();
    await expect.poll(() => page.url()).toContain(`/s/${other.id}`);
    await page.locator(`a[href="/s/${first.sessionId}"]`).click();
    await expect.poll(() => panel.textContent()).toContain('等待原生停止通知');
    if (await panel.locator('details').first().getAttribute('open') === null) await panel.locator('summary').first().click();
    step('reload-and-session-switch-recovered');
    expect(calls).toHaveLength(1);
    tasks.get('a')!.status = 'stopped';
    feed({ type: 'system', subtype: 'task_notification', uuid: 'stopped-a', session_id: nativeId,
      task_id: 'a', run_id: '001', status: 'stopped', summary: 'Only A stopped', output_file: '/tmp/a-output' });
    await expect.poll(() => row('a').getByTestId('claude-task-stop-receipt').textContent()).toContain('原生停止已确认');
    expect(await row('b').locator('.claude-task-status').textContent()).toBe('运行中');
    expect(await row('b').getByRole('button', { name: '停止此任务' }).isEnabled()).toBe(true);
    step('native-stop-confirmed-peer-available');
    await page.unroute(`**/api/sessions/${first.sessionId}/native/actions`);
    const stopC = row('c').getByRole('button', { name: '停止此任务' });
    expect(await row('c').locator('.claude-task-status').textContent()).toBe('状态待确认');
    await stopC.click();
    await expect.poll(() => calls.length).toBe(2);
    step('snapshot-only-stop-used-explicit-null');
    expect(calls[1]).toEqual({ sessionId: first.sessionId, taskId: 'c', runId: null });
    expect(await row('c').locator('.claude-task-status').textContent()).toBe('状态待确认');
    expect(await row('b').getByRole('button', { name: '停止此任务' }).isEnabled()).toBe(true);
    console.log('Claude stop receipt source proof', JSON.stringify({ producer: 'controlled native capability/task handler; actual source HTTP/SQLite/WebSocket/Chromium',
      receiptUnavailable: true, reload: true, sessionSwitch: true, calls: calls.length, target: calls[0], callReturnAndTerminalSeparate: true,
      otherTaskStillAvailable: true, snapshotOnlyTaskUsesNativeNullRunAndKeepsUnknown: true, actualSDKStop: false, realProvider: false }));
  } finally { await browser?.close(); await ctx.close(); }
}, 60000);
