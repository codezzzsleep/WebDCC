import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterEach, expect, it, vi } from 'vitest';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createSourceTestApp, observeSessionSnapshots } from './helpers.js';
import { sourceFingerprint } from '../scripts/lib/gate-report.js';

const mock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mock.query }));
import { ClaudeAdapter } from '../packages/adapters/claude/src/adapter.js';

function controlledSDK() {
  const queries: { options: Options; nativeId: string; closed: () => boolean; push: (message: unknown) => void }[] = [];
  mock.query.mockImplementation(({ options }: { options: Options }) => {
    let ended = false; let wake: (() => void) | undefined; const nativeId = options.resume ?? randomUUID();
    const messages = [{ type: 'system', subtype: 'init', session_id: nativeId, model: options.model,
      permissionMode: options.permissionMode ?? 'default', slash_commands: [], capabilities: [] }] as unknown as SDKMessage[];
    queries.push({ options, nativeId, closed: () => ended, push(message) { messages.push(message as SDKMessage); wake?.(); } });
    return {
      async *[Symbol.asyncIterator]() { while (!ended || messages.length > 0) {
        const message = messages.shift(); if (message !== undefined) yield message;
        else await new Promise<void>(resolve => { wake = resolve; });
      } }, close() { ended = true; wake?.(); }, initializationResult: async () => ({ claude_code_version: '2.1.322' }),
      supportedModels: async () => [{ value: 'current', displayName: 'Native model', description: 'Controlled SDK catalog', supportsAdaptiveThinking: true }],
      supportedCommands: async () => [], supportedAgents: async () => [], accountInfo: async () => ({}), mcpServerStatus: async () => [],
    } as unknown as Query;
  });
  return { queries, owned: () => queries.filter(query => query.options.onElicitation !== undefined),
    active: (nativeId: string) => queries.findLast(query => query.nativeId === nativeId && !query.closed())!,
    adapter() {
      const adapter = new ClaudeAdapter();
      vi.spyOn(adapter.nativeHistory, 'info').mockRejectedValue(new Error('controlled native transcript unavailable'));
      return adapter;
    } };
}
afterEach(() => mock.query.mockReset());

