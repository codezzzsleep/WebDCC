# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: agents2.spec.ts >> 7.4 改动卡片与轮次 >> AG-codex-08 刷新与另一上下文一致
- Location: e2e-real/agents2.spec.ts:76:5

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

- Expected  - 2
+ Received  + 8

  刷新一致性

  07:59
  已完成，用时 3秒
- 更新了目标，执行了 2 条命令，编辑了 9 个文件
+ 更新了目标，执行了 4 条命令，编辑了 9 个文件
  已允许一次
  · {
  已允许一次
  · {

  全部完成：列目录、读 README、写 notes.txt、改 README。

+ apply_patch
+ {
+ 详情
+ 允许一次
+ 本会话都允许
+ 拒绝
  已编辑 2 个文件
  +3 -1
  README.md
  +1 -1
  notes.txt
  +2 -0
  带到…
- 用量 1.1k tok
+ 用量 1.4k tok
  07:59
```

# Page snapshot

```yaml
- generic [ref=f2e3]:
  - complementary "会话" [ref=f2e4]:
    - generic [ref=f2e5]:
      - link "WebDCC 首页" [ref=f2e6] [cursor=pointer]:
        - /url: /
        - generic [ref=f2e7]: WebDCC
        - generic [ref=f2e8]: 3 HARNESS
      - button "收起侧边栏" [ref=f2e9] [cursor=pointer]
    - link "新会话" [ref=f2e12] [cursor=pointer]:
      - /url: /new
    - navigation [ref=f2e15]:
      - link "Agent 与 Provider" [ref=f2e16] [cursor=pointer]:
        - /url: /settings/providers
    - generic [ref=f2e19]:
      - generic [ref=f2e20]: 工作区
      - generic [ref=f2e21]:
        - button "搜索会话" [ref=f2e22] [cursor=pointer]
        - button "添加工作区" [ref=f2e25] [cursor=pointer]
    - generic [ref=f2e29]:
      - generic "/tmp/wdcc-accept-rmwcs3zxi-ccTPlR/ws/sample-repo" [ref=f2e30]:
        - generic [ref=f2e33]: sample-repo
        - link "在 sample-repo 新建会话" [ref=f2e34] [cursor=pointer]:
          - /url: /new?w=01M76GQE0HPYQGJYM0ZXGYQKG6
      - link "刷新一致性 刚刚" [ref=f2e37] [cursor=pointer]:
        - /url: /s/01M76GT5R3YTMXS9WZR8AS1RWK
        - generic [aria-hidden] [ref=f2e38]: CX
        - generic [ref=f2e39]: 刷新一致性
        - generic [ref=f2e40]: 刚刚
      - link "轮次检查 待批准" [ref=f2e41] [cursor=pointer]:
        - /url: /s/01M76GSYXWS7D3EYJFXQBT0KNG
        - generic [aria-hidden] [ref=f2e42]: CX
        - generic [ref=f2e43]: 轮次检查
        - generic [ref=f2e44]: 待批准
      - link "跑一遍 full 待批准" [ref=f2e45] [cursor=pointer]:
        - /url: /s/01M76GSREJH032XRVAVSZ4EHB5
        - generic [aria-hidden] [ref=f2e46]: CX
        - generic [ref=f2e47]: 跑一遍 full
        - generic [ref=f2e48]: 待批准
      - link "（辅助请求：不推进计划） 刚刚" [ref=f2e49] [cursor=pointer]:
        - /url: /s/01M76GSES90NPW9SJQM26JNJCD
        - generic [aria-hidden] [ref=f2e50]: DS
        - generic [ref=f2e51]: （辅助请求：不推进计划）
        - generic [ref=f2e52]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f2e53] [cursor=pointer]:
        - /url: /s/01M76GS5BSYWT72M8P8DSEVWGY
        - generic [aria-hidden] [ref=f2e54]: DS
        - generic [ref=f2e55]: （辅助请求：不推进计划）
        - generic [ref=f2e56]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f2e57] [cursor=pointer]:
        - /url: /s/01M76GS03ZWVYZQMRTB7WBBRE7
        - generic [aria-hidden] [ref=f2e58]: DS
        - generic [ref=f2e59]: （辅助请求：不推进计划）
        - generic [ref=f2e60]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f2e61] [cursor=pointer]:
        - /url: /s/01M76GRR6XBXN00SNH0R6XRT7R
        - generic [aria-hidden] [ref=f2e62]: DS
        - generic [ref=f2e63]: （辅助请求：不推进计划）
        - generic [ref=f2e64]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f2e65] [cursor=pointer]:
        - /url: /s/01M76GRJPYACQRE1GJ1BPDKRPG
        - generic [aria-hidden] [ref=f2e66]: DS
        - generic [ref=f2e67]: （辅助请求：不推进计划）
        - generic [ref=f2e68]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f2e69] [cursor=pointer]:
        - /url: /s/01M76GRD0RN917Z0K2EK388QH4
        - generic [aria-hidden] [ref=f2e70]: DS
        - generic [ref=f2e71]: （辅助请求：不推进计划）
        - generic [ref=f2e72]: 刚刚
      - link "任务清单 刚刚" [ref=f2e73] [cursor=pointer]:
        - /url: /s/01M76GR5XN60APPTPHD3P2K9K5
        - generic [aria-hidden] [ref=f2e74]: CC
        - generic [ref=f2e75]: 任务清单
        - generic [ref=f2e76]: 刚刚
      - link "流式 刚刚" [ref=f2e77] [cursor=pointer]:
        - /url: /s/01M76GR3NN5571F2TMZAWF20QV
        - generic [aria-hidden] [ref=f2e78]: CC
        - generic [ref=f2e79]: 流式
        - generic [ref=f2e80]: 刚刚
      - link "跑一遍 full 刚刚" [ref=f2e81] [cursor=pointer]:
        - /url: /s/01M76GR1YZMMNAAN7X5CWF827C
        - generic [aria-hidden] [ref=f2e82]: CC
        - generic [ref=f2e83]: 跑一遍 full
        - generic [ref=f2e84]: 刚刚
      - link "流式 刚刚" [ref=f2e85] [cursor=pointer]:
        - /url: /s/01M76GQSYQ0XYYZTXT9RNE8MCF
        - generic [aria-hidden] [ref=f2e86]: CX
        - generic [ref=f2e87]: 流式
        - generic [ref=f2e88]: 刚刚
      - link "任务清单 待批准" [ref=f2e89] [cursor=pointer]:
        - /url: /s/01M76GQVRHHZ9QKH0XGG1SHY6P
        - generic [aria-hidden] [ref=f2e90]: CX
        - generic [ref=f2e91]: 任务清单
        - generic [ref=f2e92]: 待批准
      - link "（辅助请求：不推进计划） 刚刚" [ref=f2e93] [cursor=pointer]:
        - /url: /s/01M76GQH2A95A97KGTPCW2AE4B
        - generic [aria-hidden] [ref=f2e94]: DS
        - generic [ref=f2e95]: （辅助请求：不推进计划）
        - generic [ref=f2e96]: 刚刚
      - link "跑一遍 full 刚刚" [ref=f2e97] [cursor=pointer]:
        - /url: /s/01M76GQR9MYGE76WFNGX4AAPPJ
        - generic [aria-hidden] [ref=f2e98]: CX
        - generic [ref=f2e99]: 跑一遍 full
        - generic [ref=f2e100]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f2e101] [cursor=pointer]:
        - /url: /s/01M76GQJRFX19Z486PQJS266J9
        - generic [aria-hidden] [ref=f2e102]: DS
        - generic [ref=f2e103]: （辅助请求：不推进计划）
        - generic [ref=f2e104]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f2e105] [cursor=pointer]:
        - /url: /s/01M76GQFRVW4XVQ27B8MFCD5X1
        - generic [aria-hidden] [ref=f2e106]: DS
        - generic [ref=f2e107]: （辅助请求：不推进计划）
        - generic [ref=f2e108]: 刚刚
    - generic [ref=f2e109]:
      - generic [ref=f2e110]:
        - generic [ref=f2e112]: DeepSeek Harness
        - generic [ref=f2e113]: 已连接本机 DSH
      - generic [ref=f2e114]:
        - generic [ref=f2e116]: Codex
        - generic [ref=f2e117]: 0.167.1
      - generic [ref=f2e118]:
        - generic [ref=f2e120]: Claude Code
        - generic [ref=f2e121]: 0.3.322
  - main [ref=f2e122]:
    - generic [ref=f2e123]:
      - generic [ref=f2e124]:
        - button "刷新一致性" [ref=f2e125] [cursor=pointer]
        - generic "Codex · Mock Responses · gpt-6.1-sol" [ref=f2e126]:
          - generic [aria-hidden] [ref=f2e127]: CX
          - generic [ref=f2e128]: Codex
          - generic [ref=f2e129]: · Mock Responses · gpt-6.1-sol
        - generic [ref=f2e130]:
          - button "并排" [ref=f2e132] [cursor=pointer]
          - button "更多" [ref=f2e137] [cursor=pointer]
      - navigation "视图" [ref=f2e139]:
        - button "对话" [ref=f2e140] [cursor=pointer]
        - button "轨迹" [ref=f2e141] [cursor=pointer]
    - generic [ref=f2e145]:
      - generic [ref=f2e146]:
        - paragraph [ref=f2e149]: 刷新一致性
        - generic [ref=f2e150]: 07:59
      - button "已完成，用时 3秒" [ref=f2e153] [cursor=pointer]
      - generic [ref=f2e157]:
        - button "更新了目标，执行了 4 条命令，编辑了 10 个文件" [ref=f2e158] [cursor=pointer]
        - generic [ref=f2e161]:
          - generic [ref=f2e164]: 已允许一次
          - generic [ref=f2e165]: "· {"
        - generic [ref=f2e166]:
          - generic [ref=f2e169]: 已允许一次
          - generic [ref=f2e170]: "· {"
        - paragraph [ref=f2e173]: 全部完成：列目录、读 README、写 notes.txt、改 README。
        - generic [ref=f2e174]:
          - generic [ref=f2e177]: 已允许一次
          - generic [ref=f2e178]: "· {"
        - generic [ref=f2e179]:
          - generic [ref=f2e184]:
            - text: 已编辑 2 个文件
            - generic [ref=f2e185]:
              - generic [ref=f2e186]: "+3"
              - generic [ref=f2e187]: "-1"
          - button "README.md +1 -1" [ref=f2e188] [cursor=pointer]:
            - generic [ref=f2e189]: README.md
            - generic [ref=f2e190]:
              - generic [ref=f2e191]: "+1"
              - generic [ref=f2e192]: "-1"
          - button "notes.txt +2 -0" [ref=f2e193] [cursor=pointer]:
            - generic [ref=f2e194]: notes.txt
            - generic [ref=f2e195]:
              - generic [ref=f2e196]: "+2"
              - generic [ref=f2e197]: "-0"
        - generic [ref=f2e198]:
          - button "复制回答" [ref=f2e199] [cursor=pointer]
          - button "带到…" [ref=f2e202] [cursor=pointer]
          - generic [ref=f2e205]: 用量 1.8k tok
          - generic [ref=f2e206]: 07:59
    - generic [ref=f2e207]:
      - generic [ref=f2e210]:
        - strong [ref=f2e213]: 目标
        - generic [ref=f2e214]: 跑通 full 计划：列目录、读 README、写 notes.txt、改 README · 进行中
        - generic [ref=f2e215]: Codex 的目标
      - generic [ref=f2e216]:
        - generic [ref=f2e217]:
          - generic [ref=f2e218]: 消息
          - textbox "消息" [ref=f2e219]:
            - /placeholder: 发消息给 Codex，/ 调用它的指令，@ 引用文件或会话
          - generic [ref=f2e220]:
            - button "添加附件" [ref=f2e222] [cursor=pointer]
            - button "Codex 会话创建后固定" [ref=f2e226] [cursor=pointer]:
              - generic [aria-hidden] [ref=f2e227]: CX
              - generic [ref=f2e228]: Codex
              - img "会话创建后固定" [ref=f2e229]
            - button "只读" [ref=f2e232] [cursor=pointer]
            - button "gpt-6.1-sol Mock Responses" [ref=f2e239] [cursor=pointer]:
              - generic [ref=f2e240]: gpt-6.1-sol
              - generic [ref=f2e241]: Mock Responses
            - button "思考 medium" [ref=f2e245] [cursor=pointer]
            - button "发送" [disabled] [ref=f2e249]
        - generic [ref=f2e252]: 1 轮 · 7 步 · 1.8K tok
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
> 94  |       expect(await stableText(other, 'timeline')).toBe(before);
      |                                                   ^ Error: expect(received).toBe(expected) // Object.is equality
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
  170 |       if (options.length < 1) {
  171 |         const composerText = await app.page.getByTestId('composer').innerText().catch(() => '');
  172 |         throw new Error(`模型菜单里没有可换的模型；COMPOSER=${composerText}`);
  173 |       }
  174 |       // 优先换到一个和当前不同的模型
  175 |       options.sort((a, b) => Number(a === current) - Number(b === current));
  176 |       const next = options[0] as string;
  177 |       const before = await app.mockResponses.requests();
  178 |       await app.mockClaude.reset();
  179 |       await app.mockDsh.reset();
  180 |       await app.mockResponses.reset();
  181 |       await app.planFor(agent, 'full');
  182 |       await app.page.locator(`[data-testid="model-option"]:not([disabled])[data-model="${next}"]`).first().click();
  183 |       await expect(menu).toHaveAttribute('data-model', next);
  184 |       await sendMessage(app.page, '换模型之后再跑一轮');
  185 |       await expect.poll(async () => (await app.page.getByTestId('composer').innerText()), { timeout: 120_000 }).toContain('2 轮');
  186 |       // “2 轮”只表示服务端已接受发送；等轮次完成后再检查 mock 请求，
  187 |       // 否则 Codex 尚未发起上游请求时会把一次正常的异步过程误判成模型错误。
  188 |       await waitTurnDone(app.page);
  189 |       const api = agent === 'codex' ? app.mockResponses : agent === 'claude' ? app.mockClaude : app.mockDsh;
  190 |       const requests = (await api.requests()).filter((request) => request.helper !== true);
  191 |       expect(requests.length).toBeGreaterThan(0);
  192 |       const models = requests.map((request) => String((request.body as { model?: unknown }).model ?? ''));
  193 |       expect(models, `换模型后请求里的 model 应为 ${next}`).toContain(next);
  194 |       void before;
```