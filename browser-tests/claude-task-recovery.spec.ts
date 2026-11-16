import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { captureProcess, processState } from '../packages/server/src/process-identity.js';
import { createSourceTestApp, observeSessionSnapshots } from './helpers.js';

it('source UI preserves task/output identities and unknown lifecycle after its writer is actually killed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-claude-task-restart-ui-'));
  const child = fork(join(process.cwd(), 'packages/server/test/fixtures/claude-task-owner-crash.ts'), ['--writer', directory],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let browser: Browser | undefined;
  let ctx: Awaited<ReturnType<typeof createSourceTestApp>> | undefined;
  try {
    const [message] = await once(child, 'message'); const { sessionId, workspaceId } = message as { sessionId: string; workspaceId: string };
    const identity = captureProcess(child.pid!); expect(identity).toBeDefined(); expect(processState(identity!)).toBe('running');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    ctx = await createSourceTestApp({ dbPath: join(directory, 'task.sqlite') });
    const other = await ctx.manager.createSession({ workspaceId, agent: 'claude-code' });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const listener = ctx.app.server.address(); if (!listener || typeof listener === 'string') throw new Error('Missing source recovery listener');
    const base = `http://127.0.0.1:${listener.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    const throughSeq = observeSessionSnapshots(page, sessionId);
    let socketGeneration = 0;
    page.on('websocket', () => { socketGeneration++; });
    await page.goto(`${base}/s/${sessionId}`);
    const panel = page.getByTestId('claude-tasks-panel'); await panel.waitFor(); await panel.locator('summary').first().click();
    const row = (id: string) => panel.locator(`[data-task-id="${id}"]`);
    for (const id of ['background', 'paused', 'pending', 'snapshot-only']) {
      await expect.poll(() => row(id).locator('.claude-task-status').textContent()).toBe('状态待确认');
    }
    expect(await row('background').textContent()).toContain('Retained child output');
    expect(await row('background').getAttribute('data-run-id')).toBe('001');
    expect(await row('completed').textContent()).toContain('retained completed result');
    expect(await row('failed').locator('.claude-task-status').textContent()).toBe('失败');
    expect(await row('stopped').locator('.claude-task-status').textContent()).toBe('已停止');
    await page.reload(); await panel.waitFor(); await panel.locator('summary').first().click();
    await expect.poll(() => throughSeq()).toBe(ctx!.store.lastSeq(sessionId));
    expect(await row('background').locator('.claude-task-status').textContent()).toBe('状态待确认');
    const previousSocket = socketGeneration;
    for (const client of ctx.app.websocketServer.clients) client.terminate();
    await expect.poll(() => socketGeneration).toBeGreaterThan(previousSocket);
    await expect.poll(() => throughSeq()).toBe(ctx!.store.lastSeq(sessionId));
    expect(await row('background').textContent()).toContain('Retained child output');
    await page.locator(`a[href="/s/${other.id}"]`).click();
    await expect.poll(() => page.url()).toContain(`/s/${other.id}`);
    await page.locator(`a[href="/s/${sessionId}"]`).click();
    await expect.poll(() => panel.textContent()).toContain('Retained child output');
    expect(await row('background').locator('.claude-task-status').textContent()).toBe('状态待确认');
    console.log('Claude task service recovery source proof', JSON.stringify({ scope: 'controlled SDK envelopes, actual own writer SIGKILL/SQLite/HTTP/WebSocket/Chromium',
      unknownRetained: true, originalRunAndChildOutput: true, terminalRetained: true, reload: true, websocketReconnect: true, sessionSwitch: true,
      actualNativeSDK: false, realProvider: false }));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await browser?.close(); await ctx?.close(); await rm(directory, { recursive: true, force: true });
  }
}, 60000);
