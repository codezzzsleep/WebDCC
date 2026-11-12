import type { EventData, EventKind, StoredEvent, UsageData } from './events.js';

/** A live item is the in-memory counterpart of an item.start event. */
export interface OpenItem {
  itemKey: string;
  kind: EventKind;
  data: EventData[EventKind];
  turnId?: string | null;
  at?: string;
}

/** Timeline steps intentionally retain the persisted event for stable keys and
 * native evidence.  Components must render this value instead of re-inferring
 * state from the complete event list. */
export type Step = StoredEvent;

export interface LiveItem extends OpenItem {
  text?: string;
}

export interface TurnView {
  turnId: string;
  state: 'starting' | 'running' | 'waiting' | 'completed' | 'interrupted' | 'failed';
  user: { text: string; images?: string[]; at: string };
  userSeq?: number;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  activity: null | { kind: 'thinking' | 'writing' | 'running' | 'waiting'; label?: string };
  steps: Step[];
  live: LiveItem[];
  answer: { itemKey: string; text: string }[];
  changes: { path: string; kind: 'add' | 'modify' | 'delete'; added: number; removed: number; diffFileId?: string; note?: string }[];
  summary: { commands: number; reads: number; edits: number; tools: number };
  plan?: EventData['plan']['items'];
  goal?: EventData['goal'];
  usage?: UsageData;
  pending?: { clientCommandId: string; text: string; at: string; status: 'pending' | 'sent' | 'failed' };
}

