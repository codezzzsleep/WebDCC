import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { createSourceTestApp } from './helpers.js';

it('NP-06/14 a password field sends the exact value while IndexedDB stores a receipt; refresh cannot replay a redaction marker', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const workspace = ctx.store.createWorkspace('secret browser', ctx.dataDir);
    const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' }); ctx.store.updateSession(session.id, { nativeId: 'native' });
    const native = CodexAdapter.replay(session.id, 'native'); native.adapter.resume = async () => undefined; native.adapter.dispose = async () => undefined;
    native.adapter.send = async () => { native.feed({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { id: 'secret-request', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'password', question: 'Enter password', isSecret: true, isOther: false, options: null }] } } }); };
    let attempts = 0; const answer = native.adapter.answer.bind(native.adapter);
    native.adapter.answer = async (...args) => { attempts++; await gate; return answer(...args); };
    ctx.manager.registerAdapter(native.adapter); await ctx.manager.send(session.id, { text: 'ask' });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('missing listener');
    const base = `http://127.0.0.1:${address.port}`; browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]); await page.goto(`${base}/s/${session.id}`);
    const card = page.getByTestId('question-card'); const input = card.getByLabel('其他回答'); await input.waitFor();
    expect(await input.getAttribute('type')).toBe('password');
    const secret = 'private value with spaces 中文'; await input.fill(secret); await card.getByRole('button', { name: '提交' }).click();
    await expect.poll(() => attempts, { timeout: 5000 }).toBe(1);
    const cached = await page.evaluate(async () => {
      const request = indexedDB.open('webdcc'); const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try { const query = db.transaction('outbox').objectStore('outbox').getAll(); return await new Promise<unknown[]>((resolve, reject) => { query.onsuccess = () => resolve(query.result); query.onerror = () => reject(query.error); }); } finally { db.close(); }
    });
    expect(JSON.stringify(cached)).not.toContain(secret); expect(cached).toContainEqual(expect.objectContaining({ sensitive: true }));
    expect(await input.inputValue()).toBe('');
    await page.reload(); await card.waitFor(); expect(await input.inputValue()).toBe('');
    await expect.poll(() => card.getByRole('alert').textContent()).toContain('请重新输入'); expect(attempts).toBe(1);
    release(); await expect.poll(() => native.replies.length).toBe(1);
    expect(native.replies).toEqual([{ id: 'secret-request', result: { answers: { password: { answers: [secret] } } } }]);
    native.feed({ i: 2, t: 0, dir: 'in', ch: 'rpc', frame: { method: 'serverRequest/resolved', params: { threadId: 'native', requestId: 'secret-request' } } });
    await expect.poll(() => card.getAttribute('data-state')).toBe('resolved');
    expect(JSON.stringify(ctx.store.allEvents(session.id))).not.toContain(secret);
  } finally { release(); await browser?.close(); await ctx.close(); }
}, 30_000);
