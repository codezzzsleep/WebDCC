# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: agents2.spec.ts >> 7.4 改动卡片与轮次 >> AG-claude-12 换模型
- Location: e2e-real/agents2.spec.ts:148:5

# Error details

```
Error: 换模型后请求里的 model 应为 mock-claude-b

expect(received).toContain(expected) // indexOf

Expected value: "mock-claude-b"
Received array: ["mock-claude-a", "mock-claude-a"]
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
      - link "换模型 刚刚" [ref=f1e37] [cursor=pointer]:
        - /url: /s/01M76H0XS7W0WZHBQP6J54ZCRH
        - generic [aria-hidden] [ref=f1e38]: CC
        - generic [ref=f1e39]: 换模型
        - generic [ref=f1e40]: 刚刚
      - link "第一轮 刚刚" [ref=f1e41] [cursor=pointer]:
        - /url: /s/01M76H0H05ME7DAF6J72GCB9TY
        - generic [aria-hidden] [ref=f1e42]: CC
        - generic [ref=f1e43]: 第一轮
        - generic [ref=f1e44]: 刚刚
      - link "第一轮 刚刚" [ref=f1e45] [cursor=pointer]:
        - /url: /s/01M76H06PYBT2TJMA7V20N2YZ5
        - generic [aria-hidden] [ref=f1e46]: CC
        - generic [ref=f1e47]: 第一轮
        - generic [ref=f1e48]: 刚刚
      - link "刷新一致性 刚刚" [ref=f1e49] [cursor=pointer]:
        - /url: /s/01M76GZRZGB63G7H0ARBBE6XXH
        - generic [aria-hidden] [ref=f1e50]: CC
        - generic [ref=f1e51]: 刷新一致性
        - generic [ref=f1e52]: 刚刚
      - link "轮次检查 刚刚" [ref=f1e53] [cursor=pointer]:
        - /url: /s/01M76GZEGZPSTCCXWBGTVZ1D47
        - generic [aria-hidden] [ref=f1e54]: CC
        - generic [ref=f1e55]: 轮次检查
        - generic [ref=f1e56]: 刚刚
      - link "跑一遍 full 刚刚" [ref=f1e57] [cursor=pointer]:
        - /url: /s/01M76GZ3ZA68200B8YB4QDV3EJ
        - generic [aria-hidden] [ref=f1e58]: CC
        - generic [ref=f1e59]: 跑一遍 full
        - generic [ref=f1e60]: 刚刚
      - link "换模型 待批准" [ref=f1e61] [cursor=pointer]:
        - /url: /s/01M76GYR1J5EG6M055PW379NVB
        - generic [aria-hidden] [ref=f1e62]: CX
        - generic [ref=f1e63]: 换模型
        - generic [ref=f1e64]: 待批准
      - link "第一轮 待批准" [ref=f1e65] [cursor=pointer]:
        - /url: /s/01M76GTN494PQH438RFAFJB56K
        - generic [aria-hidden] [ref=f1e66]: CX
        - generic [ref=f1e67]: 第一轮
        - generic [ref=f1e68]: 待批准
      - link "第一轮 待批准" [ref=f1e69] [cursor=pointer]:
        - /url: /s/01M76GTECBDNCZ2KZ8SC60580Z
        - generic [aria-hidden] [ref=f1e70]: CX
        - generic [ref=f1e71]: 第一轮
        - generic [ref=f1e72]: 待批准
      - link "刷新一致性 待批准" [ref=f1e73] [cursor=pointer]:
        - /url: /s/01M76GT5R3YTMXS9WZR8AS1RWK
        - generic [aria-hidden] [ref=f1e74]: CX
        - generic [ref=f1e75]: 刷新一致性
        - generic [ref=f1e76]: 待批准
      - link "轮次检查 待批准" [ref=f1e77] [cursor=pointer]:
        - /url: /s/01M76GSYXWS7D3EYJFXQBT0KNG
        - generic [aria-hidden] [ref=f1e78]: CX
        - generic [ref=f1e79]: 轮次检查
        - generic [ref=f1e80]: 待批准
      - link "跑一遍 full 待批准" [ref=f1e81] [cursor=pointer]:
        - /url: /s/01M76GSREJH032XRVAVSZ4EHB5
        - generic [aria-hidden] [ref=f1e82]: CX
        - generic [ref=f1e83]: 跑一遍 full
        - generic [ref=f1e84]: 待批准
      - link "（辅助请求：不推进计划） 刚刚" [ref=f1e85] [cursor=pointer]:
        - /url: /s/01M76GSES90NPW9SJQM26JNJCD
        - generic [aria-hidden] [ref=f1e86]: DS
        - generic [ref=f1e87]: （辅助请求：不推进计划）
        - generic [ref=f1e88]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f1e89] [cursor=pointer]:
        - /url: /s/01M76GS5BSYWT72M8P8DSEVWGY
        - generic [aria-hidden] [ref=f1e90]: DS
        - generic [ref=f1e91]: （辅助请求：不推进计划）
        - generic [ref=f1e92]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f1e93] [cursor=pointer]:
        - /url: /s/01M76GS03ZWVYZQMRTB7WBBRE7
        - generic [aria-hidden] [ref=f1e94]: DS
        - generic [ref=f1e95]: （辅助请求：不推进计划）
        - generic [ref=f1e96]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f1e97] [cursor=pointer]:
        - /url: /s/01M76GRR6XBXN00SNH0R6XRT7R
        - generic [aria-hidden] [ref=f1e98]: DS
        - generic [ref=f1e99]: （辅助请求：不推进计划）
        - generic [ref=f1e100]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f1e101] [cursor=pointer]:
        - /url: /s/01M76GRJPYACQRE1GJ1BPDKRPG
        - generic [aria-hidden] [ref=f1e102]: DS
        - generic [ref=f1e103]: （辅助请求：不推进计划）
        - generic [ref=f1e104]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f1e105] [cursor=pointer]:
        - /url: /s/01M76GRD0RN917Z0K2EK388QH4
        - generic [aria-hidden] [ref=f1e106]: DS
        - generic [ref=f1e107]: （辅助请求：不推进计划）
        - generic [ref=f1e108]: 刚刚
      - link "任务清单 刚刚" [ref=f1e109] [cursor=pointer]:
        - /url: /s/01M76GR5XN60APPTPHD3P2K9K5
        - generic [aria-hidden] [ref=f1e110]: CC
        - generic [ref=f1e111]: 任务清单
        - generic [ref=f1e112]: 刚刚
      - link "流式 刚刚" [ref=f1e113] [cursor=pointer]:
        - /url: /s/01M76GR3NN5571F2TMZAWF20QV
        - generic [aria-hidden] [ref=f1e114]: CC
        - generic [ref=f1e115]: 流式
        - generic [ref=f1e116]: 刚刚
      - link "跑一遍 full 刚刚" [ref=f1e117] [cursor=pointer]:
        - /url: /s/01M76GR1YZMMNAAN7X5CWF827C
        - generic [aria-hidden] [ref=f1e118]: CC
        - generic [ref=f1e119]: 跑一遍 full
        - generic [ref=f1e120]: 刚刚
      - link "流式 刚刚" [ref=f1e121] [cursor=pointer]:
        - /url: /s/01M76GQSYQ0XYYZTXT9RNE8MCF
        - generic [aria-hidden] [ref=f1e122]: CX
        - generic [ref=f1e123]: 流式
        - generic [ref=f1e124]: 刚刚
      - link "任务清单 待批准" [ref=f1e125] [cursor=pointer]:
        - /url: /s/01M76GQVRHHZ9QKH0XGG1SHY6P
        - generic [aria-hidden] [ref=f1e126]: CX
        - generic [ref=f1e127]: 任务清单
        - generic [ref=f1e128]: 待批准
      - link "（辅助请求：不推进计划） 刚刚" [ref=f1e129] [cursor=pointer]:
        - /url: /s/01M76GQH2A95A97KGTPCW2AE4B
        - generic [aria-hidden] [ref=f1e130]: DS
        - generic [ref=f1e131]: （辅助请求：不推进计划）
        - generic [ref=f1e132]: 刚刚
      - link "跑一遍 full 刚刚" [ref=f1e133] [cursor=pointer]:
        - /url: /s/01M76GQR9MYGE76WFNGX4AAPPJ
        - generic [aria-hidden] [ref=f1e134]: CX
        - generic [ref=f1e135]: 跑一遍 full
        - generic [ref=f1e136]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f1e137] [cursor=pointer]:
        - /url: /s/01M76GQJRFX19Z486PQJS266J9
        - generic [aria-hidden] [ref=f1e138]: DS
        - generic [ref=f1e139]: （辅助请求：不推进计划）
        - generic [ref=f1e140]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f1e141] [cursor=pointer]:
        - /url: /s/01M76GQFRVW4XVQ27B8MFCD5X1
        - generic [aria-hidden] [ref=f1e142]: DS
        - generic [ref=f1e143]: （辅助请求：不推进计划）
        - generic [ref=f1e144]: 刚刚
    - generic [ref=f1e145]:
      - generic [ref=f1e146]:
        - generic [ref=f1e148]: DeepSeek Harness
        - generic [ref=f1e149]: 已连接本机 DSH
      - generic [ref=f1e150]:
        - generic [ref=f1e152]: Codex
        - generic [ref=f1e153]: 0.167.1
      - generic [ref=f1e154]:
        - generic [ref=f1e156]: Claude Code
        - generic [ref=f1e157]: 0.3.322
  - main [ref=f1e158]:
    - generic [ref=f1e159]:
      - generic [ref=f1e160]:
        - button "换模型" [ref=f1e161] [cursor=pointer]
        - generic "Claude Code · Claude 设置里的端点 · mock-claude-b" [ref=f1e162]:
          - generic [aria-hidden] [ref=f1e163]: CC
          - generic [ref=f1e164]: Claude Code
          - generic [ref=f1e165]: · Claude 设置里的端点 · mock-claude-b
        - generic [ref=f1e166]:
          - button "并排" [ref=f1e168] [cursor=pointer]
          - button "更多" [ref=f1e173] [cursor=pointer]
      - navigation "视图" [ref=f1e175]:
        - button "对话" [ref=f1e176] [cursor=pointer]
        - button "轨迹" [ref=f1e177] [cursor=pointer]
    - generic [ref=f1e179]:
      - generic [ref=f1e181]:
        - generic [ref=f1e182]:
          - paragraph [ref=f1e185]: 换模型
          - generic [ref=f1e186]: 08:02
        - button "已完成，用时 3秒" [ref=f1e189] [cursor=pointer]
        - generic [ref=f1e193]:
          - button "执行了 1 条命令，读取了 1 个文件，编辑了 2 个文件" [ref=f1e194] [cursor=pointer]
          - generic [ref=f1e197]:
            - generic [ref=f1e200]: 已允许一次
            - generic [ref=f1e201]: · /tmp/wdcc-accept-rmwcs3zxi-ccTPlR/ws/sample-repo/notes.txt
          - generic [ref=f1e202]:
            - generic [ref=f1e205]: 已允许一次
            - generic [ref=f1e206]: · /tmp/wdcc-accept-rmwcs3zxi-ccTPlR/ws/sample-repo/README.md
          - paragraph [ref=f1e209]: 全部完成：列目录、读 README、写 notes.txt、改 README。
          - generic [ref=f1e210]:
            - generic [ref=f1e215]:
              - text: 已编辑 2 个文件
              - generic [ref=f1e216]:
                - generic [ref=f1e217]: "+3"
                - generic [ref=f1e218]: "-1"
            - button "./notes.txt +2 -0" [ref=f1e219] [cursor=pointer]:
              - generic [ref=f1e220]: ./notes.txt
              - generic [ref=f1e221]:
                - generic [ref=f1e222]: "+2"
                - generic [ref=f1e223]: "-0"
            - button "./README.md +1 -1" [ref=f1e224] [cursor=pointer]:
              - generic [ref=f1e225]: ./README.md
              - generic [ref=f1e226]:
                - generic [ref=f1e227]: "+1"
                - generic [ref=f1e228]: "-1"
            - generic [ref=f1e229]: 整文件写入，未取得原内容
          - generic [ref=f1e230]:
            - button "复制回答" [ref=f1e231] [cursor=pointer]
            - button "带到…" [ref=f1e234] [cursor=pointer]
      - generic [ref=f1e238]:
        - generic [ref=f1e239]:
          - paragraph [ref=f1e242]: 换模型之后再跑一轮
          - generic [ref=f1e243]: 08:02
        - button "已完成，用时 0秒" [ref=f1e246] [cursor=pointer]
        - generic [ref=f1e250]:
          - button "执行了 1 条命令" [ref=f1e251] [cursor=pointer]
          - paragraph [ref=f1e256]: （脚本化假模型：计划已回放完毕）
          - generic [ref=f1e257]:
            - button "复制回答" [ref=f1e258] [cursor=pointer]
            - button "带到…" [ref=f1e261] [cursor=pointer]
            - generic [ref=f1e264]: 08:02
    - generic [ref=f1e266]:
      - generic [ref=f1e267]:
        - generic [ref=f1e268]: 消息
        - textbox "消息" [ref=f1e269]:
          - /placeholder: 发消息给 Claude Code，/ 调用它的指令，@ 引用文件或会话
        - generic [ref=f1e270]:
          - button "添加附件" [ref=f1e272] [cursor=pointer]
          - button "Claude Code 会话创建后固定" [ref=f1e276] [cursor=pointer]:
            - generic [aria-hidden] [ref=f1e277]: CC
            - generic [ref=f1e278]: Claude Code
            - img "会话创建后固定" [ref=f1e279]
          - button "默认（每次询问）" [ref=f1e282] [cursor=pointer]
          - button "mock-claude-b Claude 设置里的端点" [ref=f1e289] [cursor=pointer]:
            - generic [ref=f1e290]: mock-claude-b
            - generic [ref=f1e291]: Claude 设置里的端点
          - button "发送" [disabled] [ref=f1e294]
      - generic [ref=f1e297]: 2 轮 · 5 步
```

# Test source

```ts
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
  191 |       expect(requests.length).toBeGreaterThan(0);
  192 |       const models = requests.map((request) => String((request.body as { model?: unknown }).model ?? ''));
> 193 |       expect(models, `换模型后请求里的 model 应为 ${next}`).toContain(next);
      |                                                   ^ Error: 换模型后请求里的 model 应为 mock-claude-b
  194 |       void before;
  195 |     });
  196 |   }
  197 | });
  198 | 
```