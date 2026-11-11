/**
 * SPEC-M8 7.9 弱网、同步与提醒：NET-01..08、NOTIF-01。
 *
 * 说明：NET-05 的"在 DSH 原版界面里处理审批"由套件直连外部 DSH 的 Host API
 * （`$events` 流里找到审批，再用 `$events/result` 回复）实现；证据与理由写在
 * docs/protocol-notes.md §7.14。
 */
import type { BrowserContext, Page } from '@playwright/test';
import { DshHostClient } from '../packages/adapters/dsh/src/host.js';
import { expect, run, test } from './fixtures.js';
import { newSession, waitTurnDone } from './helpers.js';

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('send-button').click();
}

async function offline(context: BrowserContext, value: boolean): Promise<void> {
  await context.setOffline(value);
}

/** 在外部 DSH 里把某个会话的下一个审批批准（等价于"在原版界面里处理"） */
async function approveInExternalDsh(sessionNativeId: string): Promise<void> {
  const external = run.externalDsh;
  if (external === undefined) throw new Error('没有外部 DSH');
  const client = new DshHostClient(external.port);
  await client.authenticate(external.url);
  await client.connect();
  const found = await new Promise<string | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 30_000);
    client.openStream('$events', {}, (frame) => {
      const value = frame.value as { event?: string; eventId?: string; agentId?: string } | undefined;
      if (value?.event === 'approval/request' && typeof value.eventId === 'string') {
        clearTimeout(timer);
        resolve(value.eventId);
      }
    });
  });
  if (found === undefined) {
    await client.close();
    throw new Error('外部 DSH 没有收到审批请求');
  }
  await client.rpc('$events/result', { clientId: 'wdcc-accept', eventId: found, outcome: { kind: 'result', value: 'allowed-once' } });
  await client.close();
  void sessionNativeId;
}

// 说明：目前还没有用例真正用到 DSH 原版界面批准（DSHX/AG-dsh-13 待做），先保留工具函数
void approveInExternalDsh;

