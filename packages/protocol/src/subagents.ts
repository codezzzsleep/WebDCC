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
    const output = data.output as { turn?: { id: string; status: string; error?: unknown }; result?: CodexSubagentView['results'][number] } | undefined;
    if (output?.turn !== undefined) child.turns[output.turn.id] = { status: output.turn.status, ...(output.turn.error == null ? {} : { error: output.turn.error }) };
    if (output?.result !== undefined) {
      const result = output.result;
      child.results = child.results.filter(item => item.itemId !== result.itemId || item.nativeTurnId !== result.nativeTurnId);
      child.results.push(result);
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
