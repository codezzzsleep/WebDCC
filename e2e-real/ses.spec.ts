/**
 * SPEC-M8 7.7 / 7.10：会话管理（SES）、@ 与交接（HO）、斜杠命令（SL）。
 */
import type { Page } from '@playwright/test';
import { expect, run, test } from './fixtures.js';
import { newSession, waitTurnDone } from './helpers.js';

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('send-button').click();
}

async function renameSession(page: Page, title: string): Promise<void> {
  await page.getByTestId('session-title').click();
  const input = page.getByTestId('session-header').locator('input');
  await input.fill(title);
  await input.press('Enter');
  await expect.poll(async () => page.getByTestId('session-header').innerText(), { timeout: 15_000 }).toContain(title);
}

test.describe('7.10 会话管理', () => {
  test('SES-01 标题规则：原生标题不覆盖用户改的名字', async ({ app }) => {
    await app.login();
    await app.planFor('dsh', 'echo-context');
    const sessionId = await newSession(app.page, 'dsh', '标题规则的会话');
    await waitTurnDone(app.page);
    // 一开始标题取第一行
    await expect.poll(async () => app.page.getByTestId('session-header').innerText()).toContain('标题规则的会话');
    await renameSession(app.page, '我改的名字');
    // 再跑一轮，DSH 会发 session/title
    await app.planFor('dsh', 'echo-context');
    await sendMessage(app.page, '再跑一轮看看标题');
    await waitTurnDone(app.page);
    await expect.poll(async () => app.page.getByTestId('session-header').innerText()).toContain('我改的名字');
    const detail = (await app.page.evaluate(async (id: string) => (await fetch(`/api/sessions/${id}`, { credentials: 'same-origin' })).json(), sessionId)) as {
      title: string;
    };
    expect(detail.title).toBe('我改的名字');
  });

  test('SES-02 置顶与归档刷新后保持', async ({ app }) => {
    await app.login();
    await app.planFor('dsh', 'echo-context');
    const first = await newSession(app.page, 'dsh', '置顶我');
    await waitTurnDone(app.page);
    await app.page.goto(`${run.baseURL}/new`);
    await app.planFor('dsh', 'echo-context');
    const second = await newSession(app.page, 'dsh', '归档我');
    await waitTurnDone(app.page);
    // 归档第二个
    await app.page.goto(`${run.baseURL}/s/${second}`);
    await app.page.getByTestId('session-more').click();
    await app.page.getByRole('menuitem', { name: '归档' }).click();
    await expect.poll(async () => app.page.getByTestId('archived-section').count(), { timeout: 20_000 }).toBe(1);
    // 置顶第一个
    await app.page.goto(`${run.baseURL}/s/${first}`);
    await app.page.getByTestId('session-more').click();
    await app.page.getByRole('menuitem', { name: '置顶' }).click();
    await expect(app.page.getByTestId('session-row').filter({ hasText: '置顶我' }).getByLabel('置顶')).toBeVisible();
    await app.page.reload();
    await expect.poll(async () => app.page.getByTestId('archived-section').count(), { timeout: 20_000 }).toBe(1);
    const rows = await app.page.getByTestId('session-row').allInnerTexts();
    expect(rows[0] ?? '').toContain('置顶我');
  });

  test('SES-03 导出 JSONL 行数等于事件数', async ({ app }) => {
    await app.login();
    await app.planFor('dsh', 'full');
    const sessionId = await newSession(app.page, 'dsh', '导出测试');
    await waitTurnDone(app.page);
    const events = (await app.page.evaluate(async (id: string) => (await fetch(`/api/sessions/${id}/events?limit=500`, { credentials: 'same-origin' })).json(), sessionId)) as {
      events: unknown[];
    };
    const text = await app.page.evaluate(async (id: string) => (await fetch(`/api/sessions/${id}/export`, { credentials: 'same-origin' })).text(), sessionId);
    const lines = text.trim().split('\n').filter((line) => line !== '');
    expect(lines.length).toBe(events.events.length);
    for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
  });

  test('SES-04 轨迹里能看到 internal/unknown 并且搜索过滤生效', async ({ app }) => {
    await app.login();
    await app.planFor('dsh', 'full');
    await newSession(app.page, 'dsh', '轨迹测试');
    await waitTurnDone(app.page);
    await app.page.getByTestId('tab-trajectory').click();
    await expect.poll(async () => app.page.getByTestId('trajectory').innerText()).toContain('internal');
    const all = await app.page.getByTestId('trajectory-row').count();
    await app.page.getByTestId('trajectory-search').fill('user.message');
    await expect.poll(async () => app.page.getByTestId('trajectory-row').count()).toBeLessThan(all);
    expect(await app.page.getByTestId('trajectory-row').count()).toBeGreaterThan(0);
  });
});