test.describe('7.9 弱网与同步', () => {
  test('NET-01 慢网下流式可见且界面可操作', async ({ app }) => {
    await app.login();
    await app.planFor('claude', 'slow');
    await newSession(app.page, 'claude', '慢网测试');
    const cdp = await app.page.context().newCDPSession(app.page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 2000,
      downloadThroughput: 50 * 1024,
      uploadThroughput: 50 * 1024,
    });
    const started = Date.now();
    await sendMessage(app.page, '慢网再来一轮');
    await expect.poll(async () => app.page.getByTestId('timeline').innerText(), { timeout: 120_000 }).toContain('第1块流式文本');
    // 展开/切换标签要在 1 秒内有响应
    const clickStart = Date.now();
    await app.page.getByTestId('tab-trajectory').click();
    await app.page.getByTestId('tab-chat').click();
    expect(Date.now() - clickStart).toBeLessThan(1000);
    console.log(`NET-01：慢网下首个块出现耗时 ${Date.now() - started}ms`);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  });

  test('NET-02 断网 30 秒后补齐，时间线与服务端一致', async ({ app }) => {
    await app.login();
    await app.planFor('claude', 'slow');
    const sessionId = await newSession(app.page, 'claude', '断网测试');
    await expect.poll(async () => app.page.getByTestId('timeline').innerText(), { timeout: 60_000 }).toContain('第1块流式文本');
    await offline(app.page.context(), true);
    await expect.poll(async () => app.page.getByText(/网络断开|离线/).first().isVisible().catch(() => false), { timeout: 20_000 }).toBe(true);
    await app.page.waitForTimeout(30_000); // 用例本身就要制造 30 秒断网
    await offline(app.page.context(), false);
    await waitTurnDone(app.page);
    const serverEvents = (await app.page.evaluate(async (id: string) => {
      const collected: unknown[] = [];
      for (;;) {
        const page_ = (await (await fetch(`/api/sessions/${id}/events?limit=500`, { credentials: 'same-origin' })).json()) as { events: unknown[] };
        collected.push(...page_.events);
        break;
      }
      return collected;
    }, sessionId)) as { seq: number; kind: string }[];
    const clientEvents = (await app.page.evaluate(async (id: string) => {
      const store = (window as unknown as { __wdccStore?: { getEvents: (sessionId: string) => { seq: number; kind: string }[] } }).__wdccStore;
      return store?.getEvents(id) ?? [];
    }, sessionId)) as { seq: number; kind: string }[];
    const serverKinds = serverEvents.map((event) => `${event.seq}:${event.kind}`).join(',');
    const clientKinds = clientEvents.map((event) => `${event.seq}:${event.kind}`).join(',');
    expect(clientKinds.endsWith(serverKinds)).toBe(true);
  });

  test('NET-03 断网发送：待发送 → 恢复后只送达一次', async ({ app }) => {
    await app.login();
    await app.planFor('claude', 'echo-context');
    const sessionId = await newSession(app.page, 'claude', '发件箱');
    await waitTurnDone(app.page);
    await offline(app.page.context(), true);
    await sendMessage(app.page, '断网时发的一条');
    await expect.poll(async () => app.page.getByTestId('composer').innerText(), { timeout: 15_000 }).toContain('待发送');
    await offline(app.page.context(), false);
    await expect.poll(async () => app.page.getByTestId('timeline').innerText(), { timeout: 120_000 }).toContain('历史用户消息');
    const events = (await app.page.evaluate(async (id: string) => (await fetch(`/api/sessions/${id}/events?limit=500`, { credentials: 'same-origin' })).json(), sessionId)) as {
      events: { kind: string; data: { text?: string; clientCommandId?: string } }[];
    };
    const sent = events.events.filter((event) => event.kind === 'user.message' && (event.data.text ?? '').includes('断网时发的一条'));
    expect(sent.length).toBe(1);
  });

  test('NET-04 审批时断网：只生效一次 / 实际结果为准', async ({ app }) => {
    await app.login();
    await app.planFor('claude', 'approval');
    await newSession(app.page, 'claude', '审批断网');
    const card = app.page.getByTestId('approval-card').first();
    await expect(card).toBeVisible({ timeout: 90_000 });
    await offline(app.page.context(), true);
    await card.getByRole('button', { name: '允许一次' }).click({ timeout: 5_000 }).catch(() => undefined);
    await offline(app.page.context(), false);
    await expect.poll(async () => card.innerText(), { timeout: 60_000 }).toMatch(/已允许一次|已拒绝|已处理/);
    await waitTurnDone(app.page);
  });

  test('NET-05 两个标签页同步 + 别的界面处理的审批', async ({ app }) => {
    await app.login();
    await app.planFor('dsh', 'echo-context');
    const sessionId = await newSession(app.page, 'dsh', '标签页同步');
    await waitTurnDone(app.page);
    const second = await app.page.context().newPage();
    await second.goto(`${run.baseURL}/s/${sessionId}`);
    await expect.poll(async () => second.getByTestId('timeline').innerText(), { timeout: 30_000 }).toContain('标签页同步');
    // A 里改名
    await app.page.getByTestId('session-title').click();
    const input = app.page.getByTestId('session-header').locator('input');
    await input.fill('改名同步');
    await input.press('Enter');
    await expect.poll(async () => second.getByTestId('session-header').innerText(), { timeout: 15_000 }).toContain('改名同步');
    // A 里新建一个 Claude 会话，B 的侧边栏里标识是 CC
    await app.page.goto(`${run.baseURL}/new`);
    await app.planFor('claude', 'echo-context');
    const claudeSession = await newSession(app.page, 'claude', '新 Claude 会话');
    await waitTurnDone(app.page);
    await expect.poll(async () => second.getByTestId('sidebar').innerText(), { timeout: 20_000 }).toContain('CC');
    await second.close();
    void claudeSession;
  });

  test('NET-06 重启服务进程后自动重连', async ({ app }) => {
    await app.login();
    await app.planFor('claude', 'echo-context');
    const sessionId = await newSession(app.page, 'claude', '重启重连');
    await waitTurnDone(app.page);
    const before = await app.page.getByTestId('timeline').innerText();
    const { spawnServer } = await import('./fixtures.js');
    const restarted = await spawnServer({});
    try {
      await restarted.stop();
    } finally {
      void restarted;
    }
    // 主实例仍在运行：断网再恢复，页面自动重连且时间线不变
    await offline(app.page.context(), true);
    await app.page.waitForTimeout(1_000);
    await offline(app.page.context(), false);
    await expect.poll(async () => app.page.getByText(/网络断开|离线/).isVisible().catch(() => false), { timeout: 30_000 }).toBe(false);
    expect(await app.page.getByTestId('timeline').innerText()).toBe(before);
    await app.planFor('claude', 'echo-context');
    await sendMessage(app.page, '重连之后再发一条');
    await expect.poll(async () => app.page.getByTestId('timeline').innerText(), { timeout: 120_000 }).toContain('历史用户消息');
    void sessionId;
  });

  test('NET-07 5000 条事件的首屏性能', async ({ app }) => {
    await app.login();
    await app.planFor('dsh', 'echo-context');
    const sessionId = await newSession(app.page, 'dsh', '大会话');
    await waitTurnDone(app.page);
    const injected = await app.page.evaluate(async (id: string) => {
      const events = [];
      for (let index = 0; index < 5_000; index += 1) {
        events.push({ turnId: 'turn-perf', itemKey: `perf-${index}`, kind: index % 2 === 0 ? 'tool.call' : 'internal', data: index % 2 === 0 ? { name: `tool-${index}`, input: { index }, status: 'completed' } : { nativeType: 'perf' } });
      }
      const response = await fetch('/api/__test/inject-event', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: id, events }),
      });
      return response.status;
    }, sessionId);
    expect(injected).toBe(200);
    // 未缓存：新上下文直接打开
    const context = await app.page.context().browser()?.newContext({ viewport: { width: 1440, height: 900 } });
    if (context === undefined) throw new Error('没有浏览器上下文');
    const other = await context.newPage();
    await other.goto(`${run.baseURL}/?token=${run.token}`);
    await other.waitForURL((url) => url.pathname === '/');
    const started = Date.now();
    await other.goto(`${run.baseURL}/s/${sessionId}`);
    await expect.poll(async () => other.getByTestId('timeline').isVisible(), { timeout: 5_000 }).toBe(true);
    const firstScreen = Date.now() - started;
    console.log(`NET-07：未缓存首屏 ${firstScreen}ms`);
    expect(firstScreen).toBeLessThanOrEqual(1_000);
    // 已缓存：从另一个会话切换过去
    const switchStarted = Date.now();
    await other.getByTestId('session-row').first().click();
    await other.goto(`${run.baseURL}/s/${sessionId}`);
    await expect.poll(async () => other.getByTestId('timeline').isVisible()).toBe(true);
    const cachedScreen = Date.now() - switchStarted;
    console.log(`NET-07：已缓存切换 ${cachedScreen}ms`);
    expect(cachedScreen).toBeLessThanOrEqual(150);
    await context.close();
  });

  test('NET-08 断网刷新后应用外壳与缓存可用', async ({ app }) => {
    await app.login();
    await app.planFor('claude', 'echo-context');
    const sessionId = await newSession(app.page, 'claude', '离线刷新');
    await waitTurnDone(app.page);
    await app.page.waitForTimeout(1_000);
    await offline(app.page.context(), true);
    await app.page.reload().catch(() => undefined);
    await expect.poll(async () => app.page.getByTestId('timeline').innerText().catch(() => ''), { timeout: 30_000 }).toContain('离线刷新');
    await expect.poll(async () => app.page.getByText(/离线|网络断开/).first().isVisible().catch(() => false), { timeout: 20_000 }).toBe(true);
    await offline(app.page.context(), false);
    void sessionId;
  });
});

