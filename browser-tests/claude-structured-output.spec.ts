import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterEach, expect, it, vi } from 'vitest';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createSourceTestApp, observeSessionSnapshots } from './helpers.js';

const mocked = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocked.query }));
import { ClaudeAdapter } from '../packages/adapters/claude/src/adapter.js';

function controlledSDK() {
  const queries: { options: Options; nativeId: string; closed: () => boolean; push: (value: unknown) => void }[] = [];
  mocked.query.mockImplementation(({ options }: { options: Options }) => {
    let ended = false; let wake: (() => void) | undefined;
    const nativeId = options.resume ?? randomUUID();
    const messages = [{ type: 'system', subtype: 'init', session_id: nativeId, model: 'claude-sonnet-5', tools: [],
      slash_commands: [], permissionMode: 'default', capabilities: [] }] as unknown as SDKMessage[];
    queries.push({ options, nativeId, closed: () => ended, push(value) { messages.push(value as SDKMessage); wake?.(); } });
    return {
      async *[Symbol.asyncIterator]() { while (!ended || messages.length > 0) {
        const message = messages.shift(); if (message !== undefined) yield message;
        else await new Promise<void>(resolve => { wake = resolve; });
      } },
      close() { ended = true; wake?.(); },
      initializationResult: async () => ({ claude_code_version: '2.1.322' }),
      supportedModels: async () => [{ value: 'claude-sonnet-5', displayName: 'Native model', description: 'Controlled catalog' }],
      supportedCommands: async () => [], supportedAgents: async () => [], accountInfo: async () => ({}), mcpServerStatus: async () => [],
    } as unknown as Query;
  });
  return { adapter: new ClaudeAdapter(),
    owned: () => queries.filter(query => query.options.onUserDialog !== undefined),
    active: () => queries.findLast(query => query.options.onUserDialog !== undefined && !query.closed())!,
  };
}

afterEach(() => mocked.query.mockReset());

async function send(page: Page, text: string): Promise<void> {
  const composer = page.locator('textarea').first();
  await composer.fill(text); await composer.press('Enter');
}

