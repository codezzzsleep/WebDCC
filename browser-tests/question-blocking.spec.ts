import { chromium } from '@playwright/test';
import { expect, it } from 'vitest';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { createSourceTestApp } from './helpers.js';

it('Issue41 native nonblocking declaration, observed waiting, answer and reload reach the actual question UI', async () => {
  const ctx = await createSourceTestApp(); let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const workspace = ctx.store.createWorkspace('native blocking browser', ctx.dataDir); const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' }); ctx.store.updateSession(session.id, { nativeId: 'native' });
    const native = CodexAdapter.replay(session.id, 'native'); let sequence = 0;
    const feed = (frame: unknown) => native.feed({ i: ++sequence, t: sequence, dir: 'in', ch: 'rpc', frame });
    native.adapter.resume = async () => undefined; native.adapter.dispose = async () => undefined;
    native.adapter.send = async () => { feed({ method: 'turn/started', params: { threadId: 'native', turn: { id: 'native-turn', status: 'inProgress', items: [] } } }); feed({ id: 'nonblocking-native', method: 'item/tool/requestUserInput', params: { threadId: 'native', turnId: 'native-turn', itemId: 'question-tool', isBlocking: false, autoResolutionMs: 1, questions: [{ id: 'q', question: '非阻塞原生问题' }] } }); };
    ctx.manager.registerAdapter(native.adapter); await ctx.manager.send(session.id, { text: 'ask' }, 'NATIVE-BLOCKING-BROWSER');
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address(); if (address === null || typeof address === 'string') throw new Error('Missing listener'); const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]); await page.goto(`${base}/s/${session.id}`);
    const card = page.getByTestId('question-card'); await card.waitFor(); expect(await card.getAttribute('data-blocking')).toBe('false'); expect(await card.textContent()).toContain('原生标记为非阻塞'); expect(await card.textContent()).not.toContain('继续执行'); expect(await page.getByTestId('turn-waiting').count()).toBe(0);
    feed({ method: 'thread/status/changed', params: { threadId: 'native', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } } }); await page.getByTestId('turn-waiting').waitFor();
    await card.getByRole('textbox', { name: '其他回答' }).fill(' 原样答案 '); await card.getByRole('button', { name: '提交' }).click(); await expect.poll(() => native.replies.length).toBe(1); expect(native.replies).toEqual([{ id: 'nonblocking-native', result: { answers: { q: { answers: [' 原样答案 '] } } } }]);
    expect(await page.getByTestId('turn-waiting').count()).toBe(1); await page.reload(); await card.waitFor(); expect(await card.getAttribute('data-blocking')).toBe('false'); expect(await card.getByRole('button').isDisabled()).toBe(true); expect(await page.getByTestId('turn-waiting').count()).toBe(1);
    feed({ method: 'serverRequest/resolved', params: { threadId: 'native', requestId: 'nonblocking-native' } }); await expect.poll(() => card.getAttribute('data-state')).toBe('resolved'); expect(await card.getAttribute('data-blocking')).toBe('false'); expect(await page.getByTestId('turn-waiting').count()).toBe(1);
    feed({ method: 'thread/status/changed', params: { threadId: 'native', status: { type: 'active', activeFlags: [] } } }); await expect.poll(() => page.getByTestId('turn-waiting').count()).toBe(0); await page.reload(); await card.waitFor(); expect(await card.getAttribute('data-blocking')).toBe('false'); expect(await page.getByTestId('turn-waiting').count()).toBe(0);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
