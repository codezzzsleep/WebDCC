/** 统一事件模型（SPEC 第 6 节） */

export type EventKind =
  | 'user.message'
  | 'assistant.message'
  | 'reasoning'
  | 'command'
  | 'file.read'
  | 'file.change'
  | 'tool.call'
  | 'plan'
  | 'approval.request'
  | 'approval.resolved'
  | 'question'
  | 'turn.started'
  | 'turn.completed'
  | 'usage'
  | 'error'
  | 'unknown'
  | 'internal';

export interface UsageData {
  inputTokens?: number;
  outputTokens?: number;
  cacheHitRatio?: number;
  contextRatio?: number;
  tokensPerSecond?: number;
}

export interface FileChangeEntry {
  path: string;
  kind: 'add' | 'modify' | 'delete';
  added: number;
  removed: number;
  diffFileId?: string;
}

export interface ApprovalOption {
  id: string;
  label: string;
}

export interface QuestionItem {
  questionId: string;
  prompt: string;
  header?: string;
  options?: { id: string; label: string; description?: string }[];
  multiSelect?: boolean;
  allowsFreeText?: boolean;
  toolCallId?: string;
  status?: 'pending' | 'answered' | 'skipped';
}

export interface PlanItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface EventData {
  'user.message': { text: string; images?: string[]; clientCommandId?: string };
  'assistant.message': { text: string; phase?: 'interim' | 'final' };
  reasoning: { text: string; summary?: boolean };
  command: {
    command: string;
    label?: string;
    cwd?: string;
    exitCode?: number;
    outputTail?: string;
    outputFileId?: string;
    status: 'running' | 'completed' | 'failed';
  };
  'file.read': { path: string; label?: string };
  'file.change': { changes: FileChangeEntry[]; status: 'running' | 'completed' | 'failed' };
  'tool.call': { name: string; label?: string; input: unknown; output?: unknown; status: 'running' | 'completed' | 'failed' };
  plan: { items: PlanItem[] };
  'approval.request': { approvalId: string; title: string; detail: string; options: ApprovalOption[] };
  'approval.resolved': { approvalId: string; optionId: string; by: 'user' | 'agent' | 'system' };
  question: QuestionItem;
  'turn.started': Record<string, never>;
  'turn.completed': { status: 'completed' | 'interrupted' | 'failed'; durationMs: number; usage?: UsageData };
  usage: UsageData;
  error: { message: string };
  unknown: { nativeType: string };
  internal: { nativeType: string };
}

export interface StoredEvent<K extends EventKind = EventKind> {
  sessionId: string;
  seq: number;
  turnId: string;
  itemKey: string;
  at: string;
  kind: K;
  data: EventData[K];
  native?: unknown;
  nativeSeq?: number;
}

export const INTERNAL_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(['internal']);

/** 对话时间线里不显示的 kind（标题、内部簿记等） */
export const NON_TIMELINE_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(['internal']);
