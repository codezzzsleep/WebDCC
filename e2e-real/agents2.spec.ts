/**
 * SPEC-M8 7.4 的核心流程用例（第二轮）：改动卡片、轮次、刷新、第二回合、回收、换模型。
 * 每个 Agent 的 01、02、04 在 agents.spec.ts；本文件补齐 03、07、08、10、11、12。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, run, test } from './fixtures.js';
import { AGENT_CARD, AGENT_MARK, waitTurnDone, type AgentKey } from './helpers.js';

const AGENTS: AgentKey[] = ['dsh', 'codex', 'claude'];
const REPO = (): string => join(run.root, 'ws/sample-repo');

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('send-button').click();
}

/** 等到区域文本连续两次相同（避免渲染中途取值） */
async function stableText(page: Page, testId: string): Promise<string> {
  let previous = '';
  for (let index = 0; index < 60; index += 1) {
    const current = await page.getByTestId(testId).innerText().catch(() => '');
    if (current !== '' && current === previous) return current;
    previous = current;
    await page.waitForTimeout(200);
  }
  return previous;
}

async function openSession(page: Page, agent: AgentKey, text: string): Promise<string> {
  await page.goto(`${run.baseURL}/new`);
  await page.getByTestId(`agent-card-${AGENT_CARD[agent]}`).click();
  await page.getByTestId('new-session-input').fill(text);
  await page.getByTestId('new-session-send').click();
  await page.waitForURL(/\/s\/[0-9A-Z]+/, { timeout: 90_000 });
  const match = /\/s\/([0-9A-Z]+)/.exec(page.url());
  return match?.[1] ?? '';
}

