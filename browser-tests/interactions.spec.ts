import { chromium } from '@playwright/test';
import { expect, it } from 'vitest';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { createSourceTestApp } from './helpers.js';

it('NP-06 a real browser keeps question input and pending state through submission failure, then resolves from server events', async () => {
  const ctx = await createSourceTestApp();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const workspace = ctx.store.createWorkspace('question browser', ctx.dataDir);
    const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    ctx.store.updateSession(session.id, { nativeId: 'native' });
    const native = CodexAdapter.replay(session.id);
    native.adapter.resume = async () => undefined;
    native.adapter.send = async () => { native.feed({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { id: 'native-request', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'one', question: '你的答案' }] } } }); };
    native.adapter.dispose = async () => undefined;
    const answer = native.adapter.answer.bind(native.adapter);
    let attempted = 0;
    let rejectReply!: (error: Error) => void;
    const delayed = new Promise<void>((_resolve, reject) => { rejectReply = reject; });
    native.adapter.answer = async (...args) => { attempted++; if (attempted === 1) await delayed; return answer(...args); };
    ctx.manager.registerAdapter(native.adapter);
    await ctx.manager.send(session.id, { text: 'ask' }, 'BROWSER-ASK');
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('Missing test listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const socketFrames: string[] = [];
    page.on('console', message => { if (message.type() === 'error') socketFrames.push(`console:${message.text()}`); });
    page.on('websocket', socket => {
      socket.on('framesent', frame => { const value = JSON.parse(String(frame.payload)) as { op?: string }; socketFrames.push(`out:${value.op}`); });
      socket.on('framereceived', frame => { const value = JSON.parse(String(frame.payload)) as { op?: string }; socketFrames.push(`in:${value.op}`); });
      socket.on('close', () => socketFrames.push('closed'));
    });
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${session.id}`);
    const card = page.getByTestId('question-card');
    await card.waitFor();
    const input = card.getByRole('textbox', { name: '其他回答' });
    const text = '  原样保留的答案  ';
    await input.fill(text);
    const button = card.getByRole('button');
    await button.click();
    try { await expect.poll(() => attempted, { timeout: 5000 }).toBe(1); }
    catch (error) { throw new Error(`${String(error)}; card=${await card.textContent()}; sockets=${socketFrames.join(',')}`, { cause: error }); }
    expect(await card.getAttribute('data-state')).toBe('pending');
    expect(await button.isDisabled()).toBe(true);
    expect(await card.textContent()).not.toContain('已回答');
    rejectReply(Object.assign(new Error('答案未提交，重试'), { statusCode: 400 }));
    await card.getByRole('alert').waitFor();
    expect(await input.inputValue()).toBe(text);
    expect(await button.isEnabled()).toBe(true);
    await button.click();
    await expect.poll(() => card.getAttribute('data-state')).toBe('resolved');
    expect(native.replies).toEqual([{ id: 'native-request', result: { answers: { one: { answers: [text] } } } }]);
    await page.reload();
    await expect.poll(() => page.getByTestId('question-card').getAttribute('data-state')).toBe('resolved');
    expect(await page.getByTestId('question-card').getByRole('button').count()).toBe(0);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);

it('NP-06 two browser contexts cannot submit the same native question twice', async () => {
  const ctx = await createSourceTestApp();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const workspace = ctx.store.createWorkspace('two browsers', ctx.dataDir);
    const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    ctx.store.updateSession(session.id, { nativeId: 'native' });
    const native = CodexAdapter.replay(session.id);
    native.adapter.resume = async () => undefined;
    native.adapter.send = async () => { native.feed({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { id: 'native-request', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'one', question: '你的答案' }] } } }); };
    native.adapter.dispose = async () => undefined;
    const answer = native.adapter.answer.bind(native.adapter);
    let attempts = 0;
    native.adapter.answer = async (...args) => { attempts++; await gate; return answer(...args); };
    ctx.manager.registerAdapter(native.adapter);
    await ctx.manager.send(session.id, { text: 'ask' }, 'ASK-TWO');
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const pages = await Promise.all([browser.newPage(), browser.newPage()]);
    for (const page of pages) {
      await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
      await page.goto(`${base}/s/${session.id}`);
      await page.getByTestId('question-card').waitFor();
    }
    const first = pages[0]!.getByTestId('question-card'); const second = pages[1]!.getByTestId('question-card');
    await first.getByRole('textbox', { name: '其他回答' }).fill('first answer');
    await first.getByRole('button').click();
    await expect.poll(() => attempts).toBe(1);
    await second.getByRole('textbox', { name: '其他回答' }).fill('competing answer');
    await second.getByRole('button').click();
    await expect.poll(() => second.getByRole('alert').textContent()).toContain('另一个客户端');
    expect(attempts).toBe(1);
    release();
    await expect.poll(() => first.getAttribute('data-state')).toBe('resolved');
    await expect.poll(() => second.getAttribute('data-state')).toBe('resolved');
    expect(native.replies).toEqual([{ id: 'native-request', result: { answers: { one: { answers: ['first answer'] } } } }]);
  } finally { release(); await browser?.close(); await ctx.close(); }
}, 30_000);
