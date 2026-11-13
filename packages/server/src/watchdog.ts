import { glob, mkdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionDto, StoredEvent, WatchdogJob, WatchdogSettings, WatchdogView } from '@webdcc/protocol';
import type { Store } from './store.js';

export const DEFAULT_WATCHDOG: WatchdogSettings = {
  enabled: false, maxAttempts: null, maxHandoffs: null, baseDelaySeconds: 30, maxDelaySeconds: 900,
};

const LIMIT_DETAIL = '已达到自动恢复上限，请核对进度后手动继续';

function budgetExceeded(job: WatchdogJob, settings: WatchdogSettings): boolean {
  return job.action === 'continue'
    ? settings.maxAttempts !== null && job.retries >= settings.maxAttempts
    : settings.maxHandoffs !== null && job.handoffs >= settings.maxHandoffs;
}

export function validateWatchdogSettings(input: unknown, current: WatchdogSettings): WatchdogSettings {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('需要 Watchdog 设置对象');
  const patch = input as Record<string, unknown>;
  if (Object.keys(patch).some((key) => !Object.hasOwn(DEFAULT_WATCHDOG, key))) throw new Error('未知 Watchdog 设置');
  const result = { ...current, ...patch } as WatchdogSettings;
  if (typeof result.enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
  if (result.maxAttempts !== null && (!Number.isSafeInteger(result.maxAttempts) || result.maxAttempts < 1)) throw new Error('maxAttempts 必须是正整数或 null（不限次数）');
  if (result.maxHandoffs !== null && (!Number.isSafeInteger(result.maxHandoffs) || result.maxHandoffs < 0)) throw new Error('maxHandoffs 必须是非负整数或 null（不限次数）');
  for (const [key, min, max] of [['baseDelaySeconds', 5, 3600], ['maxDelaySeconds', 5, 3600]] as const) {
    if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) throw new Error(`${key} 必须是 ${min}–${max} 的整数`);
  }
  if (result.maxDelaySeconds < result.baseDelaySeconds) throw new Error('最大等待不能小于初始等待');
  return result;
}

