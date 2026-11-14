/** 统一事件模型（SPEC 第 6 节） */

export type EventKind =
  | 'user.message'
  | 'assistant.message'
  | 'reasoning'
  | 'command'
  | 'file.read'
  | 'file.change'
  | 'turn.diff'
  | 'tool.call'
  | 'plan'
  | 'goal'
  | 'notice'
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
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  totalCostUsd?: number;
  modelUsage?: Record<string, unknown>;
  cacheHitRatio?: number;
  contextRatio?: number;
  tokensPerSecond?: number;
  /** Duration of the model generation that produced this usage sample. */
  generationMs?: number;
  /** DSH emits one sample per model attempt; other adapters emit turn totals. */
  scope?: 'attempt' | 'turn';
}

export interface FileChangeEntry {
  path: string;
  kind: 'add' | 'modify' | 'delete';
  added: number;
  removed: number;
  diffFileId?: string;
  /** 原生提供的 diff 文本或按 old/new 生成的 hunk（C2 第 1/2 级） */
  diff?: string;
  /** 整文件写入、拿不到原内容时的说明（C2 第 3 级） */
  note?: string;
}

export interface ApprovalOption {
  id: string;
  label: string;
}

export interface QuestionItem {
  questionId: string;
  /** Native multi-question request identity. */
  groupId?: string;
  prompt: string;
  header?: string;
  options?: { id: string; label: string; description?: string }[];
  multiSelect?: boolean;
  allowsFreeText?: boolean;
  toolCallId?: string;
  status?: 'pending' | 'answered' | 'skipped';
  resolution?: 'native-acknowledged' | 'external';
  submission?: 'sent' | 'uncertain' | 'collected';
}

export interface PlanItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface EventData {
  'user.message': { text: string; images?: string[]; clientCommandId?: string };
  /** `phase` is retained for old rows. New translations preserve the native
   * phase in `nativePhase`; the turn reducer is the sole final-answer authority. */
  'assistant.message': { text: string; phase?: 'interim' | 'final'; nativePhase?: string };
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
  'file.change': {
    changes: FileChangeEntry[];
    status: 'running' | 'completed' | 'failed';
    /** @deprecated Codex cumulative snapshots use turn.diff. */
    snapshot?: boolean;
  };
  /** A cumulative diff emitted by an Agent for the current turn. */
  'turn.diff': { changes: FileChangeEntry[]; status?: 'running' | 'completed' | 'failed' };
  'tool.call': { name: string; label?: string; input: unknown; output?: unknown; status: 'running' | 'completed' | 'failed' };
  plan: { items: PlanItem[] };
  /** Codex 的"目标"（thread/goal/updated）：原生界面会显示，WebDCC 也必须显示 */
  goal: { objective: string; status: 'active' | 'completed' | 'paused' | 'cleared'; tokensUsed?: number };
  /** 原生提示（warning / configWarning / deprecationNotice），例如"使用兜底元数据，可能影响效果" */
  notice: { level: 'info' | 'warning'; text: string; nativeType?: string };
  'approval.request': {
    approvalId: string;
    title: string;
    detail: string;
    options: ApprovalOption[];
    /** 原生工具名（自动批准与验收断言用） */
    tool?: string;
    /** 原因：DSH 取 displayReason.zh，没有时取 reason（F11） */
    reason?: string;
    /** 计划模式下提交的计划（Markdown） */
    planMarkdown?: string;
    submission?: 'sent' | 'uncertain' | 'collected';
  };
  'approval.resolved': { approvalId: string; optionId: string; by: 'user' | 'agent' | 'system' | 'other' };
  question: QuestionItem;
  'turn.started': Record<string, never>;
  'turn.completed': {
    status: 'completed' | 'interrupted' | 'failed';
    durationMs: number;
    usage?: UsageData;
    answerItemKeys?: string[];
    reason?: string;
  };
  usage: UsageData;
  error: { message: string };
  unknown: { nativeType: string };
  internal: { nativeType: string };
}

export interface StoredEvent<K extends EventKind = EventKind> {
  sessionId: string;
  seq: number;
  /** 轮次 id；轮次之外的事件为 null（不构成一轮，只进轨迹） */
  turnId: string | null;
  itemKey: string;
  at: string;
  kind: K;
  data: EventData[K];
  native?: unknown;
  nativeSeq?: number;
  nativeEnvelopeId?: number;
  late?: boolean;
}

export const INTERNAL_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(['internal']);

/** 对话时间线里不显示的 kind（标题、内部簿记等） */
export const NON_TIMELINE_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(['internal']);
