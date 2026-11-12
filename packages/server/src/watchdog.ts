import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionDto, StoredEvent, WatchdogJob, WatchdogSettings, WatchdogView } from '@webdcc/protocol';
import type { Store } from './store.js';

export const DEFAULT_WATCHDOG: WatchdogSettings = {
  enabled: false, maxAttempts: 5, maxHandoffs: 2, baseDelaySeconds: 30, maxDelaySeconds: 900,
};

export function validateWatchdogSettings(input: unknown, current: WatchdogSettings): WatchdogSettings {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('需要 Watchdog 设置对象');
  const patch = input as Record<string, unknown>;
  if (Object.keys(patch).some((key) => !Object.hasOwn(DEFAULT_WATCHDOG, key))) throw new Error('未知 Watchdog 设置');
  const result = { ...current, ...patch } as WatchdogSettings;
  if (typeof result.enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
  for (const [key, min, max] of [['maxAttempts', 1, 10], ['maxHandoffs', 0, 3], ['baseDelaySeconds', 5, 3600], ['maxDelaySeconds', 5, 3600]] as const) {
    if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) throw new Error(`${key} 必须是 ${min}–${max} 的整数`);
  }
  if (result.maxHandoffs > result.maxAttempts || result.maxDelaySeconds < result.baseDelaySeconds) throw new Error('交接上限不能大于恢复上限，最大等待不能小于初始等待');
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

export function handoffPrompt(session: SessionDto, workspacePath: string, events: StoredEvent[], contextPath: string): string {
  const userMessages = events.filter((event) => event.kind === 'user.message' && !String((event.data as { clientCommandId?: string }).clientCommandId ?? '').startsWith('watchdog:'));
  const first = userMessages[0]?.data as { text?: string } | undefined;
  const last = userMessages.at(-1)?.data as { text?: string } | undefined;
  const recent = readableEvents(events.filter((event) => ['assistant.message', 'plan', 'goal', 'file.change', 'command'].includes(event.kind)).slice(-12)).slice(-16_000);
  return [
    'Watchdog 自动交接：旧 Codex 会话因 Responses 历史项的资源归属不匹配而失败。这是独立的新会话，请恢复并继续原任务。',
    `旧 WebDCC 会话：${session.id}\n旧 Codex 会话：${session.nativeId ?? '未记录'}\n工作目录：${workspacePath}\n完整文字交接记录：${contextPath}`,
    '先读工作目录的 AGENTS.md 与项目 MEMORY.md（如有），再读取完整交接记录；核实文件、Git、进程和既有作业的实际状态。记录中的用户要求和授权优先，摘要仅作线索。保留已完成结果，不重复提交已知外部作业，不扩大原会话的权限或任务范围。',
    `最初的用户任务（节选）：\n${first?.text?.slice(0, 6000) ?? '见完整记录'}`,
    `最新用户要求（节选）：\n${last?.text?.slice(-6000) ?? '见完整记录'}`,
    `近期进度（节选）：\n${recent}`,
    '读取并核对记录后继续未完成工作。',
  ].join('\n\n');
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
    this.store.saveWatchdogSettings(settings);
    if (settings.enabled !== current.enabled) this.revision += 1;
    if (!settings.enabled) {
      for (const job of this.store.watchdogJobs()) this.cancel(job.sessionId, '全局 Watchdog 已关闭');
    } else {
      for (const job of this.store.watchdogJobs()) if (job.status === 'scheduled') this.arm(job);
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
    const source = this.store.watchdogJob(sessionId);
    const root = source?.rootSessionId ?? sessionId;
    for (const job of this.store.watchdogJobs()) {
      if (job.sessionId !== sessionId && job.rootSessionId !== root) continue;
      if (job.status !== 'scheduled' && job.status !== 'recovering') continue;
      const timer = this.timers.get(job.sessionId);
      if (timer !== undefined) clearTimeout(timer);
      this.timers.delete(job.sessionId);
      this.save({ ...job, status: 'cancelled', nextAttemptAt: null, detail });
      this.host.notice(job.sessionId, detail);
    }
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
      action: failure.action, status: 'scheduled', attempts: previous?.attempts ?? 0, handoffs: previous?.handoffs ?? 0,
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
    if (job.attempts >= settings.maxAttempts || (job.action === 'handoff' && job.handoffs >= settings.maxHandoffs)) {
      this.save({ ...job, status: 'exhausted', nextAttemptAt: null, detail: '已达到自动恢复上限，请核对进度后手动继续' });
      this.host.notice(job.sessionId, 'Watchdog 已达到恢复上限，停止自动尝试');
      return;
    }
    const backoff = Math.min(settings.maxDelaySeconds * 1000, settings.baseDelaySeconds * 1000 * 2 ** job.attempts);
    const delay = Math.max(retryAfterMs, Math.min(settings.maxDelaySeconds * 1000, backoff * (1 + Math.random() * 0.2)));
    const queued = this.save({ ...job, status: 'scheduled', nextAttemptAt: new Date(Date.now() + delay).toISOString(), detail: job.action === 'handoff' ? '资源归属不匹配，等待建立新会话交接' : '遇到限流或流中断，等待在原会话继续' });
    this.host.notice(job.sessionId, `Watchdog：${queued.detail}；第 ${job.attempts + 1}/${settings.maxAttempts} 次恢复`);
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
    if (job.attempts >= settings.maxAttempts || (job.action === 'handoff' && job.handoffs >= settings.maxHandoffs)) { this.schedule(job, 0); return; }
    const events = this.store.allEvents(sessionId);
    const lastStart = events.filter((event) => event.kind === 'turn.started').at(-1);
    if (lastStart?.turnId !== job.failedTurnId) { this.cancel(sessionId, '已有新的轮次，取消自动恢复'); return; }
    job = this.save({ ...job, status: 'recovering', attempts: job.attempts + 1, nextAttemptAt: null, detail: '正在启动自动恢复' });
    const claim = job;
    const revision = this.revision;
    const valid = (): boolean => !this.stopped && this.revision === revision && this.view().settings.enabled && this.store.watchdogJob(sessionId)?.status === 'recovering' && this.store.watchdogJob(sessionId)?.failedTurnId === claim.failedTurnId && this.store.watchdogJob(sessionId)?.attempts === claim.attempts;
    const commandId = `watchdog:${sessionId}:${claim.failedTurnId}:${claim.attempts}`;
    let target: SessionDto | undefined;
    try {
      if (job.action === 'continue') {
        await this.host.send(sessionId, '继续之前未完成的任务。先核对已有进度和运行中的作业，保留已完成结果，遵守用户最新要求。', commandId, valid);
      } else {
        const workspace = this.store.getWorkspace(source.workspaceId);
        if (workspace === undefined) throw new Error('工作区不存在');
        const dir = join(this.dataDir, 'watchdog', sessionId);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const contextPath = join(dir, `${claim.failedTurnId}.md`);
        await writeFile(contextPath, `# Codex Watchdog 交接记录\n\n原生会话：${source.nativeId ?? '未记录'}\n工作目录：${workspace.path}\n\n${readableEvents(events)}\n`, { mode: 0o600 });
        if (!valid()) return;
        target = await this.host.create(source);
        if (!valid()) { await this.host.dispose(target.id); return; }
        const child: WatchdogJob = { ...claim, sessionId: target.id, failedTurnId: '', handoffs: claim.handoffs + 1, status: 'recovering', detail: '新会话正在接续原任务' };
        this.save(child);
        // Record linkage before sending: a crash cannot lose the identity of
        // an already-created recovery thread.
        this.save({ ...claim, targetSessionId: target.id, handoffs: child.handoffs });
        await this.host.send(target.id, handoffPrompt(source, workspace.path, events, contextPath), commandId, valid);
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
