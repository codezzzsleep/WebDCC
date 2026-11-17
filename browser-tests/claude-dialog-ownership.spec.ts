import { chromium, type Browser } from '@playwright/test';
import { afterEach, expect, it, vi } from 'vitest';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createSourceTestApp, observeSessionSnapshots } from './helpers.js';
const mock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mock.query }));
import { ClaudeAdapter } from '../packages/adapters/claude/src/adapter.js';
afterEach(() => mock.query.mockReset());

it('source unsupported dialog notice keeps the native call identity through reload/reconnect/switch without enabling a renderer or retrying it', async () => {
  const options: Options[] = []; const nativeId = 'native-dialog-browser';
  mock.query.mockImplementation((input: { options: Options }) => {
    options.push(input.options); let closed = false; let wake: (() => void) | undefined;
    const messages = [{ type: 'system', subtype: 'init', session_id: nativeId, model: 'current', permissionMode: 'default', slash_commands: [], capabilities: [] }] as unknown as SDKMessage[];
    return { async *[Symbol.asyncIterator]() { while (!closed || messages.length) {
      const message = messages.shift(); if (message !== undefined) yield message; else await new Promise<void>(resolve => { wake = resolve; });
    } }, close() { closed = true; wake?.(); }, initializationResult: async () => ({ claude_code_version: '2.1.322' }),
      supportedModels: async () => [], supportedCommands: async () => [], supportedAgents: async () => [], accountInfo: async () => ({}), mcpServerStatus: async () => [],
    } as unknown as Query;
  });
  const ctx = await createSourceTestApp(); const adapter = new ClaudeAdapter(); ctx.manager.registerAdapter(adapter);
  let browser: Browser | undefined;
  try {
    const workspace = ctx.store.createWorkspace('Claude dialog ownership', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'claude-code' });
    const requestId = 'native-unsupported-request'; const kind = 'fixture-undeclared-dialog';
    await expect(options[0]!.onUserDialog!({ dialogKind: kind, payload: { native: 'retained' }, toolUseID: 'native-tool' },
      { requestId, signal: new AbortController().signal })).rejects.toThrow('未声明');
    const stored = ctx.store.allEvents(session.id).find(event => event.kind === 'notice' && event.data.nativeType === 'request_user_dialog/unsupported')!;
    expect(stored.native).toMatchObject({ requestId, queryId: expect.any(String), payload: { dialogKind: kind, toolUseID: 'native-tool' } });
    const other = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'dsh', title: 'Other fixture session' });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`; browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(8_000);
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    let generation = 0; page.on('websocket', () => { generation++; }); const through = observeSessionSnapshots(page, session.id);
    const verify = async () => {
      if (!await page.getByRole('region', { name: '原生控制', exact: true }).isVisible()) await page.getByRole('button', { name: '原生控制', exact: true }).click();
      await expect.poll(() => page.getByText(`${kind} 未在此客户端声明`, { exact: false }).count()).toBe(1);
      expect(await page.getByText('已取消', { exact: true }).count()).toBe(0);
    };
    await page.goto(`${base}/s/${session.id}`); await verify();
    await expect.poll(() => page.locator('option[value="dialog"]').isDisabled()).toBe(true);
    await page.reload(); await verify();
    const previous = generation; for (const socket of ctx.app.websocketServer.clients) socket.terminate();
    await expect.poll(() => generation).toBeGreaterThan(previous); await expect.poll(() => through()).toBe(ctx.store.lastSeq(session.id)); await verify();
    await page.getByRole('button', { name: '原生控制', exact: true }).click();
    await page.locator(`a[href="/s/${other.id}"]`).click(); await expect.poll(() => page.url()).toContain(other.id);
    await page.locator(`a[href="/s/${session.id}"]`).click(); await verify();
    expect(ctx.store.allEvents(session.id).filter(event => event.kind === 'notice' && event.data.nativeType === 'request_user_dialog/unsupported')).toHaveLength(1);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
