/** AgentAdapter 统一接口（SPEC 5.1） */
import type { EventKind, UsageData } from './events.js';
import type { TraceSink } from './trace.js';
import type { AccessModeOption, NativePermissionObservation } from './permissions.js';
import type { RuntimeIdentity } from './runtime.js';
import type { NativeFrameSink } from './native-events.js';
import type { NativeObservation } from './native-observation.js';
import type { NativeProcessCompletion, NativeProcessDelta, NativeProcessStart } from './native-controls.js';
import type { InputSkillPart, ResolvedInputContent } from './input.js';
import type { SlashCommand, SlashCommandPreview, SlashControlResult } from './slash.js';
import type { CodexSubagentView } from './subagents.js';
import type { DshSubagentCatalog, DshSubagentHistory, DshSubagentHistoryOptions, DshSubagentReadTarget, DshSubagentControlTarget, DshSubagentInterruptReceipt,
  DshSubagentPromptOptions, DshSubagentPromptReceipt, DshSubagentInputReference, DshSubagentInputObservation } from './dsh-subagents.js';
import type { DshQuestionWaitOpening } from './dsh-questions.js';
import type { ClaudeQueryConfiguration } from './claude-configuration.js';
import type { DshApprovalAttempt, DshApprovalDelivery } from './dsh-interactions.js';

export type AgentId = 'dsh' | 'codex' | 'claude-code';

export type CodexInputMode = 'default' | 'plan';
export interface CodexInputModeCatalog {
  modes: { id: CodexInputMode; label: string }[];
  observedMode: CodexInputMode | null;
  reason?: string;
}

/** Public observation metadata; endpoint IDs are opaque and contain no credentials. */
export interface NativeRuntimeContext {
  hostId: string;
  source: 'native-bootstrap' | 'local-process';
  status: 'observed' | 'unverified';
  /** Release/bootstrap evidence, not an immutable machine identity. */
  hostFingerprint?: string;
  os?: string;
  profile: { scope: string; identity?: string; status: 'observed' | 'unverified' | 'unavailable-in-api' };
  connectionRevision: string;
}

export interface ProbeResult {
  installed: boolean;
  version?: string;
  pinnedVersion: string;
  auth: 'ok' | 'missing' | 'unknown';
  notes?: string[];
  compatible?: boolean;
  runtimeContext?: NativeRuntimeContext;
}

export interface ModelOption {
  id: string;
  label: string;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  inputModalities?: ('text' | 'image' | 'audio')[];
  isDefault?: boolean;
  source?: string;
}

export interface ProviderRuntimeConfig {
  id: string;
  name: string;
  baseUrl: string;
  endpoints?: Record<string, string>;
  protocols: string[];
  /** 只在启动子进程/构造 SDK 环境时使用，绝不落库明文或返回给前端 */
  apiKey?: string;
  codexCatalogPath?: string;
}

export interface CreateOpts {
  /** Claude-only accepted startup overrides; never a replay of a user action. */
  restoreClaudeConfiguration?: ClaudeQueryConfiguration;
  sessionId: string;
  cwd: string;
  providerId: string | null;
  /** providerId 对应的解析结果；null = 原生登录/原生配置 */
  provider?: ProviderRuntimeConfig | null;
  runtime?: RuntimeIdentity;
  nativeEvents?: NativeFrameSink;
  onManagedProcess?: (pid: number, profilePath: string, nativeVersion: string) => void;
  model?: string;
  reasoningEffort?: string;
  accessMode?: string;
  /** Server-owned roundtrip from a verified CLI writer; preserve native settings. */
  restoreNativeHistory?: boolean;
  /** Passive persisted task identities for reconnect; never sent to native prompts/tools. */
  restoreCodexSubagents?: CodexSubagentView[];
  /** Optional side-channel recorder; it never changes Agent input/output. */
  traceSink?: TraceSink;
  /** Observer-only endpoint override; keeps the native provider/auth identity. */
  recordingEndpoint?: { url: string; codexProvider?: string };
}

export interface UserInput {
  text: string;
  /** Identity minted and persisted by the server before native admission. */
  nativeRequestId?: string;
  images?: { fileId: string; path: string; mime: string; name?: string; sha256?: string; size?: number }[];
  contentParts?: ResolvedInputContent;
  delivery?: 'send' | 'queue' | 'steer';
  expectedTurnId?: string;
}

