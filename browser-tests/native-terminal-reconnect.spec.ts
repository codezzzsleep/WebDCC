import { chromium, type Browser, type Page } from '@playwright/test';
import { expect, it } from 'vitest';
import type { AdapterEvent, AgentId } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { createSourceTestApp, observeSessionSnapshots } from './helpers.js';

// Browser callbacks execute in Chromium; Node fetch types remain authoritative
// for the transitive source server used by this test.
declare const window: { fetch: typeof fetch; WebSocket: typeof WebSocket };
declare function requestAnimationFrame(callback: (timestamp: number) => void): number;

async function fixture(agent: AgentId) {
  const ctx = await createSourceTestApp();
  const adapter = new FakeAdapter({ id: agent }); let receive!: (id: string, event: AdapterEvent) => void; let sends = 0;
  adapter.onEvent = callback => { receive = callback; }; adapter.send = async () => { sends++; }; ctx.manager.registerAdapter(adapter);
  const workspace = ctx.store.createWorkspace('Terminal result request recovery', ctx.dataDir);
  const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent }); const identity = ctx.manager.getRuntime(session.id)!.identity;
  const turnId = 'retained-public-turn'; const commandId = 'retained-command';
  ctx.store.appendEvent({ sessionId: session.id, turnId, itemKey: 'input', kind: 'user.message', data: { text: 'retained fixture input' } });
  ctx.store.journal.claim({ op: 'send', sessionId: session.id, clientCommandId: commandId, text: 'retained fixture input' });
  ctx.store.journal.enqueue(commandId, session.id, turnId, { text: 'retained fixture input' }); ctx.store.journal.inputState(turnId, 'uncertain');
  const record = (status: 'completed' | 'failed' = 'completed') => {
    const nativeId = ctx.store.getSession(session.id)!.nativeId!;
    const raw = ctx.store.nativeEvents.mapping({ sessionId: session.id, nativeId, agent, identity },
      { type: 'turn.end', runtime: identity, status, native: { controlled: true, originalRequest: nativeId } }, 'accepted');
    ctx.store.projectionContexts.record(raw.id, { sessionId: session.id, identity, turnId, late: false, turnEnded: false });
    return raw.id;
  };
  record(); await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener');
  return { ctx, session, identity, turnId, commandId, record, sends: () => sends, emit: (event: AdapterEvent) => receive(session.id, { ...event, runtime: identity }),
    base: `http://127.0.0.1:${address.port}`, endpoint: `/api/sessions/${session.id}/native-terminal-results` };
}

async function authenticate(page: Page, ctx: Awaited<ReturnType<typeof fixture>>) {
  await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.ctx.cookie.slice('wdcc-auth='.length), url: ctx.base }]);
}

it.each(['codex', 'claude-code', 'dsh'] as const)('%s retries a transient terminal read after actual WebSocket reconnect without resending or completing the original input', async agent => {
  const ctx = await fixture(agent); let browser: Browser | undefined;
  try {
    const original = { queue: ctx.ctx.store.journal.queue(ctx.session.id), command: ctx.ctx.store.journal.get(ctx.commandId), raw: ctx.ctx.store.nativeEvents.list(ctx.session.id, 0, 500).map(row => ctx.ctx.store.nativeEvents.get(row.id)) };
    const healthy = await ctx.ctx.app.inject({ url: ctx.endpoint, headers: { cookie: ctx.ctx.cookie } }); expect(healthy.statusCode).toBe(200); expect(healthy.json().outcomes).toHaveLength(1);
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); await authenticate(page, ctx);
    await page.addInitScript(() => {
      const scope = window as typeof window & { terminalSockets: WebSocket[] }; const NativeSocket = window.WebSocket; scope.terminalSockets = [];
      Object.defineProperty(window, 'WebSocket', { configurable: true, writable: true,
        value: class extends NativeSocket { constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); scope.terminalSockets.push(this); } } });
    });
    let controlledFailure = true; let gets = 0; let snapshots = 0;
    page.on('websocket', socket => socket.on('framereceived', frame => { const message = JSON.parse(String(frame.payload)); if (message.op === 'snapshot' && message.sessionId === ctx.session.id) snapshots++; }));
    await page.route('**' + ctx.endpoint, async route => { gets++; if (controlledFailure) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'controlled transient read failure' }) }); else await route.continue(); });
    await page.goto(ctx.base + '/s/' + ctx.session.id);
    await expect.poll(() => snapshots).toBeGreaterThanOrEqual(1);
    await expect.poll(() => page.getByText('原生轮次结果暂时无法读取，请稍后刷新。', { exact: true }).count()).toBe(1);
    await page.waitForTimeout(300); const previousGets = gets; const previousSnapshots = snapshots; controlledFailure = false;
    await page.evaluate(() => (window as typeof window & { terminalSockets: WebSocket[] }).terminalSockets.at(-1)!.close());
    await expect.poll(() => snapshots).toBeGreaterThan(previousSnapshots);
    await expect.poll(() => gets).toBeGreaterThan(previousGets);
    await expect.poll(() => page.getByTestId('native-terminal-result').count()).toBe(1);
    expect(await page.getByTestId('native-terminal-result').textContent()).toContain('原生已报告完成');
    expect(ctx.sends()).toBe(0); expect(ctx.ctx.store.journal.queue(ctx.session.id)).toEqual(original.queue); expect(ctx.ctx.store.journal.get(ctx.commandId)).toEqual(original.command);
    expect(ctx.ctx.store.nativeEvents.list(ctx.session.id, 0, 500).map(row => ctx.ctx.store.nativeEvents.get(row.id))).toEqual(original.raw);
    expect(ctx.ctx.store.allEvents(ctx.session.id).some(event => event.kind === 'turn.completed')).toBe(false);
  } finally { await browser?.close(); await ctx.ctx.close(); }
});