it('source UI restores accepted configuration and output after dispatcher reopen, then reads through reload/reconnect/switch/reopening without duplicate queries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-claude-configuration-browser-')); const dbPath = join(directory, 'state.sqlite');
  const cwd = join(directory, 'workspace'); await mkdir(cwd);
  const sdk = controlledSDK(); let ctx: Awaited<ReturnType<typeof createSourceTestApp>> | undefined;
  let browser: Browser | undefined; const screenshots: Record<string, string> = {};
  const evidence = process.env['WDCC_CLAUDE_CONFIGURATION_EVIDENCE'];
  const screenshot = async (page: Page, name: string): Promise<void> => {
    if (evidence === undefined) return;
    await mkdir(evidence, { recursive: true }); const path = join(evidence, `${name}.png`);
    await page.screenshot({ path, fullPage: true }); screenshots[name] = createHash('sha256').update(await readFile(path)).digest('hex');
  };
  try {
    ctx = await createSourceTestApp({ dbPath }); ctx.manager.registerAdapter(sdk.adapter());
    const workspace = ctx.store.createWorkspace('Claude configuration recovery', cwd);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'claude-code', model: 'current', accessMode: 'plan' });
    const other = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'claude-code', model: 'current' });
    await expect.poll(() => ctx!.store.getSession(session.id)?.nativeId).toEqual(expect.any(String));
    const nativeId = ctx.store.getSession(session.id)!.nativeId!;
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    const page = await context.newPage(); page.setDefaultTimeout(8_000); let generation = 0;
    page.on('websocket', () => { generation++; }); const through = observeSessionSnapshots(page, session.id);
    await page.goto(`${base}/s/${session.id}`); await page.getByRole('button', { name: '原生控制', exact: true }).click();
    const panel = page.getByRole('region', { name: '原生控制', exact: true });
    const thinking = { type: 'enabled', display: 'omitted' }; const schema = { type: 'object', properties: { value: { type: 'array' } }, required: ['value'] };
    for (const step of [{ type: 'thinking', field: 'thinking', value: thinking, submit: '提交更改会话 thinking' },
      { type: 'output', field: 'schema', value: schema, submit: '提交结构化输出 schema' }]) {
      await panel.getByLabel('原生操作').selectOption(step.type);
      await panel.getByLabel(step.field, { exact: true }).fill(JSON.stringify(step.value));
      await panel.getByRole('button', { name: step.submit }).click();
      await expect.poll(() => panel.getByTestId('native-action-receipt').textContent()).toContain(step.type);
    }
    await panel.getByLabel('原生操作').selectOption('checkpoints');
    await panel.getByLabel('enabled（必填）').check(); await panel.getByRole('button', { name: '提交原生文件检查点' }).click();
    await expect.poll(() => panel.getByTestId('native-action-receipt').textContent()).toContain('checkpoints');
    await expect.poll(() => sdk.active(nativeId).options.enableFileCheckpointing).toBe(true);
    const options = { thinking, outputFormat: { type: 'json_schema', schema }, enableFileCheckpointing: true };
    const verifyConfiguration = async (target: Page, restored: boolean): Promise<void> => {
      const card = target.getByTestId('claude-configuration');
      await expect.poll(() => card.getByTestId('claude-configuration-options').textContent()).toBe(JSON.stringify(options, null, 2));
      if (!await card.evaluate(element => (element as HTMLDetailsElement).open)) await card.locator('summary').click();
      await expect.poll(() => card.getByRole('status').textContent()).toContain(restored ? '已恢复会话配置' : '当前原生连接未确认');
    };
    await page.getByRole('button', { name: '原生控制', exact: true }).click();
    await ctx.manager.send(session.id, { text: 'Controlled source output for recovery.' });
    const value = { value: [false, null, 0, '中文'] }; const nativeResultId = randomUUID();
    sdk.active(nativeId).push({ type: 'result', subtype: 'success', uuid: nativeResultId, session_id: nativeId,
      result_index: 0, is_error: false, result: 'Ordinary output remains independent.', structured_output: value });
    const verifyOutput = async (target: Page): Promise<void> => {
      const card = target.getByTestId('claude-structured-output');
      await expect.poll(() => card.getByTestId('structured-output-value').textContent()).toBe(JSON.stringify(value, null, 2));
      expect(await card.count()).toBe(1); expect(await card.getAttribute('data-native-result-id')).toBe(nativeResultId);
    };
    await verifyOutput(page); await expect.poll(() => ctx!.manager.getRuntime(session.id)?.turnId).toBeNull();
    const count = sdk.owned().length; await ctx.close(); ctx = undefined;
    ctx = await createSourceTestApp({ dbPath }); ctx.manager.registerAdapter(sdk.adapter());
    await ctx.app.listen({ host: '127.0.0.1', port: address.port });
    await page.reload(); await expect.poll(() => through()).toBe(ctx!.store.lastSeq(session.id)); await verifyOutput(page);
    await page.getByRole('button', { name: '原生控制', exact: true }).click(); await verifyConfiguration(page, false);
    expect(ctx.manager.getRuntime(session.id)).toBeUndefined(); expect(sdk.owned()).toHaveLength(count);
    await screenshot(page, 'last-accepted-before-connect');
    await panel.getByRole('button', { name: '连接原生控制' }).click(); await verifyConfiguration(page, true);
    expect(sdk.owned()).toHaveLength(count + 1); expect(sdk.active(nativeId).options.thinking).toEqual(thinking);
    expect(sdk.active(nativeId).options.outputFormat).toEqual(options.outputFormat);
    expect(sdk.active(nativeId).options.enableFileCheckpointing).toBe(true);
    expect(sdk.active(nativeId).options.permissionMode).toBe('plan'); await verifyOutput(page);
    await screenshot(page, 'restored-current-configuration');
    await page.reload(); await page.getByRole('button', { name: '原生控制', exact: true }).click(); await verifyConfiguration(page, true);
    const beforeGeneration = generation; for (const socket of ctx.app.websocketServer.clients) socket.terminate();
    await expect.poll(() => generation).toBeGreaterThan(beforeGeneration);
    await expect.poll(() => through()).toBe(ctx!.store.lastSeq(session.id)); await verifyOutput(page); await verifyConfiguration(page, true);
    await page.getByRole('button', { name: '原生控制', exact: true }).click();
    await page.locator(`a[href="/s/${other.id}"]`).click(); await expect.poll(() => page.url()).toContain(`/s/${other.id}`);
    await page.locator(`a[href="/s/${session.id}"]`).click(); await verifyOutput(page);
    const fresh = await context.newPage(); await fresh.goto(`${base}/s/${session.id}`); await verifyOutput(fresh);
    await fresh.getByRole('button', { name: '原生控制', exact: true }).click(); await verifyConfiguration(fresh, true);
    expect(sdk.owned()).toHaveLength(count + 1);
    const report = { proof: 'Claude configuration source UI recovery', sourceFingerprint: sourceFingerprint(), scope: 'controlled SDK, actual production HTTP/SQLite/WebSocket/Chromium',
      dispatcherReopen: true, readonlyBeforeConnect: true, exactRestoredOptions: true, explicitSingleQueryReconnect: true,
      reload: true, newSocketGeneration: true, switch: true, newTab: true, nativeResultId, outputIdentityRetained: true,
      ownedSessionQueries: sdk.owned().length, transientCatalogQueries: sdk.queries.length - sdk.owned().length,
      actualSDKOrCLIRuns: 0, providerRequests: 0, modelRequests: 0, screenshots };
    if (evidence !== undefined) await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } finally { await browser?.close(); await ctx?.close(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);
