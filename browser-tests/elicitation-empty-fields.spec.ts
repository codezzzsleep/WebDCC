import { chromium, type Browser } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { elicitationResponse } from '../packages/adapters/codex/src/elicitation.js';
import type { McpServerElicitationRequestParams } from '../packages/adapters/codex/src/schema/v2/McpServerElicitationRequestParams.js';
import { createSourceTestApp } from './helpers.js';

it.each([0, 1, 2])('preserves native optional string values including enum option index %s and explicit empty text', async index => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const workspace = ctx.store.createWorkspace('native form', ctx.dataDir);
    const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    ctx.store.updateSession(session.id, { nativeId: 'native' });
    const form: McpServerElicitationRequestParams = { threadId: 'native', turnId: null, serverName: 'fixture', mode: 'openai/form', _meta: null, message: 'Native optional strings', requestedSchema: {
      type: 'object', additionalProperties: false, properties: {
        choice: { type: 'string', title: '枚举选择', enum: ['', 'blue'], enumNames: ['空字符串', 'Blue'] },
        emptyText: { type: 'string', title: '明确清空的文本' },
        untouched: { type: 'string', title: '未填写的文本' },
        optionalNumber: { type: 'number', title: '未填写的数字' },
      },
    } };
    const content = { ...(index === 0 ? {} : { choice: index === 1 ? '' : 'blue' }), emptyText: '' };
    expect(elicitationResponse(form, { action: 'accept', content })).toEqual({ action: 'accept', content, _meta: null });
    const native = CodexAdapter.replay(session.id, 'native');
    native.adapter.resume = async () => undefined; native.adapter.dispose = async () => undefined;
    native.adapter.send = async () => { native.feed({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { id: 'optional-strings', method: 'mcpServer/elicitation/request', params: form } }); };
    ctx.manager.registerAdapter(native.adapter); await ctx.manager.send(session.id, { text: 'ask' });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    let webCommand: { command?: { clientCommandId: string }; clientCommandId?: string } | undefined;
    let transport: string | undefined;
    page.on('request', request => { if (request.url().endsWith('/api/commands') && request.method() === 'POST') { webCommand = request.postDataJSON() as typeof webCommand; transport = 'HTTP'; } });
    page.on('websocket', socket => socket.on('framesent', frame => {
      const message = JSON.parse(String(frame.payload)) as { op?: string; command?: { clientCommandId: string } };
      if (message.op === 'command') { webCommand = message; transport = 'WebSocket'; }
    }));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${session.id}`);
    const card = page.getByTestId('question-card');
    if (index === 0) await card.getByLabel('枚举选择').selectOption({ index: 2 });
    await card.getByLabel('枚举选择').selectOption({ index });
    expect(await card.getByLabel('枚举选择').locator('option').nth(1).textContent()).toBe('空字符串');
    await card.getByLabel('明确清空的文本').fill('temporary');
    await card.getByLabel('明确清空的文本').fill('');
    await card.getByLabel('未填写的数字').fill('7');
    await card.getByLabel('未填写的数字').fill('');
    await card.getByRole('button', { name: '确认提交' }).click();
    await expect.poll(() => native.replies.length).toBe(1);
    expect(native.replies).toEqual([{ id: 'optional-strings', result: { action: 'accept', content, _meta: null } }]);
    native.feed({ i: 2, t: 0, dir: 'in', ch: 'rpc', frame: { method: 'serverRequest/resolved', params: { threadId: 'native', requestId: 'optional-strings' } } });
    await expect.poll(() => card.getAttribute('data-state')).toBe('resolved');
    await page.reload(); await expect.poll(() => card.getAttribute('data-state')).toBe('resolved');
    expect(native.replies).toHaveLength(1);
    const commandId = webCommand?.command?.clientCommandId ?? webCommand?.clientCommandId;
    expect(commandId).toBeTypeOf('string');
    expect(ctx.store.journal.get(commandId!)).toMatchObject({ state: 'completed' });
    const evidence = process.env['WDCC_UI_EVIDENCE_DIR'];
    if (evidence !== undefined) {
      await mkdir(evidence, { recursive: true, mode: 0o700 });
      await writeFile(join(evidence, `case-${index}.json`), JSON.stringify({ scope: 'controlled native protocol replay + actual source Chromium/HTTP/WebSocket/SQLite, no official Agent/provider', request: { id: 'optional-strings', method: 'mcpServer/elicitation/request', params: form }, transport, webCommand, nativeReplies: native.replies,
        receipt: ctx.store.journal.get(commandId!), afterReload: await card.getAttribute('data-state') }, null, 2), { mode: 0o600 });
    }
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
