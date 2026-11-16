import { chromium, type Browser } from '@playwright/test';
import { afterEach, expect, it, vi } from 'vitest';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { createSourceTestApp } from './helpers.js';

const mock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mock.query }));
import { ClaudeAdapter } from '../packages/adapters/claude/src/adapter.js';

afterEach(() => mock.query.mockReset());

it('source thinking control preserves an optional budget, rejects invalid input and restores the current mapping without claiming a model effect', async () => {
  const queries: Options[] = [];
  mock.query.mockImplementation(({ options }: { options: Options }) => {
    queries.push(options); let ended = false; let wake: (() => void) | undefined;
    return {
      [Symbol.asyncIterator]() { return { async next() {
        if (!ended) await new Promise<void>(resolve => { wake = resolve; });
        return { done: true as const, value: undefined };
      } }; },
      close() { ended = true; wake?.(); },
      initializationResult: async () => ({ claude_code_version: '2.1.322' }),
      supportedModels: async () => [{ value: 'current', displayName: 'Native model', description: 'Controlled SDK catalog', supportsAdaptiveThinking: true }],
      supportedCommands: async () => [], supportedAgents: async () => [], accountInfo: async () => ({}), mcpServerStatus: async () => [],
    } as unknown as Query;
  });
  const ctx = await createSourceTestApp(); ctx.manager.registerAdapter(new ClaudeAdapter());
  let browser: Browser | undefined;
  try {
    const workspace = ctx.store.createWorkspace('Claude thinking', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'claude-code', model: 'current' });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(8_000);
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${session.id}`);
    await page.getByRole('button', { name: '原生控制', exact: true }).click();
    const panel = page.getByRole('region', { name: '原生控制', exact: true });
    await expect.poll(() => panel.getByLabel('原生操作').count()).toBe(1);
    await panel.getByLabel('原生操作').selectOption('thinking');
    await expect.poll(() => panel.textContent()).toContain('enabled 不填写 budgetTokens 时使用自适应思考');
    await panel.getByLabel('thinking', { exact: true }).fill('{"type":"enabled","display":"omitted"}');
    await panel.getByRole('button', { name: '提交更改会话 thinking' }).click();
    await expect.poll(() => queries.findLast(options => options.onUserDialog !== undefined)?.thinking).toEqual({ type: 'enabled', display: 'omitted' });
    await expect.poll(() => panel.getByTestId('native-action-receipt').textContent()).toContain('原生调用已返回');
    await expect.poll(() => panel.textContent()).toContain('"modelEffect": "not-observed"');
    const count = queries.length;
    await panel.getByLabel('thinking', { exact: true }).fill('{"type":"enabled","budgetTokens":512}');
    await panel.getByRole('button', { name: '提交更改会话 thinking' }).click();
    await expect.poll(() => panel.getByRole('alert').textContent()).toContain('1024');
    expect(queries).toHaveLength(count);
    await page.reload(); await page.getByRole('button', { name: '原生控制', exact: true }).click();
    await expect.poll(() => panel.textContent()).toContain('"sdkMode": "adaptive"');
    await expect.poll(() => panel.textContent()).toContain('"display": "omitted"');
    expect(queries).toHaveLength(count);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