test.describe('7.4 改动卡片与轮次', () => {
  for (const agent of AGENTS) {
    test(`AG-${agent}-03 改动卡片与 diff`, async ({ app }) => {
      await app.login();
      await app.planFor(agent, 'full');
      await openSession(app.page, agent, '跑一遍 full');
      await waitTurnDone(app.page);
      const card = app.page.getByTestId('changes-card');
      await expect(card).toContainText('2 个文件');
      await expect(card).toContainText('notes.txt');
      await expect(card).toContainText('README.md');
      // 文件真的改了
      expect(readFileSync(join(REPO(), 'notes.txt'), 'utf8')).toBe('第一行\n第二行\n');
      expect(readFileSync(join(REPO(), 'README.md'), 'utf8')).toContain('line to modify: UPDATED');
      // 点开 README.md 的改动，停靠区显示 diff 里的那一行
      await card.locator('button', { hasText: 'README.md' }).first().click();
      const dock = app.page.getByTestId('dock');
      await expect(dock).toBeVisible();
      await expect.poll(async () => dock.innerText(), { timeout: 20_000 }).toContain('line to modify');
    });

    test(`AG-${agent}-07 轮次与已完成`, async ({ app }) => {
      await app.login();
      await app.planFor(agent, 'full');
      await openSession(app.page, agent, '轮次检查');
      await waitTurnDone(app.page);
      const timeline = app.page.getByTestId('timeline');
      await expect.poll(async () => timeline.innerText(), { timeout: 30_000 }).toMatch(/已完成，用时/);
      await expect.poll(async () => timeline.innerText()).not.toContain('运行中…');
      // 用户气泡在轮次顶部
      const userBubble = app.page.getByTestId('user-message').first();
      await expect(userBubble).toBeVisible();
      await expect.poll(async () => (await app.page.getByTestId('composer').innerText())).toContain('1 轮');
    });

    test(`AG-${agent}-08 刷新与另一上下文一致`, async ({ app }) => {
      await app.login();
      await app.planFor(agent, 'full');
      const sessionId = await openSession(app.page, agent, '刷新一致性');
      await waitTurnDone(app.page);
      const before = await stableText(app.page, 'timeline');
      await app.page.reload();
      // 刷新后等这一轮渲染完（避免取到还在补事件的中间态）
      await expect.poll(async () => app.page.getByTestId('timeline').innerText(), { timeout: 30_000 }).toMatch(/已完成|已中断/);
      const after = await stableText(app.page, 'timeline');
      if (after !== before) console.log(`AG-${agent}-08 before=${JSON.stringify(before)}\nAG-${agent}-08 after=${JSON.stringify(after)}`);
      expect(after).toBe(before);
      const context = await app.page.context().browser()?.newContext({ viewport: { width: 1440, height: 900 } });
      if (context === undefined) throw new Error('没有浏览器上下文');
      const other = await context.newPage();
      await other.goto(`${run.baseURL}/?token=${run.token}`);
      await other.waitForURL((url) => url.pathname === '/');
      await other.goto(`${run.baseURL}/s/${sessionId}`);
      expect(await stableText(other, 'timeline')).toBe(before);
      await expect(other.getByTestId('session-header').locator('.agent-mark').first()).toHaveText(AGENT_MARK[agent]);
      await context.close();
    });

    test(`AG-${agent}-10 第二轮`, async ({ app }) => {
      await app.login();
      await app.planFor(agent, 'full');
      await openSession(app.page, agent, '第一轮');
      await waitTurnDone(app.page);
      await app.planFor(agent, 'full');
      await sendMessage(app.page, '第二轮');
      await expect.poll(async () => (await app.page.getByTestId('composer').innerText()), { timeout: 120_000 }).toContain('2 轮');
      await expect.poll(async () => app.page.getByTestId('timeline').innerText()).toContain('第二轮');
    });

    test(`AG-${agent}-11 dispose 后继续`, async ({ app }) => {
      await app.login();
      await app.planFor(agent, 'full');
      const sessionId = await openSession(app.page, agent, '第一轮');
      await waitTurnDone(app.page);
      await app.planFor(agent, 'full');
      await sendMessage(app.page, '第二轮');
      await expect.poll(async () => (await app.page.getByTestId('composer').innerText()), { timeout: 120_000 }).toContain('2 轮');
      await waitTurnDone(app.page);
      // 回收 Agent 进程
      const disposed = await app.page.evaluate(async (id: string) => {
        const response = await fetch('/api/__test/dispose', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: id }),
        });
        return response.status;
      }, sessionId);
      expect(disposed).toBe(200);
      const processes = (await app.page.evaluate(async () =>
        (await fetch('/api/__test/processes', { credentials: 'same-origin' })).json())) as {
        processes: { sessionId: string; pid: number }[];
      };
      expect(processes.processes.filter((item) => item.sessionId === sessionId)).toEqual([]);
      // 回收后再发一条：历史用户消息 3 条（只比较最后一条助手消息，避免整段时间线太大）
      await app.planFor(agent, 'echo-context');
      const assistantText = async (): Promise<string> =>
        app.page
          .getByTestId('timeline')
          .locator('.step-row.assistant')
          .last()
          .innerText()
          .catch(() => '');
      await sendMessage(app.page, '回收之后再发一条');
      await expect.poll(assistantText, { timeout: 120_000 }).toContain('历史用户消息 3 条');
    });

    test(`AG-${agent}-12 换模型`, async ({ app }) => {
      await app.login();
      await app.planFor(agent, 'full');
      await openSession(app.page, agent, '换模型');
      await waitTurnDone(app.page);
      const menu = app.page.getByTestId('model-menu');
      // 模型列表是异步取的：等它到齐
      await expect.poll(async () => menu.locator('option').evaluateAll((nodes) => nodes.filter((node) => (node as HTMLOptionElement).value !== '').length), { timeout: 30_000 }).toBeGreaterThan(0);
      const options = await menu.locator('option').evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value).filter((value) => value !== ''));
      if (options.length < 1) {
        const debug = await app.page.evaluate(async () => {
          const store = (window as unknown as { __wdccStore?: { getSession: (id: string) => unknown } }).__wdccStore;
          const id = /\/s\/([0-9A-Z]+)/.exec(window.location.pathname)?.[1] ?? '';
          const session = store?.getSession(id) ?? null;
          const agent = (session as { agent?: string } | null)?.agent ?? '';
          const providerId = (session as { providerId?: string | null } | null)?.providerId ?? null;
          const models = await fetch(`/api/models?agent=${agent}${providerId === null ? '' : `&providerId=${providerId}`}`, {
            credentials: 'same-origin',
          }).then((r) => r.json());
          const meta = await fetch('/api/meta', { credentials: 'same-origin' }).then((r) => r.json());
          return JSON.stringify({ session, models, metaModels: (meta as { agents: Record<string, unknown> }).agents }).slice(0, 900);
        });
        const html = await menu.evaluate((node) => node.outerHTML).catch(() => 'no-menu');
        const composerText = await app.page.getByTestId('composer').innerText().catch(() => '');
        throw new Error(`模型菜单里没有可换的模型；fuel=${debug}\nHTML=${html}\nCOMPOSER=${composerText}`);
      }
      const next = options[0] as string;
      const before = await app.mockResponses.requests();
      await app.mockClaude.reset();
      await app.mockDsh.reset();
      await app.mockResponses.reset();
      await app.planFor(agent, 'full');
      await menu.selectOption(next);
      await sendMessage(app.page, '换模型之后再跑一轮');
      await expect.poll(async () => (await app.page.getByTestId('composer').innerText()), { timeout: 120_000 }).toContain('2 轮');
      const api = agent === 'codex' ? app.mockResponses : agent === 'claude' ? app.mockClaude : app.mockDsh;
      const requests = (await api.requests()).filter((request) => request.helper !== true);
      expect(requests.length).toBeGreaterThan(0);
      const models = requests.map((request) => String((request.body as { model?: unknown }).model ?? ''));
      expect(models, `换模型后请求里的 model 应为 ${next}`).toContain(next);
      void before;
    });
  }
});
