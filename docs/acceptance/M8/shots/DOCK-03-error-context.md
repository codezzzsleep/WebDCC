# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: dock.spec.ts >> 7.8 停靠区 >> DOCK-03 改动卡片打开 diff 标签、文件标签与直接地址
- Location: e2e-real/dock.spec.ts:43:3

# Error details

```
Error: 页面不应有错误

expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 3

- Array []
+ Array [
+   "console.error: Failed to load resource: the server responded with a status of 404 (Not Found)",
+ ]
```

# Page snapshot

```yaml
- generic [ref=f3e3]:
  - complementary "会话" [ref=f3e4]:
    - generic [ref=f3e5]:
      - link "WebDCC 首页" [ref=f3e6] [cursor=pointer]:
        - /url: /
        - generic [ref=f3e7]: WebDCC
        - generic [ref=f3e8]: 3 HARNESS
      - button "收起侧边栏" [ref=f3e9] [cursor=pointer]
    - link "新会话" [ref=f3e12] [cursor=pointer]:
      - /url: /new
    - navigation [ref=f3e15]:
      - link "Agent 与 Provider" [ref=f3e16] [cursor=pointer]:
        - /url: /settings/providers
    - generic [ref=f3e19]:
      - generic [ref=f3e20]: 工作区
      - generic [ref=f3e21]:
        - button "搜索会话" [ref=f3e22] [cursor=pointer]
        - button "添加工作区" [ref=f3e25] [cursor=pointer]
    - generic [ref=f3e29]:
      - generic "/tmp/wdcc-accept-rmwcs3zxi-ccTPlR/ws/sample-repo" [ref=f3e30]:
        - generic [ref=f3e33]: sample-repo
        - link "在 sample-repo 新建会话" [ref=f3e34] [cursor=pointer]:
          - /url: /new?w=01M76GQE0HPYQGJYM0ZXGYQKG6
      - link "diff 标签 刚刚" [ref=f3e37] [cursor=pointer]:
        - /url: /s/01M76H506Q86EZG616Q0E71316
        - generic [aria-hidden] [ref=f3e38]: CC
        - generic [ref=f3e39]: diff 标签
        - generic [ref=f3e40]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f3e41] [cursor=pointer]:
        - /url: /s/01M76H43QSV4RQYNK9BWEX7AZD
        - generic [aria-hidden] [ref=f3e42]: DS
        - generic [ref=f3e43]: （辅助请求：不推进计划）
        - generic [ref=f3e44]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f3e45] [cursor=pointer]:
        - /url: /s/01M76H3WS9VA51A6BC1PFTACTS
        - generic [aria-hidden] [ref=f3e46]: DS
        - generic [ref=f3e47]: （辅助请求：不推进计划）
        - generic [ref=f3e48]: 刚刚
      - link "停止测试 刚刚" [ref=f3e49] [cursor=pointer]:
        - /url: /s/01M76H3FEKV1QGWJJSN934MXTS
        - generic [aria-hidden] [ref=f3e50]: CC
        - generic [ref=f3e51]: 停止测试
        - generic [ref=f3e52]: 刚刚
      - link "审批：拒绝 刚刚" [ref=f3e53] [cursor=pointer]:
        - /url: /s/01M76H37B47Q3V5QST9HJPWBR8
        - generic [aria-hidden] [ref=f3e54]: CC
        - generic [ref=f3e55]: 审批：拒绝
        - generic [ref=f3e56]: 刚刚
      - link "审批：允许一次 刚刚" [ref=f3e57] [cursor=pointer]:
        - /url: /s/01M76H2Z78237AR7SJCW22RDX5
        - generic [aria-hidden] [ref=f3e58]: CC
        - generic [ref=f3e59]: 审批：允许一次
        - generic [ref=f3e60]: 刚刚
      - link "停止测试 刚刚" [ref=f3e61] [cursor=pointer]:
        - /url: /s/01M76H2JM2Y501Y0RNH5JX857M
        - generic [aria-hidden] [ref=f3e62]: CX
        - generic [ref=f3e63]: 停止测试
        - generic [ref=f3e64]: 刚刚
      - link "审批：拒绝 刚刚" [ref=f3e65] [cursor=pointer]:
        - /url: /s/01M76H2A6KE5XRNPK6KCNB2T7R
        - generic [aria-hidden] [ref=f3e66]: CX
        - generic [ref=f3e67]: 审批：拒绝
        - generic [ref=f3e68]: 刚刚
      - link "审批：允许一次 刚刚" [ref=f3e69] [cursor=pointer]:
        - /url: /s/01M76H234JD95W2KKEX4X67KFC
        - generic [aria-hidden] [ref=f3e70]: CX
        - generic [ref=f3e71]: 审批：允许一次
        - generic [ref=f3e72]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f3e73] [cursor=pointer]:
        - /url: /s/01M76H1QTRAQ0MJPMAFBBP3DYW
        - generic [aria-hidden] [ref=f3e74]: DS
        - generic [ref=f3e75]: （辅助请求：不推进计划）
        - generic [ref=f3e76]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f3e77] [cursor=pointer]:
        - /url: /s/01M76H1GDDMKNX69VW3HQNMVPK
        - generic [aria-hidden] [ref=f3e78]: DS
        - generic [ref=f3e79]: （辅助请求：不推进计划）
        - generic [ref=f3e80]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f3e81] [cursor=pointer]:
        - /url: /s/01M76H18YFX6M01C5HX3NJEGRZ
        - generic [aria-hidden] [ref=f3e82]: DS
        - generic [ref=f3e83]: （辅助请求：不推进计划）
        - generic [ref=f3e84]: 刚刚
      - link "换模型 刚刚" [ref=f3e85] [cursor=pointer]:
        - /url: /s/01M76H0XS7W0WZHBQP6J54ZCRH
        - generic [aria-hidden] [ref=f3e86]: CC
        - generic [ref=f3e87]: 换模型
        - generic [ref=f3e88]: 刚刚
      - link "第一轮 刚刚" [ref=f3e89] [cursor=pointer]:
        - /url: /s/01M76H0H05ME7DAF6J72GCB9TY
        - generic [aria-hidden] [ref=f3e90]: CC
        - generic [ref=f3e91]: 第一轮
        - generic [ref=f3e92]: 刚刚
      - link "第一轮 刚刚" [ref=f3e93] [cursor=pointer]:
        - /url: /s/01M76H06PYBT2TJMA7V20N2YZ5
        - generic [aria-hidden] [ref=f3e94]: CC
        - generic [ref=f3e95]: 第一轮
        - generic [ref=f3e96]: 刚刚
      - link "刷新一致性 刚刚" [ref=f3e97] [cursor=pointer]:
        - /url: /s/01M76GZRZGB63G7H0ARBBE6XXH
        - generic [aria-hidden] [ref=f3e98]: CC
        - generic [ref=f3e99]: 刷新一致性
        - generic [ref=f3e100]: 刚刚
      - link "轮次检查 刚刚" [ref=f3e101] [cursor=pointer]:
        - /url: /s/01M76GZEGZPSTCCXWBGTVZ1D47
        - generic [aria-hidden] [ref=f3e102]: CC
        - generic [ref=f3e103]: 轮次检查
        - generic [ref=f3e104]: 刚刚
      - link "跑一遍 full 刚刚" [ref=f3e105] [cursor=pointer]:
        - /url: /s/01M76GZ3ZA68200B8YB4QDV3EJ
        - generic [aria-hidden] [ref=f3e106]: CC
        - generic [ref=f3e107]: 跑一遍 full
        - generic [ref=f3e108]: 刚刚
      - link "换模型 待批准" [ref=f3e109] [cursor=pointer]:
        - /url: /s/01M76GYR1J5EG6M055PW379NVB
        - generic [aria-hidden] [ref=f3e110]: CX
        - generic [ref=f3e111]: 换模型
        - generic [ref=f3e112]: 待批准
      - link "第一轮 待批准" [ref=f3e113] [cursor=pointer]:
        - /url: /s/01M76GTN494PQH438RFAFJB56K
        - generic [aria-hidden] [ref=f3e114]: CX
        - generic [ref=f3e115]: 第一轮
        - generic [ref=f3e116]: 待批准
      - link "第一轮 待批准" [ref=f3e117] [cursor=pointer]:
        - /url: /s/01M76GTECBDNCZ2KZ8SC60580Z
        - generic [aria-hidden] [ref=f3e118]: CX
        - generic [ref=f3e119]: 第一轮
        - generic [ref=f3e120]: 待批准
      - link "刷新一致性 待批准" [ref=f3e121] [cursor=pointer]:
        - /url: /s/01M76GT5R3YTMXS9WZR8AS1RWK
        - generic [aria-hidden] [ref=f3e122]: CX
        - generic [ref=f3e123]: 刷新一致性
        - generic [ref=f3e124]: 待批准
      - link "轮次检查 待批准" [ref=f3e125] [cursor=pointer]:
        - /url: /s/01M76GSYXWS7D3EYJFXQBT0KNG
        - generic [aria-hidden] [ref=f3e126]: CX
        - generic [ref=f3e127]: 轮次检查
        - generic [ref=f3e128]: 待批准
      - link "跑一遍 full 待批准" [ref=f3e129] [cursor=pointer]:
        - /url: /s/01M76GSREJH032XRVAVSZ4EHB5
        - generic [aria-hidden] [ref=f3e130]: CX
        - generic [ref=f3e131]: 跑一遍 full
        - generic [ref=f3e132]: 待批准
      - link "（辅助请求：不推进计划） 刚刚" [ref=f3e133] [cursor=pointer]:
        - /url: /s/01M76GSES90NPW9SJQM26JNJCD
        - generic [aria-hidden] [ref=f3e134]: DS
        - generic [ref=f3e135]: （辅助请求：不推进计划）
        - generic [ref=f3e136]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f3e137] [cursor=pointer]:
        - /url: /s/01M76GS5BSYWT72M8P8DSEVWGY
        - generic [aria-hidden] [ref=f3e138]: DS
        - generic [ref=f3e139]: （辅助请求：不推进计划）
        - generic [ref=f3e140]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f3e141] [cursor=pointer]:
        - /url: /s/01M76GS03ZWVYZQMRTB7WBBRE7
        - generic [aria-hidden] [ref=f3e142]: DS
        - generic [ref=f3e143]: （辅助请求：不推进计划）
        - generic [ref=f3e144]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f3e145] [cursor=pointer]:
        - /url: /s/01M76GRR6XBXN00SNH0R6XRT7R
        - generic [aria-hidden] [ref=f3e146]: DS
        - generic [ref=f3e147]: （辅助请求：不推进计划）
        - generic [ref=f3e148]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f3e149] [cursor=pointer]:
        - /url: /s/01M76GRJPYACQRE1GJ1BPDKRPG
        - generic [aria-hidden] [ref=f3e150]: DS
        - generic [ref=f3e151]: （辅助请求：不推进计划）
        - generic [ref=f3e152]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f3e153] [cursor=pointer]:
        - /url: /s/01M76GRD0RN917Z0K2EK388QH4
        - generic [aria-hidden] [ref=f3e154]: DS
        - generic [ref=f3e155]: （辅助请求：不推进计划）
        - generic [ref=f3e156]: 刚刚
      - link "流式 刚刚" [ref=f3e157] [cursor=pointer]:
        - /url: /s/01M76GR3NN5571F2TMZAWF20QV
        - generic [aria-hidden] [ref=f3e158]: CC
        - generic [ref=f3e159]: 流式
        - generic [ref=f3e160]: 刚刚
      - link "任务清单 刚刚" [ref=f3e161] [cursor=pointer]:
        - /url: /s/01M76GR5XN60APPTPHD3P2K9K5
        - generic [aria-hidden] [ref=f3e162]: CC
        - generic [ref=f3e163]: 任务清单
        - generic [ref=f3e164]: 刚刚
      - link "流式 刚刚" [ref=f3e165] [cursor=pointer]:
        - /url: /s/01M76GQSYQ0XYYZTXT9RNE8MCF
        - generic [aria-hidden] [ref=f3e166]: CX
        - generic [ref=f3e167]: 流式
        - generic [ref=f3e168]: 刚刚
      - link "跑一遍 full 刚刚" [ref=f3e169] [cursor=pointer]:
        - /url: /s/01M76GR1YZMMNAAN7X5CWF827C
        - generic [aria-hidden] [ref=f3e170]: CC
        - generic [ref=f3e171]: 跑一遍 full
        - generic [ref=f3e172]: 刚刚
      - link "任务清单 待批准" [ref=f3e173] [cursor=pointer]:
        - /url: /s/01M76GQVRHHZ9QKH0XGG1SHY6P
        - generic [aria-hidden] [ref=f3e174]: CX
        - generic [ref=f3e175]: 任务清单
        - generic [ref=f3e176]: 待批准
      - link "（辅助请求：不推进计划） 刚刚" [ref=f3e177] [cursor=pointer]:
        - /url: /s/01M76GQH2A95A97KGTPCW2AE4B
        - generic [aria-hidden] [ref=f3e178]: DS
        - generic [ref=f3e179]: （辅助请求：不推进计划）
        - generic [ref=f3e180]: 刚刚
      - link "跑一遍 full 刚刚" [ref=f3e181] [cursor=pointer]:
        - /url: /s/01M76GQR9MYGE76WFNGX4AAPPJ
        - generic [aria-hidden] [ref=f3e182]: CX
        - generic [ref=f3e183]: 跑一遍 full
        - generic [ref=f3e184]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f3e185] [cursor=pointer]:
        - /url: /s/01M76GQJRFX19Z486PQJS266J9
        - generic [aria-hidden] [ref=f3e186]: DS
        - generic [ref=f3e187]: （辅助请求：不推进计划）
        - generic [ref=f3e188]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f3e189] [cursor=pointer]:
        - /url: /s/01M76GQFRVW4XVQ27B8MFCD5X1
        - generic [aria-hidden] [ref=f3e190]: DS
        - generic [ref=f3e191]: （辅助请求：不推进计划）
        - generic [ref=f3e192]: 刚刚
    - generic [ref=f3e193]:
      - generic [ref=f3e194]:
        - generic [ref=f3e196]: DeepSeek Harness
        - generic [ref=f3e197]: 已连接本机 DSH
      - generic [ref=f3e198]:
        - generic [ref=f3e200]: Codex
        - generic [ref=f3e201]: 0.167.1
      - generic [ref=f3e202]:
        - generic [ref=f3e204]: Claude Code
        - generic [ref=f3e205]: 0.3.322
  - main [ref=f3e206]:
    - generic [ref=f3e207]:
      - generic [ref=f3e208]:
        - button "diff 标签" [ref=f3e209] [cursor=pointer]
        - generic "Claude Code · Claude 设置里的端点 · mock-claude-a" [ref=f3e210]:
          - generic [aria-hidden] [ref=f3e211]: CC
          - generic [ref=f3e212]: Claude Code
          - generic [ref=f3e213]: · Claude 设置里的端点 · mock-claude-a
        - generic [ref=f3e214]:
          - button "并排" [ref=f3e216] [cursor=pointer]
          - button "更多" [ref=f3e221] [cursor=pointer]
      - navigation "视图" [ref=f3e223]:
        - button "对话" [ref=f3e224] [cursor=pointer]
        - button "轨迹" [ref=f3e225] [cursor=pointer]
    - generic [ref=f3e229]:
      - generic [ref=f3e230]:
        - paragraph [ref=f3e233]: diff 标签
        - generic [ref=f3e234]: 08:05
      - button "已完成，用时 5秒" [ref=f3e237] [cursor=pointer]
      - generic [ref=f3e241]:
        - button "执行了 1 条命令，读取了 1 个文件，编辑了 2 个文件" [ref=f3e242] [cursor=pointer]
        - generic [ref=f3e245]:
          - generic [ref=f3e248]: 已允许一次
          - generic [ref=f3e249]: · /tmp/wdcc-accept-rmwcs3zxi-ccTPlR/ws/sample-repo/notes.txt
        - generic [ref=f3e250]:
          - generic [ref=f3e253]: 已允许一次
          - generic [ref=f3e254]: · /tmp/wdcc-accept-rmwcs3zxi-ccTPlR/ws/sample-repo/README.md
        - paragraph [ref=f3e257]: 全部完成：列目录、读 README、写 notes.txt、改 README。
        - generic [ref=f3e258]:
          - generic [ref=f3e263]:
            - text: 已编辑 2 个文件
            - generic [ref=f3e264]:
              - generic [ref=f3e265]: "+3"
              - generic [ref=f3e266]: "-1"
          - button "./notes.txt +2 -0" [ref=f3e267] [cursor=pointer]:
            - generic [ref=f3e268]: ./notes.txt
            - generic [ref=f3e269]:
              - generic [ref=f3e270]: "+2"
              - generic [ref=f3e271]: "-0"
          - button "./README.md +1 -1" [ref=f3e272] [cursor=pointer]:
            - generic [ref=f3e273]: ./README.md
            - generic [ref=f3e274]:
              - generic [ref=f3e275]: "+1"
              - generic [ref=f3e276]: "-1"
          - generic [ref=f3e277]: 整文件写入，未取得原内容
        - generic [ref=f3e278]:
          - button "复制回答" [ref=f3e279] [cursor=pointer]
          - button "带到…" [ref=f3e282] [cursor=pointer]
          - generic [ref=f3e285]: 08:05
    - generic [ref=f3e287]:
      - generic [ref=f3e288]:
        - generic [ref=f3e289]: 消息
        - textbox "消息" [ref=f3e290]:
          - /placeholder: 发消息给 Claude Code，/ 调用它的指令，@ 引用文件或会话
        - generic [ref=f3e291]:
          - button "添加附件" [ref=f3e293] [cursor=pointer]
          - button "Claude Code 会话创建后固定" [ref=f3e297] [cursor=pointer]:
            - generic [aria-hidden] [ref=f3e298]: CC
            - generic [ref=f3e299]: Claude Code
            - img "会话创建后固定" [ref=f3e300]
          - button "默认（每次询问）" [ref=f3e303] [cursor=pointer]
          - button "mock-claude-a" [ref=f3e310] [cursor=pointer]
          - button "发送" [disabled] [ref=f3e314]
      - generic [ref=f3e317]: 1 轮 · 4 步
  - complementary "停靠区" [ref=f3e319]:
    - generic [ref=f3e320]:
      - generic [ref=f3e323]: 工作区文件
      - button "关闭停靠区" [ref=f3e324] [cursor=pointer]
    - generic [ref=f3e328]:
      - button "工作区" [ref=f3e330] [cursor=pointer]
      - generic [ref=f3e331]:
        - button "新建文件" [ref=f3e332] [cursor=pointer]
        - button "新建文件夹" [ref=f3e333] [cursor=pointer]
      - list [ref=f3e334]:
        - listitem [ref=f3e335]:
          - button ".git" [ref=f3e336] [cursor=pointer]
        - listitem [ref=f3e339]:
          - button "src" [ref=f3e340] [cursor=pointer]
        - listitem [ref=f3e343]:
          - button "AGENTS.md" [ref=f3e344] [cursor=pointer]
        - listitem [ref=f3e347]:
          - button "CLAUDE.md" [ref=f3e348] [cursor=pointer]
        - listitem [ref=f3e351]:
          - button "notes.txt" [ref=f3e352] [cursor=pointer]
        - listitem [ref=f3e355]:
          - button "README.md" [ref=f3e356] [cursor=pointer]
        - listitem [ref=f3e359]:
          - button "SPEC.md" [ref=f3e360] [cursor=pointer]
```

