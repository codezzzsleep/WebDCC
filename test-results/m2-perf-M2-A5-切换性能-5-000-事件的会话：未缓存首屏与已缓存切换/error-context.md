# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: m2-perf.spec.ts >> M2 / A5 切换性能 >> 5,000 事件的会话：未缓存首屏与已缓存切换
- Location: e2e/m2-perf.spec.ts:5:3

# Error details

```
Error: expect(received).toBeLessThanOrEqual(expected)

Expected: <= 1000
Received:    8808
```

# Page snapshot

```yaml
- generic [ref=f1e3]:
  - complementary [ref=f1e4]:
    - generic [ref=f1e5]:
      - link "WebDCC" [ref=f1e6] [cursor=pointer]:
        - /url: /
      - button "⇤" [ref=f1e7] [cursor=pointer]
    - link "＋ 新会话" [ref=f1e8] [cursor=pointer]:
      - /url: /new
    - generic [ref=f1e9]:
      - generic [ref=f1e10]: 工作区
      - generic [ref=f1e11]:
        - button "⌕" [ref=f1e12] [cursor=pointer]
        - button "＋" [ref=f1e13] [cursor=pointer]
    - generic [ref=f1e15]:
      - generic [ref=f1e16]:
        - generic [ref=f1e17]: ▸
        - generic "/tmp/wdcc-e2e-workspace" [ref=f1e18]: e2e 工作区
        - link "＋" [ref=f1e19] [cursor=pointer]:
          - /url: /new?w=01M73Q0KWVPKQQCWJMBAF7YWZB
      - link "DS 五千事件会话 刚刚" [ref=f1e20] [cursor=pointer]:
        - /url: /s/01M73Q0N0R0JZYK6R2W2SYRD15
        - generic [ref=f1e21]: DS
        - generic [ref=f1e22]: 五千事件会话
        - generic [ref=f1e23]: 刚刚
    - generic [ref=f1e24]: WebDCC · 三个原装 Agent
  - main [ref=f1e25]:
    - generic [ref=f1e26]:
      - generic [ref=f1e27]:
        - button "五千事件会话" [ref=f1e28] [cursor=pointer]
        - generic [ref=f1e29]: DS
        - generic [ref=f1e30]: DeepSeek Harness
        - button "···" [ref=f1e32] [cursor=pointer]
        - button "▥" [ref=f1e33] [cursor=pointer]
      - navigation [ref=f1e34]:
        - button "对话" [ref=f1e35] [cursor=pointer]
        - button "轨迹" [ref=f1e36] [cursor=pointer]
    - generic [ref=f1e38]:
      - generic [ref=f1e40]:
        - generic [ref=f1e41]:
          - paragraph [ref=f1e44]: 五千事件会话
          - generic [ref=f1e45]: 05:49
        - generic [ref=f1e47]: 运行中…
      - generic [ref=f1e49]:
        - button "已完成，用时 0秒 ⌄" [ref=f1e51] [cursor=pointer]
        - generic [ref=f1e52]:
          - paragraph [ref=f1e55]: 收到：五千事件会话。这是假 adapter 的回放内容。
          - generic [ref=f1e56]:
            - generic [ref=f1e57]:
              - text: 已编辑 1 个文件
              - generic [ref=f1e58]: "+3"
              - generic [ref=f1e59]: "-1"
            - button "README.md +3 -1" [ref=f1e60] [cursor=pointer]:
              - generic [ref=f1e61]: README.md
              - generic [ref=f1e62]: "+3"
              - generic [ref=f1e63]: "-1"
          - generic [ref=f1e64]:
            - generic [ref=f1e65]: 完成
            - button "带到…" [ref=f1e66] [cursor=pointer]
      - generic [ref=f1e68]:
        - generic [ref=f1e69]:
          - paragraph [ref=f1e72]: 第 0 轮
          - generic [ref=f1e73]: 05:49
        - generic [ref=f1e75]: 运行中…
      - generic [ref=f1e77]:
        - button "已完成，用时 0秒 ⌄" [ref=f1e79] [cursor=pointer]
        - generic [ref=f1e80]:
          - paragraph [ref=f1e83]: 收到：第 0 轮。这是假 adapter 的回放内容。
          - generic [ref=f1e84]:
            - generic [ref=f1e85]:
              - text: 已编辑 1 个文件
              - generic [ref=f1e86]: "+3"
              - generic [ref=f1e87]: "-1"
            - button "README.md +3 -1" [ref=f1e88] [cursor=pointer]:
              - generic [ref=f1e89]: README.md
              - generic [ref=f1e90]: "+3"
              - generic [ref=f1e91]: "-1"
          - generic [ref=f1e92]:
            - generic [ref=f1e93]: 完成
            - button "带到…" [ref=f1e94] [cursor=pointer]
      - generic [ref=f1e96]:
        - generic [ref=f1e97]:
          - paragraph [ref=f1e100]: 第 1 轮
          - generic [ref=f1e101]: 05:50
        - generic [ref=f1e103]: 运行中…
      - generic [ref=f1e105]:
        - button "已完成，用时 0秒 ⌄" [ref=f1e107] [cursor=pointer]
        - generic [ref=f1e108]:
          - paragraph [ref=f1e111]: 收到：第 1 轮。这是假 adapter 的回放内容。
          - generic [ref=f1e112]:
            - generic [ref=f1e113]:
              - text: 已编辑 1 个文件
              - generic [ref=f1e114]: "+3"
              - generic [ref=f1e115]: "-1"
            - button "README.md +3 -1" [ref=f1e116] [cursor=pointer]:
              - generic [ref=f1e117]: README.md
              - generic [ref=f1e118]: "+3"
              - generic [ref=f1e119]: "-1"
          - generic [ref=f1e120]:
            - generic [ref=f1e121]: 完成
            - button "带到…" [ref=f1e122] [cursor=pointer]
      - generic [ref=f1e124]:
        - generic [ref=f1e125]:
          - paragraph [ref=f1e128]: 第 2 轮
          - generic [ref=f1e129]: 05:50
        - generic [ref=f1e131]: 运行中…
      - generic [ref=f1e133]:
        - button "已完成，用时 0秒 ⌄" [ref=f1e135] [cursor=pointer]
        - generic [ref=f1e136]:
          - paragraph [ref=f1e139]: 收到：第 2 轮。这是假 adapter 的回放内容。
          - generic [ref=f1e140]:
            - generic [ref=f1e141]:
              - text: 已编辑 1 个文件
              - generic [ref=f1e142]: "+3"
              - generic [ref=f1e143]: "-1"
            - button "README.md +3 -1" [ref=f1e144] [cursor=pointer]:
              - generic [ref=f1e145]: README.md
              - generic [ref=f1e146]: "+3"
              - generic [ref=f1e147]: "-1"
          - generic [ref=f1e148]:
            - generic [ref=f1e149]: 完成
            - button "带到…" [ref=f1e150] [cursor=pointer]
      - generic [ref=f1e152]:
        - generic [ref=f1e153]:
          - paragraph [ref=f1e156]: 第 3 轮
          - generic [ref=f1e157]: 05:50
        - generic [ref=f1e159]: 运行中…
      - generic [ref=f1e161]:
        - button "已完成，用时 0秒 ⌄" [ref=f1e163] [cursor=pointer]
        - generic [ref=f1e164]:
          - paragraph [ref=f1e167]: 收到：第 3 轮。这是假 adapter 的回放内容。
          - generic [ref=f1e168]:
            - generic [ref=f1e169]:
              - text: 已编辑 1 个文件
              - generic [ref=f1e170]: "+3"
              - generic [ref=f1e171]: "-1"
            - button "README.md +3 -1" [ref=f1e172] [cursor=pointer]:
              - generic [ref=f1e173]: README.md
              - generic [ref=f1e174]: "+3"
              - generic [ref=f1e175]: "-1"
          - generic [ref=f1e176]:
            - generic [ref=f1e177]: 完成
            - button "带到…" [ref=f1e178] [cursor=pointer]
      - generic [ref=f1e180]:
        - generic [ref=f1e181]:
          - paragraph [ref=f1e184]: 第 4 轮
          - generic [ref=f1e185]: 05:50
        - generic [ref=f1e187]: 运行中…
      - generic [ref=f1e189]:
        - button "已完成，用时 0秒 ⌄" [ref=f1e191] [cursor=pointer]
        - generic [ref=f1e192]:
          - paragraph [ref=f1e195]: 收到：第 4 轮。这是假 adapter 的回放内容。
          - generic [ref=f1e196]:
            - generic [ref=f1e197]:
              - text: 已编辑 1 个文件
              - generic [ref=f1e198]: "+3"
              - generic [ref=f1e199]: "-1"
            - button "README.md +3 -1" [ref=f1e200] [cursor=pointer]:
              - generic [ref=f1e201]: README.md
              - generic [ref=f1e202]: "+3"
              - generic [ref=f1e203]: "-1"
          - generic [ref=f1e204]:
            - generic [ref=f1e205]: 完成
            - button "带到…" [ref=f1e206] [cursor=pointer]
      - generic [ref=f1e208]:
        - generic [ref=f1e209]:
          - paragraph [ref=f1e212]: 第 5 轮
          - generic [ref=f1e213]: 05:50
        - generic [ref=f1e215]: 运行中…
      - generic [ref=f1e217]:
        - button "已完成，用时 0秒 ⌄" [ref=f1e219] [cursor=pointer]
        - generic [ref=f1e220]:
          - paragraph [ref=f1e223]: 收到：第 5 轮。这是假 adapter 的回放内容。
          - generic [ref=f1e224]:
            - generic [ref=f1e225]:
              - text: 已编辑 1 个文件
              - generic [ref=f1e226]: "+3"
              - generic [ref=f1e227]: "-1"
            - button "README.md +3 -1" [ref=f1e228] [cursor=pointer]:
              - generic [ref=f1e229]: README.md
              - generic [ref=f1e230]: "+3"
              - generic [ref=f1e231]: "-1"
          - generic [ref=f1e232]:
            - generic [ref=f1e233]: 完成
            - button "带到…" [ref=f1e234] [cursor=pointer]
      - generic [ref=f1e236]:
        - generic [ref=f1e237]:
          - paragraph [ref=f1e240]: 第 6 轮
          - generic [ref=f1e241]: 05:50
        - generic [ref=f1e243]: 运行中…
    - generic [ref=f1e244]:
      - generic [ref=f1e245]:
        - textbox "发消息或创建任务, / 调用指令, @ 文件或对话" [ref=f1e246]
        - generic [ref=f1e247]:
          - generic [ref=f1e248]:
            - button "＋" [ref=f1e249] [cursor=pointer]
            - button "仅可查看" [ref=f1e251] [cursor=pointer]
          - generic [ref=f1e252]:
            - generic [ref=f1e253]: Fake Model
            - button "发送" [ref=f1e254] [cursor=pointer]
      - generic [ref=f1e255]: 102 轮 · 4896 步
```

