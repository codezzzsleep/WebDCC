import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterEvent, CreateOpts, UserInput } from '@webdcc/protocol';
import { ulid } from '@webdcc/protocol';
import { FakeAdapter } from '@webdcc/fake-adapter';
import { SessionManager } from '../src/manager.js';
import { classifyCodexFailure } from '../src/watchdog.js';
import { createTestApp, seedWorkspaceAndSession, type TestApp } from './helpers.js';

const RESOURCE_ERROR = 'OpenAI Responses bad request: The requested item was created under a different *** OpenAI resource. Use the same resource that created the item to access it.';

class ControlledCodex extends FakeAdapter {
  created: CreateOpts[] = [];
  resumed: (CreateOpts & { nativeId: string })[] = [];
  sent: { sessionId: string; input: UserInput }[] = [];
  createGate?: Promise<void>;
  resumeGate?: Promise<void>;
  afterSend?: (sessionId: string) => void;
  private callbacks: ((sessionId: string, event: AdapterEvent) => void)[] = [];
  private nativeTurns = new Map<string, string>();
  constructor() { super({ id: 'codex' }); }
  override onEvent(cb: (id: string, event: AdapterEvent) => void): void { this.callbacks.push(cb); }
  override async create(opts: CreateOpts): Promise<{ nativeId: string }> {
    this.created.push(opts);
    await this.createGate;
    return super.create(opts);
  }
  override async resume(opts: CreateOpts & { nativeId: string }): Promise<void> {
    this.resumed.push(opts);
    await this.resumeGate;
    await super.resume(opts);
  }
  override async send(sessionId: string, input: UserInput): Promise<void> {
    this.sent.push({ sessionId, input });
    const id = ulid(); this.nativeTurns.set(sessionId, id);
    this.fire(sessionId, { type: 'turn.start', nativeTurnId: id });
    this.afterSend?.(sessionId);
  }
  override async interrupt(sessionId: string): Promise<void> { this.finish(sessionId, 'interrupted'); }
  fire(sessionId: string, event: AdapterEvent): void { for (const cb of this.callbacks) cb(sessionId, event); }
  finish(sessionId: string, status: 'completed' | 'interrupted' | 'failed', message?: string): void {
    const id = this.nativeTurns.get(sessionId);
    this.fire(sessionId, { type: 'turn.end', ...(id === undefined ? {} : { nativeTurnId: id }), status, native: { turn: { id, status, ...(message === undefined ? {} : { error: { message } }) } } });
  }
}

