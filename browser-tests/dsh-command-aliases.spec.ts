import { chromium, type Browser } from '@playwright/test';
import type { AgentAdapter } from '@webdcc/protocol';
import { expect, it } from 'vitest';
import { createSourceTestApp } from './helpers.js';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';
import { dshCommandAliases } from '../packages/adapters/dsh/src/commands.js';
import preview from '../packages/adapters/dsh/src/slash-catalog.json' with { type: 'json' };

const pairs = [
  ['goal', '目标', '  原始目标正文'], ['plan', '计划', '\t off'], ['feedback', '反馈', '   原始反馈\r\nsecond'],
  ['compact', '压缩', ''], ['permission', '权限', '  workspace-write'], ['export', '导出', ''],
] as const;

it('the actual Composer discovers Chinese aliases and forwards both spellings unchanged to the declared command control', async () => {
  const ctx = await createSourceTestApp();
  let browser: Browser | undefined;
  try {
    const commands = dshCommandAliases(preview.commands);
    const adapter: AgentAdapter = ctx.manager.adapter('dsh');
    adapter.slashCommands = async () => commands;
    const received: string[] = [];
    adapter.executeSlashControl = async (_id, line) => {
      received.push(line);
      const result = { commandId: `controlled-${received.length}`, result: { kind: 'success', text: 'Controlled native command receipt' } };
      return { text: result.result.text, result, failed: false };
    };
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    if (!address || typeof address === 'string') throw new Error('missing command listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${sessionId}`);
    const input = page.getByTestId('composer-input');
    for (const [english, chinese, argument] of pairs) {
      await input.fill(`/${chinese[0]}`);
      const item = page.getByTestId('slash-menu').getByRole('button').filter({ hasText: `/${english}` });
      await item.waitFor(); await item.click();
      expect(await input.inputValue()).toBe(`/${chinese}`);
      for (const spelling of [chinese, english]) {
        const line = `/${spelling}${argument}`;
        await input.fill(line);
        const editor = await input.inputValue();
        const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/sessions/${sessionId}/slash-commands`)
          .then(response => ({ response, failure: undefined }), failure => ({ response: undefined, failure }));
        await page.getByTestId('send-button').click();
        const observed = await responsePromise;
        if (observed.failure) throw observed.failure;
        const response = observed.response!;
        console.info('controlled alias submission', JSON.stringify({ intended: line, editor, request: response.request().postDataJSON(), status: response.status(), result: await response.json() }));
        await expect.poll(() => received.at(-1)).toBe(editor);
        await expect.poll(() => input.inputValue()).toBe('');
      }
    }
    expect(received).toHaveLength(12);
    await page.reload();
    await input.fill('/目');
    await page.getByTestId('slash-menu').getByRole('button').filter({ hasText: '/goal' }).waitFor();
  } finally { await browser?.close(); await ctx.close(); }
}, 60000);
