# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: agents2.spec.ts >> 7.4 改动卡片与轮次 >> AG-codex-12 换模型
- Location: e2e-real/agents2.spec.ts:148:5

# Error details

```
Error: expect(received).toBeGreaterThan(expected)

Expected: > 0
Received:   0
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
      - link "换模型 运行中" [ref=f1e37] [cursor=pointer]:
        - /url: /s/01M76GYR1J5EG6M055PW379NVB
        - generic [aria-hidden] [ref=f1e38]: CX
        - generic [ref=f1e39]: 换模型
        - img "运行中" [ref=f1e41]
      - link "第一轮 待批准" [ref=f1e43] [cursor=pointer]:
        - /url: /s/01M76GTN494PQH438RFAFJB56K
        - generic [aria-hidden] [ref=f1e44]: CX
        - generic [ref=f1e45]: 第一轮
        - generic [ref=f1e46]: 待批准
      - link "第一轮 待批准" [ref=f1e47] [cursor=pointer]:
        - /url: /s/01M76GTECBDNCZ2KZ8SC60580Z
        - generic [aria-hidden] [ref=f1e48]: CX
        - generic [ref=f1e49]: 第一轮
        - generic [ref=f1e50]: 待批准
      - link "刷新一致性 待批准" [ref=f1e51] [cursor=pointer]:
        - /url: /s/01M76GT5R3YTMXS9WZR8AS1RWK
        - generic [aria-hidden] [ref=f1e52]: CX
        - generic [ref=f1e53]: 刷新一致性
        - generic [ref=f1e54]: 待批准
      - link "轮次检查 待批准" [ref=f1e55] [cursor=pointer]:
        - /url: /s/01M76GSYXWS7D3EYJFXQBT0KNG
        - generic [aria-hidden] [ref=f1e56]: CX
        - generic [ref=f1e57]: 轮次检查
        - generic [ref=f1e58]: 待批准
      - link "跑一遍 full 待批准" [ref=f1e59] [cursor=pointer]:
        - /url: /s/01M76GSREJH032XRVAVSZ4EHB5
        - generic [aria-hidden] [ref=f1e60]: CX
        - generic [ref=f1e61]: 跑一遍 full
        - generic [ref=f1e62]: 待批准
      - link "（辅助请求：不推进计划） 刚刚" [ref=f1e63] [cursor=pointer]:
        - /url: /s/01M76GSES90NPW9SJQM26JNJCD
        - generic [aria-hidden] [ref=f1e64]: DS
        - generic [ref=f1e65]: （辅助请求：不推进计划）
        - generic [ref=f1e66]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f1e67] [cursor=pointer]:
        - /url: /s/01M76GS5BSYWT72M8P8DSEVWGY
        - generic [aria-hidden] [ref=f1e68]: DS
        - generic [ref=f1e69]: （辅助请求：不推进计划）
        - generic [ref=f1e70]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f1e71] [cursor=pointer]:
        - /url: /s/01M76GS03ZWVYZQMRTB7WBBRE7
        - generic [aria-hidden] [ref=f1e72]: DS
        - generic [ref=f1e73]: （辅助请求：不推进计划）
        - generic [ref=f1e74]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f1e75] [cursor=pointer]:
        - /url: /s/01M76GRR6XBXN00SNH0R6XRT7R
        - generic [aria-hidden] [ref=f1e76]: DS
        - generic [ref=f1e77]: （辅助请求：不推进计划）
        - generic [ref=f1e78]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f1e79] [cursor=pointer]:
        - /url: /s/01M76GRJPYACQRE1GJ1BPDKRPG
        - generic [aria-hidden] [ref=f1e80]: DS
        - generic [ref=f1e81]: （辅助请求：不推进计划）
        - generic [ref=f1e82]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f1e83] [cursor=pointer]:
        - /url: /s/01M76GRD0RN917Z0K2EK388QH4
        - generic [aria-hidden] [ref=f1e84]: DS
        - generic [ref=f1e85]: （辅助请求：不推进计划）
        - generic [ref=f1e86]: 刚刚
      - link "流式 刚刚" [ref=f1e87] [cursor=pointer]:
        - /url: /s/01M76GR3NN5571F2TMZAWF20QV
        - generic [aria-hidden] [ref=f1e88]: CC
        - generic [ref=f1e89]: 流式
        - generic [ref=f1e90]: 刚刚
      - link "任务清单 刚刚" [ref=f1e91] [cursor=pointer]:
        - /url: /s/01M76GR5XN60APPTPHD3P2K9K5
        - generic [aria-hidden] [ref=f1e92]: CC
        - generic [ref=f1e93]: 任务清单
        - generic [ref=f1e94]: 刚刚
      - link "流式 刚刚" [ref=f1e95] [cursor=pointer]:
        - /url: /s/01M76GQSYQ0XYYZTXT9RNE8MCF
        - generic [aria-hidden] [ref=f1e96]: CX
        - generic [ref=f1e97]: 流式
        - generic [ref=f1e98]: 刚刚
      - link "跑一遍 full 刚刚" [ref=f1e99] [cursor=pointer]:
        - /url: /s/01M76GR1YZMMNAAN7X5CWF827C
        - generic [aria-hidden] [ref=f1e100]: CC
        - generic [ref=f1e101]: 跑一遍 full
        - generic [ref=f1e102]: 刚刚
      - link "任务清单 待批准" [ref=f1e103] [cursor=pointer]:
        - /url: /s/01M76GQVRHHZ9QKH0XGG1SHY6P
        - generic [aria-hidden] [ref=f1e104]: CX
        - generic [ref=f1e105]: 任务清单
        - generic [ref=f1e106]: 待批准
      - link "（辅助请求：不推进计划） 刚刚" [ref=f1e107] [cursor=pointer]:
        - /url: /s/01M76GQH2A95A97KGTPCW2AE4B
        - generic [aria-hidden] [ref=f1e108]: DS
        - generic [ref=f1e109]: （辅助请求：不推进计划）
        - generic [ref=f1e110]: 刚刚
      - link "跑一遍 full 刚刚" [ref=f1e111] [cursor=pointer]:
        - /url: /s/01M76GQR9MYGE76WFNGX4AAPPJ
        - generic [aria-hidden] [ref=f1e112]: CX
        - generic [ref=f1e113]: 跑一遍 full
        - generic [ref=f1e114]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f1e115] [cursor=pointer]:
        - /url: /s/01M76GQJRFX19Z486PQJS266J9
        - generic [aria-hidden] [ref=f1e116]: DS
        - generic [ref=f1e117]: （辅助请求：不推进计划）
        - generic [ref=f1e118]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f1e119] [cursor=pointer]:
        - /url: /s/01M76GQFRVW4XVQ27B8MFCD5X1
        - generic [aria-hidden] [ref=f1e120]: DS
        - generic [ref=f1e121]: （辅助请求：不推进计划）
        - generic [ref=f1e122]: 刚刚
    - generic [ref=f1e123]:
      - generic [ref=f1e124]:
        - generic [ref=f1e126]: DeepSeek Harness
        - generic [ref=f1e127]: 已连接本机 DSH
      - generic [ref=f1e128]:
        - generic [ref=f1e130]: Codex
        - generic [ref=f1e131]: 0.167.1
      - generic [ref=f1e132]:
        - generic [ref=f1e134]: Claude Code
        - generic [ref=f1e135]: 0.3.322
  - main [ref=f1e136]:
    - generic [ref=f1e137]:
      - generic [ref=f1e138]:
        - button "换模型" [ref=f1e139] [cursor=pointer]
        - generic "Codex · Mock Responses · gpt-6-astra" [ref=f1e140]:
          - generic [aria-hidden] [ref=f1e141]: CX
          - generic [ref=f1e142]: Codex
          - generic [ref=f1e143]: · Mock Responses · gpt-6-astra
        - generic [ref=f1e144]:
          - button "并排" [ref=f1e146] [cursor=pointer]
          - button "更多" [ref=f1e151] [cursor=pointer]
      - navigation "视图" [ref=f1e153]:
        - button "对话" [ref=f1e154] [cursor=pointer]
        - button "轨迹" [ref=f1e155] [cursor=pointer]
    - generic [ref=f1e157]:
      - generic [ref=f1e159]:
        - generic [ref=f1e160]:
          - paragraph [ref=f1e163]: 换模型
          - generic [ref=f1e164]: 08:01
        - button "已完成，用时 4秒" [ref=f1e167] [cursor=pointer]
        - generic [ref=f1e171]:
          - button "更新了目标，执行了 4 条命令，编辑了 9 个文件" [ref=f1e172] [cursor=pointer]
          - generic [ref=f1e175]:
            - generic [ref=f1e178]: 已允许一次
            - generic [ref=f1e179]: "· {"
          - generic [ref=f1e180]:
            - generic [ref=f1e183]: 已允许一次
            - generic [ref=f1e184]: "· {"
          - paragraph [ref=f1e187]: 全部完成：列目录、读 README、写 notes.txt、改 README。
          - generic [ref=f1e188]:
            - generic [ref=f1e193]:
              - text: 已编辑 2 个文件
              - generic [ref=f1e194]:
                - generic [ref=f1e195]: "+3"
                - generic [ref=f1e196]: "-1"
            - button "README.md +1 -1" [ref=f1e197] [cursor=pointer]:
              - generic [ref=f1e198]: README.md
              - generic [ref=f1e199]:
                - generic [ref=f1e200]: "+1"
                - generic [ref=f1e201]: "-1"
            - button "notes.txt +2 -0" [ref=f1e202] [cursor=pointer]:
              - generic [ref=f1e203]: notes.txt
              - generic [ref=f1e204]:
                - generic [ref=f1e205]: "+2"
                - generic [ref=f1e206]: "-0"
          - generic [ref=f1e207]:
            - button "复制回答" [ref=f1e208] [cursor=pointer]
            - button "带到…" [ref=f1e211] [cursor=pointer]
            - generic [ref=f1e214]: 用量 1.4k tok
      - generic [ref=f1e216]:
        - generic [ref=f1e217]:
          - paragraph [ref=f1e220]: 换模型之后再跑一轮
          - generic [ref=f1e221]: 08:01
        - generic [ref=f1e223]: 运行中…
        - generic [ref=f1e229]:
          - paragraph [ref=f1e232]: 先看一下工作区里有哪些文件。
          - button "运行命令 /bin/bash -lc 'ls -la'" [ref=f1e234] [cursor=pointer]:
            - generic [ref=f1e237]: 运行命令
            - generic [ref=f1e238]: /bin/bash -lc 'ls -la'
          - generic [ref=f1e242]:
            - generic [ref=f1e245]: 更新了目标
            - generic [ref=f1e246]: 跑通 full 计划：列目录、读 README、写 notes.txt、改 README
    - generic [ref=f1e247]:
      - generic [ref=f1e250]:
        - strong [ref=f1e253]: 目标
        - generic [ref=f1e254]: 跑通 full 计划：列目录、读 README、写 notes.txt、改 README · 进行中
        - generic [ref=f1e255]: Codex 的目标
      - generic [ref=f1e256]:
        - generic [ref=f1e257]:
          - generic [ref=f1e258]: 消息
          - textbox "消息" [ref=f1e259]:
            - /placeholder: 发消息给 Codex，/ 调用它的指令，@ 引用文件或会话
          - generic [ref=f1e260]:
            - button "添加附件" [ref=f1e262] [cursor=pointer]
            - button "Codex 会话创建后固定" [ref=f1e266] [cursor=pointer]:
              - generic [aria-hidden] [ref=f1e267]: CX
              - generic [ref=f1e268]: Codex
              - img "会话创建后固定" [ref=f1e269]
            - button "只读" [ref=f1e272] [cursor=pointer]
            - button "gpt-6-astra Mock Responses" [ref=f1e279] [cursor=pointer]:
              - generic [ref=f1e280]: gpt-6-astra
              - generic [ref=f1e281]: Mock Responses
            - button "思考 medium" [ref=f1e285] [cursor=pointer]
            - button "停止" [ref=f1e289] [cursor=pointer]
        - generic [ref=f1e292]: 2 轮 · 7 步 · 1.6K tok
```

# Test source

```ts
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
> 191 |       expect(requests.length).toBeGreaterThan(0);
      |                               ^ Error: expect(received).toBeGreaterThan(expected)
  192 |       const models = requests.map((request) => String((request.body as { model?: unknown }).model ?? ''));
  193 |       expect(models, `换模型后请求里的 model 应为 ${next}`).toContain(next);
  194 |       void before;
  195 |     });
  196 |   }
  197 | });
  198 | 
```