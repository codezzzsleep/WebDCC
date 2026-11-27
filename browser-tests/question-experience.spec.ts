import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { createSourceTestApp } from './helpers.js';

it.each([390, 1280])('keeps question drafts/multiline, guides the native group and shows actual submitted answers after reload at %spx', async width => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const workspace = ctx.store.createWorkspace('question UX', ctx.dataDir), session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    ctx.store.updateSession(session.id, { nativeId: 'native-question-ux' });
    const native = CodexAdapter.replay(session.id, 'native-question-ux'); let seq = 0;
    const feed = (frame: unknown) => native.feed({ i: ++seq, t: seq, dir: 'in', ch: 'rpc', frame });
    native.adapter.resume = async () => undefined; native.adapter.dispose = async () => undefined;
    native.adapter.send = async () => {
      feed({ method: 'turn/started', params: { threadId: 'native-question-ux', turn: { id: 'question-turn', status: 'inProgress', items: [] } } });
      feed({ id: 'native-group', method: 'item/tool/requestUserInput', params: { threadId: 'native-question-ux', turnId: 'question-turn', itemId: 'native-question-tool', questions: [
        { id: 'audience', header: '目标受众', question: '主要给谁看？', options: [{ label: '第一次使用的人', description: '逐步操作说明' }, { label: '已经熟悉的人', description: '快速参考' }] },
        { id: 'scope', header: '覆盖范围', question: '先覆盖什么？', isOther: true, options: [{ label: '上传文档' }, { label: '历史过程' }, { label: '回答提问' }] },
      ] } });
    };
    ctx.manager.registerAdapter(native.adapter); await ctx.manager.send(session.id, { text: '请先确认需求' }, 'actual-ask-command');
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const context = await browser.newContext({ viewport: { width, height: 844 } });
    await context.addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]); const page = await context.newPage();
    await page.goto(`${base}/s/${session.id}`); let cards = page.getByTestId('question-card'); await cards.and(page.locator('[data-sync="ready"]')).first().waitFor();
    expect(await page.getByTestId('question-pending-bar').innerText()).toContain('2 个问题待回答');
    await page.getByRole('button', { name: '去回答', exact: true }).click();
    await expect.poll(() => cards.first().evaluate(el => document.activeElement === el)).toBe(true);
    expect(await cards.first().innerText()).toContain('第 1 / 2 题');
    await cards.first().getByRole('radio').first().check(); const firstText = cards.first().getByRole('textbox', { name: '其他回答' });
    await firstText.fill('保留中文原文'); await firstText.press('Enter'); await firstText.pressSequentially('second line');
    const exactText = '保留中文原文\nsecond line'; expect(await firstText.inputValue()).toBe(exactText);
    await cards.nth(1).getByRole('radio').nth(2).check();
    await cards.nth(1).getByRole('textbox').fill('都要实际操作\n不要只报测试数量');
    await page.goto(`${base}/new?w=${workspace.id}`); await page.getByTestId('new-session-input').waitFor();
    await page.goto(`${base}/s/${session.id}`); cards = page.getByTestId('question-card'); await cards.first().waitFor();
    expect(await cards.first().getByRole('radio').first().isChecked()).toBe(true);
    expect(await cards.first().getByRole('textbox').inputValue()).toBe(exactText);
    expect(await cards.nth(1).getByRole('radio').nth(2).isChecked()).toBe(true);
    await page.reload(); await cards.and(page.locator('[data-sync="ready"]')).first().waitFor();
    expect(await cards.first().getByRole('textbox').inputValue()).toBe(exactText);
    await cards.first().getByRole('button', { name: '保存本题答案', exact: true }).click();
    await expect.poll(() => cards.first().getByRole('status').innerText()).toContain('已保存');
    expect(native.replies).toEqual([]);
    await expect.poll(() => cards.first().getByTestId('question-answer-preview').innerText()).toContain(exactText);
    expect(await page.getByTestId('question-pending-bar').innerText()).toContain('1 个问题待回答');
    // A fresh browser storage state must recover the accepted answer from the
    // authenticated server receipt, independent of a local editing draft.
    await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('wdcc.question-draft.v1:')) localStorage.removeItem(key); });
    const fresh = await context.newPage(); await fresh.goto(`${base}/s/${session.id}`); const restored = fresh.getByTestId('question-card');
    await expect.poll(() => restored.first().getByRole('textbox').inputValue()).toBe(exactText);
    expect(await restored.first().getByRole('radio').first().isChecked()).toBe(true);
    await restored.first().getByRole('button', { name: '回答下一题', exact: true }).click();
    await expect.poll(() => restored.nth(1).evaluate(el => document.activeElement === el)).toBe(true);
    await restored.nth(1).getByRole('radio').nth(2).check();
    await restored.nth(1).getByRole('textbox').fill('都要实际操作\n不要只报测试数量');
    await restored.nth(1).getByRole('button', { name: '提交本组回答', exact: true }).click();
    await expect.poll(() => native.replies.length).toBe(1);
    expect(JSON.stringify(native.replies)).toContain('second line');
    expect(JSON.stringify(native.replies)).toContain('不要只报测试数量');
    feed({ method: 'serverRequest/resolved', params: { threadId: 'native-question-ux', requestId: 'native-group' } });
    await expect.poll(() => restored.first().getAttribute('data-state')).toBe('resolved');
    await expect.poll(() => restored.first().getByTestId('question-answer-preview').innerText()).toContain(exactText);
    await fresh.reload(); await restored.first().waitFor();
    await expect.poll(() => restored.nth(1).getByTestId('question-answer-preview').innerText()).toContain('不要只报测试数量');
    expect(await fresh.getByTestId('question-pending-bar').count()).toBe(0);
    expect(await fresh.getByTestId('timeline').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(native.replies.length).toBe(1);
  } finally { await browser?.close(); await ctx.close(); }
}, 50_000);

it('does not persist a sensitive question draft or show it as a submitted answer', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const workspace = ctx.store.createWorkspace('sensitive', ctx.dataDir), session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    ctx.store.appendEvent({ sessionId: session.id, turnId: null, kind: 'question', itemKey: 'secret', data: { questionId: 'secret', prompt: '敏感回答', isSecret: true } });
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 }); browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]); await page.goto(`${base}/s/${session.id}`);
    const card = page.getByTestId('question-card'); await card.and(page.locator('[data-sync="ready"]')).waitFor();
    await card.locator('input[type=password]').fill('sensitive-not-for-storage');
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('sensitive-not-for-storage');
    await page.reload(); await card.waitFor(); expect(await card.locator('input[type=password]').inputValue()).toBe('');
    expect(await card.getByTestId('question-answer-preview').count()).toBe(0);
  } finally { await browser?.close(); await ctx.close(); }
});