/** Classify only an actual terminal error, never assistant/tool text. */
export function classifyCodexFailure(error: unknown): { action: WatchdogJob['action']; retryAfterMs: number } | undefined {
  const text = typeof error === 'string' ? error : JSON.stringify(error ?? '');
  if (/requested item was created under a different.{0,120}openai resource|use the same resource that created the item/i.test(text)) return { action: 'handoff', retryAfterMs: 0 };
  if (/insufficient[_ ]quota|quota.{0,30}exceeded|unauthori[sz]ed|invalid[_ ]api[_ ]key|billing|payment required/i.test(text)) return undefined;
  if (!/rate[_ -]?limit|too many requests|\b429\b|stream disconnected|stream.{0,50}before.{0,50}(?:complet|response)/i.test(text)) return undefined;
  const hint = /(?:retry[_ -]?after|try again in|retry in)[\s"':=]*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?)?/i.exec(text);
  const unit = hint?.[2]?.toLowerCase() ?? 's';
  const multiplier = unit.startsWith('ms') || unit.startsWith('millisecond') ? 1 : unit.startsWith('m') ? 60_000 : unit.startsWith('h') ? 3_600_000 : 1000;
  return { action: 'continue', retryAfterMs: hint === null ? 0 : Math.min(Number(hint[1]) * multiplier, 86_400_000) };
}

function readableEvents(events: StoredEvent[]): string {
  return events.flatMap((event) => {
    const data = event.data as Record<string, unknown>;
    if (event.kind === 'user.message' || event.kind === 'assistant.message') return [`[${event.at} ${event.kind}]\n${String(data['text'] ?? '')}`];
    if (['command', 'file.change', 'plan', 'goal', 'error', 'turn.completed', 'notice'].includes(event.kind)) return [`[${event.at} ${event.kind}]\n${JSON.stringify(event.data)}`];
    return [];
  }).join('\n\n');
}

export function handoffPrompt(session: SessionDto, contextPath: string): string {
  return [
    `旧 Codex 会话 ID：${session.nativeId ?? session.id}`,
    '看一下这个会话的完整上下文，然后继续做。',
    `会话记录：${contextPath}`,
  ].join('\n');
}

/** Locate the actual local rollout, as in the user's manual old-ID handoff. */
export async function nativeHistoryPath(nativeId: string | undefined, codexHome = process.env['CODEX_HOME'] ?? join(homedir(), '.codex')): Promise<string | undefined> {
  if (nativeId === undefined || !/^[a-f0-9-]{36}$/i.test(nativeId)) return undefined;
  const root = join(codexHome, 'sessions');
  try {
    for await (const path of glob(`**/*${nativeId}.jsonl`, { cwd: root })) return join(root, path);
  } catch { /* Fall back to the readable WebDCC record if the native rollout is unavailable. */ }
  return undefined;
}

interface WatchdogHost {
  isActive(sessionId: string): boolean;
  create(source: SessionDto): Promise<SessionDto>;
  send(sessionId: string, text: string, commandId: string, allowed: () => boolean): Promise<void>;
  dispose(sessionId: string): Promise<void>;
  notice(sessionId: string, text: string): void;
}

/** Durable queues; fresh-thread creation never uses resume/fork. */
export class CodexWatchdog {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private stopped = false;
  private started = false;
  private revision = 0;

  constructor(private readonly store: Store, private readonly host: WatchdogHost, private readonly dataDir = tmpdir()) {}

  view(): WatchdogView {
    return { settings: { ...DEFAULT_WATCHDOG, ...this.store.watchdogSettings() }, jobs: this.store.watchdogJobs().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
  }

  configure(input: unknown): WatchdogView {
    const current = this.view().settings;
    const settings = validateWatchdogSettings(input, current);
    const limitsChanged = settings.maxAttempts !== current.maxAttempts || settings.maxHandoffs !== current.maxHandoffs;
    this.store.saveWatchdogSettings(settings);
    if (settings.enabled !== current.enabled) this.revision += 1;
    if (!settings.enabled) {
      for (const job of this.store.watchdogJobs()) this.cancel(job.sessionId, '全局 Watchdog 已关闭');
    } else {
      for (const job of this.store.watchdogJobs()) {
        if (job.status === 'scheduled') this.arm(job);
        else if (job.status === 'exhausted' && job.detail === LIMIT_DETAIL && (!current.enabled || limitsChanged) && !budgetExceeded(job, settings)) {
          const source = this.store.getSession(job.sessionId);
          if (source?.agent === 'codex' && !source.archived && !this.host.isActive(job.sessionId)) this.schedule(job, 0);
        }
      }
    }
    return this.view();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const job of this.store.watchdogJobs()) {
      if (job.status === 'recovering') {
        // A request may already have executed before a crash. Do not repeat
        // an uncertain send or create a second handoff thread on restart.
        this.save({ ...job, status: 'cancelled', nextAttemptAt: null, detail: '服务重启，上一轮恢复结果不确定；请核对进度后手动继续' });
      } else if (job.status === 'scheduled' && this.view().settings.enabled) this.arm(job);
    }
  }

  stop(): void {
    this.stopped = true;
    this.revision += 1;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  cancel(sessionId: string, detail = '用户取消了自动恢复'): void {
    const job = this.store.watchdogJob(sessionId);
    if (job === undefined || (job.status !== 'scheduled' && job.status !== 'recovering')) return;
    const timer = this.timers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(sessionId);
    this.save({ ...job, status: 'cancelled', nextAttemptAt: null, detail });
    this.host.notice(sessionId, detail);
  }

  userInput(sessionId: string): void {
    this.cancel(sessionId, '用户已介入，取消待执行的自动恢复');
    this.store.clearWatchdogJob(sessionId);
  }

  terminal(sessionId: string, turnId: string, status: 'completed' | 'interrupted' | 'failed', error: unknown): void {
    const source = this.store.getSession(sessionId);
    if (source?.agent !== 'codex' || source.archived || this.stopped) return;
    const previous = this.store.watchdogJob(sessionId);
    if (status === 'interrupted') { this.cancel(sessionId, '轮次已停止，取消自动恢复'); return; }
    if (previous?.status === 'cancelled' || !this.view().settings.enabled) return;
    if (status === 'completed') {
      if (previous?.status === 'recovering') this.save({ ...previous, status: 'recovered', nextAttemptAt: null, detail: '恢复轮次已正常结束' });
      return;
    }
    if (previous?.failedTurnId === turnId) return;
    const failure = classifyCodexFailure(error);
    if (failure === undefined) {
      if (previous?.status === 'recovering') this.save({ ...previous, status: 'exhausted', nextAttemptAt: null, detail: '此错误不支持自动恢复，请检查后手动处理' });
      return;
    }
    this.schedule({
      sessionId, rootSessionId: previous?.rootSessionId ?? sessionId, failedTurnId: turnId,
      action: failure.action, status: 'scheduled', attempts: previous?.attempts ?? 0, retries: previous?.retries ?? 0, handoffs: previous?.handoffs ?? 0,
      nextAttemptAt: null, detail: '', updatedAt: '',
    }, failure.retryAfterMs);
  }

  private save(job: WatchdogJob): WatchdogJob {
    const updated = { ...job, updatedAt: new Date().toISOString() };
    this.store.saveWatchdogJob(updated);
    return updated;
  }

  private schedule(job: WatchdogJob, retryAfterMs: number): void {
    const settings = this.view().settings;
    if (!settings.enabled || this.stopped) return;
    if (budgetExceeded(job, settings)) {
      this.save({ ...job, status: 'exhausted', nextAttemptAt: null, detail: LIMIT_DETAIL });
      this.host.notice(job.sessionId, 'Watchdog 已达到恢复上限，停止自动尝试');
      return;
    }
    const backoff = Math.min(settings.maxDelaySeconds * 1000, settings.baseDelaySeconds * 1000 * 2 ** Math.min(job.attempts, 30));
    const delay = Math.max(retryAfterMs, Math.min(settings.maxDelaySeconds * 1000, backoff * (1 + Math.random() * 0.2)));
    const queued = this.save({ ...job, status: 'scheduled', nextAttemptAt: new Date(Date.now() + delay).toISOString(), detail: job.action === 'handoff' ? '资源归属不匹配，等待建立新会话交接' : '遇到限流或流中断，等待在原会话继续' });
    const number = job.action === 'continue' ? job.retries + 1 : job.handoffs + 1;
    const limit = job.action === 'continue' ? settings.maxAttempts : settings.maxHandoffs;
    const action = job.action === 'continue' ? '续跑' : '转交';
    const count = limit === null ? `第 ${number} 次${action}（不限次数）` : `第 ${number}/${limit} 次${action}`;
    this.host.notice(job.sessionId, `Watchdog：${queued.detail}；${count}`);
    this.arm(queued);
  }

  private arm(job: WatchdogJob): void {
    const old = this.timers.get(job.sessionId);
    if (old !== undefined) clearTimeout(old);
    if (this.stopped || !this.view().settings.enabled || job.nextAttemptAt === null) return;
    const timer = setTimeout(() => {
      this.timers.delete(job.sessionId);
      void this.execute(job.sessionId).catch(() => {
        const current = this.store.watchdogJob(job.sessionId);
        if (current?.status === 'recovering') this.save({ ...current, status: 'exhausted', nextAttemptAt: null, detail: '自动恢复未能启动，请检查后手动继续' });
      });
    }, Math.max(0, Date.parse(job.nextAttemptAt) - Date.now()));
    timer.unref?.();
    this.timers.set(job.sessionId, timer);
  }

  private async execute(sessionId: string): Promise<void> {
    let job = this.store.watchdogJob(sessionId);
    const settings = this.view().settings;
    if (job?.status !== 'scheduled' || !settings.enabled || this.stopped) return;
    const source = this.store.getSession(sessionId);
    if (source === undefined || source.archived || source.agent !== 'codex' || this.host.isActive(sessionId)) { this.cancel(sessionId, '会话已变化，取消自动恢复'); return; }
    if (budgetExceeded(job, settings)) { this.schedule(job, 0); return; }
    const events = this.store.allEvents(sessionId);
    const lastStart = events.filter((event) => event.kind === 'turn.started').at(-1);
    if (lastStart?.turnId !== job.failedTurnId) { this.cancel(sessionId, '已有新的轮次，取消自动恢复'); return; }
    job = this.save({ ...job, status: 'recovering', attempts: job.attempts + 1, retries: job.retries + (job.action === 'continue' ? 1 : 0), nextAttemptAt: null, detail: '正在启动自动恢复' });
    const claim = job;
    const revision = this.revision;
    const valid = (): boolean => !this.stopped && this.revision === revision && this.view().settings.enabled && this.store.watchdogJob(sessionId)?.status === 'recovering' && this.store.watchdogJob(sessionId)?.failedTurnId === claim.failedTurnId && this.store.watchdogJob(sessionId)?.attempts === claim.attempts;
    const commandId = `watchdog:${sessionId}:${claim.failedTurnId}:${claim.attempts}`;
    let target: SessionDto | undefined;
    try {
      if (job.action === 'continue') {
        await this.host.send(sessionId, '继续', commandId, valid);
      } else {
        const workspace = this.store.getWorkspace(source.workspaceId);
        if (workspace === undefined) throw new Error('工作区不存在');
        let contextPath = await nativeHistoryPath(source.nativeId);
        if (contextPath === undefined) {
          const dir = join(this.dataDir, 'watchdog', sessionId);
          await mkdir(dir, { recursive: true, mode: 0o700 });
          contextPath = join(dir, `${claim.failedTurnId}.md`);
          await writeFile(contextPath, `# Codex Watchdog 交接记录\n\n原生会话：${source.nativeId ?? '未记录'}\n工作目录：${workspace.path}\n\n${readableEvents(events)}\n`, { mode: 0o600 });
        }
        if (!valid()) return;
        target = await this.host.create(source);
        if (!valid()) { await this.host.dispose(target.id); return; }
        const child: WatchdogJob = { ...claim, sessionId: target.id, failedTurnId: '', handoffs: claim.handoffs + 1, status: 'recovering', detail: '新会话正在接续原任务' };
        this.save(child);
        // Record linkage before sending: a crash cannot lose the identity of
        // an already-created recovery thread.
        this.save({ ...claim, targetSessionId: target.id, handoffs: child.handoffs });
        await this.host.send(target.id, handoffPrompt(source, contextPath), commandId, valid);
        if (valid()) {
          this.save({ ...claim, handoffs: child.handoffs, targetSessionId: target.id, status: 'handed-off', detail: '已在新会话接续原任务' });
          this.host.notice(sessionId, `Watchdog 已建立接续会话：${target.id}`);
        }
      }
    } catch (error) {
      if (!valid()) return;
      const current = this.store.watchdogJob(sessionId) as WatchdogJob;
      const failure = classifyCodexFailure(error instanceof Error ? error.message : error);
      if (target !== undefined) {
        const child = this.store.watchdogJob(target.id);
        if (child?.status === 'recovering') this.save({ ...child, status: 'exhausted', detail: '接续会话未能启动，请检查后手动继续' });
        this.save({ ...current, status: 'handed-off', targetSessionId: target.id, detail: '已建立接续会话，恢复状态见新会话' });
      } else if (failure === undefined) {
        this.save({ ...current, status: 'exhausted', detail: '自动恢复未能启动，请检查后手动继续' });
      } else this.schedule({ ...current, action: failure.action }, failure.retryAfterMs);
    }
  }
}
