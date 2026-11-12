# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: agents2.spec.ts >> 7.4 改动卡片与轮次 >> AG-codex-11 dispose 后继续
- Location: e2e-real/agents2.spec.ts:110:5

# Error details

```
Error: expect(received).toContain(expected) // indexOf

Expected substring: "历史用户消息 3 条"
Received string:    "历史用户消息 54 条"

Call Log:
- Timeout 120000ms exceeded while waiting on the predicate
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
      - generic "/tmp/wdcc-accept-rmwcs3zxi-ccTPlR/ws/sample-repo" [ref=f1e30]:
        - generic [ref=f1e33]: sample-repo
        - link "在 sample-repo 新建会话" [ref=f1e34] [cursor=pointer]:
          - /url: /new?w=01M76GQE0HPYQGJYM0ZXGYQKG6
      - link "第一轮 运行中" [ref=f1e37] [cursor=pointer]:
        - /url: /s/01M76GTN494PQH438RFAFJB56K
        - generic [aria-hidden] [ref=f1e38]: CX
        - generic [ref=f1e39]: 第一轮
        - img "运行中" [ref=f1e41]
      - link "第一轮 待批准" [ref=f1e43] [cursor=pointer]:
        - /url: /s/01M76GTECBDNCZ2KZ8SC60580Z
        - generic [aria-hidden] [ref=f1e44]: CX
        - generic [ref=f1e45]: 第一轮
        - generic [ref=f1e46]: 待批准
      - link "刷新一致性 待批准" [ref=f1e47] [cursor=pointer]:
        - /url: /s/01M76GT5R3YTMXS9WZR8AS1RWK
        - generic [aria-hidden] [ref=f1e48]: CX
        - generic [ref=f1e49]: 刷新一致性
        - generic [ref=f1e50]: 待批准
      - link "轮次检查 待批准" [ref=f1e51] [cursor=pointer]:
        - /url: /s/01M76GSYXWS7D3EYJFXQBT0KNG
        - generic [aria-hidden] [ref=f1e52]: CX
        - generic [ref=f1e53]: 轮次检查
        - generic [ref=f1e54]: 待批准
      - link "跑一遍 full 待批准" [ref=f1e55] [cursor=pointer]:
        - /url: /s/01M76GSREJH032XRVAVSZ4EHB5
        - generic [aria-hidden] [ref=f1e56]: CX
        - generic [ref=f1e57]: 跑一遍 full
        - generic [ref=f1e58]: 待批准
      - link "（辅助请求：不推进计划） 2分钟" [ref=f1e59] [cursor=pointer]:
        - /url: /s/01M76GSES90NPW9SJQM26JNJCD
        - generic [aria-hidden] [ref=f1e60]: DS
        - generic [ref=f1e61]: （辅助请求：不推进计划）
        - generic [ref=f1e62]: 2分钟
      - link "（辅助请求：不推进计划） 2分钟" [ref=f1e63] [cursor=pointer]:
        - /url: /s/01M76GS5BSYWT72M8P8DSEVWGY
        - generic [aria-hidden] [ref=f1e64]: DS
        - generic [ref=f1e65]: （辅助请求：不推进计划）
        - generic [ref=f1e66]: 2分钟
      - link "（辅助请求：不推进计划） 2分钟" [ref=f1e67] [cursor=pointer]:
        - /url: /s/01M76GS03ZWVYZQMRTB7WBBRE7
        - generic [aria-hidden] [ref=f1e68]: DS
        - generic [ref=f1e69]: （辅助请求：不推进计划）
        - generic [ref=f1e70]: 2分钟
      - link "（辅助请求：不推进计划） 2分钟" [ref=f1e71] [cursor=pointer]:
        - /url: /s/01M76GRR6XBXN00SNH0R6XRT7R
        - generic [aria-hidden] [ref=f1e72]: DS
        - generic [ref=f1e73]: （辅助请求：不推进计划）
        - generic [ref=f1e74]: 2分钟
      - link "（辅助请求：不推进计划） 2分钟" [ref=f1e75] [cursor=pointer]:
        - /url: /s/01M76GRJPYACQRE1GJ1BPDKRPG
        - generic [aria-hidden] [ref=f1e76]: DS
        - generic [ref=f1e77]: （辅助请求：不推进计划）
        - generic [ref=f1e78]: 2分钟
      - link "（辅助请求：不推进计划） 2分钟" [ref=f1e79] [cursor=pointer]:
        - /url: /s/01M76GRD0RN917Z0K2EK388QH4
        - generic [aria-hidden] [ref=f1e80]: DS
        - generic [ref=f1e81]: （辅助请求：不推进计划）
        - generic [ref=f1e82]: 2分钟
      - link "流式 2分钟" [ref=f1e83] [cursor=pointer]:
        - /url: /s/01M76GR3NN5571F2TMZAWF20QV
        - generic [aria-hidden] [ref=f1e84]: CC
        - generic [ref=f1e85]: 流式
        - generic [ref=f1e86]: 2分钟
      - link "任务清单 2分钟" [ref=f1e87] [cursor=pointer]:
        - /url: /s/01M76GR5XN60APPTPHD3P2K9K5
        - generic [aria-hidden] [ref=f1e88]: CC
        - generic [ref=f1e89]: 任务清单
        - generic [ref=f1e90]: 2分钟
      - link "流式 2分钟" [ref=f1e91] [cursor=pointer]:
        - /url: /s/01M76GQSYQ0XYYZTXT9RNE8MCF
        - generic [aria-hidden] [ref=f1e92]: CX
        - generic [ref=f1e93]: 流式
        - generic [ref=f1e94]: 2分钟
      - link "跑一遍 full 2分钟" [ref=f1e95] [cursor=pointer]:
        - /url: /s/01M76GR1YZMMNAAN7X5CWF827C
        - generic [aria-hidden] [ref=f1e96]: CC
        - generic [ref=f1e97]: 跑一遍 full
        - generic [ref=f1e98]: 2分钟
      - link "任务清单 待批准" [ref=f1e99] [cursor=pointer]:
        - /url: /s/01M76GQVRHHZ9QKH0XGG1SHY6P
        - generic [aria-hidden] [ref=f1e100]: CX
        - generic [ref=f1e101]: 任务清单
        - generic [ref=f1e102]: 待批准
      - link "（辅助请求：不推进计划） 2分钟" [ref=f1e103] [cursor=pointer]:
        - /url: /s/01M76GQH2A95A97KGTPCW2AE4B
        - generic [aria-hidden] [ref=f1e104]: DS
        - generic [ref=f1e105]: （辅助请求：不推进计划）
        - generic [ref=f1e106]: 2分钟
      - link "跑一遍 full 2分钟" [ref=f1e107] [cursor=pointer]:
        - /url: /s/01M76GQR9MYGE76WFNGX4AAPPJ
        - generic [aria-hidden] [ref=f1e108]: CX
        - generic [ref=f1e109]: 跑一遍 full
        - generic [ref=f1e110]: 2分钟
      - link "（辅助请求：不推进计划） 2分钟" [ref=f1e111] [cursor=pointer]:
        - /url: /s/01M76GQJRFX19Z486PQJS266J9
        - generic [aria-hidden] [ref=f1e112]: DS
        - generic [ref=f1e113]: （辅助请求：不推进计划）
        - generic [ref=f1e114]: 2分钟
      - link "（辅助请求：不推进计划） 2分钟" [ref=f1e115] [cursor=pointer]:
        - /url: /s/01M76GQFRVW4XVQ27B8MFCD5X1
        - generic [aria-hidden] [ref=f1e116]: DS
        - generic [ref=f1e117]: （辅助请求：不推进计划）
        - generic [ref=f1e118]: 2分钟
    - generic [ref=f1e119]:
      - generic [ref=f1e120]:
        - generic [ref=f1e122]: DeepSeek Harness
        - generic [ref=f1e123]: 已连接本机 DSH
      - generic [ref=f1e124]:
        - generic [ref=f1e126]: Codex
        - generic [ref=f1e127]: 0.167.1
      - generic [ref=f1e128]:
        - generic [ref=f1e130]: Claude Code
        - generic [ref=f1e131]: 0.3.322
  - main [ref=f1e132]:
    - generic [ref=f1e133]:
      - generic [ref=f1e134]:
        - button "第一轮" [ref=f1e135] [cursor=pointer]
        - generic "Codex · Mock Responses · gpt-6.1-sol" [ref=f1e136]:
          - generic [aria-hidden] [ref=f1e137]: CX
          - generic [ref=f1e138]: Codex
          - generic [ref=f1e139]: · Mock Responses · gpt-6.1-sol
        - generic [ref=f1e140]:
          - button "并排" [ref=f1e142] [cursor=pointer]
          - button "更多" [ref=f1e147] [cursor=pointer]
      - navigation "视图" [ref=f1e149]:
        - button "对话" [ref=f1e150] [cursor=pointer]
        - button "轨迹" [ref=f1e151] [cursor=pointer]
    - generic [ref=f1e153]:
      - generic [ref=f1e155]:
        - generic [ref=f1e156]:
          - paragraph [ref=f1e159]: 第一轮
          - generic [ref=f1e160]: 07:59
        - button "已完成，用时 3秒" [ref=f1e163] [cursor=pointer]
        - generic [ref=f1e167]:
          - button "更新了目标，执行了 2 条命令，编辑了 9 个文件" [ref=f1e168] [cursor=pointer]
          - generic [ref=f1e171]:
            - generic [ref=f1e174]: 已允许一次
            - generic [ref=f1e175]: "· {"
          - generic [ref=f1e176]:
            - generic [ref=f1e179]: 已允许一次
            - generic [ref=f1e180]: "· {"
          - paragraph [ref=f1e183]: 全部完成：列目录、读 README、写 notes.txt、改 README。
          - generic [ref=f1e184]:
            - generic [ref=f1e189]:
              - text: 已编辑 2 个文件
              - generic [ref=f1e190]:
                - generic [ref=f1e191]: "+3"
                - generic [ref=f1e192]: "-1"
            - button "README.md +1 -1" [ref=f1e193] [cursor=pointer]:
              - generic [ref=f1e194]: README.md
              - generic [ref=f1e195]:
                - generic [ref=f1e196]: "+1"
                - generic [ref=f1e197]: "-1"
            - button "notes.txt +2 -0" [ref=f1e198] [cursor=pointer]:
              - generic [ref=f1e199]: notes.txt
              - generic [ref=f1e200]:
                - generic [ref=f1e201]: "+2"
                - generic [ref=f1e202]: "-0"
          - generic [ref=f1e203]:
            - button "复制回答" [ref=f1e204] [cursor=pointer]
            - button "带到…" [ref=f1e207] [cursor=pointer]
            - generic [ref=f1e210]: 用量 1.1k tok
      - generic [ref=f1e212]:
        - generic [ref=f1e213]:
          - paragraph [ref=f1e216]: 第二轮
          - generic [ref=f1e217]: 07:59
        - button "已完成，用时 3秒" [ref=f1e220] [cursor=pointer]
        - generic [ref=f1e224]:
          - button "更新了目标，执行了 3 条命令，编辑了 1 个文件" [ref=f1e225] [cursor=pointer]
          - generic [ref=f1e228]:
            - generic [ref=f1e231]: 已允许一次
            - generic [ref=f1e232]: "· {"
          - paragraph [ref=f1e235]: 修改 README.md 里的一行。
          - paragraph [ref=f1e238]: 记下这一轮的目标。
          - paragraph [ref=f1e241]: 把目标标成已完成。
          - paragraph [ref=f1e244]: 全部完成：列目录、读 README、写 notes.txt、改 README。
          - generic [ref=f1e245]:
            - generic [ref=f1e250]:
              - text: 已编辑 1 个文件
              - generic [ref=f1e251]:
                - generic [ref=f1e252]: "+2"
                - generic [ref=f1e253]: "-0"
            - button "notes.txt +2 -0" [ref=f1e254] [cursor=pointer]:
              - generic [ref=f1e255]: notes.txt
              - generic [ref=f1e256]:
                - generic [ref=f1e257]: "+2"
                - generic [ref=f1e258]: "-0"
            - generic [ref=f1e259]: 整文件写入，未取得原内容
          - generic [ref=f1e260]:
            - button "复制回答" [ref=f1e261] [cursor=pointer]
            - button "带到…" [ref=f1e264] [cursor=pointer]
            - generic [ref=f1e267]: 用量 2.4k tok
      - generic [ref=f1e269]:
        - generic [ref=f1e270]:
          - paragraph [ref=f1e273]: 回收之后再发一条
          - generic [ref=f1e274]: 07:59
        - button "已完成，用时 0秒" [ref=f1e277] [cursor=pointer]
        - generic [ref=f1e281]:
          - button "更新了目标" [ref=f1e282] [cursor=pointer]
          - paragraph [ref=f1e287]: 历史用户消息 54 条
          - generic [ref=f1e288]:
            - button "复制回答" [ref=f1e289] [cursor=pointer]
            - button "带到…" [ref=f1e292] [cursor=pointer]
            - generic [ref=f1e295]: 用量 40.0k tok
            - generic [ref=f1e296]: 07:59
    - generic [ref=f1e297]:
      - generic [ref=f1e300]:
        - strong [ref=f1e303]: 目标
        - generic [ref=f1e304]: 跑通 full 计划：列目录、读 README、写 notes.txt、改 README · 进行中
        - generic [ref=f1e305]: Codex 的目标
      - generic [ref=f1e306]:
        - generic [ref=f1e307]:
          - generic [ref=f1e308]: 消息
          - textbox "消息" [ref=f1e309]:
            - /placeholder: 发消息给 Codex，/ 调用它的指令，@ 引用文件或会话
          - generic [ref=f1e310]:
            - button "添加附件" [ref=f1e312] [cursor=pointer]
            - button "Codex 会话创建后固定" [ref=f1e316] [cursor=pointer]:
              - generic [aria-hidden] [ref=f1e317]: CX
              - generic [ref=f1e318]: Codex
              - img "会话创建后固定" [ref=f1e319]
            - button "只读" [ref=f1e322] [cursor=pointer]
            - button "gpt-6.1-sol Mock Responses" [ref=f1e329] [cursor=pointer]:
              - generic [ref=f1e330]: gpt-6.1-sol
              - generic [ref=f1e331]: Mock Responses
            - button "思考 medium" [ref=f1e335] [cursor=pointer]
            - button "停止" [ref=f1e339] [cursor=pointer]
        - generic [ref=f1e342]: 3 轮 · 8 步 · 206.9K tok
```

# Test source

```ts
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
> 145 |       await expect.poll(assistantText, { timeout: 120_000 }).toContain('历史用户消息 3 条');
      |                                                              ^ Error: expect(received).toContain(expected) // indexOf
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
  195 |     });
  196 |   }
  197 | });
  198 | 
```