# Test source

```ts
  1  | import { expect, test } from '@playwright/test';
  2  | import { createSession, login } from './helpers.js';
  3  | 
  4  | test.describe('M2 / A5 切换性能', () => {
  5  |   test('5,000 事件的会话：未缓存首屏与已缓存切换', async ({ page, context }) => {
  6  |     await login(page);
  7  |     const big = await createSession(page, 'dsh', '五千事件会话');
  8  | 
  9  |     // 用 API 连续发 50 轮（每轮约 100 条事件），凑够 5,000+ 条事件
  10 |     const total = await page.evaluate(async (sessionId) => {
  11 |       const count = async (): Promise<number> => {
  12 |         const text = await (await fetch(`/api/sessions/${sessionId}/export`, { credentials: 'same-origin' })).text();
  13 |         const lines = text.trim().split('\n').filter(Boolean);
  14 |         return (lines.at(-1) ?? '').includes('turn.completed') ? lines.length : 0;
  15 |       };
  16 |       for (let i = 0; i < 50; i += 1) {
  17 |         await fetch('/api/commands', {
  18 |           method: 'POST',
  19 |           credentials: 'same-origin',
  20 |           headers: { 'content-type': 'application/json' },
  21 |           body: JSON.stringify({ command: { op: 'send', clientCommandId: `PERF-${i}`, sessionId, text: `第 ${i} 轮` } }),
  22 |         });
  23 |         const started = Date.now();
  24 |         while (Date.now() - started < 20_000) {
  25 |           const n = await count();
  26 |           if (n > 0 && i > 0) break;
  27 |           await new Promise((resolve) => setTimeout(resolve, 50));
  28 |         }
  29 |       }
  30 |       return count();
  31 |     }, big.sessionId);
  32 |     console.log(`A5 造数：${total} 条事件`);
  33 |     expect(total).toBeGreaterThanOrEqual(5000);
  34 | 
  35 |     // ---- 未缓存：新上下文 ----
  36 |     const fresh = await context.browser()?.newContext();
  37 |     if (fresh === undefined) throw new Error('没有浏览器上下文');
  38 |     const freshPage = await fresh.newPage();
  39 |     await login(freshPage);
  40 |     const firstRequest = freshPage.waitForRequest((request) => request.url().includes(`/api/sessions/${big.sessionId}/events`), { timeout: 20_000 });
  41 |     const startedAt = Date.now();
  42 |     await freshPage.goto(`/s/${big.sessionId}`, { waitUntil: 'domcontentloaded' });
  43 |     const domMs = Date.now() - startedAt;
  44 |     const request = await firstRequest;
  45 |     const limit = Number(new URL(request.url()).searchParams.get('limit') ?? '0');
  46 |     await freshPage.waitForFunction(() => document.querySelectorAll('.turn').length > 0, undefined, { timeout: 15_000 });
  47 |     const firstPaintMs = Date.now() - startedAt;
  48 |     console.log(`A5 未缓存：DOM ${domMs}ms，limit=${limit}，首屏 ${firstPaintMs}ms`);
  49 |     expect(limit).toBeLessThanOrEqual(200);
> 50 |     expect(firstPaintMs).toBeLessThanOrEqual(1000);
     |                          ^ Error: expect(received).toBeLessThanOrEqual(expected)
  51 | 
  52 |     // ---- 已缓存：同一上下文再次进入 ----
  53 |     await freshPage.waitForTimeout(2000);
  54 |     await freshPage.goto('/new');
  55 |     const switchStart = Date.now();
  56 |     await freshPage.goto(`/s/${big.sessionId}`, { waitUntil: 'domcontentloaded' });
  57 |     await freshPage.waitForFunction(() => document.querySelectorAll('.turn').length > 0, undefined, { timeout: 10_000 });
  58 |     const switchMs = Date.now() - switchStart;
  59 |     console.log(`A5 已缓存：切换首屏 ${switchMs}ms`);
  60 |     expect(switchMs).toBeLessThanOrEqual(1500);
  61 |     await fresh.close();
  62 |   });
  63 | });
  64 | 
```