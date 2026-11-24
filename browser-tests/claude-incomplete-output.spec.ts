import { chromium, type Browser, type Page } from '@playwright/test';
import { expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdapterEvent } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { ClaudeAdapter } from '../packages/adapters/claude/src/adapter.js';
import { createSourceTestApp, observeSessionSnapshots } from './helpers.js';

it('interrupted main/child content and unexecuted tool input retain partial labels through refresh, reconnect and reopening', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined; let page: Page | undefined;
  const evidence = process.env['WEBDCC_AUDIT_BROWSER_EVIDENCE']; let sends = 0;
  const adapter = new FakeAdapter({ id: 'claude-code' }); let callback!: (id: string, event: AdapterEvent) => void;
  adapter.onEvent = cb => { callback = cb; };
  adapter.send = async id => {
    sends++;
    const nativeId = ctx.store.getSession(id)!.nativeId!;
    callback(id, { type: 'turn.start', nativeTurnId: 'native-turn' });
    const replay = ClaudeAdapter.replay(id, { queryId: 'controlled-original-query', generation: 1 });
    const native = (uuid: string, parent: string | null, content: unknown[]) => ({ type: 'assistant', uuid, session_id: nativeId, parent_tool_use_id: parent,
      aborted: true, message: { id: uuid, content, stop_reason: null } });
    const frames = [
      { type: 'system', subtype: 'task_started', uuid: 'task-start', session_id: nativeId, task_id: 'child', run_id: '001', tool_use_id: 'spawn', description: 'Native child', task_type: 'local_agent', is_backgrounded: true },
      native('main', null, [{ type: 'text', text: '主回复原文未完成' }]),
      native('child-thinking', 'spawn', [{ type: 'thinking', thinking: '子思考原文未完成', signature: 'opaque-original' }]),
      native('truncated-tool', null, [{ type: 'tool_use', id: 'tool-original', name: 'Bash', input: {} }]),
    ];
    for (const [index, frame] of frames.entries()) for (const event of replay.feed({ i: index + 1, t: index, dir: 'in', ch: 'sdk', frame })) callback(id, event);
    callback(id, { type: 'turn.end', nativeTurnId: 'native-turn', status: 'interrupted' });
  };
  ctx.manager.registerAdapter(adapter);
  try {
    const w = ctx.store.createWorkspace('Claude partial', ctx.dataDir); const session = await ctx.manager.createSession({ workspaceId: w.id, agent: 'claude-code' });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener'); const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]); page = await context.newPage();
    const through = observeSessionSnapshots(page, session.id); let connections = 0; page.on('websocket', () => { connections++; });
    await page.goto(`${base}/s/${session.id}`); const composer = page.locator('textarea').first(); await composer.fill('controlled input'); await composer.press('Enter');
    await expect.poll(() => ctx.store.allEvents(session.id).some(event => event.kind === 'turn.completed')).toBe(true);
    const verify = async (target: Page) => {
      await expect.poll(() => target.getByTestId('assistant-message').getAttribute('data-raw-text')).toBe('主回复原文未完成');
      await expect.poll(() => target.getByTestId('claude-incomplete-output').allTextContents()).toContain('原生输出未完成');
      const summary = target.locator('.turn-summary'); if (await summary.count() > 0) await summary.click();
      await expect.poll(() => target.getByTestId('claude-incomplete-tool').textContent()).toContain('执行状态待核对');
      const panel = target.getByTestId('claude-tasks-panel'); await panel.waitFor();
      if (await panel.locator('details').first().getAttribute('open') === null) await panel.locator('summary').first().click();
      await expect.poll(() => target.locator('[data-task-id="child"]').textContent()).toContain('子思考原文未完成');
      expect(await target.locator('[data-task-id="child"]').textContent()).toContain('未完成');
      expect(await target.locator('.turn-body .spin, .turn-body .shimmer').count()).toBe(0);
    };
    await verify(page); const keys = ctx.store.allEvents(session.id).map(event => event.itemKey);
    await page.reload(); await expect.poll(() => through()).toBe(ctx.store.lastSeq(session.id)); await verify(page);
    const previous = connections; for (const socket of ctx.app.websocketServer.clients) socket.terminate();
    await expect.poll(() => connections).toBeGreaterThan(previous); await expect.poll(() => through()).toBe(ctx.store.lastSeq(session.id)); await verify(page);
    const reopened = await context.newPage(); await reopened.goto(`${base}/s/${session.id}`); await verify(reopened);
    expect(sends).toBe(1); expect(ctx.store.allEvents(session.id).map(event => event.itemKey)).toEqual(keys);
    expect(ctx.store.allEvents(session.id).some(event => event.kind === 'command')).toBe(false);
    if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, 'claude-incomplete-recovered.png'), fullPage: true });
      await writeFile(join(evidence, 'claude-incomplete.json'), JSON.stringify({ status: 'passed', scope: 'Controlled SDK envelopes through production Claude reducer + Manager/HTTP/SQLite/WS/Chromium; no official CLI/model/Provider execution', refresh: true, reconnect: true, reopen: true, sends, modelRequests: 0, keys }) + '\n'); }
  } catch (error) {
    if (evidence && page) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, 'claude-incomplete-failed.png'), fullPage: true }); await writeFile(join(evidence, 'claude-incomplete-failed.txt'), await page.locator('body').innerText()); }
    throw error;
  } finally { await browser?.close(); await ctx.close(); }
}, 60_000);