describe('Codex Watchdog', () => {
  let ctx: TestApp;
  let codex: ControlledCodex;
  beforeEach(async () => {
    ctx = await createTestApp(); codex = new ControlledCodex(); ctx.manager.registerAdapter(codex);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); vi.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(async () => { ctx.manager.watchdog.stop(); vi.useRealTimers(); await ctx.close(); vi.restoreAllMocks(); });
  const enable = (patch: Record<string, unknown> = {}): void => { ctx.manager.watchdog.configure({ enabled: true, baseDelaySeconds: 5, ...patch }); };

  it('分类实际限流/资源错误，拒绝余额、认证和未知错误', () => {
    expect(classifyCodexFailure(RESOURCE_ERROR)?.action).toBe('handoff');
    expect(classifyCodexFailure({ message: 'token rate limit exceeded, please try again in 2m' })).toEqual({ action: 'continue', retryAfterMs: 120_000 });
    expect(classifyCodexFailure('stream disconnected before response.completed')?.action).toBe('continue');
    expect(classifyCodexFailure('429 insufficient_quota')).toBeUndefined();
    expect(classifyCodexFailure('401 unauthorized')).toBeUndefined();
    expect(classifyCodexFailure('command exited with code 1')).toBeUndefined();
  });

  it('全局设置默认关闭，并要求认证及有效的有界设置', async () => {
    const route = '/api/watchdog';
    expect((await ctx.app.inject({ method: 'GET', url: route })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'PATCH', url: route, payload: { enabled: true } })).statusCode).toBe(401);
    const get = await ctx.app.inject({ method: 'GET', url: route, headers: { cookie: ctx.cookie } });
    expect(get.json().settings.enabled).toBe(false);
    for (const payload of [{ enabled: 'yes' }, { maxAttempts: 0 }, { maxAttempts: 1 }, { baseDelaySeconds: 4000 }, { unknown: true }, null]) {
      expect((await ctx.app.inject({ method: 'PATCH', url: route, headers: { cookie: ctx.cookie }, payload })).statusCode).toBe(400);
    }
    const result = await ctx.app.inject({ method: 'PATCH', url: route, headers: { cookie: ctx.cookie }, payload: { enabled: true } });
    expect(result.statusCode).toBe(200); expect(ctx.store.watchdogSettings()?.enabled).toBe(true);
  });

  it('默认关闭不发送任何自动消息，且不影响其他 Harness', async () => {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    await ctx.manager.send(sessionId, { text: '开发任务' }); codex.finish(sessionId, 'failed', '429 token rate limit exceeded');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(codex.sent).toHaveLength(1); expect(ctx.manager.watchdog.view().jobs).toHaveLength(0);
    enable();
    for (const agent of ['dsh', 'claude-code']) {
      const other = await seedWorkspaceAndSession(ctx, agent);
      ctx.manager.watchdog.terminal(other.sessionId, 'failed-turn', 'failed', RESOURCE_ERROR);
    }
    expect(ctx.manager.watchdog.view().jobs).toHaveLength(0);
  });

  it('等待终止失败后，在原会话续跑，并去重重复的终止通知', async () => {
    enable(); const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    const original = ctx.store.getSession(sessionId)?.nativeId;
    await ctx.manager.send(sessionId, { text: '继续开发，暂不上线' });
    codex.fire(sessionId, { type: 'item.complete', itemKey: 'retry-error', kind: 'error', data: { message: '429 rate limit exceeded' }, native: { willRetry: true } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(codex.sent).toHaveLength(1); expect(ctx.manager.watchdog.view().jobs).toHaveLength(0);
    codex.finish(sessionId, 'failed', '429 rate limit exceeded'); codex.finish(sessionId, 'failed', '429 rate limit exceeded');
    await vi.advanceTimersByTimeAsync(4999); expect(codex.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(codex.sent).toHaveLength(2);
    expect(codex.created).toHaveLength(1); expect(ctx.store.getSession(sessionId)?.nativeId).toBe(original);
    expect(ctx.store.watchdogJob(sessionId)?.attempts).toBe(1);
    codex.finish(sessionId, 'completed'); await vi.advanceTimersByTimeAsync(1500);
    expect(ctx.store.watchdogJob(sessionId)?.status).toBe('recovered');
  });

  it('全局开关覆盖多个 Codex 会话并遵守供应商等待时间', async () => {
    enable(); const a = await seedWorkspaceAndSession(ctx, 'codex'); const b = await seedWorkspaceAndSession(ctx, 'codex');
    await ctx.manager.send(a.sessionId, { text: '任务 A' }); await ctx.manager.send(b.sessionId, { text: '任务 B' });
    codex.finish(a.sessionId, 'failed', '429 rate limit exceeded, retry after 20 seconds');
    codex.finish(b.sessionId, 'failed', '429 rate limit exceeded');
    await vi.advanceTimersByTimeAsync(5000);
    expect(codex.sent.filter((send) => send.sessionId === a.sessionId)).toHaveLength(1);
    expect(codex.sent.filter((send) => send.sessionId === b.sessionId)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(codex.sent.filter((send) => send.sessionId === a.sessionId)).toHaveLength(2);
  });

  it('资源不匹配建立独立新会话，保留配置/关联/文字记录，不重带图像或原生 item', async () => {
    enable();
    const ws = await seedWorkspaceAndSession(ctx, 'codex');
    ctx.store.createProvider({ id: 'test-provider', name: 'test', baseUrl: 'https://example.invalid', protocols: ['openai-responses'], models: ['fake-model'], secretRef: 'fake-key-ref', codexCatalogPath: null });
    const source = await ctx.manager.createSession({ workspaceId: ws.workspaceId, agent: 'codex', providerId: 'test-provider', model: 'fake-model', reasoningEffort: 'high', accessMode: 'workspace' });
    await ctx.manager.send(source.id, { text: '实现 Watchdog，暂不上线', images: [{ fileId: 'old-image', path: '/unused.png', mime: 'image/png' }] });
    codex.fire(source.id, { type: 'item.complete', itemKey: 'progress', kind: 'assistant.message', data: { text: '已完成数据库迁移' }, native: { encrypted_content: 'must-not-copy' } });
    codex.finish(source.id, 'failed', RESOURCE_ERROR);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(ctx.store.watchdogJob(source.id)?.status).toBe('handed-off'));
    const targetId = ctx.store.watchdogJob(source.id)?.targetSessionId as string;
    const child = ctx.store.getSession(targetId);
    expect(child?.nativeId).not.toBe(source.nativeId); expect(child?.parentId).toBe(source.id);
    expect(child).toMatchObject({ workspaceId: source.workspaceId, providerId: 'test-provider', model: 'fake-model', reasoningEffort: 'high', accessMode: 'workspace' });
    const send = codex.sent.find((item) => item.sessionId === targetId);
    expect(send?.input.images).toBeUndefined(); expect(send?.input.text).toContain('暂不上线'); expect(send?.input.text).toContain(source.nativeId);
    expect(send?.input.text).not.toContain('must-not-copy');
    const contextPath = /完整文字交接记录：([^\n]+)/.exec(send?.input.text ?? '')?.[1] as string;
    expect(await readFile(contextPath, 'utf8')).toContain('已完成数据库迁移');
    expect(codex.resumed).toHaveLength(0);
  });

  it.each(['disable', 'interrupt', 'archive', 'manual', 'cancel-api'])('用户 %s 后取消待执行的恢复', async (action) => {
    enable(); const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    await ctx.manager.send(sessionId, { text: '开发任务' }); codex.finish(sessionId, 'failed', '429 rate limit exceeded');
    if (action === 'disable') ctx.manager.watchdog.configure({ enabled: false });
    if (action === 'interrupt') await ctx.manager.interrupt(sessionId);
    if (action === 'archive') await ctx.manager.archive(sessionId, true);
    if (action === 'manual') await ctx.manager.send(sessionId, { text: '我来继续' });
    if (action === 'cancel-api') expect((await ctx.app.inject({ method: 'POST', url: `/api/watchdog/sessions/${sessionId}/cancel`, headers: { cookie: ctx.cookie }, payload: {} })).statusCode).toBe(200);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(codex.sent).toHaveLength(action === 'manual' ? 2 : 1);
  });

  it('关闭再开启不会重新唤醒已取消的失败', async () => {
    enable(); const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    await ctx.manager.send(sessionId, { text: '开发任务' }); codex.finish(sessionId, 'failed', RESOURCE_ERROR);
    ctx.manager.watchdog.configure({ enabled: false }); ctx.manager.watchdog.configure({ enabled: true });
    await vi.advanceTimersByTimeAsync(60_000); expect(codex.created).toHaveLength(1);
  });

  it('限流连续失败使用指数退避，并在上限停止，包括同步终止通知', async () => {
    enable({ maxAttempts: 2, maxHandoffs: 0 }); const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    await ctx.manager.send(sessionId, { text: '开发任务' });
    codex.afterSend = (id) => codex.finish(id, 'failed', '429 rate limit exceeded');
    codex.finish(sessionId, 'failed', '429 rate limit exceeded');
    await vi.advanceTimersByTimeAsync(5000); expect(codex.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(9999); expect(codex.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); expect(codex.sent).toHaveLength(3);
    expect(ctx.store.watchdogJob(sessionId)?.status).toBe('exhausted');
    expect(ctx.store.getSession(sessionId)?.status).toBe('idle');
    await vi.advanceTimersByTimeAsync(100_000); expect(codex.sent).toHaveLength(3);
  });

  it('新会话继承交接预算，连续资源错误不会无限创建会话', async () => {
    enable({ maxAttempts: 2, maxHandoffs: 1 }); const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    await ctx.manager.send(sessionId, { text: '开发任务' });
    codex.afterSend = (id) => codex.finish(id, 'failed', RESOURCE_ERROR);
    codex.finish(sessionId, 'failed', RESOURCE_ERROR); await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(ctx.store.watchdogJob(sessionId)?.status).toBe('handed-off'));
    const child = ctx.store.watchdogJob(sessionId)?.targetSessionId as string;
    expect(ctx.store.watchdogJob(child)).toMatchObject({ status: 'exhausted', rootSessionId: sessionId, handoffs: 1, attempts: 1 });
    await vi.advanceTimersByTimeAsync(100_000); expect(codex.created).toHaveLength(2);
  });

  it('重启恢复持久化等待队列，原生会话身份保持不变', async () => {
    enable(); const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    const nativeId = ctx.store.getSession(sessionId)?.nativeId;
    await ctx.manager.send(sessionId, { text: '开发任务' }); codex.finish(sessionId, 'failed', '429 rate limit exceeded');
    await ctx.manager.disposeAll();
    const next = new SessionManager(ctx.store, { idleDisposeMin: 0, watchdogDataDir: ctx.dataDir }); const adapter = new ControlledCodex(); next.registerAdapter(adapter);
    try {
      await vi.advanceTimersByTimeAsync(5000); expect(adapter.sent).toHaveLength(1);
      expect(adapter.resumed[0]?.nativeId).toBe(nativeId); expect(adapter.created).toHaveLength(0);
    } finally { await next.disposeAll(); }
  });

  it('重启不重复提交结果不确定的恢复请求', async () => {
    enable(); const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    await ctx.manager.send(sessionId, { text: '开发任务' }); codex.finish(sessionId, 'failed', '429 rate limit exceeded');
    await vi.advanceTimersByTimeAsync(5000); await ctx.manager.disposeAll();
    const job = ctx.store.watchdogJob(sessionId); if (job === undefined) throw new Error('missing job');
    ctx.store.saveWatchdogJob({ ...job, status: 'recovering' });
    const next = new SessionManager(ctx.store, { idleDisposeMin: 0, watchdogDataDir: ctx.dataDir }); const adapter = new ControlledCodex(); next.registerAdapter(adapter);
    try { await vi.advanceTimersByTimeAsync(60_000); expect(adapter.sent).toHaveLength(0); expect(ctx.store.watchdogJob(sessionId)?.status).toBe('cancelled'); }
    finally { await next.disposeAll(); }
  });

  it('新会话正在创建时关闭开关，不发送交接请求', async () => {
    enable(); const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    await ctx.manager.send(sessionId, { text: '开发任务' });
    let release: (() => void) | undefined; codex.createGate = new Promise<void>((resolve) => { release = resolve; });
    codex.finish(sessionId, 'failed', RESOURCE_ERROR); await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(codex.created).toHaveLength(2));
    ctx.manager.watchdog.configure({ enabled: false }); release?.();
    await vi.waitFor(() => expect(ctx.store.listSessions()).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(60_000); expect(codex.sent).toHaveLength(1);
    expect(ctx.store.watchdogJob(sessionId)?.status).toBe('cancelled');
  });

  it('原会话正在恢复连接时用户停止，不提交续跑消息', async () => {
    enable(); const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    await ctx.manager.send(sessionId, { text: '开发任务' }); codex.finish(sessionId, 'failed', '429 rate limit exceeded');
    await ctx.manager.dispose(sessionId);
    let release: (() => void) | undefined; codex.resumeGate = new Promise<void>((resolve) => { release = resolve; });
    await vi.advanceTimersByTimeAsync(5000); expect(codex.resumed).toHaveLength(1);
    await ctx.manager.interrupt(sessionId); release?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(codex.sent).toHaveLength(1); expect(ctx.store.watchdogJob(sessionId)?.status).toBe('cancelled');
  });

  it('仍有未回答的问题时不自动继续，也不自动回答', async () => {
    enable(); const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    await ctx.manager.send(sessionId, { text: '开发任务' });
    codex.fire(sessionId, { type: 'item.complete', itemKey: 'pending-question', kind: 'question', data: { questionId: 'q', prompt: '需要用户选择', status: 'pending' } });
    codex.finish(sessionId, 'failed', '429 rate limit exceeded'); await vi.advanceTimersByTimeAsync(60_000);
    expect(codex.sent).toHaveLength(1); expect(ctx.store.watchdogJob(sessionId)?.status).toBe('cancelled');
  });

  it('交接任务运行中不会在旧会话并发执行，停止来源会话会停止接续轮次', async () => {
    enable(); const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    await ctx.manager.send(sessionId, { text: '开发任务' }); codex.finish(sessionId, 'failed', RESOURCE_ERROR);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(ctx.store.watchdogJob(sessionId)?.status).toBe('handed-off'));
    const child = ctx.store.watchdogJob(sessionId)?.targetSessionId as string;
    await expect(ctx.manager.send(sessionId, { text: '继续' })).rejects.toThrow('接续会话');
    await ctx.manager.interrupt(sessionId);
    expect(ctx.manager.getRuntime(child)?.turnId).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000); expect(codex.created).toHaveLength(2);
  });

  it('交接已创建而首轮发送抛出限流时，保留新会话关联并由新会话退避', async () => {
    enable(); const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    await ctx.manager.send(sessionId, { text: '开发任务' });
    codex.afterSend = () => { throw new Error('429 token rate limit exceeded'); };
    codex.finish(sessionId, 'failed', RESOURCE_ERROR); await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(ctx.store.watchdogJob(sessionId)?.status).toBe('handed-off'));
    const child = ctx.store.watchdogJob(sessionId)?.targetSessionId as string;
    expect(ctx.store.watchdogJob(child)).toMatchObject({ status: 'scheduled', action: 'continue', attempts: 1, handoffs: 1 });
    expect(ctx.store.getSession(child)?.parentId).toBe(sessionId);
  });

  it('用户排队的消息优先于失败轮次的自动恢复', async () => {
    enable(); const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    await ctx.manager.send(sessionId, { text: '第一轮' });
    const queued = await ctx.manager.send(sessionId, { text: '用户的下一步' });
    expect(queued.queued).toBe(true);
    codex.finish(sessionId, 'failed', '429 token rate limit exceeded');
    expect(codex.sent.map((item) => item.input.text)).toEqual(['第一轮', '用户的下一步']);
    expect(ctx.store.watchdogJob(sessionId)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000); expect(codex.sent).toHaveLength(2);
  });

  it('正在运行的会话不排队自动恢复消息', async () => {
    enable(); const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    await ctx.manager.send(sessionId, { text: '第一轮' });
    await expect(ctx.manager.send(sessionId, { text: '自动恢复' }, 'watchdog:test', () => true)).rejects.toThrow('正在运行');
    expect(ctx.manager.getRuntime(sessionId)?.queued).toHaveLength(0);
  });

  it('回收会话时不会提交剩余队列中的消息', async () => {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    await ctx.manager.send(sessionId, { text: '第一轮' });
    await ctx.manager.send(sessionId, { text: '排队的第二轮' });
    await ctx.manager.dispose(sessionId);
    expect(codex.sent).toHaveLength(1);
    expect(ctx.manager.getRuntime(sessionId)).toBeUndefined();
  });
});