test.describe('7.7 @ 与交接、斜杠命令', () => {
  test('HO-01 输入 @ 选择 README.md', async ({ app }) => {
    await app.login();
    await app.planFor('dsh', 'echo-context');
    await newSession(app.page, 'dsh', '@ 菜单测试');
    await waitTurnDone(app.page);
    await app.page.getByTestId('composer-input').fill('@READ');
    const menu = app.page.getByTestId('at-menu');
    await expect(menu).toBeVisible();
    await expect.poll(async () => menu.innerText()).toContain('README.md');
    await menu.getByText('README.md').first().click();
    await expect.poll(async () => app.page.getByTestId('composer-input').inputValue()).toContain('README.md');
  });

  test('HO-02 输入 @ 选择同一工作区里的另一个会话', async ({ app }) => {
    await app.login();
    await app.planFor('dsh', 'echo-context');
    const other = await newSession(app.page, 'dsh', '另一个会话');
    await waitTurnDone(app.page);
    await app.page.goto(`${run.baseURL}/new`);
    await app.planFor('dsh', 'echo-context');
    await newSession(app.page, 'dsh', '当前会话');
    await waitTurnDone(app.page);
    await app.page.getByTestId('composer-input').fill('@');
    const menu = app.page.getByTestId('at-menu');
    await expect(menu).toBeVisible();
    await expect.poll(async () => menu.innerText()).toContain('另一个会话');
    await menu.getByText('另一个会话').first().click();
    await expect.poll(async () => app.page.getByTestId('composer-input').inputValue()).not.toBe('@');
    void other;
  });

  test('HO-03 带到…把最终回答放进另一个会话的输入框', async ({ app }) => {
    await app.login();
    await app.planFor('claude', 'full');
    const source = await newSession(app.page, 'claude', '给点内容');
    await waitTurnDone(app.page);
    await app.page.goto(`${run.baseURL}/new`);
    await app.planFor('claude', 'echo-context');
    const target = await newSession(app.page, 'claude', '接收方');
    await waitTurnDone(app.page);
    // 回到源会话，点"带到…"
    await app.page.goto(`${run.baseURL}/s/${source}`);
    const finalText = await app.page.getByTestId('timeline').locator('.step-row.assistant').last().innerText();
    await app.mockClaude.reset();
    await app.page.getByRole('button', { name: '带到…' }).last().click();
    const dialog = app.page.getByTestId('handoff-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByText('接收方').first().click();
    await expect.poll(async () => app.page.url(), { timeout: 20_000 }).toContain(target);
    const draft = await app.page.getByTestId('composer-input').inputValue();
    expect(draft.trim()).toBe(finalText.trim());
    // 发送之前 mock 没有收到任何新请求
    expect((await app.mockClaude.requests()).length).toBe(0);
  });

  test('SL-01 Claude 的斜杠命令菜单来自 init 消息', async ({ app }) => {
    await app.login();
    await app.planFor('claude', 'echo-context');
    await newSession(app.page, 'claude', '斜杠命令');
    await waitTurnDone(app.page);
    const commands = (await app.page.evaluate(async (id: string) => (await fetch(`/api/sessions/${id}/slash-commands`, { credentials: 'same-origin' })).json(), (await /\/s\/([0-9A-Z]+)/.exec(app.page.url()))?.[1] ?? '')) as {
      commands: { name: string }[];
    };
    expect(commands.commands.length).toBeGreaterThan(0);
    await app.page.getByTestId('composer-input').fill('/');
    const menu = app.page.getByTestId('slash-menu');
    await expect(menu).toBeVisible();
    await expect.poll(async () => menu.innerText()).toContain(commands.commands[0]?.name ?? '');
    await menu.getByRole('button').first().click();
    await expect.poll(async () => app.page.getByTestId('composer-input').inputValue()).toContain('/');
  });

  test('SL-02 DSH 的 /permission 走 commands/execute，不发给模型', async ({ app }) => {
    await app.login();
    await app.planFor('dsh', 'echo-context');
    await newSession(app.page, 'dsh', '斜杠权限');
    await waitTurnDone(app.page);
    await app.mockDsh.reset();
    await sendMessage(app.page, '/permission read-only');
    await expect.poll(async () => app.page.getByTestId('access-mode').innerText(), { timeout: 60_000 }).toContain('仅可查看');
    const requests = await app.mockDsh.requests();
    expect(requests.length).toBe(0);
  });

  test('SL-03 Codex 不弹斜杠菜单，文字原样发送', async ({ app }) => {
    await app.login();
    await app.planFor('codex', 'echo-context');
    await newSession(app.page, 'codex', 'codex 没有斜杠菜单');
    await waitTurnDone(app.page);
    await app.mockResponses.reset();
    await app.page.getByTestId('composer-input').fill('/foo bar');
    await expect(app.page.getByTestId('slash-menu')).toHaveCount(0);
    await app.page.getByTestId('send-button').click();
    await expect.poll(async () => app.page.getByTestId('timeline').innerText(), { timeout: 60_000 }).toContain('历史用户消息');
    const requests = (await app.mockResponses.requests()).filter((request) => request.helper !== true);
    const text = JSON.stringify(requests.at(-1)?.body ?? {});
    expect(text).toContain('/foo bar');
  });
});
