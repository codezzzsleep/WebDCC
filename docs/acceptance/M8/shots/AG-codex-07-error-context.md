# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: agents2.spec.ts >> 7.4 改动卡片与轮次 >> AG-codex-07 轮次与已完成
- Location: e2e-real/agents2.spec.ts:62:5

# Error details

```
Error: expect(received).not.toContain(expected) // indexOf

Expected substring: not "运行中…"
Received string:        "轮次检查

05:09
运行中…
已允许一次
· {
已允许一次
· {
更新了目标
跑通 full 计划：列目录、读 README、写 notes.txt、改 README
更新了目标
跑通 full 计划：列目录、读 README、写 notes.txt、改 README
更新了目标
跑通 full 计划：列目录、读 README、写 notes.txt、改 README
已完成，用时 4秒
执行了 4 条命令，编辑了 2 个文件

新建 notes.txt，写两行内容。

已编辑 2 个文件
+3 -1
notes.txt
+2 -0
README.md
+1 -1
带到…
05:09"

Call Log:
- Timeout 15000ms exceeded while waiting on the predicate
```

# Page snapshot

```yaml
- generic [ref=f1e3]:
  - complementary "会话" [ref=f1e4]:
    - generic [ref=f1e5]:
      - link "WebDCC 首页" [ref=f1e6] [cursor=pointer]:
        - /url: /
        - generic [ref=f1e7]: WebDCC
        - generic [ref=f1e8]: 3 HARNESS
      - button "收起侧边栏" [ref=f1e9] [cursor=pointer]
    - link "新会话" [ref=f1e12] [cursor=pointer]:
      - /url: /new
    - navigation [ref=f1e15]:
      - link "Agent 与 Provider" [ref=f1e16] [cursor=pointer]:
        - /url: /settings/providers
    - generic [ref=f1e19]:
      - generic [ref=f1e20]: 工作区
      - generic [ref=f1e21]:
        - button "搜索会话" [ref=f1e22] [cursor=pointer]
        - button "添加工作区" [ref=f1e25] [cursor=pointer]
    - generic [ref=f1e29]:
      - generic "/tmp/wdcc-accept-rmwclzkwx-Mwl3mI/ws/sample-repo" [ref=f1e30]:
        - generic [ref=f1e33]: sample-repo
        - link "在 sample-repo 新建会话" [ref=f1e34] [cursor=pointer]:
          - /url: /new?w=01M766XJQN0FM9K2PM1A2V71XV
      - link "轮次检查 刚刚" [ref=f1e37] [cursor=pointer]:
        - /url: /s/01M76739YN7PKXM678JG6H1JS1
        - generic [aria-hidden] [ref=f1e38]: CX
        - generic [ref=f1e39]: 轮次检查
        - generic [ref=f1e40]: 刚刚
      - link "跑一遍 full 刚刚" [ref=f1e41] [cursor=pointer]:
        - /url: /s/01M766XMBG1V6K9FV1QBRY64QV
        - generic [aria-hidden] [ref=f1e42]: CX
        - generic [ref=f1e43]: 跑一遍 full
        - generic [ref=f1e44]: 刚刚
    - generic [ref=f1e45]:
      - generic [ref=f1e46]:
        - generic [ref=f1e48]: DeepSeek Harness
        - generic [ref=f1e49]: 已连接本机 DSH
      - generic [ref=f1e50]:
        - generic [ref=f1e52]: Codex
        - generic [ref=f1e53]: 0.167.0
      - generic [ref=f1e54]:
        - generic [ref=f1e56]: Claude Code
        - generic [ref=f1e57]: 0.3.322
  - main [ref=f1e58]:
    - generic [ref=f1e59]:
      - generic [ref=f1e60]:
        - button "轮次检查" [ref=f1e61] [cursor=pointer]
        - generic "Codex · Mock Responses · gpt-6.1-sol" [ref=f1e62]:
          - generic [aria-hidden] [ref=f1e63]: CX
          - generic [ref=f1e64]: Codex
          - generic [ref=f1e65]: · Mock Responses · gpt-6.1-sol
        - generic [ref=f1e66]:
          - button "并排" [ref=f1e68] [cursor=pointer]
          - button "更多" [ref=f1e73] [cursor=pointer]
      - navigation "视图" [ref=f1e75]:
        - button "对话" [ref=f1e76] [cursor=pointer]
        - button "轨迹" [ref=f1e77] [cursor=pointer]
    - generic [ref=f1e79]:
      - generic [ref=f1e81]:
        - generic [ref=f1e82]:
          - paragraph [ref=f1e85]: 轮次检查
          - generic [ref=f1e86]: 05:09
        - generic [ref=f1e88]: 运行中…
        - generic [ref=f1e94]:
          - generic [ref=f1e95]:
            - generic [ref=f1e98]: 已允许一次
            - generic [ref=f1e99]: "· {"
          - generic [ref=f1e100]:
            - generic [ref=f1e103]: 已允许一次
            - generic [ref=f1e104]: "· {"
          - generic [ref=f1e106]:
            - generic [ref=f1e109]: 更新了目标
            - generic [ref=f1e110]: 跑通 full 计划：列目录、读 README、写 notes.txt、改 README
          - generic [ref=f1e112]:
            - generic [ref=f1e115]: 更新了目标
            - generic [ref=f1e116]: 跑通 full 计划：列目录、读 README、写 notes.txt、改 README
          - generic [ref=f1e118]:
            - generic [ref=f1e121]: 更新了目标
            - generic [ref=f1e122]: 跑通 full 计划：列目录、读 README、写 notes.txt、改 README
      - generic [ref=f1e124]:
        - button "已完成，用时 4秒" [ref=f1e126] [cursor=pointer]
        - generic [ref=f1e130]:
          - button "执行了 4 条命令，编辑了 2 个文件" [ref=f1e131] [cursor=pointer]
          - paragraph [ref=f1e136]: 新建 notes.txt，写两行内容。
          - generic [ref=f1e137]:
            - generic [ref=f1e142]:
              - text: 已编辑 2 个文件
              - generic [ref=f1e143]:
                - generic [ref=f1e144]: "+3"
                - generic [ref=f1e145]: "-1"
            - button "notes.txt +2 -0" [ref=f1e146] [cursor=pointer]:
              - generic [ref=f1e147]: notes.txt
              - generic [ref=f1e148]:
                - generic [ref=f1e149]: "+2"
                - generic [ref=f1e150]: "-0"
            - button "README.md +1 -1" [ref=f1e151] [cursor=pointer]:
              - generic [ref=f1e152]: README.md
              - generic [ref=f1e153]:
                - generic [ref=f1e154]: "+1"
                - generic [ref=f1e155]: "-1"
          - generic [ref=f1e156]:
            - button "复制回答" [ref=f1e157] [cursor=pointer]
            - button "带到…" [ref=f1e160] [cursor=pointer]
            - generic [ref=f1e163]: 05:09
    - generic [ref=f1e164]:
      - generic [ref=f1e167]:
        - strong [ref=f1e170]: 目标
        - generic [ref=f1e171]: 跑通 full 计划：列目录、读 README、写 notes.txt、改 README · 进行中
        - generic [ref=f1e172]: Codex 的目标
      - generic [ref=f1e173]:
        - generic [ref=f1e174]:
          - generic [ref=f1e175]: 消息
          - textbox "消息" [ref=f1e176]:
            - /placeholder: 发消息给 Codex，/ 调用它的指令，@ 引用文件或会话
          - generic [ref=f1e177]:
            - button "添加附件" [ref=f1e179] [cursor=pointer]
            - button "Codex 会话创建后固定" [ref=f1e183] [cursor=pointer]:
              - generic [aria-hidden] [ref=f1e184]: CX
              - generic [ref=f1e185]: Codex
              - img "会话创建后固定" [ref=f1e186]
            - button "只读" [ref=f1e189] [cursor=pointer]
            - button "gpt-6.1-sol Mock Responses" [ref=f1e196] [cursor=pointer]:
              - generic [ref=f1e197]: gpt-6.1-sol
              - generic [ref=f1e198]: Mock Responses
            - button "思考 medium" [ref=f1e202] [cursor=pointer]
            - button "发送" [disabled] [ref=f1e206]
        - generic [ref=f1e209]: 1 轮 · 13 步 · 1.4K tok
```