export interface ApprovalDecision {
  approvalId: string;
  optionId: string;
}

export interface AnswerSubmission {
  submitted: boolean;
  questionIds?: string[];
  /** false means transport submission still awaits native request resolution. */
  confirmed?: boolean;
  queued?: boolean;
  turnId?: string;
}

export interface NativeInteractionSubmission { confirmed: boolean }

export interface LaunchSpec {
  command?: string;
  args?: string[];
  env: Record<string, string>;
  sdkOptions?: Record<string, unknown>;
  startParams?: Record<string, unknown>;
}

type AdapterEventBody =
  | { type: 'transport.closed'; reason: string; activeWork: boolean; native?: unknown }
  | { type: 'permissions'; observation: NativePermissionObservation }
  | { type: 'history'; nativeId: string; records: NativeHistoryRecord[] }
  | { type: 'item.start'; itemKey: string; kind: EventKind; data: unknown; nativeTurnId?: string; /** @deprecated use nativeTurnId */ turnId?: string; native?: unknown }
  | { type: 'item.delta'; itemKey: string; field: 'text' | 'output'; append: string; nativeTurnId?: string }
  | { type: 'item.update'; itemKey: string; data: unknown; nativeTurnId?: string }
  | { type: 'item.complete'; itemKey: string; kind: EventKind; data: unknown; nativeTurnId?: string; /** @deprecated use nativeTurnId */ turnId?: string; native?: unknown; nativeSeq?: number }
  | { type: 'item.cancel'; itemKey: string; nativeTurnId?: string; turnId?: string; native?: unknown }
  | { type: 'turn.start'; nativeTurnId?: string; native?: unknown }
  | { type: 'turn.end'; nativeTurnId?: string; status: 'completed' | 'interrupted' | 'failed'; usage?: UsageData; native?: unknown }
  /** @deprecated adapters should derive session status from turn lifecycle */
  | { type: 'status'; status: 'running' | 'waiting' | 'idle' | 'error'; source?: 'native-thread'; native?: unknown }
  /** 原生 id 迟到（Claude Code 要等首条消息才有 session_id）：manager 收到后落库 */
  | { type: 'native-id'; nativeId: string };

export type AdapterEvent = AdapterEventBody & { runtime?: RuntimeIdentity; nativeEnvelopeId?: number; scope?: 'session' };

export interface NativeHistoryRecord {
  nativeSeq: number;
  nativeTurnId?: string;
  at: string;
  native: unknown;
  admittedInputs?: { nativeRequestId: string; text: string }[];
  events: Exclude<AdapterEvent, { type: 'history' }>[];
}

export interface AgentProcessInfo {
  sessionId: string;
  pid: number;
  /** 进程环境里与本 Agent 相关的目录变量（测试断言用） */
  dirs?: Record<string, string>;
}