it('source schema/result/clear/plain flow restores exact outputs across refresh, reconnect, session switch and reopening', async () => {
  const ctx = await createSourceTestApp(); const sdk = controlledSDK(); ctx.manager.registerAdapter(sdk.adapter);
  let browser: Browser | undefined;
  const workspace = ctx.store.createWorkspace('Claude output', ctx.dataDir);
  const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'claude-code' });
  const other = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'claude-code' });
  const schema = { type: 'object', properties: { exact: { type: 'array', items: {} } }, required: ['exact'], additionalProperties: false };
  const value = { exact: ['中文', false, null, 0, { nested: 'retained' }] };
  try {
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    let generation = 0; page.on('websocket', () => { generation++; });
    const through = observeSessionSnapshots(page, session.id);
    await page.goto(`${base}/s/${session.id}`);
    await page.getByRole('button', { name: '原生控制', exact: true }).click();
    const panel = page.getByRole('region', { name: '原生控制', exact: true });
    await panel.getByRole('button', { name: '连接原生控制' }).click();
    await panel.getByLabel('原生操作').selectOption('output');
    await panel.getByLabel('schema', { exact: true }).fill(JSON.stringify(schema));
    await panel.getByRole('button', { name: '提交结构化输出 schema' }).click();
    await expect.poll(() => sdk.active().options.outputFormat).toEqual({ type: 'json_schema', schema });
    await expect.poll(() => panel.getByTestId('native-action-receipt').textContent()).toContain('原生调用已返回');
    await page.getByRole('button', { name: '原生控制', exact: true }).click();
    await send(page, 'Return the explicit structured result.');
    await expect.poll(() => ctx.manager.getRuntime(session.id)?.turnId).toEqual(expect.any(String));
    const nativeResultId = randomUUID();
    sdk.active().push({ type: 'result', subtype: 'success', session_id: sdk.active().nativeId, uuid: nativeResultId,
      result_index: 0, result: 'Ordinary answer remains independent.', is_error: false, structured_output: value });
    const card = page.getByTestId('claude-structured-output');
    await expect.poll(() => card.getByTestId('structured-output-value').textContent()).toBe(JSON.stringify(value, null, 2));
    expect(await card.getAttribute('data-native-result-id')).toBe(nativeResultId);
    expect(await card.getByRole('status').textContent()).toBe('结构化结果已完成');
    await expect.poll(() => ctx.manager.getRuntime(session.id)?.turnId).toBeNull();
    await page.getByRole('button', { name: '原生控制', exact: true }).click();
    await panel.getByLabel('原生操作').selectOption('output');
    await panel.getByLabel('schema', { exact: true }).fill('null');
    await panel.getByRole('button', { name: '提交结构化输出 schema' }).click();
    await expect.poll(() => sdk.active().options.outputFormat).toBeUndefined();
    await expect.poll(() => panel.getByTestId('native-action-receipt').textContent()).toContain('原生调用已返回');
    await page.getByRole('button', { name: '原生控制', exact: true }).click();
    await send(page, 'Now return ordinary text.');
    await expect.poll(() => ctx.manager.getRuntime(session.id)?.turnId).toEqual(expect.any(String));
    sdk.active().push({ type: 'result', subtype: 'success', session_id: sdk.active().nativeId, uuid: randomUUID(),
      result_index: 0, result: '{"plain":"still plain text"}', is_error: false });
    await expect.poll(() => ctx.manager.getRuntime(session.id)?.turnId).toBeNull();
    const owned = sdk.owned().length;
    const key = await card.getAttribute('data-item-key');
    const verify = async (target: Page): Promise<void> => {
      const output = target.getByTestId('claude-structured-output');
      await expect.poll(() => output.getByTestId('structured-output-value').textContent()).toBe(JSON.stringify(value, null, 2));
      expect(await output.count()).toBe(1); expect(await output.getAttribute('data-item-key')).toBe(key);
      await expect.poll(() => target.getByTestId('assistant-message').allTextContents()).toContain('{"plain":"still plain text"}');
    };
    await page.reload(); await expect.poll(() => through()).toBe(ctx.store.lastSeq(session.id)); await verify(page);
    const previous = generation; for (const socket of ctx.app.websocketServer.clients) socket.terminate();
    await expect.poll(() => generation).toBeGreaterThan(previous);
    await expect.poll(() => through()).toBe(ctx.store.lastSeq(session.id)); await verify(page);
    await page.locator(`a[href="/s/${other.id}"]`).click(); await expect.poll(() => page.url()).toContain(`/s/${other.id}`);
    await page.locator(`a[href="/s/${session.id}"]`).click(); await verify(page);
    const fresh = await page.context().newPage(); await fresh.goto(`${base}/s/${session.id}`); await verify(fresh);
    expect(sdk.owned().length).toBe(owned);
    const stored = ctx.store.allEvents(session.id).filter(event => event.kind === 'structured.output');
    expect(stored).toHaveLength(1); expect(stored[0]?.data).toMatchObject({ nativeResultId, value });
    console.log(JSON.stringify({ proof: 'Claude output source recovery', scope: 'controlled SDK, actual source UI/SQLite/HTTP/WebSocket/Chromium',
      schemaExact: true, ordinarySeparate: true, clearedSchema: true, refresh: true, reconnect: true, switch: true, reopen: true,
      outputIdentity: true, noDuplicateQuery: true, actualNative: false, providerRequests: 0 }));
  } finally { await browser?.close(); await ctx.close(); }
}, 60_000);

it('source displays the native schema failure and raw invalid text without interpreting HTML or claiming success', async () => {
  const ctx = await createSourceTestApp(); const sdk = controlledSDK(); ctx.manager.registerAdapter(sdk.adapter);
  let browser: Browser | undefined;
  try {
    const workspace = ctx.store.createWorkspace('Claude failed output', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'claude-code' });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${session.id}`); await send(page, 'Return a structured result.');
    await expect.poll(() => ctx.manager.getRuntime(session.id)?.turnId).toEqual(expect.any(String));
    const raw = '<img src=x onerror="window.structuredExecuted=true">{broken';
    sdk.active().push({ type: 'result', subtype: 'error_max_structured_output_retries', session_id: sdk.active().nativeId,
      uuid: randomUUID(), is_error: true, terminal_reason: 'structured_output_retry_exhausted', errors: ['native schema retry exhausted'], result: raw });
    const card = page.getByTestId('claude-structured-output');
    await expect.poll(() => card.getByRole('status').textContent()).toBe('结构化输出失败');
    expect(await card.getByRole('alert').textContent()).toBe('native schema retry exhausted');
    expect(await card.textContent()).toContain(raw); expect(await card.getByTestId('structured-output-value').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { structuredExecuted?: boolean }).structuredExecuted)).toBeUndefined();
    await page.reload(); await expect.poll(() => card.getByRole('status').textContent()).toBe('结构化输出失败');
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