it('refreshes a changed native target with an already uncertain turn, rejects its delayed old body and keeps live deltas from restarting result reads', async () => {
  const ctx = await fixture('codex'); let browser: Browser | undefined;
  try {
    const originalQueue = ctx.ctx.store.journal.queue(ctx.session.id);
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); await authenticate(page, ctx);
    await page.addInitScript(({ endpoint }) => {
      const scope = window as typeof window & { releaseTerminalBody?: () => void; terminalBodyWaiting?: boolean; terminalBodyParsed?: boolean };
      const originalFetch = window.fetch.bind(window); let delayed = false;
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
        if (!delayed && url.includes(endpoint)) {
          delayed = true; const response = await originalFetch(input, { ...init, signal: undefined }); const originalJson = response.json.bind(response);
          Object.defineProperty(response, 'json', { configurable: true, writable: true,
            value: async () => { const value = await originalJson(); scope.terminalBodyParsed = true; return value; } });
          await new Promise<void>(resolve => { scope.releaseTerminalBody = resolve; scope.terminalBodyWaiting = true; }); return response;
        }
        return originalFetch(input, init);
      };
    }, { endpoint: ctx.endpoint });
    let gets = 0; page.on('request', request => { if (request.url().endsWith(ctx.endpoint)) gets++; });
    const snapshot = observeSessionSnapshots(page, ctx.session.id); await page.goto(ctx.base + '/s/' + ctx.session.id);
    await expect.poll(() => snapshot()).not.toBeUndefined();
    await expect.poll(() => page.evaluate(() => (window as typeof window & { terminalBodyWaiting?: boolean }).terminalBodyWaiting)).toBe(true);
    const nextNativeId = ctx.session.nativeId! + '-reported-next-target'; ctx.emit({ type: 'native-id', nativeId: nextNativeId }); ctx.record('failed');
    await expect.poll(() => page.getByTestId('native-terminal-result').count()).toBe(2);
    expect(await page.getByTestId('native-terminal-result').last().textContent()).toContain(nextNativeId);
    const currentIds = await page.getByTestId('native-terminal-result').evaluateAll(items => items.map(item => item.getAttribute('data-outcome-id')));
    await page.evaluate(() => (window as typeof window & { releaseTerminalBody?: () => void }).releaseTerminalBody?.());
    await expect.poll(() => page.evaluate(() => (window as typeof window & { terminalBodyParsed?: boolean }).terminalBodyParsed)).toBe(true);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(await page.getByTestId('native-terminal-result').evaluateAll(items => items.map(item => item.getAttribute('data-outcome-id')))).toEqual(currentIds);
    const readCount = gets;
    ctx.emit({ type: 'item.start', itemKey: 'session-stream', kind: 'assistant.message', data: { text: '' }, scope: 'session' });
    for (const append of ['one ', 'two ', 'three']) ctx.emit({ type: 'item.delta', itemKey: 'session-stream', field: 'text', append, scope: 'session' });
    await page.waitForTimeout(300); expect(gets).toBe(readCount);
    expect(ctx.sends()).toBe(0); expect(ctx.ctx.store.journal.queue(ctx.session.id)).toEqual(originalQueue);
    expect(ctx.ctx.store.allEvents(ctx.session.id).some(event => event.kind === 'turn.completed')).toBe(false);
  } finally { await browser?.close(); await ctx.ctx.close(); }
});
