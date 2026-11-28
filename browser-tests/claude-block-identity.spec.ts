import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterEach, expect, it, vi } from 'vitest';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createSourceTestApp, observeSessionSnapshots } from './helpers.js';

const mocked = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocked.query }));
import { ClaudeAdapter } from '../packages/adapters/claude/src/adapter.js';

function controlledSDK() {
  const queries: { nativeId: string; options: Options; closed: () => boolean; push: (value: unknown) => void }[] = [];
  mocked.query.mockImplementation(({ options }: { options: Options }) => {
    let ended = false, wake: (() => void) | undefined;
    const nativeId = options.resume ?? randomUUID();
    const messages = [{ type: 'system', subtype: 'init', session_id: nativeId, uuid: randomUUID(), model: 'claude-sonnet-5',
      permissionMode: 'default', tools: [], slash_commands: [], capabilities: [] }] as unknown as SDKMessage[];
    queries.push({ nativeId, options, closed: () => ended, push(value) { messages.push(value as SDKMessage); wake?.(); } });
    return { async *[Symbol.asyncIterator]() { while (!ended || messages.length > 0) {
      const message = messages.shift(); if (message !== undefined) yield message; else await new Promise<void>(resolve => { wake = resolve; });
    } }, close() { ended = true; wake?.(); }, initializationResult: async () => ({ claude_code_version: '2.1.322' }),
    supportedModels: async () => [{ value: 'claude-sonnet-5', displayName: 'Native model', description: 'Controlled catalog' }],
    supportedCommands: async () => [], supportedAgents: async () => [], accountInfo: async () => ({}), mcpServerStatus: async () => [],
    } as unknown as Query;
  });
  return { adapter: new ClaudeAdapter(), forNative: (nativeId: string | undefined) => queries.findLast(query => query.options.onUserDialog !== undefined && query.nativeId === nativeId && !query.closed()),
    owned: () => queries.filter(query => query.options.onUserDialog !== undefined) };
}
afterEach(() => mocked.query.mockReset());

