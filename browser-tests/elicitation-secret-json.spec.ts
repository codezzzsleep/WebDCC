import { chromium, type Browser } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type { EventData } from '@webdcc/protocol';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { createSourceTestApp } from './helpers.js';

it.each([
  { variant: 'root', action: 'accept' }, { variant: 'nested', action: 'accept' }, { variant: 'plain', action: 'accept' },
  { variant: 'root', action: 'decline' }, { variant: 'root', action: 'cancel' },
] as const)('JSON fallback respects $variant/$action Native schema secrecy while preserving original content', async ({ variant, action }) => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const workspace = ctx.store.createWorkspace('native secret JSON', ctx.dataDir);
    const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' }); ctx.store.updateSession(session.id, { nativeId: 'native' });
    const schema = variant === 'root' ? { type: 'object', writeOnly: true, additionalProperties: true }
      : variant === 'nested' ? { type: 'object', allOf: [{ type: 'object', properties: { pin: { type: 'string', format: 'password' } }, required: ['pin'] }] }
      : { type: 'object', additionalProperties: true };
    const params = { threadId: 'native', turnId: null, serverName: 'fixture', mode: 'openai/form', _meta: null, message: 'Secret JSON request', requestedSchema: schema };
    const native = CodexAdapter.replay(session.id, 'native');
    native.adapter.resume = async () => undefined; native.adapter.dispose = async () => undefined;
    native.adapter.send = async () => { native.feed({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { id: 'secret-json', method: 'mcpServer/elicitation/request', params } }); };
    let calls = 0; const answer = native.adapter.answer.bind(native.adapter);
    native.adapter.answer = async (...args) => { calls++; await gate; return answer(...args); };
    ctx.manager.registerAdapter(native.adapter); await ctx.manager.send(session.id, { text: 'ask' });
    const question = ctx.store.allEvents(session.id).find(event => event.kind === 'question')!.data as EventData['question'];
    const sensitive = variant !== 'plain';
    expect(question.isSecret).toBe(sensitive);
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]); await page.goto(`${base}/s/${session.id}`);
    const card = page.getByTestId('question-card'); const input = card.getByLabel('表单内容'); await input.waitFor();
    const inputType = await input.getAttribute('type');
    const secret = 'synthetic secret JSON value 中文'; const content = { pin: secret };
    await input.fill(action === 'accept' ? JSON.stringify(content) : `{invalid-sensitive:${secret}}`);
    await card.getByRole('button', { name: action === 'accept' ? '确认提交' : action === 'decline' ? '拒绝' : '取消', exact: true }).click();
    await expect.poll(() => calls).toBe(1);
    const retained = await input.inputValue();
    const evidence = process.env['WDCC_UI_EVIDENCE_DIR'];
    if (evidence !== undefined) { await mkdir(evidence, { recursive: true, mode: 0o700 }); await writeFile(join(evidence, `secret-${variant}-${action}.json`), JSON.stringify({ scope: 'actualSourceChrome/WS/SQLite+controlledcodec; noofficialNative/provider', questionSecret: question.isSecret, inputType, retainedContainsSyntheticSecret: retained.includes(secret), variant, action, schema }, null, 2), { mode: 0o600 }); }
    expect(inputType).toBe(sensitive ? 'password' : null); expect(retained).toBe(sensitive ? '' : JSON.stringify(content));
    let cachedSensitive: boolean | undefined;
    if (sensitive) {
      const cached = await page.evaluate(async () => {
        const opening = indexedDB.open('webdcc'); const db = await new Promise<IDBDatabase>((resolve, reject) => { opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); });
        try { const request = db.transaction('outbox').objectStore('outbox').getAll(); return await new Promise<unknown[]>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); } finally { db.close(); }
      });
      expect(JSON.stringify(cached)).not.toContain(secret);
      cachedSensitive = cached.some(row => (row as { sensitive?: boolean }).sensitive === true);
      expect(cachedSensitive).toBe(true);
      await page.reload(); await input.waitFor(); expect(await input.inputValue()).toBe(''); expect(calls).toBe(1);
    }
    release();
    const responseContent = action === 'accept' ? content : null;
    await expect.poll(() => native.replies).toEqual([{ id: 'secret-json', result: { action, content: responseContent, _meta: null } }]);
    native.feed({ i: 2, t: 0, dir: 'in', ch: 'rpc', frame: { method: 'serverRequest/resolved', params: { threadId: 'native', requestId: 'secret-json' } } });
    await expect.poll(() => card.getAttribute('data-state')).toBe('resolved'); await page.reload(); await expect.poll(() => card.getAttribute('data-state')).toBe('resolved');
    if (sensitive) expect(JSON.stringify(ctx.store.allEvents(session.id))).not.toContain(secret);
    if (evidence !== undefined) await writeFile(join(evidence, `complete-${variant}-${action}.json`), JSON.stringify({ scope: 'sourceChrome/WS/SQLite + controlledcodec; officialNative/provider0', schema, inputType, retainedContainsSyntheticSecret: retained.includes(secret), cachedSensitive,
      nativeResponseId: 'secret-json', responseAction: action, originalContentSha256: createHash('sha256').update(JSON.stringify(responseContent)).digest('hex'), nativeReplyCount: native.replies.length, afterReload: await card.getAttribute('data-state'), nativeAnswerCalls: calls }, null, 2), { mode: 0o600 });
  } finally { release(); await browser?.close(); await ctx.close(); }
});