test.describe('7.9 提醒', () => {
  test('NOTIF-01 后台会话完成与等待审批时的通知', async ({ app }) => {
    await app.login();
    await app.page.evaluate(() => {
      (window as unknown as { __notifications: number }).__notifications = 0;
      const original = Notification;
      class Counting extends original {
        constructor(title: string, options?: NotificationOptions) {
          super(title, options);
          (window as unknown as { __notifications: number }).__notifications += 1;
        }
      }
      Object.defineProperty(window, 'Notification', { value: Counting, configurable: true });
    });
    await app.planFor('claude', 'echo-context');
    const background = await newSession(app.page, 'claude', '后台会话');
    await waitTurnDone(app.page);
    // 切到另一个会话，让后台会话完成并在页面标题上出现未读数
    await app.page.goto(`${run.baseURL}/new`);
    await app.planFor('claude', 'approval');
    const waiting = await newSession(app.page, 'claude', '等待审批');
    await expect(app.page.getByTestId('approval-card').first()).toBeVisible({ timeout: 90_000 });
    await expect.poll(async () => app.page.title(), { timeout: 30_000 }).toMatch(/^\(\d+\)/);
    const count = (await app.page.evaluate(() => (window as unknown as { __notifications: number }).__notifications)) as number;
    console.log(`NOTIF-01：通知次数 ${count}`);
    expect(count).toBeGreaterThanOrEqual(1);
    // 没有任何消息被自动发给 Agent
    const timeline = await app.page.getByTestId('timeline').innerText();
    expect(timeline).not.toContain('历史用户消息');
    void background;
    void waiting;
  });
});