# Test source

```ts
  1   | /**
  2   |  * SPEC-M8 7.4 的核心流程用例（第二轮）：改动卡片、轮次、刷新、第二回合、回收、换模型。
  3   |  * 每个 Agent 的 01、02、04 在 agents.spec.ts；本文件补齐 03、07、08、10、11、12。
  4   |  */
  5   | import { readFileSync } from 'node:fs';
  6   | import { join } from 'node:path';
  7   | import type { Page } from '@playwright/test';
  8   | import { expect, run, test } from './fixtures.js';
  9   | import { AGENT_CARD, AGENT_MARK, waitTurnDone, type AgentKey } from './helpers.js';
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
  49  |       await expect(card).toContainText('2 个文件');
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
> 69  |       await expect.poll(async () => timeline.innerText()).not.toContain('运行中…');
      |                                                               ^ Error: expect(received).not.toContain(expected) // indexOf
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
  150 |       await app.planFor(agent, 'full');
  151 |       await openSession(app.page, agent, '换模型');
  152 |       await waitTurnDone(app.page);
  153 |       const menu = app.page.getByTestId('model-menu');
  154 |       // 模型列表是异步取的：打开"模型"菜单，等可选的模型到齐
  155 |       const enabledOptions = app.page.locator('[data-testid="model-option"]:not([disabled])');
  156 |       await expect
  157 |         .poll(
  158 |           async () => {
  159 |             if ((await enabledOptions.count()) === 0) {
  160 |               await app.page.keyboard.press('Escape');
  161 |               await menu.click();
  162 |             }
  163 |             return enabledOptions.evaluateAll((nodes) => nodes.filter((node) => (node.getAttribute('data-model') ?? '') !== '').length);
  164 |           },
  165 |           { timeout: 30_000 },
  166 |         )
  167 |         .toBeGreaterThan(0);
  168 |       const current = (await menu.getAttribute('data-model')) ?? '';
  169 |       const options = await enabledOptions.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-model') ?? '').filter((value) => value !== ''));
```