# Test source

```ts
  156 | 
  157 | const approvals: { tool: string; at: number }[] = [];
  158 | 
  159 | /** 工作区 fixture 复位：git reset --hard && git clean -xfd（SPEC-M8 6.2） */
  160 | export function resetWorkspace(): void {
  161 |   const repo = join(run.root, 'ws/sample-repo');
  162 |   try {
  163 |     execFileSync('git', ['reset', '--hard', '-q'], { cwd: repo });
  164 |     execFileSync('git', ['clean', '-xfdq'], { cwd: repo });
  165 |   } catch {
  166 |     // 工作区还没建好时忽略
  167 |   }
  168 | }
  169 | 
  170 | export const test = base.extend<AppFixtures>({
  171 |   app: async ({ page, context }, use, testInfo) => {
  172 |     const errors: string[] = [];
  173 |     const secrets: string[] = [];
  174 |     page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  175 |     page.on('console', (message) => {
  176 |       // 浏览器自己打印的网络错误（断网/服务重启用例里必然出现，不是应用错误）
  177 |       const IGNORED = [/WebSocket connection to .* failed/, /Failed to load resource: net::ERR_INTERNET_DISCONNECTED/, /Failed to load resource: net::ERR_CONNECTION_REFUSED/];
  178 |       if (message.type() === 'error' && !IGNORED.some((pattern) => pattern.test(message.text()))) {
  179 |         errors.push(`console.error: ${message.text()}`);
  180 |       }
  181 |       const text = message.text();
  182 |       if (text.includes('sk-wdcc-test-')) secrets.push(`console: ${text.slice(0, 120)}`);
  183 |     });
  184 |     page.on('response', (response) => {
  185 |       if (response.status() >= 500) errors.push(`http ${response.status()}: ${response.url()}`);
  186 |     });
  187 | 
  188 |     const mockResponses = mockApi(run.mocks.responses);
  189 |     const mockClaude = mockApi(run.mocks.anthClaude);
  190 |     const mockDsh = mockApi(run.mocks.anthDsh);
  191 |     // 每个用例独立检查自己的上游请求。Codex 请求包含完整上下文，若跨用例
  192 |     // 保留会让 mock 进程和 Playwright 主进程的内存线性增长。
  193 |     await Promise.all([mockResponses.reset(), mockClaude.reset(), mockDsh.reset()]);
  194 | 
  195 |     const login = async (): Promise<void> => {
  196 |       await page.goto(`${run.baseURL}/?token=${run.token}`);
  197 |       await page.waitForURL((url) => url.pathname === '/', { timeout: 30_000 });
  198 |     };
  199 | 
  200 |     const shotDir = join(run.root, 'shots');
  201 |     const shot = async (name: string): Promise<string> => {
  202 |       await mkdir(shotDir, { recursive: true });
  203 |       const file = join(shotDir, `${name}.jpg`);
  204 |       await page.screenshot({ path: file, type: 'jpeg', quality: 70 });
  205 |       return file;
  206 |     };
  207 | 
  208 |     const planFor = async (agent: 'codex' | 'claude' | 'dsh', name: string): Promise<void> => {
  209 |       const api = agent === 'codex' ? mockResponses : agent === 'claude' ? mockClaude : mockDsh;
  210 |       await api.plan(name);
  211 |     };
  212 | 
  213 |     // 预期之外的审批一律点"允许一次"（SPEC 第 7 节开头的约定；05/06 与 MODE 用例除外）。
  214 |     // 规则：只点 data-state="pending" 的卡片，每次点击记录工具名，用例结束时与预期列表严格比较。
  215 |     // 09 用例本身就要"审批保持挂起时打断"，自动批准会让它无法成立，因此一并排除
  216 |     const autoApprove =
  217 |       !/-(0[569])(\s|$)/.test(testInfo.title) && !/^MODE-/.test(testInfo.title) && !/AG-\w+-09/.test(testInfo.title);
  218 |     let stopped = false;
  219 |     const autoLoop = autoApprove
  220 |       ? (async () => {
  221 |           while (!stopped) {
  222 |             // 只点可见的待处理卡片：收起轮次里的卡片点不到，会白白占住循环
  223 |             const pending = page.locator('[data-testid="approval-card"][data-state="pending"]:visible');
  224 |             const count = await pending.count().catch(() => 0);
  225 |             if (count > 0) {
  226 |               const card = pending.first();
  227 |               const tool = (await card.getAttribute('data-tool').catch(() => null)) ?? '';
  228 |               const button = card.getByRole('button', { name: '允许一次' });
  229 |               if ((await button.count().catch(() => 0)) > 0) {
  230 |                 await button.click({ timeout: 3000 }).catch((error: unknown) => {
  231 |                   console.log(`auto-approve 点击失败：${String(error).slice(0, 120)}`);
  232 |                 });
  233 |                 approvals.push({ tool, at: Date.now() });
  234 |               }
  235 |             }
  236 |             // 条件等待：等卡片出现，或 250ms 后重新检查（不用于断言）
  237 |             await Promise.race([
  238 |               pending.first().waitFor({ state: 'attached', timeout: 250 }).catch(() => undefined),
  239 |               new Promise((resolveWait) => setTimeout(resolveWait, 250)),
  240 |             ]);
  241 |           }
  242 |         })()
  243 |       : null;
  244 | 
  245 |     // 每个用例开始前把工作区恢复原样（SPEC-M8 6.2）
  246 |     resetWorkspace();
  247 |     // 每个用例开始时清掉审批记录
  248 |     approvals.length = 0;
  249 |     await use({ page, run, approvals, mockResponses, mockClaude, mockDsh, planFor, login, shot, url: (path: string) => `${run.baseURL}${path}` });
  250 |     stopped = true;
  251 |     await autoLoop;
  252 | 
  253 |     // 全局断言（用例不能关闭）
  254 |     const shotPath = await shot(`${testInfo.title.split(' ')[0]}-end`);
  255 |     testInfo.attachments.push({ name: `${testInfo.title.split(' ')[0]}-end`, path: shotPath, contentType: 'image/jpeg' });
> 256 |     expect(errors, '页面不应有错误').toEqual([]);
      |                               ^ Error: 页面不应有错误
  257 |     expect(secrets, '响应/控制台里不应出现测试 Key').toEqual([]);
  258 |     void context;
  259 |   },
  260 | });
  261 | 
  262 | export { expect };
  263 | 
```