it('source main/child block order and equal-tool-ID results recover through refresh, reconnect, switch and reopening', async () => {
  const evidenceRoot = process.env['WEBDCC_CLAUDE_BLOCK_EVIDENCE'] ?? join(process.cwd(), '.artifacts', 'browser-tests');
  await mkdir(evidenceRoot, { recursive: true });
  const evidence = await mkdtemp(join(evidenceRoot, 'claude-blocks-'));
  const ctx = await createSourceTestApp(); const sdk = controlledSDK(); ctx.manager.registerAdapter(sdk.adapter);
  let browser: Browser | undefined; let page: Page | undefined;
  try {
    const workspace = ctx.store.createWorkspace('Claude blocks', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'claude-code' });
    const other = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'claude-code' });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }); page = await context.newPage();
    await context.addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    const through = observeSessionSnapshots(page, session.id); let generation = 0;
    page.on('websocket', () => { generation++; });
    await page.goto(`${base}/s/${session.id}`);
    const composer = page.locator('textarea').first(); await composer.fill('Preserve each native block.'); await composer.press('Enter');
    await expect.poll(() => ctx.manager.getRuntime(session.id)?.turnId).toEqual(expect.any(String));
    await expect.poll(() => sdk.forNative(ctx.store.getSession(session.id)?.nativeId)?.nativeId).toEqual(expect.any(String));
    const query = sdk.forNative(ctx.store.getSession(session.id)?.nativeId)!;
    const nativeId = query.nativeId;
    const assistant = (parent: string | null, id: string, content: unknown[]) => ({ type: 'assistant', uuid: randomUUID(), session_id: nativeId,
      parent_tool_use_id: parent, message: { id, stop_reason: null, content } });
    const tool = (path: string) => ({ type: 'tool_use', id: 'same-tool', name: 'Read', input: { file_path: path } });
    query.push({ type: 'system', subtype: 'task_started', session_id: nativeId, uuid: randomUUID(), task_id: 'child', run_id: '001',
      tool_use_id: 'spawn', description: 'Native child', task_type: 'local_agent', is_backgrounded: true });
    query.push(assistant(null, 'main-message', [{ type: 'text', text: 'MAIN BEFORE' }, tool('/main.txt'), { type: 'text', text: 'MAIN AFTER' }]));
    query.push(assistant('spawn', 'child-message', [{ type: 'text', text: 'CHILD BEFORE' }, tool('/child.txt'), { type: 'text', text: 'CHILD AFTER' }]));
    const task = page.locator('[data-task-id="child"]'); const panel = page.getByTestId('claude-tasks-panel');
    await panel.waitFor(); await panel.locator('summary').first().click();
    await expect.poll(() => task.getByTestId('claude-task-output').locator('pre').allTextContents()).toContain('CHILD BEFORE');
    const result = (parent: string | null, output: string) => ({ type: 'user', uuid: randomUUID(), session_id: nativeId, parent_tool_use_id: parent,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'same-tool', content: output }] } });
    query.push(result(null, 'MAIN RESULT'));
    await expect.poll(() => ctx.store.allEvents(session.id).filter(event => event.kind === 'file.read' && (event.data as { path?: string }).path === '/main.txt').length).toBe(1);
    expect(await task.textContent()).not.toContain('MAIN RESULT');
    query.push(result('spawn', 'CHILD RESULT'));
    const childExpected = ['CHILD BEFORE', '读取 /child.txt\nCHILD RESULT', 'CHILD AFTER'];
    await expect.poll(() => task.getByTestId('claude-task-output').locator('pre').allTextContents()).toEqual(childExpected);
    await expect.poll(() => page!.locator('.turn-body > .event-target > .step-row').allTextContents()).toEqual(['MAIN BEFORE', expect.stringContaining('/main.txt'), 'MAIN AFTER']);
    query.push({ type: 'result', subtype: 'success', session_id: nativeId, uuid: randomUUID(), is_error: false, result: 'MAIN FINAL' });
    await expect.poll(() => ctx.manager.getRuntime(session.id)?.turnId).toBeNull();
    const owned = sdk.owned().length;
    const keys = ctx.store.allEvents(session.id).filter(event => (event.data as { claudeActor?: unknown }).claudeActor !== undefined
      && ['assistant.message', 'file.read'].includes(event.kind)).map(event => event.itemKey).sort();
    expect(new Set(keys).size).toBe(3);
    const verify = async (target: Page): Promise<void> => {
      const taskPanel = target.getByTestId('claude-tasks-panel'); await taskPanel.waitFor();
      if (await taskPanel.locator('details').first().getAttribute('open') === null) await taskPanel.locator('summary').first().click();
      await expect.poll(() => target.locator('[data-task-id="child"]').getByTestId('claude-task-output').locator('pre').allTextContents()).toEqual(childExpected);
      expect(await taskPanel.textContent()).not.toContain('MAIN RESULT');
      const title = target.locator('.turn-title[aria-expanded]');
      if (await title.getAttribute('aria-expanded') === 'true') await title.click();
      expect(await target.getByTestId('assistant-message').allTextContents()).toEqual(['MAIN FINAL']);
      await target.locator('.turn-summary').click();
      await expect.poll(() => target.locator('.turn-body > .event-target > .step-row').allTextContents()).toEqual(['MAIN BEFORE', expect.stringContaining('/main.txt'), 'MAIN AFTER', 'MAIN FINAL']);
    };
    await page.reload(); await expect.poll(() => through()).toBe(ctx.store.lastSeq(session.id)); await verify(page);
    const previous = generation; for (const socket of ctx.app.websocketServer.clients) socket.terminate();
    await expect.poll(() => generation).toBeGreaterThan(previous); await expect.poll(() => through()).toBe(ctx.store.lastSeq(session.id)); await verify(page);
    await page.locator(`a[href="/s/${other.id}"]`).click(); await expect.poll(() => page.url()).toContain(`/s/${other.id}`);
    await page.locator(`a[href="/s/${session.id}"]`).click(); await verify(page);
    const fresh = await context.newPage(); await fresh.goto(`${base}/s/${session.id}`); await verify(fresh);
    expect(sdk.owned().length).toBe(owned);
    expect(ctx.store.allEvents(session.id).filter(event => keys.includes(event.itemKey)).map(event => event.itemKey).sort()).toEqual(keys);
    await page.screenshot({ path: join(evidence, 'recovered.png'), fullPage: true });
    await writeFile(join(evidence, 'report.json'), JSON.stringify({ scope: 'Controlled SDK through actual source adapter/HTTP/Manager/SQLite/WS/Chromium',
      keys, mainChildSeparate: true, mainOrder: true, childOrder: true, refresh: true, reconnect: true, sessionSwitch: true, reopen: true,
      ownedQueries: owned, nativeRequests: 0, modelRequests: 0, providerRequests: 0 }, null, 2) + '\n');
    console.log(JSON.stringify({ evidence, status: 'passed', nativeRequests: 0, providerRequests: 0 }));
  } catch (error) {
    if (page !== undefined) { await page.screenshot({ path: join(evidence, 'failed.png'), fullPage: true }).catch(() => {});
      await writeFile(join(evidence, 'failed.txt'), await page.locator('body').innerText().catch(() => 'Page unavailable')); }
    await writeFile(join(evidence, 'failure.json'), JSON.stringify({ status: 'failed', error: String(error), nativeRequests: 0, modelRequests: 0, providerRequests: 0 }) + '\n');
    throw error;
  } finally { await browser?.close(); await ctx.close(); }
}, 60_000);
