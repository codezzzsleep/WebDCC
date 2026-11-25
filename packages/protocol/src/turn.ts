import type { EventData, EventKind, StoredEvent, UsageData } from './events.js';
import { isBlockingQuestion } from './events.js';
import { failedFileOperation, nativeOperationDeclined } from './file-operation.js';
import type { InputContent } from './input.js';
import { claudeOutputOrigin } from './claude-tasks.js';
import { codexReviewItem } from './codex-review.js';
import { nativePlanText } from './plans.js';
import { claudeStructuredOutputs, type ClaudeStructuredOutputView } from './claude-output.js';
import type { HotObservation } from './hot-recovery.js';
import type { RecoveredCompletion } from './completed-recovery.js';
import { isIncompleteClaudeOutput } from './claude-content.js';

/** A live item is the in-memory counterpart of an item.start event. */
export interface OpenItem {
  itemKey: string;
  kind: EventKind;
  data: EventData[EventKind];
  turnId?: string | null;
  at?: string;
  observation?: HotObservation;
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
  user: { text: string; images?: string[]; contentParts?: InputContent; commandId?: string; at: string };
  inputs?: { text: string; images?: string[]; contentParts?: InputContent; at: string; seq: number }[];
  pendingInputs?: NonNullable<TurnView['pending']>[];
  userSeq?: number;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  activity: null | { kind: 'thinking' | 'writing' | 'running' | 'waiting'; label?: string };
  steps: Step[];
  live: LiveItem[];
  answer: { itemKey: string; text: string }[];
  structuredOutputs?: ClaudeStructuredOutputView[];
  changes: { path: string; kind: 'add' | 'modify' | 'delete'; added: number; removed: number; diffFileId?: string; note?: string }[];
  summary: { commands: number; reads: number; edits: number; tools: number };
  plan?: EventData['plan']['items'];
  goal?: EventData['goal'];
  usage?: UsageData;
  pending?: { clientCommandId: string; text: string; images?: string[]; contentParts?: InputContent; error?: string; at: string; status: 'pending' | 'queued' | 'sent' | 'failed' | 'uncertain'; turnId?: string };
  commandState?: 'uncertain';
  observation?: 'lost';
  recovered?: RecoveredCompletion[];
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

function currentItems(events: readonly StoredEvent[]): StoredEvent[] {
  const items = new Map<string, StoredEvent>();
  for (const event of events) {
    const key = event.kind === 'question' ? `question:${(event.data as EventData['question']).questionId}`
      : event.kind === 'goal' ? `goal:${(event.data as EventData['goal']).goalId ?? event.sessionId}` : `${event.kind}:${event.itemKey}`;
    items.set(key, event);
  }
  return [...items.values()];
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
  const assistants = currentItems(events).filter((event) => event.kind === 'assistant.message' && assistantText(event) !== '' && claudeOutputOrigin(event) === undefined);
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
  const cumulative = [...events].filter((event) => event.kind === 'turn.diff' && !failedFileOperation(event));
  const source = cumulative.length > 0 ? cumulative[cumulative.length - 1] : undefined;
  const lists: EventData['file.change']['changes'][] = source !== undefined
    ? [(source.data as EventData['turn.diff']).changes ?? []]
    : events
        .filter((event) => event.kind === 'file.change' && !failedFileOperation(event))
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
  if (waiting) return { kind: 'waiting' };
  if (live.some((item) => item.kind === 'command' || item.kind === 'tool.call')) return { kind: 'running' };
  if (live.some((item) => item.kind === 'assistant.message')) return { kind: 'writing' };
  if (live.some((item) => item.kind === 'reasoning')) return { kind: 'thinking' };
  return null;
}

/** Aggregate provider attempt samples without using the whole turn wall time.
 * Tool calls and approval waits are not model generation and must not be the
 * denominator for tok/s. */
function usageFor(events: readonly StoredEvent[], completedData: EventData['turn.completed'] | undefined): UsageData | undefined {
  const samples = events.filter((event) => event.kind === 'usage').map((event) => ({ at: event.at, data: event.data as UsageData }));
  const attempts = samples.map((sample) => sample.data).filter((sample) => sample.scope === 'attempt');
  if (attempts.length > 0) {
    const completeSum = (field: 'inputTokens' | 'outputTokens' | 'generationMs'): number | undefined =>
      attempts.every(sample => sample[field] !== undefined) ? attempts.reduce((total, sample) => total + sample[field]!, 0) : undefined;
    const inputTokens = completeSum('inputTokens');
    const outputTokens = completeSum('outputTokens');
    const generationMs = completeSum('generationMs');
    const sum = (field: 'cacheReadInputTokens' | 'cacheCreationInputTokens' | 'reasoningOutputTokens' | 'totalCostUsd'): number | undefined => attempts.some(sample => sample[field] !== undefined) ? attempts.reduce((total, sample) => total + (sample[field] ?? 0), 0) : undefined;
    return { inputTokens, outputTokens, cacheReadInputTokens: sum('cacheReadInputTokens'), cacheCreationInputTokens: sum('cacheCreationInputTokens'), reasoningOutputTokens: sum('reasoningOutputTokens'), totalCostUsd: sum('totalCostUsd'), scope: 'turn',
      ...(generationMs !== undefined && generationMs > 0 ? { generationMs, ...(outputTokens === undefined ? {} : { tokensPerSecond: outputTokens / (generationMs / 1000) }) } : {}) };
  }
  const latestSample = samples.at(-1);
  const latest = latestSample?.data ?? completedData?.usage;
  if (latest === undefined) return undefined;
  if (latest.tokensPerSecond !== undefined) return latest;
  if (latest.generationMs !== undefined && latest.generationMs > 0 && latest.outputTokens !== undefined) {
    return { ...latest, tokensPerSecond: latest.outputTokens / (latest.generationMs / 1000) };
  }
  // Older Codex/Claude rows only persisted turn-scoped usage. When there are
  // several native usage updates, the interval since the previous update is
  // the only recoverable timing signal; use it for the latest response rather
  // than dividing by the entire turn (which includes tools and approvals).
  const previous = samples.at(-2);
  if (latest.scope === 'turn' && latest.outputTokens !== undefined && latestSample !== undefined && previous !== undefined) {
    const elapsedMs = Date.parse(latestSample.at) - Date.parse(previous.at);
    if (elapsedMs > 0) return { ...latest, tokensPerSecond: latest.outputTokens / (elapsedMs / 1000) };
  }
  return latest;
}

/** Reduce one turn's persisted events and currently open items into the one
 * shape accepted by the web client. */
export function reduceTurn(events: StoredEvent[], open: OpenItem[] = [], sessionInteractions: readonly StoredEvent[] = [], observedWaiting = false): TurnView {
  const first = events[0];
  const turnId = first?.turnId ?? open.find((item) => item.turnId)?.turnId ?? '';
  const userEvent = events.find((event) => event.kind === 'user.message');
  const userData = userEvent?.data as EventData['user.message'] | undefined;
  const started = events.find((event) => event.kind === 'turn.started');
  const completed = [...events].reverse().find((event) => event.kind === 'turn.completed');
  const completedData = completed?.data as EventData['turn.completed'] | undefined;
  const relevant = (item: { turnId?: string | null }) => item.turnId == null || item.turnId === turnId;
  const live = open.filter(item => relevant(item) && claudeOutputOrigin(item) === undefined).map((item) => ({ ...item, ...(liveText(item) === undefined ? {} : { text: liveText(item) }) }));
  const stateEvents = [...events.filter(relevant), ...sessionInteractions.filter(event => event.turnId === null)];
  const questions = new Map<string, EventData['question']>(); const approvals = new Set<string>(); const resolvedApprovals = new Set<string>();
  for (const event of stateEvents) {
    if (event.kind === 'question') { const question = event.data as EventData['question']; questions.set(question.questionId, question); }
    if (event.kind === 'approval.request') approvals.add((event.data as EventData['approval.request']).approvalId);
    if (event.kind === 'approval.resolved') { const id = (event.data as EventData['approval.resolved']).approvalId; approvals.delete(id); resolvedApprovals.add(id); }
  }
  const waiting = observedWaiting || approvals.size > 0 || [...questions.values()].some(isBlockingQuestion) || live.some(item => {
    if (item.kind === 'approval.request') return !resolvedApprovals.has((item.data as EventData['approval.request']).approvalId);
    if (item.kind !== 'question') return false;
    const question = item.data as EventData['question']; return isBlockingQuestion(questions.get(question.questionId) ?? question);
  });
  const state = completedData?.status ?? (started === undefined ? 'starting' : waiting ? 'waiting' : 'running');
  const observationLost = completed === undefined && !live.some(item => item.observation === undefined)
    && (live.some(item => item.observation?.state === 'lost') || events.some(event => event.kind === 'notice'
      && ['command-uncertain', 'runtime-unobserved'].includes((event.data as EventData['notice']).nativeType ?? '')));
  const steps = currentItems(events).filter((event) => !['user.message', 'turn.started', 'turn.completed', 'internal'].includes(event.kind) && claudeOutputOrigin(event) === undefined);
  const answer = completedData?.answerItemKeys
    ? completedData.answerItemKeys.flatMap((key) => {
        const event = events.find((candidate) => candidate.itemKey === key && candidate.kind === 'assistant.message');
        return event === undefined || claudeOutputOrigin(event) !== undefined ? [] : [{ itemKey: key, text: assistantText(event) }];
      })
    : TERMINAL.has(state)
      ? resolveAnswer(events)
      : [];
  const latestPlan = [...events].reverse().find((event) => event.kind === 'plan' && nativePlanText(event) === undefined);
  const structuredOutputs = claudeStructuredOutputs(events);
  const latestGoal = [...events].reverse().find((event) => event.kind === 'goal');
  const summary = {
    commands: steps.filter((event) => event.kind === 'command' && !nativeOperationDeclined(event)).length,
    reads: steps.filter((event) => event.kind === 'file.read' && !failedFileOperation(event)).length,
    edits: steps.filter((event) => (event.kind === 'file.change' || event.kind === 'turn.diff') && !failedFileOperation(event)).length,
    tools: steps.filter((event) => event.kind === 'tool.call' && codexReviewItem(event) === undefined && !isIncompleteClaudeOutput(event)).length,
  };
  const startedAt = started?.at ?? userEvent?.at ?? first?.at ?? new Date(0).toISOString();
  return {
    turnId,
    state: state as TurnView['state'],
    ...(observationLost ? { observation: 'lost' as const } : {}),
    user: {
      text: userData?.text ?? '',
      ...(userData?.images === undefined ? {} : { images: userData.images }),
      ...(userData?.contentParts === undefined ? {} : { contentParts: userData.contentParts }),
      ...(userData?.clientCommandId === undefined ? {} : { commandId: userData.clientCommandId }),
      at: userEvent?.at ?? startedAt,
    },
    ...(events.filter(event => event.kind === 'user.message').length <= 1 ? {} : { inputs: events.filter(event => event.kind === 'user.message').map(event => {
      const data = event.data as EventData['user.message']; return { text: data.text, images: data.images, contentParts: data.contentParts, at: event.at, seq: event.seq };
    }) }),
    startedAt,
    ...(completedData?.durationMs === undefined ? {} : { durationMs: completedData.durationMs }),
    ...(completed === undefined ? {} : { endedAt: completed.at }),
    ...(userEvent === undefined ? {} : { userSeq: userEvent.seq }),
    activity: TERMINAL.has(state) || observationLost ? null : activityFor(live, waiting),
    steps,
    live: TERMINAL.has(state) ? [] : live,
    answer,
    ...(structuredOutputs.length === 0 ? {} : { structuredOutputs }),
    changes: changesFor(events),
    summary,
    ...(latestPlan === undefined ? {} : { plan: (latestPlan.data as EventData['plan']).items }),
    ...(latestGoal === undefined ? {} : { goal: latestGoal.data as EventData['goal'] }),
    ...(usageFor(events, completedData) === undefined
      ? {}
      : {
          usage: usageFor(events, completedData),
        }),
  };
}