const TERMINAL: ReadonlySet<string> = new Set(['completed', 'interrupted', 'failed']);
const ACTION_KINDS: ReadonlySet<EventKind> = new Set([
  'command',
  'file.read',
  'file.change',
  'turn.diff',
  'tool.call',
  'approval.request',
  'question',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function nativePhase(event: StoredEvent): string | undefined {
  const data = record(event.data);
  if (typeof data?.['nativePhase'] === 'string') return data['nativePhase'];
  if (data?.['phase'] === 'final') return 'final_answer';
  const native = record(event.native);
  return typeof native?.['phase'] === 'string' ? native['phase'] : undefined;
}

function assistantText(event: StoredEvent): string {
  const data = event.data as Partial<EventData['assistant.message']>;
  return typeof data.text === 'string' ? data.text : '';
}

function isFinalNativeAssistant(event: StoredEvent): boolean {
  if (event.kind !== 'assistant.message') return false;
  const native = record(event.native);
  if (Array.isArray(native?.['questions']) && native['questions'].length > 0) return false;
  const phase = nativePhase(event);
  if (phase === 'final_answer' || phase === 'partial_answer' || phase === 'final_result') return true;
  const message = record(native?.['message']);
  const stopReason = native?.['stop_reason'] ?? message?.['stop_reason'];
  return typeof stopReason === 'string' && stopReason !== 'tool_use';
}

/** Decide the answer once at turn completion.  This function is pure and can
 * be used both for old rows (which have no answerItemKeys) and live turns. */
export function resolveAnswer(events: readonly StoredEvent[]): { itemKey: string; text: string }[] {
  const assistants = events.filter((event) => event.kind === 'assistant.message' && assistantText(event) !== '');
  if (assistants.length === 0) return [];

  const completed = [...events].reverse().find((event) => event.kind === 'turn.completed');
  const completedNative = record(completed?.native);
  if (typeof completedNative?.['result'] === 'string' && completedNative['result'] !== '') {
    const result = String(completedNative['result']);
    const matching = assistants.filter((event) => assistantText(event) === result);
    if (matching.length > 0) {
      const event = matching[matching.length - 1] as StoredEvent;
      return [{ itemKey: event.itemKey, text: result }];
    }
    const marked = assistants.filter((event) => nativePhase(event) === 'final_result');
    if (marked.length > 0) {
      const event = marked[marked.length - 1] as StoredEvent;
      return [{ itemKey: event.itemKey, text: assistantText(event) }];
    }
  }

  const explicit = assistants.filter(isFinalNativeAssistant);
  if (explicit.length > 0) return explicit.map((event) => ({ itemKey: event.itemKey, text: assistantText(event) }));

  let lastAction = -1;
  for (let index = 0; index < events.length; index += 1) if (ACTION_KINDS.has(events[index]?.kind as EventKind)) lastAction = index;
  const afterAction = assistants.filter((event) => events.indexOf(event) > lastAction);
  const fallback = afterAction.length > 0 ? afterAction : assistants.slice(-1);
  return fallback.map((event) => ({ itemKey: event.itemKey, text: assistantText(event) }));
}

function changesFor(events: readonly StoredEvent[]): TurnView['changes'] {
  const cumulative = [...events].filter((event) => event.kind === 'turn.diff');
  const source = cumulative.length > 0 ? cumulative[cumulative.length - 1] : undefined;
  const lists: EventData['file.change']['changes'][] = source !== undefined
    ? [(source.data as EventData['turn.diff']).changes ?? []]
    : events
        .filter((event) => event.kind === 'file.change')
        .map((event) => (event.data as EventData['file.change']).changes ?? []);
  const byPath = new Map<string, TurnView['changes'][number]>();
  for (const list of lists) {
    for (const change of list) byPath.set(change.path, {
      path: change.path,
      kind: change.kind,
      added: change.added,
      removed: change.removed,
      ...(change.diffFileId === undefined ? {} : { diffFileId: change.diffFileId }),
      ...(change.note === undefined ? {} : { note: change.note }),
    });
  }
  return [...byPath.values()];
}

function liveText(item: OpenItem): string | undefined {
  const data = record(item.data);
  return typeof data?.['text'] === 'string' ? data['text'] : undefined;
}

function activityFor(live: readonly LiveItem[], waiting = false): TurnView['activity'] {
  if (waiting || live.some((item) => item.kind === 'approval.request' || item.kind === 'question')) return { kind: 'waiting' };
  if (live.some((item) => item.kind === 'command' || item.kind === 'tool.call')) return { kind: 'running' };
  if (live.some((item) => item.kind === 'assistant.message')) return { kind: 'writing' };
  if (live.some((item) => item.kind === 'reasoning')) return { kind: 'thinking' };
  return null;
}

/** Reduce one turn's persisted events and currently open items into the one
 * shape accepted by the web client. */
export function reduceTurn(events: StoredEvent[], open: OpenItem[] = []): TurnView {
  const first = events[0];
  const turnId = first?.turnId ?? open.find((item) => item.turnId)?.turnId ?? '';
  const userEvent = events.find((event) => event.kind === 'user.message');
  const userData = userEvent?.data as EventData['user.message'] | undefined;
  const started = events.find((event) => event.kind === 'turn.started');
  const completed = [...events].reverse().find((event) => event.kind === 'turn.completed');
  const completedData = completed?.data as EventData['turn.completed'] | undefined;
  const live = open.map((item) => ({ ...item, ...(liveText(item) === undefined ? {} : { text: liveText(item) }) }));
  const pendingApprovals = events.some((event) => event.kind === 'approval.request' && !events.some((resolved) => resolved.kind === 'approval.resolved' && (resolved.data as EventData['approval.resolved']).approvalId === (event.data as EventData['approval.request']).approvalId));
  const pendingQuestions = events.some((event) => event.kind === 'question' && (event.data as EventData['question']).status !== 'answered' && (event.data as EventData['question']).status !== 'skipped' && !events.some((resolved) => resolved.kind === 'question' && resolved !== event && (resolved.data as EventData['question']).questionId === (event.data as EventData['question']).questionId && ((resolved.data as EventData['question']).status === 'answered' || (resolved.data as EventData['question']).status === 'skipped')));
  const waiting = pendingApprovals || pendingQuestions || live.some((item) => item.kind === 'approval.request' || item.kind === 'question');
  const state = completedData?.status ?? (started === undefined ? 'starting' : waiting ? 'waiting' : 'running');
  const steps = events.filter((event) => !['user.message', 'turn.started', 'turn.completed', 'internal'].includes(event.kind));
  const answer = completedData?.answerItemKeys
    ? completedData.answerItemKeys.flatMap((key) => {
        const event = events.find((candidate) => candidate.itemKey === key && candidate.kind === 'assistant.message');
        return event === undefined ? [] : [{ itemKey: key, text: assistantText(event) }];
      })
    : TERMINAL.has(state)
      ? resolveAnswer(events)
      : [];
  const latestPlan = [...events].reverse().find((event) => event.kind === 'plan');
  const latestGoal = [...events].reverse().find((event) => event.kind === 'goal');
  const latestUsage = [...events].reverse().find((event) => event.kind === 'usage');
  const summary = {
    commands: events.filter((event) => event.kind === 'command').length,
    reads: events.filter((event) => event.kind === 'file.read').length,
    edits: events.filter((event) => event.kind === 'file.change' || event.kind === 'turn.diff').length,
    tools: events.filter((event) => event.kind === 'tool.call').length,
  };
  const startedAt = started?.at ?? userEvent?.at ?? first?.at ?? new Date(0).toISOString();
  return {
    turnId,
    state: state as TurnView['state'],
    user: {
      text: userData?.text ?? '',
      ...(userData?.images === undefined ? {} : { images: userData.images }),
      at: userEvent?.at ?? startedAt,
    },
    startedAt,
    ...(completedData?.durationMs === undefined ? {} : { durationMs: completedData.durationMs }),
    ...(completed === undefined ? {} : { endedAt: completed.at }),
    ...(userEvent === undefined ? {} : { userSeq: userEvent.seq }),
    activity: TERMINAL.has(state) ? null : activityFor(live, waiting),
    steps,
    live: TERMINAL.has(state) ? [] : live,
    answer,
    changes: changesFor(events),
    summary,
    ...(latestPlan === undefined ? {} : { plan: (latestPlan.data as EventData['plan']).items }),
    ...(latestGoal === undefined ? {} : { goal: latestGoal.data as EventData['goal'] }),
    ...(latestUsage === undefined
      ? {}
      : {
          usage: {
            ...(latestUsage.data as UsageData),
            ...((completedData?.durationMs ?? 0) > 0 && (latestUsage.data as UsageData).tokensPerSecond === undefined && (latestUsage.data as UsageData).outputTokens !== undefined
              ? { tokensPerSecond: (latestUsage.data as UsageData).outputTokens! / ((completedData?.durationMs ?? 0) / 1000) }
              : {}),
          },
        }),
  };
}
