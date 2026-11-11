# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: agents2.spec.ts >> 7.4 改动卡片与轮次 >> AG-codex-03 改动卡片与 diff
- Location: e2e-real/agents2.spec.ts:43:5

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: getByTestId('changes-card')
Expected substring: "2 个文件"
Received string:    "已编辑 1 个文件 +2 -0notes.txt+2-0"
Timeout: 15000ms

Call log:
  - Expect "toContainText" getByTestId('changes-card') with timeout 15000ms
  - waiting for getByTestId('changes-card')
    34 × locator resolved to <div class="changes-card" data-testid="changes-card">…</div>
       - unexpected value "已编辑 1 个文件 +2 -0notes.txt+2-0"

```

```yaml
- text: 已编辑 1 个文件 +2 -0
- button "notes.txt +2 -0"
```

# Test source

```ts
  1   | /**
  2   |  * SPEC-M8 7.4 的核心流程用例（第二轮）：改动卡片、轮次、刷新、第二回合、回收、换模型。
  3   |  * 每个 Agent 的 01、02、04 在 agents.spec.ts；本文件补齐 03、07、08、10、11、12。
  4   |  */
  5   | import { readFileSync, existsSync } from 'node:fs';
  6   | import { join } from 'node:path';
  7   | import type { Page } from '@playwright/test';
  8   | import { expect, resetWorkspace, run, test } from './fixtures.js';
  9   | import { AGENT_CARD, AGENT_MARK, newSession, waitTurnDone, type AgentKey } from './helpers.js';
  10  | 
  11  | const AGENTS: AgentKey[] = ['dsh', 'codex', 'claude'];
  12  | const REPO = (): string => join(run.root, 'ws/sample-repo');
  13  | 
  14  | async function sendMessage(page: Page, text: string): Promise<void> {
  15  |   await page.getByTestId('composer-input').fill(text);
  16  |   await page.getByTestId('send-button').click();
  17  | }
  18  | 
  19  | /** 等到区域文本连续两次相同（避免渲染中途取值） */
  20  | async function stableText(page: Page, testId: string): Promise<string> {
  21  |   let previous = '';
  22  |   for (let index = 0; index < 60; index += 1) {
  23  |     const current = await page.getByTestId(testId).innerText().catch(() => '');
  24  |     if (current !== '' && current === previous) return current;
  25  |     previous = current;
  26  |     await page.waitForTimeout(200);
  27  |   }
  28  |   return previous;
  29  | }
  30  | 
  31  | async function openSession(page: Page, agent: AgentKey, text: string): Promise<string> {
  32  |   await page.goto(`${run.baseURL}/new`);
  33  |   await page.getByTestId(`agent-card-${AGENT_CARD[agent]}`).click();
  34  |   await page.getByTestId('new-session-input').fill(text);
  35  |   await page.getByTestId('new-session-send').click();
  36  |   await page.waitForURL(/\/s\/[0-9A-Z]+/, { timeout: 90_000 });
  37  |   const match = /\/s\/([0-9A-Z]+)/.exec(page.url());
  38  |   return match?.[1] ?? '';
  39  | }
  40  | 
  41  | test.describe('7.4 改动卡片与轮次', () => {
  42  |   for (const agent of AGENTS) {
  43  |     test(`AG-${agent}-03 改动卡片与 diff`, async ({ app }) => {
  44  |       await app.login();
  45  |       await app.planFor(agent, 'full');
  46  |       await openSession(app.page, agent, '跑一遍 full');
  47  |       await waitTurnDone(app.page);
  48  |       const card = app.page.getByTestId('changes-card');
> 49  |       await expect(card).toContainText('2 个文件');
      |                          ^ Error: expect(locator).toContainText(expected) failed
  50  |       await expect(card).toContainText('notes.txt');
  51  |       await expect(card).toContainText('README.md');
  52  |       // 文件真的改了
  53  |       expect(readFileSync(join(REPO(), 'notes.txt'), 'utf8')).toBe('第一行\n第二行\n');
  54  |       expect(readFileSync(join(REPO(), 'README.md'), 'utf8')).toContain('line to modify: UPDATED');
  55  |       // 点开 README.md 的改动，停靠区显示 diff 里的那一行
  56  |       await card.locator('button', { hasText: 'README.md' }).first().click();
  57  |       const dock = app.page.getByTestId('dock');
  58  |       await expect(dock).toBeVisible();
  59  |       await expect.poll(async () => dock.innerText(), { timeout: 20_000 }).toContain('line to modify');
  60  |     });
  61  | 
  62  |     test(`AG-${agent}-07 轮次与已完成`, async ({ app }) => {
  63  |       await app.login();
  64  |       await app.planFor(agent, 'full');
  65  |       await openSession(app.page, agent, '轮次检查');
  66  |       await waitTurnDone(app.page);
  67  |       const timeline = app.page.getByTestId('timeline');
  68  |       await expect.poll(async () => timeline.innerText(), { timeout: 30_000 }).toMatch(/已完成，用时/);
  69  |       await expect.poll(async () => timeline.innerText()).not.toContain('运行中…');
  70  |       // 用户气泡在轮次顶部
  71  |       const userBubble = app.page.getByTestId('user-message').first();
  72  |       await expect(userBubble).toBeVisible();
  73  |       await expect.poll(async () => (await app.page.getByTestId('composer').innerText())).toContain('1 轮');
  74  |     });
  75  | 
  76  |     test(`AG-${agent}-08 刷新与另一上下文一致`, async ({ app }) => {
  77  |       await app.login();
  78  |       await app.planFor(agent, 'full');
  79  |       const sessionId = await openSession(app.page, agent, '刷新一致性');
  80  |       await waitTurnDone(app.page);
  81  |       const before = await stableText(app.page, 'timeline');
  82  |       await app.page.reload();
  83  |       // 刷新后等这一轮渲染完（避免取到还在补事件的中间态）
  84  |       await expect.poll(async () => app.page.getByTestId('timeline').innerText(), { timeout: 30_000 }).toMatch(/已完成|已中断/);
  85  |       const after = await stableText(app.page, 'timeline');
  86  |       if (after !== before) console.log(`AG-${agent}-08 before=${JSON.stringify(before)}\nAG-${agent}-08 after=${JSON.stringify(after)}`);
  87  |       expect(after).toBe(before);
  88  |       const context = await app.page.context().browser()?.newContext({ viewport: { width: 1440, height: 900 } });
  89  |       if (context === undefined) throw new Error('没有浏览器上下文');
  90  |       const other = await context.newPage();
  91  |       await other.goto(`${run.baseURL}/?token=${run.token}`);
  92  |       await other.waitForURL((url) => url.pathname === '/');
  93  |       await other.goto(`${run.baseURL}/s/${sessionId}`);
  94  |       expect(await stableText(other, 'timeline')).toBe(before);
  95  |       await expect(other.getByTestId('session-header').locator('.agent-mark').first()).toHaveText(AGENT_MARK[agent]);
  96  |       await context.close();
  97  |     });
  98  | 
  99  |     test(`AG-${agent}-10 第二轮`, async ({ app }) => {
  100 |       await app.login();
  101 |       await app.planFor(agent, 'full');
  102 |       await openSession(app.page, agent, '第一轮');
  103 |       await waitTurnDone(app.page);
  104 |       await app.planFor(agent, 'full');
  105 |       await sendMessage(app.page, '第二轮');
  106 |       await expect.poll(async () => (await app.page.getByTestId('composer').innerText()), { timeout: 120_000 }).toContain('2 轮');
  107 |       await expect.poll(async () => app.page.getByTestId('timeline').innerText()).toContain('第二轮');
  108 |     });
  109 | 
  110 |     test(`AG-${agent}-11 dispose 后继续`, async ({ app }) => {
  111 |       await app.login();
  112 |       await app.planFor(agent, 'full');
  113 |       const sessionId = await openSession(app.page, agent, '第一轮');
  114 |       await waitTurnDone(app.page);
  115 |       await app.planFor(agent, 'full');
  116 |       await sendMessage(app.page, '第二轮');
  117 |       await expect.poll(async () => (await app.page.getByTestId('composer').innerText()), { timeout: 120_000 }).toContain('2 轮');
  118 |       await waitTurnDone(app.page);
  119 |       // 回收 Agent 进程
  120 |       const disposed = await app.page.evaluate(async (id: string) => {
  121 |         const response = await fetch('/api/__test/dispose', {
  122 |           method: 'POST',
  123 |           credentials: 'same-origin',
  124 |           headers: { 'content-type': 'application/json' },
  125 |           body: JSON.stringify({ sessionId: id }),
  126 |         });
  127 |         return response.status;
  128 |       }, sessionId);
  129 |       expect(disposed).toBe(200);
  130 |       const processes = (await app.page.evaluate(async () =>
  131 |         (await fetch('/api/__test/processes', { credentials: 'same-origin' })).json())) as {
  132 |         processes: { sessionId: string; pid: number }[];
  133 |       };
  134 |       expect(processes.processes.filter((item) => item.sessionId === sessionId)).toEqual([]);
  135 |       // 回收后再发一条：历史用户消息 3 条（只比较最后一条助手消息，避免整段时间线太大）
  136 |       await app.planFor(agent, 'echo-context');
  137 |       const assistantText = async (): Promise<string> =>
  138 |         app.page
  139 |           .getByTestId('timeline')
  140 |           .locator('.step-row.assistant')
  141 |           .last()
  142 |           .innerText()
  143 |           .catch(() => '');
  144 |       await sendMessage(app.page, '回收之后再发一条');
  145 |       await expect.poll(assistantText, { timeout: 120_000 }).toContain('历史用户消息 3 条');
  146 |     });
  147 | 
  148 |     test(`AG-${agent}-12 换模型`, async ({ app }) => {
  149 |       await app.login();
```