export interface AgentAdapter {
  id: AgentId;
  /** real = 原生 Agent；fake = 假 adapter（只在快速 e2e 里出现） */
  kind?: 'real' | 'fake';
  /** 测试钩子用：列出本 adapter 启动的进程 */
  debugProcesses?(): AgentProcessInfo[];
  probe(): Promise<ProbeResult>;
  listModels(providerId: string | null): Promise<ModelOption[]>;
  accessModes(): AccessModeOption[];
  /** 运行时可用的访问模式（Codex 从 permissionProfile/list 读，MODE-codex-01） */
  listAccessModes?(): Promise<AccessModeOption[]>;
  buildLaunchSpec(opts: CreateOpts): LaunchSpec;
  create(opts: CreateOpts): Promise<{ nativeId: string }>;
  resume(opts: CreateOpts & { nativeId: string }): Promise<void>;
  send(sessionId: string, input: UserInput): Promise<void>;
  validateInput?(sessionId: string, input: UserInput): Promise<void>;
  resolveInputSkill?(sessionId: string, selection: InputSkillPart): Promise<{ path: string }>;
  steer?(sessionId: string, input: UserInput): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  respond(sessionId: string, d: ApprovalDecision): Promise<void | NativeInteractionSubmission>;
  /** 打断时取消该会话自己挂起的审批/提问（SPEC 7.4 AG-*-09 / 2.3 生命周期） */
  cancelPending?(sessionId: string): Promise<void | NativeInteractionSubmission>;
  answer?(sessionId: string, questionId: string, answer: unknown): Promise<void | AnswerSubmission>;
  claimDshQuestionWait?(sessionId: string, questionId: string, signal: AbortSignal): Promise<DshQuestionWaitOpening | undefined>;
  timeoutDshQuestion?(sessionId: string, questionId: string, signal: AbortSignal, guard?: () => void): Promise<void>;
  setModel?(sessionId: string, model: string): Promise<void>;
  setReasoningEffort?(sessionId: string, effort: string): Promise<void>;
  /** 切换访问模式（F6）；Codex 在下一次 turn/start 生效，返回值是实际生效的模式 */
  setAccessMode?(sessionId: string, mode: string): Promise<{ accessMode: string } | void>;
  /** 斜杠命令目录（F8）：Claude 来自 init 消息，DSH 来自 commands/list */
  slashCommands?(sessionId: string): Promise<SlashCommand[]>;
  /** Read command names before creation without activating a native writer. */
  previewSlashCommands?(cwd?: string): Promise<SlashCommand[] | SlashCommandPreview>;
  executeSlashControl?(sessionId: string, line: string, options?: { replaceGoal?: boolean; editGoal?: boolean; contentParts?: ResolvedInputContent }): Promise<SlashControlResult>;
  /** Read-only mode discovery; it must not activate or resume a native writer. */
  inputModes?(sessionId?: string): Promise<CodexInputModeCatalog>;
  sendSubagent?(sessionId: string, childSessionId: string, text: string, options?: DshSubagentPromptOptions, target?: DshSubagentControlTarget): Promise<void | DshSubagentPromptReceipt>;
  interruptSubagent?(sessionId: string, childSessionId: string, target?: DshSubagentControlTarget): Promise<void | DshSubagentInterruptReceipt>;
  /** Passive direct-child discovery and reads; these never submit a prompt. */
  listSubagents?(sessionId: string, target?: DshSubagentReadTarget): Promise<DshSubagentCatalog>;
  readSubagentHistory?(sessionId: string, childSessionId: string, options: DshSubagentHistoryOptions, target?: DshSubagentReadTarget): Promise<DshSubagentHistory>;
  findSubagentInput?(sessionId: string, childSessionId: string, reference: DshSubagentInputReference, target?: DshSubagentReadTarget): Promise<DshSubagentInputObservation | undefined>;
  dispose(sessionId: string): Promise<void>;
  onEvent(cb: (sessionId: string, e: AdapterEvent) => void): void;
  /** Bind transport-free handlers and adapter lifecycle callbacks before activation. */
  bindRuntime?(sessionId: string, identity: RuntimeIdentity): void;
  observe?(opts: CreateOpts & { nativeId: string }): Promise<NativeObservation>;
  nativeCatalog?(sessionId: string): Promise<unknown>;
  nativeState?(sessionId: string): unknown | Promise<unknown>;
  dshApprovalDelivery?(sessionId: string, approvalId: string): Promise<DshApprovalDelivery | undefined>;
  retryDshApproval?(sessionId: string, attempt: DshApprovalAttempt, revision: string): Promise<void | { confirmed: boolean }>;
  executeNativeControl?(sessionId: string, action: unknown): Promise<unknown>;
  readNativeHistory?(sessionId: string, options: { cursor?: string; offset?: number; limit: number }): Promise<unknown>;
  nativeProcessStart?(sessionId: string, params: NativeProcessStart, onOutput: (delta: NativeProcessDelta) => void): Promise<NativeProcessCompletion>;
  nativeProcessWrite?(sessionId: string, params: { processId: string; deltaBase64?: string; closeStdin?: boolean }): Promise<void>;
  nativeProcessResize?(sessionId: string, params: { processId: string; size: { rows: number; cols: number } }): Promise<void>;
  nativeProcessTerminate?(sessionId: string, params: { processId: string }): Promise<void>;
  /** Server-only launch environment, never part of a public catalog. */
  nativeTerminalEnvironment?(): Record<string, string | undefined>;
  /** Server-only peer transport; it shares the existing native process. */
  nativePeerConnection?(sessionId: string): {
    socketPath: string; nativeId: string; nativeVersion: string; codexHome: string; command: string;
    record(direction: 'in' | 'out', channel: string, frame: Record<string, unknown>): boolean;
  } | undefined;
  /** Host-wide transport records have an explicit non-session diagnostic scope. */
  bindGlobalNativeEvents?(sink: NativeFrameSink): void;
}
