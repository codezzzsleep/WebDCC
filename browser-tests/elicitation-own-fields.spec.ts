import { chromium, type Browser } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { Command } from '@webdcc/protocol';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { createSourceTestApp } from './helpers.js';

it.each([false, true])('native optional constructor starts empty and submits only own fields (filled=%s)', async filled => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const workspace = ctx.store.createWorkspace('native own fields', ctx.dataDir);
    const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' }); ctx.store.updateSession(session.id, { nativeId: 'native' });
    const params = { threadId: 'native', turnId: null, serverName: 'fixture', mode: 'openai/form', _meta: null, message: 'Native field names', requestedSchema: {
      type: 'object', additionalProperties: false, properties: { constructor: { type: 'string', title: '原生 constructor 字段' } },
    } };
    const native = CodexAdapter.replay(session.id, 'native');
    native.adapter.resume = async () => undefined; native.adapter.dispose = async () => undefined;
    native.adapter.send = async () => { native.feed({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { id: 'own-properties', method: 'mcpServer/elicitation/request', params } }); };
    ctx.manager.registerAdapter(native.adapter); await ctx.manager.send(session.id, { text: 'ask' });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    let command: Command | undefined;
    page.on('websocket', socket => socket.on('framesent', frame => { const message = JSON.parse(String(frame.payload)) as { op?: string; command?: Command }; if (message.op === 'command') command = message.command; }));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${session.id}`);
    const card = page.getByTestId('question-card'); const input = card.getByLabel('原生 constructor 字段'); await input.waitFor();
    const actualInitial = await input.inputValue();
    const evidence = process.env['WDCC_UI_EVIDENCE_DIR'];
    if (evidence !== undefined) { await mkdir(evidence, { recursive: true, mode: 0o700 }); await writeFile(join(evidence, `initial-field-${filled}.json`), JSON.stringify({ scope: 'actual source Chromium + controlled codec; official Native/provider0', actualInitial, params }, null, 2), { mode: 0o600 }); }
    expect(actualInitial).toBe('');
    const content = filled ? { constructor: '  原文用户输入  ' } : {};
    if (filled) await input.fill(content.constructor!);
    await card.getByRole('button', { name: '确认提交' }).click();
    await expect.poll(() => native.replies).toEqual([{ id: 'own-properties', result: { action: 'accept', content, _meta: null } }]);
    native.feed({ i: 2, t: 0, dir: 'in', ch: 'rpc', frame: { method: 'serverRequest/resolved', params: { threadId: 'native', requestId: 'own-properties' } } });
    await expect.poll(() => card.getAttribute('data-state')).toBe('resolved');
    await page.reload(); await expect.poll(() => card.getAttribute('data-state')).toBe('resolved');
    expect(command).toBeDefined();
    expect(ctx.store.journal.get(command!.clientCommandId)).toMatchObject({ state: 'completed' });
    if (evidence !== undefined) await writeFile(join(evidence, `complete-${filled}.json`), JSON.stringify({ scope: 'actual source Chrome/WS/SQLite+controlled native codec; actualNative/provider0', params, actualInitial, command, reply: native.replies, receipt: ctx.store.journal.get(command!.clientCommandId), afterReload: await card.getAttribute('data-state') }, null, 2), { mode: 0o600 });
  } finally { await browser?.close(); await ctx.close(); }
});
