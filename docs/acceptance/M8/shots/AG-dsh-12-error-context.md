# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: agents2.spec.ts >> 7.4 改动卡片与轮次 >> AG-dsh-12 换模型
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
      - generic "/tmp/wdcc-accept-rmwckla75-ocjTuA/ws/sample-repo" [ref=f1e30]:
        - generic [ref=f1e33]: sample-repo
        - link "在 sample-repo 新建会话" [ref=f1e34] [cursor=pointer]:
          - /url: /new?w=01M764P1CDD3J2QM8D34GDZ8FC
      - link "（辅助请求：不推进计划） 运行中" [ref=f1e37] [cursor=pointer]:
        - /url: /s/01M764P88JX16KVBMRACQ1ABGX
        - generic [aria-hidden] [ref=f1e38]: DS
        - generic [ref=f1e39]: （辅助请求：不推进计划）
        - img "运行中" [ref=f1e41]
      - link "（辅助请求：不推进计划） 刚刚" [ref=f1e43] [cursor=pointer]:
        - /url: /s/01M764P2ZXA8ZXGHDPQ6K5SRY6
        - generic [aria-hidden] [ref=f1e44]: DS
        - generic [ref=f1e45]: （辅助请求：不推进计划）
        - generic [ref=f1e46]: 刚刚
    - generic [ref=f1e47]:
      - generic [ref=f1e48]:
        - generic [ref=f1e50]: DeepSeek Harness
        - generic [ref=f1e51]: 已连接本机 DSH
      - generic [ref=f1e52]:
        - generic [ref=f1e54]: Codex
        - generic [ref=f1e55]: 0.167.0
      - generic [ref=f1e56]:
        - generic [ref=f1e58]: Claude Code
        - generic [ref=f1e59]: 0.3.322
  - main [ref=f1e60]:
    - generic [ref=f1e61]:
      - generic [ref=f1e62]:
        - button "（辅助请求：不推进计划）" [ref=f1e63] [cursor=pointer]
        - generic "DeepSeek Harness · deepseek-v4-pro" [ref=f1e64]:
          - generic [aria-hidden] [ref=f1e65]: DS
          - generic [ref=f1e66]: DeepSeek Harness
          - generic [ref=f1e67]: · deepseek-v4-pro
        - generic [ref=f1e68]:
          - button "并排" [ref=f1e70] [cursor=pointer]
          - button "更多" [ref=f1e75] [cursor=pointer]
      - navigation "视图" [ref=f1e77]:
        - button "对话" [ref=f1e78] [cursor=pointer]
        - button "轨迹" [ref=f1e79] [cursor=pointer]
    - generic [ref=f1e81]:
      - generic [ref=f1e83]:
        - generic [ref=f1e84]:
          - paragraph [ref=f1e87]: 换模型
          - generic [ref=f1e88]: 04:27
        - button "已完成，用时 3秒" [ref=f1e91] [cursor=pointer]
        - generic [ref=f1e95]:
          - button "更新了计划，执行了 1 条命令，读取了 1 个文件，编辑了 2 个文件，调用了 1 次工具" [ref=f1e96] [cursor=pointer]
          - paragraph [ref=f1e101]: 全部完成：列目录、读 README、写 notes.txt、改 README、更新任务清单。
          - generic [ref=f1e102]:
            - generic [ref=f1e107]:
              - text: 已编辑 2 个文件
              - generic [ref=f1e108]:
                - generic [ref=f1e109]: "+3"
                - generic [ref=f1e110]: "-1"
            - button "./notes.txt +2 -0" [ref=f1e111] [cursor=pointer]:
              - generic [ref=f1e112]: ./notes.txt
              - generic [ref=f1e113]:
                - generic [ref=f1e114]: "+2"
                - generic [ref=f1e115]: "-0"
            - button "./README.md +1 -1" [ref=f1e116] [cursor=pointer]:
              - generic [ref=f1e117]: ./README.md
              - generic [ref=f1e118]:
                - generic [ref=f1e119]: "+1"
                - generic [ref=f1e120]: "-1"
            - generic [ref=f1e121]: 整文件写入，未取得原内容
          - generic [ref=f1e122]:
            - button "复制回答" [ref=f1e123] [cursor=pointer]
            - button "带到…" [ref=f1e126] [cursor=pointer]
            - generic [ref=f1e129]: 用量 160 tok
      - generic [ref=f1e131]:
        - generic [ref=f1e132]:
          - paragraph [ref=f1e135]: 换模型之后再跑一轮
          - generic [ref=f1e136]: 04:27
        - generic [ref=f1e138]: 运行中…
    - generic [ref=f1e144]:
      - button "任务 1 已完成 · 1 进行中 · 0 待处理 DeepSeek Harness" [ref=f1e147] [cursor=pointer]:
        - strong [ref=f1e150]: 任务
        - generic [ref=f1e151]: 1 已完成 · 1 进行中 · 0 待处理
        - generic [ref=f1e152]: DeepSeek Harness
      - generic [ref=f1e155]:
        - generic [ref=f1e156]:
          - generic [ref=f1e157]: 消息
          - textbox "消息" [ref=f1e158]:
            - /placeholder: 发消息给 DeepSeek Harness，/ 调用它的指令，@ 引用文件或会话
          - generic [ref=f1e159]:
            - button "添加附件" [ref=f1e161] [cursor=pointer]
            - button "DeepSeek Harness 会话创建后固定" [ref=f1e165] [cursor=pointer]:
              - generic [aria-hidden] [ref=f1e166]: DS
              - generic [ref=f1e167]: DeepSeek Harness
              - img "会话创建后固定" [ref=f1e168]
            - button "仅可查看" [ref=f1e171] [cursor=pointer]
            - button "deepseek-v4-pro DSH Provider" [ref=f1e178] [cursor=pointer]:
              - generic [ref=f1e179]: deepseek-v4-pro
              - generic [ref=f1e180]: DSH Provider
            - button "停止" [ref=f1e183] [cursor=pointer]
        - generic [ref=f1e186]: 2 轮 · 5 步 · 160 tok
```

# Test source

```ts
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
  186 |       const api = agent === 'codex' ? app.mockResponses : agent === 'claude' ? app.mockClaude : app.mockDsh;
  187 |       const requests = (await api.requests()).filter((request) => request.helper !== true);
> 188 |       expect(requests.length).toBeGreaterThan(0);
      |                               ^ Error: expect(received).toBeGreaterThan(expected)
  189 |       const models = requests.map((request) => String((request.body as { model?: unknown }).model ?? ''));
  190 |       expect(models, `换模型后请求里的 model 应为 ${next}`).toContain(next);
  191 |       void before;
  192 |     });
  193 |   }
  194 | });
  195 | 
```