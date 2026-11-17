import type { EventData, StoredEvent } from './events.js';

/** A passive projection of native Codex tasks, never a WebDCC turn admission. */
export interface CodexSubagentIdentity {
  agent: 'codex';
  childId: string;
  parentThreadId: string;
  nativeTurnId?: string;
  rootTurnId?: string;
  nativeStatus: string;
  agentPath?: string;
  model?: string;
  nativeVersion?: string;
  rolloutPath?: string;
}

export interface CodexSubagentView extends CodexSubagentIdentity {
  turns: Record<string, { status: string; error?: unknown }>;
  results: { nativeTurnId?: string; itemId: string; text: string; nativePhase?: string }[];
  /** The native caller's observations, independent of the child's own turns. */
  snapshots?: CodexSubagentSnapshot[];
}

export interface CodexSubagentSnapshot {
  callId: string;
  senderThreadId: string;
  /** Originating caller turn, never an inferred child turn. */
  nativeTurnId?: string;
  tool: string;
  callStatus: string;
  status: string;
  message: string | null;
  /** Whether this observation was used for the current projected child state. */
  applied: boolean;
}

export function codexSubagentSnapshotKey(value: Pick<CodexSubagentSnapshot, 'callId' | 'senderThreadId' | 'nativeTurnId'>): string {
  return JSON.stringify([value.senderThreadId, value.nativeTurnId ?? null, value.callId]);
}

function codexSubagentSnapshot(value: unknown): CodexSubagentSnapshot | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const snapshot = value as Partial<CodexSubagentSnapshot>;
  if (!['callId', 'senderThreadId', 'tool', 'callStatus', 'status', 'message', 'applied'].every(key => Object.hasOwn(value, key))
    || typeof snapshot.callId !== 'string' || typeof snapshot.senderThreadId !== 'string'
    || typeof snapshot.tool !== 'string' || typeof snapshot.callStatus !== 'string' || typeof snapshot.status !== 'string'
    || snapshot.message !== null && typeof snapshot.message !== 'string' || typeof snapshot.applied !== 'boolean'
    || snapshot.nativeTurnId !== undefined && typeof snapshot.nativeTurnId !== 'string') return undefined;
  return snapshot as CodexSubagentSnapshot;
}

export function codexSubagentStatusLabel(status: string): string {
  return ({ completed: '已完成', failed: '失败', errored: '失败', interrupted: '已中断', shutdown: '已关闭',
    notFound: '原生线程未找到', pendingInit: '等待初始化', waiting: '等待原生交互', running: '运行中' } as Record<string, string>)[status] ?? '状态待确认';
}

export function codexSubagentIdentity(data: EventData['tool.call']): CodexSubagentIdentity | undefined {
  if (data.name !== 'subagent' || data.input === null || typeof data.input !== 'object') return undefined;
  const input = data.input as Partial<CodexSubagentIdentity>;
  return input.agent === 'codex' && typeof input.childId === 'string' && typeof input.parentThreadId === 'string'
    && typeof input.nativeStatus === 'string' ? input as CodexSubagentIdentity : undefined;
}

/** Rebuilt from persisted events after refresh/restart, including earlier turns/results. */
export function currentCodexSubagents(events: readonly StoredEvent[]): CodexSubagentView[] {
  const children = new Map<string, CodexSubagentView>();
  for (const event of events) {
    if (event.kind !== 'tool.call') continue;
    const data = event.data as EventData['tool.call'];
    const identity = codexSubagentIdentity(data);
    if (identity === undefined) continue;
    const previous = children.get(identity.childId);
    const child: CodexSubagentView = { ...previous, ...identity, turns: previous?.turns ?? {}, results: previous?.results ?? [] };
    const output = data.output as { turn?: { id: string; status: string; error?: unknown }; result?: CodexSubagentView['results'][number]; collabSnapshot?: unknown } | undefined;
    if (output?.turn !== undefined) child.turns[output.turn.id] = { status: output.turn.status, ...(output.turn.error == null ? {} : { error: output.turn.error }) };
    if (output?.result !== undefined) {
      const result = output.result;
      child.results = child.results.filter(item => item.itemId !== result.itemId || item.nativeTurnId !== result.nativeTurnId);
      child.results.push(result);
    }
    const snapshot = codexSubagentSnapshot(output?.collabSnapshot);
    if (snapshot !== undefined) {
      const key = codexSubagentSnapshotKey(snapshot);
      child.snapshots = (previous?.snapshots ?? []).filter(value => codexSubagentSnapshotKey(value) !== key);
      child.snapshots.push(snapshot);
    }
    children.set(identity.childId, child);
  }
  return [...children.values()];
}

export function codexSubagentRecoveryText(parentState: string | undefined, children: readonly CodexSubagentView[]): string | undefined {
  if (parentState !== 'failed' || children.length === 0) return undefined;
  return children.every(child => child.nativeStatus === 'completed')
    ? '父轮次失败，子任务已完成，待恢复汇总'
    : '父轮次失败，子任务状态单独保留，待恢复汇总';
}
