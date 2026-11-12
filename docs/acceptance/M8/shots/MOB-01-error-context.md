# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: dock.spec.ts >> 7.8 窄屏 >> MOB-01 390×844 抽屉里切换会话
- Location: e2e-real/dock.spec.ts:63:3

# Error details

```
Test timeout of 180000ms exceeded.
```

```
Error: locator.click: Test timeout of 180000ms exceeded.
Call log:
  - waiting for getByTestId('session-row').filter({ hasText: '手机会话二' })

```

# Page snapshot

```yaml
- generic [ref=f4e3]:
  - complementary "会话" [ref=f4e4]:
    - generic [ref=f4e5]:
      - link "WebDCC 首页" [ref=f4e6] [cursor=pointer]:
        - /url: /
        - generic [ref=f4e7]: WebDCC
        - generic [ref=f4e8]: 3 HARNESS
      - button "收起侧边栏" [ref=f4e9] [cursor=pointer]
    - link "新会话" [ref=f4e12] [cursor=pointer]:
      - /url: /new
    - navigation [ref=f4e15]:
      - link "Agent 与 Provider" [ref=f4e16] [cursor=pointer]:
        - /url: /settings/providers
    - generic [ref=f4e19]:
      - generic [ref=f4e20]: 工作区
      - generic [ref=f4e21]:
        - button "搜索会话" [ref=f4e22] [cursor=pointer]
        - button "添加工作区" [ref=f4e25] [cursor=pointer]
    - generic [ref=f4e29]:
      - generic "/tmp/wdcc-accept-rmwcs3zxi-ccTPlR/ws/sample-repo" [ref=f4e30]:
        - generic [ref=f4e33]: sample-repo
        - link "在 sample-repo 新建会话" [ref=f4e34] [cursor=pointer]:
          - /url: /new?w=01M76GQE0HPYQGJYM0ZXGYQKG6
      - link "（辅助请求：不推进计划） 刚刚" [ref=f4e37] [cursor=pointer]:
        - /url: /s/01M76H5SSTN2VDRJVY9SNFR539
        - generic [aria-hidden] [ref=f4e38]: DS
        - generic [ref=f4e39]: （辅助请求：不推进计划）
        - generic [ref=f4e40]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f4e41] [cursor=pointer]:
        - /url: /s/01M76H5HPRAXKT4NY7QDF5AY72
        - generic [aria-hidden] [ref=f4e42]: DS
        - generic [ref=f4e43]: （辅助请求：不推进计划）
        - generic [ref=f4e44]: 刚刚
      - link "diff 标签 刚刚" [ref=f4e45] [cursor=pointer]:
        - /url: /s/01M76H506Q86EZG616Q0E71316
        - generic [aria-hidden] [ref=f4e46]: CC
        - generic [ref=f4e47]: diff 标签
        - generic [ref=f4e48]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f4e49] [cursor=pointer]:
        - /url: /s/01M76H43QSV4RQYNK9BWEX7AZD
        - generic [aria-hidden] [ref=f4e50]: DS
        - generic [ref=f4e51]: （辅助请求：不推进计划）
        - generic [ref=f4e52]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f4e53] [cursor=pointer]:
        - /url: /s/01M76H3WS9VA51A6BC1PFTACTS
        - generic [aria-hidden] [ref=f4e54]: DS
        - generic [ref=f4e55]: （辅助请求：不推进计划）
        - generic [ref=f4e56]: 刚刚
      - link "停止测试 刚刚" [ref=f4e57] [cursor=pointer]:
        - /url: /s/01M76H3FEKV1QGWJJSN934MXTS
        - generic [aria-hidden] [ref=f4e58]: CC
        - generic [ref=f4e59]: 停止测试
        - generic [ref=f4e60]: 刚刚
      - link "审批：拒绝 刚刚" [ref=f4e61] [cursor=pointer]:
        - /url: /s/01M76H37B47Q3V5QST9HJPWBR8
        - generic [aria-hidden] [ref=f4e62]: CC
        - generic [ref=f4e63]: 审批：拒绝
        - generic [ref=f4e64]: 刚刚
      - link "审批：允许一次 刚刚" [ref=f4e65] [cursor=pointer]:
        - /url: /s/01M76H2Z78237AR7SJCW22RDX5
        - generic [aria-hidden] [ref=f4e66]: CC
        - generic [ref=f4e67]: 审批：允许一次
        - generic [ref=f4e68]: 刚刚
      - link "停止测试 刚刚" [ref=f4e69] [cursor=pointer]:
        - /url: /s/01M76H2JM2Y501Y0RNH5JX857M
        - generic [aria-hidden] [ref=f4e70]: CX
        - generic [ref=f4e71]: 停止测试
        - generic [ref=f4e72]: 刚刚
      - link "审批：拒绝 刚刚" [ref=f4e73] [cursor=pointer]:
        - /url: /s/01M76H2A6KE5XRNPK6KCNB2T7R
        - generic [aria-hidden] [ref=f4e74]: CX
        - generic [ref=f4e75]: 审批：拒绝
        - generic [ref=f4e76]: 刚刚
      - link "审批：允许一次 刚刚" [ref=f4e77] [cursor=pointer]:
        - /url: /s/01M76H234JD95W2KKEX4X67KFC
        - generic [aria-hidden] [ref=f4e78]: CX
        - generic [ref=f4e79]: 审批：允许一次
        - generic [ref=f4e80]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f4e81] [cursor=pointer]:
        - /url: /s/01M76H1QTRAQ0MJPMAFBBP3DYW
        - generic [aria-hidden] [ref=f4e82]: DS
        - generic [ref=f4e83]: （辅助请求：不推进计划）
        - generic [ref=f4e84]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f4e85] [cursor=pointer]:
        - /url: /s/01M76H1GDDMKNX69VW3HQNMVPK
        - generic [aria-hidden] [ref=f4e86]: DS
        - generic [ref=f4e87]: （辅助请求：不推进计划）
        - generic [ref=f4e88]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f4e89] [cursor=pointer]:
        - /url: /s/01M76H18YFX6M01C5HX3NJEGRZ
        - generic [aria-hidden] [ref=f4e90]: DS
        - generic [ref=f4e91]: （辅助请求：不推进计划）
        - generic [ref=f4e92]: 刚刚
      - link "换模型 刚刚" [ref=f4e93] [cursor=pointer]:
        - /url: /s/01M76H0XS7W0WZHBQP6J54ZCRH
        - generic [aria-hidden] [ref=f4e94]: CC
        - generic [ref=f4e95]: 换模型
        - generic [ref=f4e96]: 刚刚
      - link "第一轮 刚刚" [ref=f4e97] [cursor=pointer]:
        - /url: /s/01M76H0H05ME7DAF6J72GCB9TY
        - generic [aria-hidden] [ref=f4e98]: CC
        - generic [ref=f4e99]: 第一轮
        - generic [ref=f4e100]: 刚刚
      - link "第一轮 刚刚" [ref=f4e101] [cursor=pointer]:
        - /url: /s/01M76H06PYBT2TJMA7V20N2YZ5
        - generic [aria-hidden] [ref=f4e102]: CC
        - generic [ref=f4e103]: 第一轮
        - generic [ref=f4e104]: 刚刚
      - link "刷新一致性 刚刚" [ref=f4e105] [cursor=pointer]:
        - /url: /s/01M76GZRZGB63G7H0ARBBE6XXH
        - generic [aria-hidden] [ref=f4e106]: CC
        - generic [ref=f4e107]: 刷新一致性
        - generic [ref=f4e108]: 刚刚
      - link "轮次检查 刚刚" [ref=f4e109] [cursor=pointer]:
        - /url: /s/01M76GZEGZPSTCCXWBGTVZ1D47
        - generic [aria-hidden] [ref=f4e110]: CC
        - generic [ref=f4e111]: 轮次检查
        - generic [ref=f4e112]: 刚刚
      - link "跑一遍 full 刚刚" [ref=f4e113] [cursor=pointer]:
        - /url: /s/01M76GZ3ZA68200B8YB4QDV3EJ
        - generic [aria-hidden] [ref=f4e114]: CC
        - generic [ref=f4e115]: 跑一遍 full
        - generic [ref=f4e116]: 刚刚
      - link "换模型 待批准" [ref=f4e117] [cursor=pointer]:
        - /url: /s/01M76GYR1J5EG6M055PW379NVB
        - generic [aria-hidden] [ref=f4e118]: CX
        - generic [ref=f4e119]: 换模型
        - generic [ref=f4e120]: 待批准
      - link "第一轮 待批准" [ref=f4e121] [cursor=pointer]:
        - /url: /s/01M76GTN494PQH438RFAFJB56K
        - generic [aria-hidden] [ref=f4e122]: CX
        - generic [ref=f4e123]: 第一轮
        - generic [ref=f4e124]: 待批准
      - link "第一轮 待批准" [ref=f4e125] [cursor=pointer]:
        - /url: /s/01M76GTECBDNCZ2KZ8SC60580Z
        - generic [aria-hidden] [ref=f4e126]: CX
        - generic [ref=f4e127]: 第一轮
        - generic [ref=f4e128]: 待批准
      - link "刷新一致性 待批准" [ref=f4e129] [cursor=pointer]:
        - /url: /s/01M76GT5R3YTMXS9WZR8AS1RWK
        - generic [aria-hidden] [ref=f4e130]: CX
        - generic [ref=f4e131]: 刷新一致性
        - generic [ref=f4e132]: 待批准
      - link "轮次检查 待批准" [ref=f4e133] [cursor=pointer]:
        - /url: /s/01M76GSYXWS7D3EYJFXQBT0KNG
        - generic [aria-hidden] [ref=f4e134]: CX
        - generic [ref=f4e135]: 轮次检查
        - generic [ref=f4e136]: 待批准
      - link "跑一遍 full 待批准" [ref=f4e137] [cursor=pointer]:
        - /url: /s/01M76GSREJH032XRVAVSZ4EHB5
        - generic [aria-hidden] [ref=f4e138]: CX
        - generic [ref=f4e139]: 跑一遍 full
        - generic [ref=f4e140]: 待批准
      - link "（辅助请求：不推进计划） 刚刚" [ref=f4e141] [cursor=pointer]:
        - /url: /s/01M76GSES90NPW9SJQM26JNJCD
        - generic [aria-hidden] [ref=f4e142]: DS
        - generic [ref=f4e143]: （辅助请求：不推进计划）
        - generic [ref=f4e144]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f4e145] [cursor=pointer]:
        - /url: /s/01M76GS5BSYWT72M8P8DSEVWGY
        - generic [aria-hidden] [ref=f4e146]: DS
        - generic [ref=f4e147]: （辅助请求：不推进计划）
        - generic [ref=f4e148]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f4e149] [cursor=pointer]:
        - /url: /s/01M76GS03ZWVYZQMRTB7WBBRE7
        - generic [aria-hidden] [ref=f4e150]: DS
        - generic [ref=f4e151]: （辅助请求：不推进计划）
        - generic [ref=f4e152]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f4e153] [cursor=pointer]:
        - /url: /s/01M76GRR6XBXN00SNH0R6XRT7R
        - generic [aria-hidden] [ref=f4e154]: DS
        - generic [ref=f4e155]: （辅助请求：不推进计划）
        - generic [ref=f4e156]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f4e157] [cursor=pointer]:
        - /url: /s/01M76GRJPYACQRE1GJ1BPDKRPG
        - generic [aria-hidden] [ref=f4e158]: DS
        - generic [ref=f4e159]: （辅助请求：不推进计划）
        - generic [ref=f4e160]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f4e161] [cursor=pointer]:
        - /url: /s/01M76GRD0RN917Z0K2EK388QH4
        - generic [aria-hidden] [ref=f4e162]: DS
        - generic [ref=f4e163]: （辅助请求：不推进计划）
        - generic [ref=f4e164]: 刚刚
      - link "流式 刚刚" [ref=f4e165] [cursor=pointer]:
        - /url: /s/01M76GR3NN5571F2TMZAWF20QV
        - generic [aria-hidden] [ref=f4e166]: CC
        - generic [ref=f4e167]: 流式
        - generic [ref=f4e168]: 刚刚
      - link "任务清单 刚刚" [ref=f4e169] [cursor=pointer]:
        - /url: /s/01M76GR5XN60APPTPHD3P2K9K5
        - generic [aria-hidden] [ref=f4e170]: CC
        - generic [ref=f4e171]: 任务清单
        - generic [ref=f4e172]: 刚刚
      - link "流式 刚刚" [ref=f4e173] [cursor=pointer]:
        - /url: /s/01M76GQSYQ0XYYZTXT9RNE8MCF
        - generic [aria-hidden] [ref=f4e174]: CX
        - generic [ref=f4e175]: 流式
        - generic [ref=f4e176]: 刚刚
      - link "跑一遍 full 刚刚" [ref=f4e177] [cursor=pointer]:
        - /url: /s/01M76GR1YZMMNAAN7X5CWF827C
        - generic [aria-hidden] [ref=f4e178]: CC
        - generic [ref=f4e179]: 跑一遍 full
        - generic [ref=f4e180]: 刚刚
      - link "任务清单 待批准" [ref=f4e181] [cursor=pointer]:
        - /url: /s/01M76GQVRHHZ9QKH0XGG1SHY6P
        - generic [aria-hidden] [ref=f4e182]: CX
        - generic [ref=f4e183]: 任务清单
        - generic [ref=f4e184]: 待批准
      - link "（辅助请求：不推进计划） 刚刚" [ref=f4e185] [cursor=pointer]:
        - /url: /s/01M76GQH2A95A97KGTPCW2AE4B
        - generic [aria-hidden] [ref=f4e186]: DS
        - generic [ref=f4e187]: （辅助请求：不推进计划）
        - generic [ref=f4e188]: 刚刚
      - link "跑一遍 full 刚刚" [ref=f4e189] [cursor=pointer]:
        - /url: /s/01M76GQR9MYGE76WFNGX4AAPPJ
        - generic [aria-hidden] [ref=f4e190]: CX
        - generic [ref=f4e191]: 跑一遍 full
        - generic [ref=f4e192]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f4e193] [cursor=pointer]:
        - /url: /s/01M76GQJRFX19Z486PQJS266J9
        - generic [aria-hidden] [ref=f4e194]: DS
        - generic [ref=f4e195]: （辅助请求：不推进计划）
        - generic [ref=f4e196]: 刚刚
      - link "（辅助请求：不推进计划） 刚刚" [ref=f4e197] [cursor=pointer]:
        - /url: /s/01M76GQFRVW4XVQ27B8MFCD5X1
        - generic [aria-hidden] [ref=f4e198]: DS
        - generic [ref=f4e199]: （辅助请求：不推进计划）
        - generic [ref=f4e200]: 刚刚
    - generic [ref=f4e201]:
      - generic [ref=f4e202]:
        - generic [ref=f4e204]: DeepSeek Harness
        - generic [ref=f4e205]: 已连接本机 DSH
      - generic [ref=f4e206]:
        - generic [ref=f4e208]: Codex
        - generic [ref=f4e209]: 0.167.1
      - generic [ref=f4e210]:
        - generic [ref=f4e212]: Claude Code
        - generic [ref=f4e213]: 0.3.322
  - main [ref=f4e215]:
    - generic [ref=f4e216]:
      - generic [ref=f4e217]:
        - button "会话列表" [active] [ref=f4e218] [cursor=pointer]
        - button "（辅助请求：不推进计划）" [ref=f4e221] [cursor=pointer]
        - generic "DeepSeek Harness · deepseek-flash" [ref=f4e222]:
          - generic [aria-hidden] [ref=f4e223]: DS
          - generic [ref=f4e224]: DeepSeek Harness
        - generic [ref=f4e225]:
          - button "在右侧并排打开另一个会话" [ref=f4e227] [cursor=pointer]
          - button "更多" [ref=f4e231] [cursor=pointer]
      - navigation "视图" [ref=f4e233]:
        - button "对话" [ref=f4e234] [cursor=pointer]
        - button "轨迹" [ref=f4e235] [cursor=pointer]
    - generic [ref=f4e239]:
      - generic [ref=f4e240]:
        - paragraph [ref=f4e243]: 手机会话一
        - generic [ref=f4e244]: 08:05
      - button "已完成，用时 0秒" [ref=f4e247] [cursor=pointer]
      - generic [ref=f4e251]:
        - button "查看过程" [ref=f4e252] [cursor=pointer]
        - paragraph [ref=f4e257]: 历史用户消息 1 条
        - generic [ref=f4e258]:
          - button "复制回答" [ref=f4e259] [cursor=pointer]
          - button "带到…" [ref=f4e262] [cursor=pointer]
          - generic [ref=f4e265]: 用量 160 tok
          - generic [ref=f4e266]: 08:05
    - generic [ref=f4e268]:
      - generic [ref=f4e269]:
        - generic [ref=f4e270]: 消息
        - textbox "消息" [ref=f4e271]:
          - /placeholder: 发消息给 DeepSeek Harness，/ 调用它的指令，@ 引用文件或会话
        - generic [ref=f4e272]:
          - button "添加附件" [ref=f4e274] [cursor=pointer]
          - button [ref=f4e278] [cursor=pointer]:
            - generic [aria-hidden] [ref=f4e279]: DS
            - img "会话创建后固定" [ref=f4e280]
          - button "仅可查看" [ref=f4e283] [cursor=pointer]
          - button "deepseek-flash" [ref=f4e290] [cursor=pointer]
          - button "发送" [disabled] [ref=f4e294]
      - generic [ref=f4e297]: 1 轮 · 0 步 · 160 tok
```

