/** 统一事件模型（SPEC 第 6 节） */
import type { ElicitationForm, ElicitationAction } from './elicitation.js';
import type { InputContent, InputIntent } from './input.js';
import type { ClaudeOutputOrigin, ClaudeTaskRuntime } from './claude-tasks.js';
import type { NativeReasoningPart } from './codex-reasoning.js';
import type { ClaudeBlockOrigin } from './claude-content.js';
import type { ClaudeStructuredOutput } from './claude-output.js';
import type { ClaudeQueryConfiguration } from './claude-configuration.js';

export type EventKind =
  | 'user.message'
  | 'assistant.message'
  | 'structured.output'
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

/** A surface boundary declared by the native conversation_reset frame. */
export interface ConversationReset {
  id: string;
  uuid: string;
  trigger?: string;
  userMessageUuid?: string;
  timestamp?: string;
}

/** Durable receive sequence orders boundaries; native timestamps are display only. */
export interface ConversationState extends ConversationReset {
  resetSeq: number;
  previousNativeId?: string;
  previousTitle?: string;
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
  isSecret?: boolean;
  /** Native blocking declaration; absence in old events means blocking. */
  isBlocking?: boolean;
  /** Native async message identity; its reply is ordinary input, not RPC. */
  asyncReply?: { nativeId: string; itemId: string; index: number };
  elicitation?: ElicitationForm;
  outcome?: ElicitationAction;
  toolCallId?: string;
  dshQuestion?: DshQuestionIdentity;
  status?: 'pending' | 'answered' | 'skipped';
  /** native-resolved records the business outcome without asserting a replying Client. */
  resolution?: 'native-acknowledged' | 'native-resolved' | 'external' | 'outcome-unknown';
  submission?: 'sent' | 'uncertain' | 'collected' | 'queued' | 'failed';
  submissionError?: string;
}

export function isBlockingQuestion(question: Pick<QuestionItem, 'isBlocking' | 'status'>): boolean {
  return question.isBlocking !== false && question.status !== 'answered' && question.status !== 'skipped';
}

export interface PlanItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface EventData {
  'user.message': { text: string; images?: string[]; contentParts?: InputContent; intent?: InputIntent; clientCommandId?: string };
  /** `phase` is retained for old rows. New translations preserve the native
   * phase in `nativePhase`; the turn reducer is the sole final-answer authority. */
  'assistant.message': { text: string; phase?: 'interim' | 'final'; nativePhase?: string; claudeActor?: ClaudeOutputOrigin; claudeBlock?: ClaudeBlockOrigin; incomplete?: boolean };
  'structured.output': ClaudeStructuredOutput;
  reasoning: { text: string; summary?: boolean; claudeActor?: ClaudeOutputOrigin; claudeBlock?: ClaudeBlockOrigin; incomplete?: boolean;
    nativeContent?: NativeReasoningPart[] };
  command: {
    command: string;
    label?: string;
    cwd?: string;
    exitCode?: number;
    outputTail?: string;
    outputFileId?: string;
    status: 'running' | 'completed' | 'failed';
    claudeActor?: ClaudeOutputOrigin;
    claudeBlock?: ClaudeBlockOrigin;
  };
  'file.read': { path: string; label?: string; status?: 'running' | 'completed' | 'failed'; error?: string; claudeActor?: ClaudeOutputOrigin; claudeBlock?: ClaudeBlockOrigin; output?: string };
  'file.change': {
    changes: FileChangeEntry[];
    status: 'running' | 'completed' | 'failed';
    path?: string;
    error?: string;
    /** @deprecated Codex cumulative snapshots use turn.diff. */
    snapshot?: boolean;
    claudeActor?: ClaudeOutputOrigin;
    claudeBlock?: ClaudeBlockOrigin;
    output?: string;
  };
  /** A cumulative diff emitted by an Agent for the current turn. */
  'turn.diff': { changes: FileChangeEntry[]; status?: 'running' | 'completed' | 'failed' };
  'tool.call': { name: string; label?: string; input: unknown; output?: unknown; status: 'running' | 'completed' | 'failed' | 'stopped' | 'paused' | 'pending' | 'unknown'; claudeActor?: ClaudeOutputOrigin; claudeBlock?: ClaudeBlockOrigin;
    /** The observed native item notification phase, independent of business success. */
    codexItemPhase?: 'started' | 'completed' };
  /** Structured task steps and native Markdown plans have distinct content.
   * incomplete preserves a draft without claiming a native final document. */
  plan: { items: PlanItem[]; text?: string; incomplete?: boolean };
  /** Native session goal, including Codex notifications and DSH durable projections. */
  goal: {
    objective: string; status: 'active' | 'completed' | 'paused' | 'cleared' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'unknown';
    goalId?: string; nativeStatus?: string; tokensUsed?: number; tokenBudget?: number | null; timeUsedSeconds?: number;
    nativeRevision?: number; roundsStarted?: number; maxGoalRounds?: number;
    blockedReason?: { code: string; message: string };
  };
  /** 原生提示（warning / configWarning / deprecationNotice），例如"使用兜底元数据，可能影响效果" */
  notice: { level: 'info' | 'warning'; text: string; nativeType?: string; details?: string; contextReset?: ConversationReset };
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
  'approval.resolved': { approvalId: string; optionId: string; by: 'user' | 'agent' | 'system' | 'other' | 'unknown' };
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
  unknown: { nativeType: string; claudeBlock?: ClaudeBlockOrigin };
  internal: { nativeType: string; claudeTaskRuntime?: ClaudeTaskRuntime; claudeConfiguration?: ClaudeQueryConfiguration };
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
import type { DshQuestionIdentity } from './dsh-questions.js';