# Test source

```ts
  1   | /**
  2   |  * SPEC-M8 7.8 停靠区与窄屏：DOCK-01/02/03、MOB-01..04、UI-01。
  3   |  */
  4   | import type { Page } from '@playwright/test';
  5   | import { expect, run, test } from './fixtures.js';
  6   | import { newSession, waitTurnDone } from './helpers.js';
  7   | 
  8   | async function sendMessage(page: Page, text: string): Promise<void> {
  9   |   await page.getByTestId('composer-input').fill(text);
  10  |   await page.getByTestId('send-button').click();
  11  | }
  12  | 
  13  | test.describe('7.8 停靠区', () => {
  14  |   test('DOCK-01 移到主栏、刷新与前进后退还原', async ({ app }) => {
  15  |     await app.login();
  16  |     await app.planFor('dsh', 'echo-context');
  17  |     const first = await newSession(app.page, 'dsh', '会话 A');
  18  |     await waitTurnDone(app.page);
  19  |     await app.page.goto(`${run.baseURL}/new`);
  20  |     await app.planFor('dsh', 'echo-context');
  21  |     const second = await newSession(app.page, 'dsh', '会话 B');
  22  |     await waitTurnDone(app.page);
  23  |     // A+B：主栏 A、停靠区 B
  24  |     await app.page.goto(`${run.baseURL}/s/${first}+${second}`);
  25  |     const dock = app.page.getByTestId('dock');
  26  |     await expect(dock).toBeVisible();
  27  |     await expect.poll(async () => dock.innerText()).toContain('会话 B');
  28  |     await expect.poll(async () => dock.innerText()).toMatch(/DS/);
  29  |     await dock.getByRole('button', { name: '移到主栏' }).click();
  30  |     await expect.poll(async () => app.page.url()).toContain(`${second}+${first}`);
  31  |     // 刷新后布局还原
  32  |     await app.page.reload();
  33  |     await expect(dock).toBeVisible();
  34  |     await expect.poll(async () => dock.innerText()).toContain('会话 A');
  35  |     // 浏览器后退、前进
  36  |     await app.page.goBack();
  37  |     await expect.poll(async () => app.page.url()).toContain(`${first}+${second}`);
  38  |     await app.page.goForward();
  39  |     await expect.poll(async () => app.page.url()).toContain(`${second}+${first}`);
  40  |     await expect(dock).toBeVisible();
  41  |   });
  42  | 
  43  |   test('DOCK-03 改动卡片打开 diff 标签、文件标签与直接地址', async ({ app }) => {
  44  |     await app.login();
  45  |     await app.planFor('claude', 'full');
  46  |     const sessionId = await newSession(app.page, 'claude', 'diff 标签');
  47  |     await waitTurnDone(app.page);
  48  |     await app.page.getByTestId('changes-card').locator('button', { hasText: 'README.md' }).first().click();
  49  |     await expect(app.page.getByTestId('dock')).toContainText('改动');
  50  |     const url = app.page.url();
  51  |     expect(url).toContain('dock=diff');
  52  |     await app.page.reload();
  53  |     await expect(app.page.getByTestId('dock')).toContainText('改动');
  54  |     await expect.poll(async () => app.page.getByTestId('dock').innerText(), { timeout: 20_000 }).toContain('line to modify');
  55  |     // 文件标签
  56  |     await app.page.goto(`${run.baseURL}/s/${sessionId}?dock=files`);
  57  |     await expect(app.page.getByTestId('dock')).toContainText('工作区文件');
  58  |     void sendMessage;
  59  |   });
  60  | });
  61  | 
  62  | test.describe('7.8 窄屏', () => {
  63  |   test('MOB-01 390×844 抽屉里切换会话', async ({ app }) => {
  64  |     await app.page.setViewportSize({ width: 390, height: 844 });
  65  |     await app.login();
  66  |     await app.planFor('dsh', 'echo-context');
  67  |     const first = await newSession(app.page, 'dsh', '手机会话一');
  68  |     await waitTurnDone(app.page);
  69  |     await app.page.goto(`${run.baseURL}/new`);
  70  |     await app.planFor('dsh', 'echo-context');
  71  |     const second = await newSession(app.page, 'dsh', '手机会话二');
  72  |     await waitTurnDone(app.page);
  73  |     // 抽屉默认隐藏，点会话头左侧按钮打开
  74  |     await app.page.goto(`${run.baseURL}/s/${first}`);
  75  |     await app.page.getByTestId('drawer-toggle').click();
  76  |     await expect(app.page.getByTestId('sidebar')).toBeInViewport();
> 77  |     await app.page.getByTestId('session-row').filter({ hasText: '手机会话二' }).click();
      |                                                                            ^ Error: locator.click: Test timeout of 180000ms exceeded.
  78  |     await expect.poll(async () => app.page.url()).toContain(second);
  79  |     await expect(app.page.getByTestId('drawer-backdrop')).toHaveCount(0);
  80  |   });
  81  | 
  82  |   test('MOB-02 390×844 新建并跑完一轮，输入框贴底', async ({ app }) => {
  83  |     await app.page.setViewportSize({ width: 390, height: 844 });
  84  |     await app.login();
  85  |     await app.planFor('dsh', 'echo-context');
  86  |     await app.page.goto(`${run.baseURL}/new`);
  87  |     await app.page.getByTestId('drawer-toggle').click().catch(() => undefined);
  88  |     await app.page.getByTestId('agent-card-dsh').click();
  89  |     await app.page.getByTestId('new-session-input').fill('手机新建');
  90  |     await app.page.getByTestId('new-session-send').click();
  91  |     await app.page.waitForURL(/\/s\/[0-9A-Z]+/, { timeout: 90_000 });
  92  |     await waitTurnDone(app.page);
  93  |     const box = await app.page.getByTestId('composer').boundingBox();
  94  |     expect(box).not.toBeNull();
  95  |     expect(844 - ((box?.y ?? 0) + (box?.height ?? 0))).toBeLessThanOrEqual(24);
  96  |   });
  97  | 
  98  |   test('MOB-03 390×844 截图清单', async ({ app }) => {
  99  |     await app.page.setViewportSize({ width: 390, height: 844 });
  100 |     await app.login();
  101 |     await app.planFor('dsh', 'full');
  102 |     await newSession(app.page, 'dsh', '手机截图');
  103 |     await waitTurnDone(app.page);
  104 |     await app.shot('MOB-03-chat');
  105 |     await app.page.getByTestId('drawer-toggle').click();
  106 |     await app.shot('MOB-03-drawer');
  107 |     await app.page.getByTestId('drawer-backdrop').click();
  108 |     await app.page.getByTestId('tab-chat').click();
  109 |     await app.shot('MOB-03-timeline');
  110 |     await expect(app.page.getByTestId('timeline')).toBeVisible();
  111 |   });
  112 | 
  113 |   test('MOB-04 900×800 侧边栏窄栏与停靠区', async ({ app }) => {
  114 |     await app.page.setViewportSize({ width: 900, height: 800 });
  115 |     await app.login();
  116 |     await app.planFor('dsh', 'echo-context');
  117 |     const first = await newSession(app.page, 'dsh', '窄栏测试');
  118 |     await waitTurnDone(app.page);
  119 |     const sidebar = app.page.getByTestId('sidebar');
  120 |     const box = await sidebar.boundingBox();
  121 |     expect(box?.width ?? 0).toBeLessThanOrEqual(120);
  122 |     // 会话头的"并排"菜单：选"工作区文件"在右侧打开
  123 |     await app.page.getByTestId('dock-toggle').click();
  124 |     await app.page.getByRole('menuitem', { name: '工作区文件' }).click();
  125 |     await expect(app.page.getByTestId('dock')).toBeVisible();
  126 |     void first;
  127 |   });
  128 | });
  129 | 
  130 | test.describe('7.8 UI 截图', () => {
  131 |   test('UI-01 1440×900 截图清单', async ({ app }) => {
  132 |     await app.page.setViewportSize({ width: 1440, height: 900 });
  133 |     await app.login();
  134 |     await app.planFor('dsh', 'full');
  135 |     await newSession(app.page, 'dsh', '界面截图');
  136 |     await waitTurnDone(app.page);
  137 |     await app.shot('UI-01-chat');
  138 |     await app.page.getByTestId('changes-card').first().click().catch(() => undefined);
  139 |     await app.shot('UI-01-changes');
  140 |     await expect(app.page.getByTestId('timeline')).toBeVisible();
  141 |   });
  142 | });
  143 | 
```