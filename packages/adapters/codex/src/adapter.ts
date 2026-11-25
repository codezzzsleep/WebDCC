import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type {
  AdapterEvent,
  AgentAdapter,
  ApprovalDecision,
  CreateOpts,
  EventData,
  EventKind,
  LaunchSpec,
  ModelOption,
  ProbeResult,
  ProviderRuntimeConfig,
  UserInput,
  InputSkillPart,
  TraceSink,
  TraceFrame,
  AccessModeOption,
  NativePermissionObservation,
  NativeInteractionSubmission,
  RuntimeIdentity,
  NativeObservation,
  NativeProcessDelta,
  NativeProcessCompletion,
  NativeProcessStart,
  CodexInputModeCatalog,
  CodexInputMode,
  NativeHistoryRecord,
  CodexSubagentIdentity,
  CodexSubagentView,
  CodexSubagentSnapshot,
} from '@webdcc/protocol';
import { traceFrame } from '@webdcc/protocol';
import { isValidEventData } from '@webdcc/protocol';
import { normalizeQuestionAnswer } from '@webdcc/protocol';
import { nativeAccessMode, schemaHasSecrets, codexSubagentSnapshotKey, codexCollabCallStatus, codexNativeToolStatus, codexNativeImageStatus, validCodexCommandItem } from '@webdcc/protocol';
import { codexPermissionObservation } from './permissions.js';
import { JsonRpcStdio, type Frame } from './rpc.js';
import { nativeRequest, nativeSettingsNotification, validateNativeResult, validateNativeServerParams, type NativeParams } from './controls.js';
import type { ReviewStartResponse } from './schema/v2/ReviewStartResponse.js';
import { codexSlashCommands, executeCodexSlash } from './slash.js';
import { codexInputParts, encodeCodexInput, unsupportedCodexInput } from './input.js';
import { elicitationResponse } from './elicitation.js';
import { CodexPlanStreams } from './plans.js';
import type { McpServerElicitationRequestParams } from './schema/v2/McpServerElicitationRequestParams.js';
import type { PermissionsRequestApprovalParams } from './schema/v2/PermissionsRequestApprovalParams.js';
import type { PermissionsRequestApprovalResponse } from './schema/v2/PermissionsRequestApprovalResponse.js';
import type { ThreadStartParams } from './schema/v2/ThreadStartParams.js';
import type { TurnStartParams } from './schema/v2/TurnStartParams.js';
import type { ThreadTurnsListResponse } from './schema/v2/ThreadTurnsListResponse.js';
import type { InitializeResponse } from './schema/InitializeResponse.js';
import { codexNativeCatalog, codexNativeState, executeCodexNativeControl, parseCodexNativeAction } from './native.js';

import { PINNED_VERSION, SUPPORTED_CODEX_VERSIONS, isSupportedCodexVersion, CODEX_COMPATIBILITY_LABEL } from './versions.js';
import { codexAsyncQuestions, codexAsyncQuestionEvents, nativeAsyncReplies } from './async-questions.js';
export { PINNED_VERSION } from './versions.js';

export interface CodexAdapterOptions {
  command?: string;
  /** 额外的 -c 覆盖（Provider 注入用，M6 会用到） */
  configOverrides?: string[];
  env?: NodeJS.ProcessEnv;
  onTitle?: (sessionId: string, title: string) => void;
  traceSink?: TraceSink;
}

interface PendingApproval {
  requestId: string | number;
  nativeThreadId?: string;
  nativeTurnId?: string;
  kind: 'commandExecution' | 'fileChange' | 'legacyExec' | 'legacyPatch' | 'userInput' | 'elicitation' | 'permissions';
  elicitation?: McpServerElicitationRequestParams;
  permissions?: PermissionsRequestApprovalParams['permissions'];
  outcome?: 'accept' | 'decline' | 'cancel';
  sessionScoped?: boolean;
  questionIds?: string[];
  answers?: Record<string, { answers: string[] }>;
  questions?: EventData['question'][];
  submitted?: boolean;
  decision?: string;
}

interface ReasoningSummary {
  nativeTurnId: string | null;
  parts: Map<number, string>;
  started: boolean;
  content?: Map<number, string>;
}

function reasoningText(summary: ReasoningSummary): string {
  return [...summary.parts].sort(([a], [b]) => a - b).map(([, text]) => text).join('\n');
}

function reasoningData(summary: ReasoningSummary): EventData['reasoning'] {
  return { text: reasoningText(summary), ...(summary.content?.size ? { nativeContent:
    [...summary.content].sort(([a], [b]) => a - b).map(([index, text]) => ({ index, text })) } : {}) };
}

function completeReasoning(runtime: SessionRuntime, key: string): void {
  runtime.reasoningSummaries?.delete(key);
  const completed = runtime.completedReasoning ??= new Set();
  completed.add(key);
  if (completed.size > 1024) completed.delete(completed.values().next().value!);
}

function beginGeneration(runtime: SessionRuntime, turnId: string | undefined, at: number): void {
  const identity = turnId ?? runtime.turnId;
  if (identity !== null) {
    const timers = runtime.generationByTurn ??= new Map();
    if (!timers.has(identity)) timers.set(identity, at);
  }
  if (identity === runtime.turnId) runtime.generationStartedAt ??= at;
}

function endGeneration(runtime: SessionRuntime, turnId: string | undefined, at: number): number | undefined {
  const identity = turnId ?? runtime.turnId;
  const started = identity === null ? runtime.generationStartedAt : runtime.generationByTurn?.get(identity)
    ?? (identity === runtime.turnId ? runtime.generationStartedAt : undefined);
  if (identity !== null) runtime.generationByTurn?.delete(identity);
  if (identity === runtime.turnId) runtime.generationStartedAt = null;
  return started == null ? undefined : Math.max(1, at - started);
}

interface SessionRuntime {
  peer?: { directory: string; socketPath: string; record(direction: 'in' | 'out', channel: string, frame: Frame): boolean };
  asyncQuestions?: Map<string, EventData['question']>;
  asyncAnswered?: Set<string>;
  nativeVersion: string;
  identity?: RuntimeIdentity;
  envelopeId?: number;
  permissions?: NativePermissionObservation;
  nativeId: string;
  pid: number;
  /** 每个 app-server 进程一个 token：JSON-RPC 的 request id 在每个进程里从 0/1 开始，
   *  resume 后会与上一进程的 id 重复，必须拼上 token 才能全局唯一 */
  processToken: string;
  /** resume 之后等线程真正挂上（thread/started）再发首轮 */
  ready: Promise<void>;
  markReady?: () => void;
  rpc: JsonRpcStdio;
  cwd: string;
  codexHome?: string;
  /** 当前访问模式：在下一次 turn/start 里带上（F6） */
  accessMode: string | null;
  /** 当前模型：换模型后下一次 turn/start 带上（AG-*-12） */
  model: string | null;
  reasoningEffort: string | null;
  nativeModel?: string;
  nativeEffort?: string | null;
  observedMode?: CodexInputMode | null;
  turnId: string | null;
  observedTurns?: Set<string>;
  completedTurns?: Set<string>;
  reviewRoots?: Map<string, { completed: boolean; executionTurnId?: string; executionTurnIds: Set<string> }>;
  activeReviewRoot?: string;
  subagents?: Map<string, CodexSubagentIdentity>;
  subagentTurns?: Map<string, Set<string>>;
  subagentTurnCompletions?: Set<string>;
  subagentMessageCompletions?: Set<string>;
  subagentCommandCompletions?: Set<string>;
  collabCalls?: Map<string, { startFrame?: number; completed: boolean }>;
  subagentStateFrames?: Map<string, number>;
  subagentSnapshotStarts?: Map<string, number>;
  reasoningSummaries?: Map<string, ReasoningSummary>;
  plans?: CodexPlanStreams;
  completedReasoning?: Set<string>;
  goalId?: string;
  goalVersion?: { createdAt: number; updatedAt: number };
  /** Invalidates pending readbacks after an accepted goal update or clear. */
  goalObservation?: number;
  frameSeq: number;
  turnStartedAt: number;
  /** 模型输出开始时间；用于把 tok/s 的分母限制在生成阶段。 */
  generationStartedAt: number | null;
  generationByTurn?: Map<string, number>;
  approvals: Map<string, PendingApproval>;
  lastAssistantText: string;
  /** 已经发过 item.start 的条目（Codex 的 agentMessage 不一定有 item/started） */
  started: Set<string>;
}

function subagentMessageKey(childId: string, nativeTurnId: string | undefined, itemId: string): string {
  return JSON.stringify([childId, nativeTurnId ?? null, itemId]);
}

function subagentCommandKey(childId: string, nativeTurnId: string, itemId: string): string {
  return JSON.stringify([childId, nativeTurnId, itemId]);
}

function restoreSubagentState(runtime: SessionRuntime, children: readonly CodexSubagentView[]): void {
  runtime.subagents = new Map(children.map(({ turns: _turns, results: _results, snapshots: _snapshots, commands: _commands, ...identity }) => {
    void _turns; void _results; void _snapshots; void _commands;
    return [identity.childId, identity];
  }));
  runtime.subagentTurns = new Map(children.map(child => [child.childId, new Set(Object.keys(child.turns))]));
  runtime.subagentTurnCompletions = new Set(children.flatMap(child => Object.entries(child.turns)
    .filter(([, turn]) => turn.status !== 'inProgress').map(([turnId]) => JSON.stringify([child.childId, turnId]))));
  runtime.subagentMessageCompletions = new Set(children.flatMap(child => child.results.filter(result => result.incomplete !== true)
    .map(result => subagentMessageKey(child.childId, result.nativeTurnId, result.itemId))));
  runtime.subagentCommandCompletions = new Set(children.flatMap(child => (child.commands ?? []).filter(command => command.incomplete !== true)
    .map(command => subagentCommandKey(child.childId, command.nativeTurnId, command.itemId))));
  runtime.collabCalls = new Map(children.flatMap(child => (child.snapshots ?? []).filter(snapshot =>
    ['completed', 'failed', 'interrupted'].includes(snapshot.callStatus)).map(snapshot =>
      [codexSubagentSnapshotKey(snapshot), { completed: true }] as const)));
  runtime.subagentStateFrames = new Map(children.filter(child => child.nativeTurnId !== undefined).map(child => [child.childId, 0]));
}

const NATIVE_COLLAB_STATES = new Set(['pendingInit', 'running', 'interrupted', 'completed', 'errored', 'shutdown', 'notFound']);
const NATIVE_COLLAB_TOOLS = new Set(['spawnAgent', 'sendInput', 'resumeAgent', 'wait', 'closeAgent', 'sendMessage', 'followupTask', 'interruptAgent', 'listAgents']);

const ACCESS_MODES = [
  { id: 'read-only', label: '只读' },
  { id: 'workspace', label: '工作区可写' },
  { id: 'workspace-auto', label: '工作区可写 + 自动审批' },
  { id: 'danger-full-access', label: '完全访问' },
];

function accessParams(mode: string | undefined): Pick<ThreadStartParams, 'approvalPolicy' | 'sandbox' | 'approvalsReviewer'> {
  switch (mode) {
    // 原生值，仅供验收脚本触发"每条命令都问"的审批；不作为界面档位
    case 'untrusted':
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write', approvalsReviewer: 'user' };
    case 'read-only':
    case ':read-only':
      return { approvalPolicy: 'on-request', sandbox: 'read-only', approvalsReviewer: 'user' };
    case 'workspace':
    case ':workspace':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'user' };
    case 'workspace-auto':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'auto_review' };
    case 'danger-full-access':
    case ':danger-full-access':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access', approvalsReviewer: 'user' };
    default:
      if (mode == null || mode === '' || mode === 'inherit') return {};
      throw Object.assign(new Error(`Codex 权限模式不支持: ${mode}`), { statusCode: 400 });
  }
}

/** 把 Codex 的 ThreadItem 映射成我方 kind（SPEC 6.3） */
export function mapItemKind(type: string): EventKind {
  switch (type) {
    case 'agentMessage':
      return 'assistant.message';
    case 'reasoning':
      return 'reasoning';
    case 'commandExecution':
    case 'exec':
      return 'command';
    case 'fileChange':
      return 'file.change';
    case 'plan':
      return 'plan';
    case 'imageView':
      return 'file.read';
    // userMessage 归为 internal：我们已经有自己的 user.message（F12）
    case 'userMessage':
      return 'internal';
    case undefined:
    case '':
      return 'internal';
    default:
      return 'tool.call';
  }
}

/**
 * Codex 的 ServerNotification 方法 → 显式归类（F12）。
 * unknown 只留给 schema 之外真正未知的事件；原生界面会显示的内容不许归为 internal。
 */
export type CodexRoute =
  | 'thread/status'
  | 'turn/started'
  | 'turn/completed'
  | 'item/started'
  | 'item/completed'
  | 'agentMessage/delta'
  | 'reasoning/summaryTextDelta'
  | 'reasoning/summaryPartAdded'
  | 'reasoning/textDelta'
  | 'commandExecution/outputDelta'
  | 'tokenUsage'
  | 'title'
  | 'error'
  | 'goal/updated'
  | 'goal/cleared'
  | 'plan/updated'
  | 'plan/delta'
  | 'plan/item'
  | 'diff/updated'
  | 'serverRequest/resolved'
  | 'notice'
  | 'internal'
  | 'unknown';

export function routeNotification(method: string): CodexRoute {
  switch (method) {
    case 'turn/started':
      return 'turn/started';
    case 'turn/completed':
      return 'turn/completed';
    case 'item/started':
      return 'item/started';
    case 'item/completed':
      return 'item/completed';
    case 'item/agentMessage/delta':
      return 'agentMessage/delta';
    case 'item/reasoning/summaryTextDelta':
      return 'reasoning/summaryTextDelta';
    case 'item/reasoning/summaryPartAdded':
      return 'reasoning/summaryPartAdded';
    case 'item/reasoning/textDelta':
      return 'reasoning/textDelta';
    case 'item/commandExecution/outputDelta':
      return 'commandExecution/outputDelta';
    case 'thread/tokenUsage/updated':
      return 'tokenUsage';
    case 'thread/name/updated':
      return 'title';
    case 'error':
      return 'error';
    case 'thread/goal/updated':
      return 'goal/updated';
    case 'thread/goal/cleared':
      return 'goal/cleared';
    case 'turn/plan/updated':
      return 'plan/updated';
    case 'item/plan/delta':
      return 'plan/delta';
    case 'turn/diff/updated':
      return 'diff/updated';
    case 'serverRequest/resolved':
      return 'serverRequest/resolved';
    case 'thread/status/changed':
      return 'thread/status';
    case 'warning':
    case 'configWarning':
    case 'deprecationNotice':
    case 'guardianWarning':
    case 'model/rerouted':
    case 'model/verification':
    case 'thread/compacted':
    case 'windowsSandbox/setupCompleted':
    case 'windows/worldWritableWarning':
      return 'notice';
    case 'item/plan/started':
    case 'item/plan/updated':
    case 'item/plan/completed':
      return 'plan/item';
    case 'thread/started':
    case 'account/rateLimits/updated':
    case 'remoteControl/status/changed':
    case 'item/commandExecution/terminalInteraction':
    case 'item/mcpToolCall/progress':
    case 'account/gatewayOAuth/changed':
    case 'account/login/completed':
    case 'account/updated':
    case 'app/list/updated':
    case 'autoApprovalReview/strictReviewRequired':
    case 'command/exec/outputDelta':
    case 'externalAgentConfig/import/completed':
    case 'externalAgentConfig/import/progress':
    case 'fs/changed':
    case 'fuzzyFileSearch/sessionCompleted':
    case 'fuzzyFileSearch/sessionUpdated':
    case 'hook/completed':
    case 'hook/started':
    case 'item/autoApprovalReview/completed':
    case 'item/autoApprovalReview/started':
    case 'item/fileChange/outputDelta':
    case 'item/fileChange/patchUpdated':
    case 'mcpServer/event/stream/notification':
    case 'mcpServer/oauthLogin/completed':
    case 'mcpServer/startupStatus/updated':
    case 'modelProvider/authRecoveryCompleted':
    case 'modelProvider/authRecoveryStarted':
    case 'model/safetyBuffering/updated':
    case 'process/exited':
    case 'process/outputDelta':
    case 'project/changed':
    case 'rawResponse/completed':
    case 'rawResponseItem/completed':
    case 'skills/changed':
    case 'thread/archived':
    case 'thread/attachment/updated':
    case 'thread/closed':
    case 'thread/deleted':
    case 'thread/environment/connected':
    case 'thread/environment/disconnected':
    case 'thread/prediction/updated':
    case 'thread/project/updated':
    case 'thread/queue/changed':
    case 'thread/readState/changed':
    case 'thread/realtime/closed':
    case 'thread/realtime/error':
    case 'thread/realtime/itemAdded':
    case 'thread/realtime/item/completed':
    case 'thread/realtime/item/started':
    case 'thread/realtime/item/transcript/delta':
    case 'thread/realtime/outputAudio/delta':
    case 'thread/realtime/sdp':
    case 'thread/realtime/started':
    case 'thread/realtime/transcript/delta':
    case 'thread/realtime/transcript/done':
    case 'thread/reverted':
    case 'thread/section/changed':
    case 'thread/settings/updated':
    case 'thread/unarchived':
    case 'turn/moderationMetadata':
      return 'internal';
    default:
      return 'unknown';
  }
}

/** 把 Codex 的 `turn/plan/updated` / `item/plan/*` 映射成任务面板的条目 */
export function mapPlanItems(params: Record<string, unknown>): { text: string; status: 'pending' | 'in_progress' | 'completed' }[] {
  const raw = params['plan'] ?? params['items'] ?? params['steps'] ?? [];
  if (!Array.isArray(raw)) return [];
  const out: { text: string; status: 'pending' | 'in_progress' | 'completed' }[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      out.push({ text: entry, status: 'pending' });
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const rawStatus = String(item['status'] ?? '');
    const status = rawStatus === 'completed' ? 'completed' : rawStatus === 'in_progress' || rawStatus === 'inProgress' ? 'in_progress' : 'pending';
    out.push({ text: String(item['step'] ?? item['text'] ?? item['title'] ?? item['description'] ?? ''), status });
  }
  // 纯文本计划（explanation 里的 markdown）也算一条
  if (out.length === 0 && typeof params['explanation'] === 'string' && params['explanation'].trim() !== '') {
    out.push({ text: params['explanation'].trim(), status: 'pending' });
  }
  return out;
}

/** 解析 `turn/diff/updated` 的 git diff 文本，得到每个文件的增删行数（C2 第 1 级） */
export function parseUnifiedDiff(
  diff: string,
): { path: string; kind: 'add' | 'modify' | 'delete'; added: number; removed: number; diff: string }[] {
  const files: { path: string; kind: 'add' | 'modify' | 'delete'; added: number; removed: number; diff: string }[] = [];
  let current: (typeof files)[number] | null = null;
  for (const raw of diff.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
    if (header !== null) {
      if (current !== null) files.push(current);
      current = { path: header[2] ?? header[1] ?? '', kind: 'modify', added: 0, removed: 0, diff: `${raw}\n` };
      continue;
    }
    if (current !== null) current.diff += `${raw}\n`;
    if (current === null) continue;
    if (raw.startsWith('new file mode')) {
      current.kind = 'add';
      continue;
    }
    if (raw.startsWith('deleted file mode')) {
      current.kind = 'delete';
      continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('@@') || raw.startsWith('index ')) continue;
    if (raw.startsWith('+')) current.added += 1;
    else if (raw.startsWith('-')) current.removed += 1;
  }
  if (current !== null) files.push(current);
  return files;
}

export function mapItemData(item: Record<string, unknown>, codexItemPhase?: EventData['tool.call']['codexItemPhase']): EventData[EventKind] {
  const type = String(item['type'] ?? '');
  switch (type) {
    case 'agentMessage':
      {
        const nativePhase = typeof item['phase'] === 'string' ? item['phase'] : undefined;
        const phase = item['delivery'] !== 'async' && (nativePhase === 'final_answer' || nativePhase === 'partial_answer') ? 'final' : 'interim';
        return { text: String(item['text'] ?? ''), phase, ...(nativePhase === undefined ? {} : { nativePhase }) };
      }
    case 'reasoning':
      return { text: Array.isArray(item['summary']) ? item['summary'].filter((part): part is string => typeof part === 'string').join('\n') : '',
        ...(Array.isArray(item['content']) && item['content'].length > 0 ? { nativeContent:
          item['content'].flatMap((text, index) => typeof text === 'string' ? [{ index, text }] : []) } : {}) };
    case 'commandExecution':
      return {
        command: String(item['command'] ?? ''),
        ...(typeof item['cwd'] === 'string' ? { cwd: item['cwd'] } : {}),
        ...(typeof item['exitCode'] === 'number' ? { exitCode: item['exitCode'] } : {}),
        ...(typeof item['aggregatedOutput'] === 'string' ? { outputTail: item['aggregatedOutput'].split('\n').slice(-200).join('\n') } : {}),
        status: item['status'] === 'failed' || item['status'] === 'declined' ? 'failed' : item['status'] === 'inProgress' ? 'running' : 'completed',
      };
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const data: EventData['tool.call'] = { name: type, input: item, status: 'unknown' };
      return { ...data, status: codexNativeToolStatus(data) ?? 'unknown' };
    }
    case 'webSearch': {
      const data: EventData['tool.call'] = { name: type, input: item, status: 'unknown',
        ...(codexItemPhase === undefined ? {} : { codexItemPhase }) };
      return { ...data, status: codexNativeToolStatus(data) ?? 'unknown' };
    }
    case 'imageGeneration': {
      const data: EventData['tool.call'] = { name: type, input: item, status: 'unknown' };
      return { ...data, status: codexNativeImageStatus(data) ?? 'unknown' };
    }
    case 'exec': {
      const input = item['input'] ?? item['source'] ?? '';
      return {
        command: typeof input === 'string' ? input : JSON.stringify(input),
        label: '脚本',
        status: item['status'] === 'failed' ? 'failed' : 'completed',
      };
    }
    case 'fileChange': {
      const changes = Array.isArray(item['changes']) ? (item['changes'] as Record<string, unknown>[]) : [];
      return {
        changes: changes.map((change) => {
          const rawKind = change['kind'];
          const kindType = typeof rawKind === 'object' && rawKind !== null ? String((rawKind as { type?: string }).type ?? '') : String(rawKind ?? '');
          const kind = kindType === 'add' ? 'add' : kindType === 'delete' ? 'delete' : 'modify';
          const diffText = typeof change['diff'] === 'string' ? change['diff'] : '';
          const added = diffText.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
          const removed = diffText.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
          // add 的 diff 是整段新内容（没有 + 前缀）
          const addLines = kind === 'add' && added === 0 ? diffText.replace(/\n$/, '').split('\n').filter((line) => line !== '').length : added;
          return {
            path: String(change['path'] ?? ''),
            kind,
            added: addLines,
            removed,
            ...(diffText === '' ? {} : { diff: kind === 'add' ? `--- /dev/null\n+++ b/${String(change['path'] ?? '')}\n${diffText.split('\n').map((line) => `+${line}`).join('\n')}\n` : diffText }),
            ...(kind === 'add' ? { note: '整文件写入，未取得原内容' } : {}),
          };
        }),
        status: item['status'] === 'failed' || item['status'] === 'declined' ? 'failed' : item['status'] === 'inProgress' ? 'running' : 'completed',
      };
    }
    case 'plan':
      return {
        ...(typeof item['text'] === 'string' ? { text: item['text'] } : {}),
        items: (Array.isArray(item['items']) ? (item['items'] as Record<string, unknown>[]) : []).map((step) => ({
          text: String(step['step'] ?? step['text'] ?? ''),
          status: step['status'] === 'completed' ? 'completed' : step['status'] === 'inProgress' ? 'in_progress' : 'pending',
        })),
      };
    case 'imageView':
      return { path: String(item['path'] ?? '') };
    case 'collabAgentToolCall': {
      const data: EventData['tool.call'] = { name: type, input: item, status: 'unknown' };
      return { ...data, status: codexCollabCallStatus(data) ?? 'unknown' };
    }
    default:
      return { name: type, input: item, status: item['status'] === 'failed' ? 'failed' : 'completed' };
  }
}

/** 纯函数：thread/start 参数（3.3 的机器检查用；永不包含 baseInstructions/developerInstructions） */
export function buildThreadStartParams(opts: CreateOpts): ThreadStartParams {
  return {
    cwd: opts.cwd,
    ...(opts.model === undefined ? {} : { model: opts.model }),
    ...accessParams(opts.accessMode),
  };
}

/** 纯函数：turn/start 参数 */
export function buildTurnStartParams(
  threadId: string,
  text: string,
  accessMode?: string | null,
  model?: string | null,
  reasoningEffort?: string | null,
  images?: { path: string; mime: string }[],
  cwd?: string,
): TurnStartParams {
  const access = accessMode == null ? {} : accessParams(accessMode);
  const sandboxPolicy: TurnStartParams['sandboxPolicy'] = access.sandbox === 'read-only'
    ? { type: 'readOnly', networkAccess: false }
    : access.sandbox === 'danger-full-access'
      ? { type: 'dangerFullAccess' }
      : access.sandbox === 'workspace-write'
        ? { type: 'workspaceWrite', writableRoots: cwd === undefined ? [] : [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
        : undefined;
  return {
    threadId,
    input: [
      // Codex 的附件是 localImage（SPEC-M8 F7）
      ...(images ?? []).map((image) => ({ type: 'localImage' as const, path: image.path })),
      { type: 'text', text, text_elements: [] },
    ],
    ...(model === undefined || model === null ? {} : { model }),
    ...(reasoningEffort === undefined || reasoningEffort === null ? {} : { effort: reasoningEffort }),
    ...(access.approvalPolicy === undefined ? {} : { approvalPolicy: access.approvalPolicy, approvalsReviewer: access.approvalsReviewer, sandboxPolicy }),
  };
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex' as const;
  private readonly listeners: ((sessionId: string, event: AdapterEvent) => void)[] = [];
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly options: CodexAdapterOptions;

  constructor(options: CodexAdapterOptions = {}) {
    this.options = options;
  }

  /** Transport-free replay through the production notification/request handlers. */
  static replay(sessionId = 'replay', nativeId = '', children: readonly CodexSubagentView[] = []): { feed: (frame: TraceFrame) => AdapterEvent[]; adapter: CodexAdapter; replies: unknown[] } {
    const adapter = new CodexAdapter();
    const replies: unknown[] = [];
    const runtime: SessionRuntime = {
      nativeId, nativeVersion: 'replay', pid: 0, processToken: 'replay', ready: Promise.resolve(),
      rpc: { respond: (id: string | number, result: unknown) => replies.push({ id, result }) } as unknown as JsonRpcStdio,
      cwd: '.', accessMode: null, model: null, reasoningEffort: null, turnId: null,
      frameSeq: 0, turnStartedAt: 0, generationStartedAt: null, approvals: new Map(), lastAssistantText: '', started: new Set(),
    };
    restoreSubagentState(runtime, children);
    adapter.sessions.set(sessionId, runtime);
    let events: AdapterEvent[] = [];
    adapter.onEvent((_id, event) => events.push(event));
    const reviewRequests = new Set<string | number>();
    return { adapter, replies, feed(frame) {
      events = []; adapter.replayTime = frame.t;
      const raw = frame.frame as Frame;
      const requestId = raw['id'];
      if (frame.ch === 'rpc' && (typeof requestId === 'string' || typeof requestId === 'number')) {
        if (frame.dir === 'out' && raw['method'] === 'review/start' && (raw['params'] as { threadId?: string } | undefined)?.threadId === runtime.nativeId) {
          reviewRequests.add(requestId);
          if (reviewRequests.size > 128) reviewRequests.delete(reviewRequests.values().next().value!);
        } else if (frame.dir === 'in' && raw['method'] === undefined && (raw['result'] !== undefined || raw['error'] !== undefined) && reviewRequests.delete(requestId)) {
          if (raw['result'] !== undefined) adapter.acceptReview(sessionId, runtime, raw['result']);
        }
      }
      if (frame.dir === 'in' && typeof raw['method'] === 'string') {
        if (raw['id'] !== undefined) {
          try { adapter.onServerRequest(sessionId, raw); } catch (error) {
            replies.push({ id: raw['id'], error: { code: (error as { code?: number }).code ?? -32000, message: String(error) } });
          }
        }
        else adapter.onNotification(sessionId, raw);
      }
      return events.length > 0 ? [...events] : [{ type: 'item.complete', itemKey: `transport-${frame.ch}-${frame.i}`, kind: 'internal', data: { nativeType: frame.ch }, native: frame.frame }];
    } };
  }

  private replayTime?: number;
  private now(): number { return this.replayTime ?? Date.now(); }

  onEvent(cb: (sessionId: string, event: AdapterEvent) => void): void {
    this.listeners.push(cb);
  }

  bindRuntime(sessionId: string, identity: RuntimeIdentity): void {
    const runtime = this.sessions.get(sessionId);
    if (runtime !== undefined) runtime.identity = identity;
  }

  private emit(sessionId: string, event: AdapterEvent): void {
    const current = this.sessions.get(sessionId);
    const native = ('native' in event ? event.native : undefined) as { params?: { threadId?: unknown; conversationId?: unknown } } | undefined;
    const requestThread = native?.params?.threadId ?? native?.params?.conversationId;
    const childRequest = event.type === 'item.complete' && ['question', 'approval.request', 'approval.resolved'].includes(event.kind)
      && typeof requestThread === 'string' && requestThread !== current?.nativeId;
    const identity = current?.identity;
    if (identity !== undefined) event = { ...event, runtime: identity };
    if (current?.envelopeId !== undefined) event = { ...event, nativeEnvelopeId: current.envelopeId };
    if ('nativeTurnId' in event && event.nativeTurnId !== undefined && !childRequest) {
      const projected = this.nativeTurnId({ turnId: event.nativeTurnId }, current);
      if (projected !== event.nativeTurnId) event = { ...event, nativeTurnId: projected };
    }
    if ((event.type === 'item.start' || event.type === 'item.complete' || event.type === 'item.cancel' || event.type === 'turn.start' || event.type === 'turn.end')
      && event.nativeTurnId === undefined && event.native !== null && typeof event.native === 'object') {
      const native = event.native as Record<string, unknown>;
      const params = native['params'] !== null && typeof native['params'] === 'object' ? native['params'] as Record<string, unknown> : native;
      const nativeTurnId = this.nativeTurnId(params, childRequest ? undefined : current);
      if (nativeTurnId !== undefined) event = { ...event, nativeTurnId };
    }
    if (event.type === 'item.complete' && !isValidEventData(event.kind, event.data)) {
      const degraded: AdapterEvent = {
        type: 'item.complete',
        itemKey: event.itemKey,
        kind: 'unknown',
        data: { nativeType: event.kind },
        native: event.native ?? event.data,
        runtime: event.runtime,
        nativeTurnId: event.nativeTurnId,
        scope: event.scope,
        nativeEnvelopeId: event.nativeEnvelopeId,
      };
      for (const listener of this.listeners) listener(sessionId, degraded);
      return;
    }
    for (const listener of this.listeners) listener(sessionId, event);
  }

  async probe(): Promise<ProbeResult> {
    const result = spawnSync(this.options.command ?? 'codex', ['--version'], { encoding: 'utf8', env: this.options.env ?? process.env, timeout: 5000 });
    if (result.status !== 0) {
      return { installed: false, pinnedVersion: PINNED_VERSION, auth: 'unknown', notes: ['服务器上没有安装 Codex CLI'] };
    }
    const version = (result.stdout ?? '').trim().replace(/^codex-cli\s+/, '');
    return {
      installed: true,
      version,
      pinnedVersion: PINNED_VERSION,
      compatible: isSupportedCodexVersion(version),
      supportedVersions: SUPPORTED_CODEX_VERSIONS,
      auth: 'unknown',
      notes: isSupportedCodexVersion(version) ? [] : [`版本 ${version} 不在已审核兼容范围 ${CODEX_COMPATIBILITY_LABEL} 内`],
    };
  }

  async listModels(providerId: string | null = null, provider?: ProviderRuntimeConfig | null): Promise<ModelOption[]> {
    if ((provider?.id ?? null) !== providerId) throw new Error('模型目录的 Provider 身份与运行配置不一致');
    const version = await this.requireCompatibleVersion();
    const spec = this.buildLaunchSpec({ sessionId: 'model-catalog', cwd: process.cwd(), providerId, provider });
    let frameIndex = 0;
    const rpc = JsonRpcStdio.start({ command: spec.command!, nativeVersion: version, args: spec.args, env: { ...(this.options.env ?? process.env), ...spec.env },
      onFrame: (dir, frame) => traceFrame(this.options.traceSink, { i: ++frameIndex, t: 0, dir, ch: 'rpc-catalog', frame }) });
    try {
      await this.handshake(rpc);
      const models: ModelOption[] = []; let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 5; page++) {
        const result = await nativeRequest(rpc, 'model/list', { limit: 100, ...(cursor === undefined ? {} : { cursor }), includeHidden: false });
        for (const model of result.data) models.push({ id: model.model, label: model.displayName,
          reasoningEfforts: model.supportedReasoningEfforts.map(option => option.reasoningEffort), defaultReasoningEffort: model.defaultReasoningEffort,
          inputModalities: model.inputModalities, isDefault: model.isDefault, source: `codex:${version}:model/list` });
        if (result.nextCursor === null) return models;
        if (seen.has(result.nextCursor)) throw new Error('原生模型目录分页游标循环');
        cursor = result.nextCursor; seen.add(cursor);
      }
      throw new Error('原生模型目录超过本次500项读取范围，请缩小目录');
    } finally { await rpc.kill(); }
  }

  /** The pinned CLI owns command names; explicit routes separate native
   * controls, Web pickers and commands requiring its interactive terminal. */
  async slashCommands() {
    await this.requireCompatibleVersion();
    return codexSlashCommands;
  }

  async previewSlashCommands() {
    return this.slashCommands();
  }

  async executeSlashControl(sessionId: string, line: string, options: { replaceGoal?: boolean; editGoal?: boolean; contentParts?: UserInput['contentParts'] } = {}) {
    const runtime = this.require(sessionId); await runtime.ready;
    if (/^\/compact(?:\s|$)/.test(line) && (runtime.turnId !== null || runtime.approvals.size > 0)) throw Object.assign(new Error('请等待原生轮次和交互结束后压缩'), { statusCode: 409, code: 'native-control-rejected' });
    const result = await executeCodexSlash(runtime.rpc, runtime.nativeId, runtime.cwd, line, { ...options, codexHome: runtime.codexHome });
    if (this.sessions.get(sessionId) !== runtime || runtime.rpc.isClosed) throw Object.assign(new Error('原生运行实例已变化，指令结果需核对'), { code: 'uncertain' });
    return result;
  }

  /** 换模型（AG-*-12）：下一次 turn/start 带上新模型 */
  /** 访问模式来自 app-server 的 permissionProfile/list（MODE-codex-01） */
  async listAccessModes(): Promise<AccessModeOption[]> {
    const unavailable = (reason: string): AccessModeOption[] => ACCESS_MODES.map(option => ({ ...option, allowed: false, reason, source: 'permissionProfile/list' }));
    const probe = await this.probe();
    if (probe.compatible === false) return unavailable('原生版本不兼容，权限目录未确认');
    const labels: Record<string, string> = {
      ':read-only': '只读',
      ':workspace': '工作区可写',
      ':danger-full-access': '完全访问',
    };
    const rpc = JsonRpcStdio.start({ command: this.options.command ?? 'codex', nativeVersion: probe.version, args: ['app-server', ...(this.options.configOverrides ?? []).flatMap(override => ['-c', override])], env: { ...(this.options.env ?? process.env) } });
    try {
      await nativeRequest(rpc, 'initialize', { clientInfo: { name: 'webdcc', title: 'WebDCC', version: '0.1.0' }, capabilities: null });
      rpc.notify('initialized');
      const result = await nativeRequest(rpc, 'permissionProfile/list', {});
      const modes = (result.data ?? [])
        .filter((entry) => typeof entry.id === 'string')
        .map((entry) => ({ id: entry.id, label: labels[entry.id] ?? entry.id, allowed: entry.allowed, implemented: entry.id in labels, reason: entry.id in labels ? entry.description ?? undefined : '此基线尚无经过验证的 profile 切换协议', source: 'permissionProfile/list', scope: 'thread' as const }));
      return modes.length === 0 ? unavailable('原生权限目录为空，请刷新后重试') : modes;
    } catch {
      return unavailable('原生权限目录读取失败，请刷新后重试');
    } finally {
      await rpc.kill().catch(() => undefined);
    }
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const runtime = this.require(sessionId);
    runtime.model = model;
    if (process.env['WDCC_DEBUG_CODEX'] === '1') console.error('[codex] model set', sessionId, model);
  }

  async setReasoningEffort(sessionId: string, effort: string): Promise<void> {
    this.require(sessionId).reasoningEffort = effort;
  }

  /** Codex：下一次 turn/start 带上 approvalPolicy / sandboxPolicy（F6） */
  async setAccessMode(sessionId: string, mode: string): Promise<{ accessMode: string }> {
    const runtime = this.require(sessionId);
    accessParams(mode);
    if (nativeAccessMode(mode) === undefined) await this.readPermissions(sessionId, runtime);
    runtime.accessMode = nativeAccessMode(mode) ?? null;
    return { accessMode: mode };
  }

  accessModes(): { id: string; label: string }[] {
    return ACCESS_MODES;
  }

  /** 3.3 的机器检查入口：纯函数，不启动进程 */
  buildLaunchSpec(opts: CreateOpts): LaunchSpec {
    const args = ['app-server'];
    for (const override of this.options.configOverrides ?? []) args.push('-c', override);
    const env: Record<string, string> = {};
    const provider = opts.provider;
    if (provider !== null && provider !== undefined) {
      const key = `wdcc_${provider.id}`;
      if (!/^[A-Za-z0-9_-]+$/.test(key)) throw Object.assign(new Error('Provider身份不符合原生配置键要求'), { statusCode: 400 });
      args.push('-c', `model_provider=${JSON.stringify(key)}`);
      args.push('-c', `model_providers.${key}.name=${JSON.stringify(provider.name)}`);
      const baseUrl = provider.endpoints?.['openai-responses'] ?? provider.baseUrl;
      args.push('-c', `model_providers.${key}.base_url=${JSON.stringify(baseUrl)}`);
      args.push('-c', `model_providers.${key}.wire_api="responses"`);
      args.push('-c', `model_providers.${key}.env_key="WDCC_PROVIDER_KEY"`);
      if (provider.codexCatalogPath !== undefined) args.push('-c', `model_catalog_json=${JSON.stringify(provider.codexCatalogPath)}`);
      if (provider.apiKey !== undefined) env['WDCC_PROVIDER_KEY'] = provider.apiKey;
    }
    if (opts.model !== undefined) args.push('-c', `model=${JSON.stringify(opts.model)}`);
    if (opts.recordingEndpoint?.codexProvider !== undefined) args.push('-c', `model_providers.${opts.recordingEndpoint.codexProvider}.base_url=${JSON.stringify(opts.recordingEndpoint.url)}`);
    return { command: this.options.command ?? 'codex', args, env };
  }

  private startProcess(sessionId: string, opts: CreateOpts, nativeVersion: string): SessionRuntime {
    const spec = this.buildLaunchSpec(opts);
    const nativeHelp = process.platform !== 'win32' && ['0.168.0', '0.169.0', '0.172.0'].includes(nativeVersion)
      ? spawnSync(spec.command ?? 'codex', ['app-server', '--help'], { env: { ...(this.options.env ?? process.env), ...spec.env }, encoding: 'utf8', timeout: 1500 }) : undefined;
    const directory = nativeHelp?.status === 0 && nativeHelp.stdout.includes('unix://') ? mkdtempSync(join(tmpdir(), 'wdcc-codex-peer-')) : undefined;
    const socketPath = directory === undefined ? undefined : join(directory, 'host.sock');
    let traceIndex = 0;
    const traceStarted = this.now();
    const runtimeRef: { current?: SessionRuntime } = {};
    const rpc = JsonRpcStdio.start({
      command: spec.command ?? 'codex',
      nativeVersion,
      args: [...(spec.args ?? []), ...(socketPath === undefined ? [] : ['--listen', `unix://${socketPath}`])],
      unixSocketPath: socketPath,
      cwd: opts.cwd,
      env: { ...(this.options.env ?? process.env), ...spec.env },
      onFrame: (direction, frame) => {
        const observation = { i: ++traceIndex, t: this.now() - traceStarted, dir: direction, ch: 'rpc', frame };
        const receipt = opts.nativeEvents?.record(observation);
        if (runtimeRef.current !== undefined) runtimeRef.current.envelopeId = receipt?.envelopeId;
        traceFrame(this.options.traceSink ?? opts.traceSink, observation);
        return receipt?.accepted !== false;
      },
      onExit: () => {
        if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
        if (this.sessions.get(sessionId) !== runtimeRef.current) return;
        this.emit(sessionId, { type: 'transport.closed', reason: 'process-exited', activeWork: runtimeRef.current?.turnId != null });
      },
    });
    const launchEnv = { ...(this.options.env ?? process.env), ...spec.env };
    const profilePath = resolve(opts.cwd, launchEnv['CODEX_HOME'] ?? resolve(launchEnv['HOME'] ?? homedir(), '.codex'));
    try { if (rpc.child.pid !== undefined) opts.onManagedProcess?.(rpc.child.pid, profilePath, nativeVersion); }
    catch (error) { rpc.child.kill('SIGKILL'); void rpc.kill(); throw error; }
    let markReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const runtime: SessionRuntime = {
      ...(directory === undefined ? {} : { peer: { directory, socketPath: socketPath!, record: (direction, channel, frame) => {
        if (this.sessions.get(sessionId) !== runtimeRef.current || rpc.isClosed) return false;
        const observation = { i: ++traceIndex, t: this.now() - traceStarted, dir: direction, ch: channel, frame };
        const receipt = opts.nativeEvents?.record(observation); traceFrame(this.options.traceSink ?? opts.traceSink, observation);
        return receipt?.accepted !== false;
      } } }),
      nativeId: 'nativeId' in opts && typeof opts.nativeId === 'string' ? opts.nativeId : '',
      identity: opts.runtime,
      pid: rpc.child.pid ?? 0,
      processToken: randomUUID(),
      ready,
      markReady,
      rpc,
      nativeVersion,
      cwd: opts.cwd,
      accessMode: opts.accessMode ?? null,
      model: opts.model ?? null,
      reasoningEffort: opts.reasoningEffort ?? null,
      turnId: null,
      frameSeq: 0,
      turnStartedAt: 0,
      generationStartedAt: null,
      approvals: new Map(),
      lastAssistantText: '',
      started: new Set(),
    };
    restoreSubagentState(runtime, opts.restoreCodexSubagents ?? []);
    runtimeRef.current = runtime;
    rpc.onNotification((frame) => {
      if (this.sessions.get(sessionId) !== runtime) return;
      if (frame['method'] === 'thread/started') markReady();
      this.onNotification(sessionId, frame);
    });
    rpc.onServerRequest((frame) => {
      if (this.sessions.get(sessionId) !== runtime) throw new Error('Stale native process');
      return this.onServerRequest(sessionId, frame);
    });
    this.sessions.set(sessionId, runtime);
    return runtime;
  }

  private async handshake(rpc: JsonRpcStdio, questionModes = false): Promise<InitializeResponse> {
    const initialized = await nativeRequest(rpc, 'initialize', {
      clientInfo: { name: 'webdcc', title: 'WebDCC', version: '0.1.0' },
      capabilities: questionModes ? { experimentalApi: true, requestAttestation: false } : null,
    });
    rpc.notify('initialized');
    return initialized;
  }

  /** Read rollout history without resuming, changing settings, or sending input.
   * Thread status belongs to this observer, not to another app-server process. */
  async observe(opts: CreateOpts & { nativeId: string }): Promise<NativeObservation> {
    const nativeVersion = await this.requireCompatibleVersion();
    const spec = this.buildLaunchSpec({ sessionId: opts.sessionId, cwd: opts.cwd, providerId: null });
    let index = 0;
    const rpc = JsonRpcStdio.start({ command: spec.command!, nativeVersion, args: spec.args, cwd: opts.cwd,
      env: { ...(this.options.env ?? process.env), ...spec.env },
      onFrame: (dir, frame) => opts.nativeEvents?.record({ i: ++index, t: 0, dir, ch: 'rpc-observation', frame }).accepted,
    });
    try {
      const initialized = await this.handshake(rpc);
      const { thread } = await nativeRequest(rpc, 'thread/read', { threadId: opts.nativeId, includeTurns: false });
      if (thread.id !== opts.nativeId) throw new Error('原生观察返回了不同线程');
      if (!isSupportedCodexVersion(thread.cliVersion)) throw new Error('原生历史版本不在已审核兼容范围内，不能推断恢复结果');
      const turns: NativeObservation['turns'] = [];
      let cursor: string | null = null;
      const cursors = new Set<string>();
      for (let page = 0; page < 10; page++) {
        const result: ThreadTurnsListResponse = await nativeRequest(rpc, 'thread/turns/list', { threadId: opts.nativeId, cursor, limit: 50, sortDirection: 'desc', itemsView: 'full' });
        for (const turn of result.data) {
          if (turns.some(previous => previous.nativeTurnId === turn.id)) throw new Error('原生轮次分页重复，请重新核对');
          turns.push({ nativeTurnId: turn.id, status: turn.status,
            startedAt: turn.startedAt == null ? null : new Date(turn.startedAt * 1000).toISOString(),
            completedAt: turn.completedAt == null ? null : new Date(turn.completedAt * 1000).toISOString(),
            itemsComplete: turn.itemsView === 'full',
            clientCommandIds: turn.items.flatMap(item => item.type === 'userMessage' && item.clientId !== null ? [item.clientId] : []),
            items: turn.items.flatMap(item => [{ itemKey: item.id,
              kind: item.type === 'userMessage' ? 'user.message' : mapItemKind(item.type),
              data: item.type === 'userMessage' ? { text: item.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'), ...(item.clientId === null ? {} : { clientCommandId: item.clientId }) }
                : item.type === 'reasoning' ? { text: item.summary.join('\n') } : mapItemData(item as unknown as Record<string, unknown>),
              native: item }, ...codexAsyncQuestions(item as unknown as Record<string, unknown>, opts.nativeId).map(question => ({ itemKey: `question-${question.questionId}`, kind: 'question' as const, data: question, native: item }))]),
          });
        }
        cursor = result.nextCursor;
        if (cursor === null) break;
        if (cursors.has(cursor)) throw new Error('原生轮次分页游标循环');
        cursors.add(cursor);
      }
      return { nativeId: thread.id, agent: this.id, cwd: thread.cwd, version: nativeVersion,
        profilePath: initialized.codexHome,
        capturedAt: new Date().toISOString(), state: thread.status.type === 'active' ? 'running' : 'unknown',
        authority: 'history-only', releasePolicy: 'managed-process', turns,
        notes: ['线程状态仅属于观察进程，不能证明其他原生客户端空闲。', ...(cursor === null ? [] : ['历史超过本次500轮读取上限，未读取的轮次保持待核对。'])] };
    } finally { await rpc.kill(); }
  }

  async create(opts: CreateOpts): Promise<{ nativeId: string }> {
    const nativeVersion = await this.requireCompatibleVersion();
    const runtime = this.startProcess(opts.sessionId, opts, nativeVersion);
    try {
    runtime.codexHome = (await this.handshake(runtime.rpc, true)).codexHome;
    const response = await nativeRequest(runtime.rpc, 'thread/start', buildThreadStartParams(opts));
    runtime.nativeId = response.thread.id;
    runtime.cwd = response.thread.cwd;
    runtime.markReady?.();
    this.observeMode(runtime, response);
    runtime.permissions = codexPermissionObservation(response, 'thread/start');
    this.emit(opts.sessionId, { type: 'permissions', observation: runtime.permissions });
    return { nativeId: runtime.nativeId };
    } catch (error) { await this.dispose(opts.sessionId); throw error; }
  }

  async resume(opts: CreateOpts & { nativeId: string }): Promise<void> {
    const nativeVersion = await this.requireCompatibleVersion();
    const runtime = this.startProcess(opts.sessionId, opts, nativeVersion);
    try {
    if (process.env['WDCC_DEBUG_CODEX'] === '1') console.error('[codex] resume process started');
    runtime.codexHome = (await this.handshake(runtime.rpc, true)).codexHome;
    if (process.env['WDCC_DEBUG_CODEX'] === '1') console.error('[codex] initialize done, resuming');
    const response = await nativeRequest(runtime.rpc, 'thread/resume', {
      threadId: opts.nativeId,
      excludeTurns: true,
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...accessParams(opts.accessMode),
    });
    if (response.thread.id !== opts.nativeId) throw Object.assign(new Error('原生恢复返回了不同会话身份'), { code: 'uncertain' });
    runtime.nativeId = response.thread.id;
    runtime.cwd = response.thread.cwd;
    // A validated resume response acknowledges a loaded thread. The pinned
    // native server need not send a second thread/started notification.
    runtime.markReady?.();
    this.observeMode(runtime, response);
    runtime.permissions = codexPermissionObservation(response, 'thread/resume');
    this.emit(opts.sessionId, { type: 'permissions', observation: runtime.permissions });
    // thread/resume 返回后线程可能还没挂上；等 thread/started 或最多 2 秒
    await Promise.race([runtime.ready, new Promise((resolve) => setTimeout(resolve, 2000))]);
    if (opts.restoreNativeHistory) await this.restoreHistory(opts.sessionId, runtime);
    else await this.restoreAsyncQuestions(opts.sessionId, runtime);
    if (process.env['WDCC_DEBUG_CODEX'] === '1') console.error('[codex] resumed', runtime.nativeId);
    } catch (error) { await this.dispose(opts.sessionId); throw error; }
  }

  private async requireCompatibleVersion(): Promise<string> {
    const probe = await this.probe();
    if (!probe.installed || !isSupportedCodexVersion(probe.version)) throw Object.assign(new Error(`Codex 版本不兼容：支持 ${CODEX_COMPATIBILITY_LABEL}，实际 ${probe.version ?? '未知'}`), { statusCode: 503, code: 'native-version-incompatible' });
    return probe.version!;
  }

  async send(sessionId: string, input: UserInput): Promise<void> {
    const runtime = this.require(sessionId);
    runtime.started.clear();
    runtime.generationStartedAt = null;
    const startedAt = this.now();
    await Promise.race([runtime.ready, new Promise((resolve) => setTimeout(resolve, 2000))]);
    if (process.env['WDCC_DEBUG_CODEX'] === '1') console.error('[codex] turn/start →', runtime.nativeId, 'model=', runtime.model);
    const mode = runtime.accessMode;
    const params: NativeParams<'turn/start'> = buildTurnStartParams(runtime.nativeId, input.text, mode, runtime.model, runtime.reasoningEffort, input.images, runtime.cwd);
    const modalities = await this.inputModalities(sessionId, input);
    params.input = await encodeCodexInput(input, modalities);
    if (input.contentParts?.collaborationMode !== undefined) {
      const selected = input.contentParts.collaborationMode;
      await this.validateMode(runtime, selected);
      const model = runtime.model ?? runtime.nativeModel;
      if (!model) throw Object.assign(new Error('尚未读取原生模型，不能选择输入模式'), { statusCode: 409 });
      params.collaborationMode = { mode: selected, settings: { model,
        reasoning_effort: runtime.reasoningEffort ?? runtime.nativeEffort ?? null,
        // Native null selects the built-in mode instructions, never a Web prompt.
        developer_instructions: null } };
    }
    if (this.sessions.get(sessionId) !== runtime) throw Object.assign(new Error('Codex 运行实例在输入准备期间已替换'), { code: 'uncertain' });
    if (input.nativeRequestId !== undefined) params.clientUserMessageId = input.nativeRequestId;
    const response = await nativeRequest(runtime.rpc, 'turn/start', params);
    if (process.env['WDCC_DEBUG_CODEX'] === '1') console.error('[codex] turn started', response.turn?.id);
    const notified = runtime.observedTurns?.has(response.turn.id) === true;
    if (!notified) {
      this.rememberTurn(runtime, response.turn.id);
      runtime.turnId = response.turn.id;
      runtime.turnStartedAt = startedAt;
      this.emit(sessionId, { type: 'turn.start', nativeTurnId: response.turn.id, native: response });
    }
    // turn/start acknowledges a turn, not its effective policy. Rejoin the
    // loaded thread without overrides to read the native policy; overrides
    // persist for subsequent turns, including when the user selects inherit.
    try { await this.readPermissions(sessionId, runtime); }
    catch {
      if (this.sessions.get(sessionId) === runtime) this.emit(sessionId, { type: 'permissions', observation: { effective: null, source: 'turn/start:policy-unconfirmed', scope: 'turn' } });
    }
  }

  private async inputModalities(sessionId: string, input: UserInput): Promise<readonly string[] | undefined> {
    if (!codexInputParts(input).some(part => part.type === 'image' || part.type === 'audio')) return undefined;
    const runtime = this.require(sessionId); let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const catalog = await nativeRequest(runtime.rpc, 'model/list', { limit: 100, ...(cursor === undefined ? {} : { cursor }), includeHidden: false });
      const selected = catalog.data.find(model => runtime.model === null ? model.isDefault : model.id === runtime.model || model.model === runtime.model);
      if (selected !== undefined) return selected.inputModalities;
      cursor = catalog.nextCursor ?? undefined;
      if (cursor !== undefined && seen.has(cursor)) return undefined;
      if (cursor !== undefined) seen.add(cursor);
    } while (cursor !== undefined);
    return undefined;
  }
  async validateInput(sessionId: string, input: UserInput): Promise<void> {
    await encodeCodexInput(input, await this.inputModalities(sessionId, input));
    if (input.contentParts?.collaborationMode !== undefined) await this.validateMode(this.require(sessionId), input.contentParts.collaborationMode);
  }

  private observeMode(runtime: SessionRuntime, response: { model: string; reasoningEffort: string | null; collaborationMode?: { mode: CodexInputMode } | null }): void {
    runtime.nativeModel = response.model;
    runtime.nativeEffort = response.reasoningEffort;
    runtime.observedMode = response.collaborationMode?.mode ?? null;
  }

  private async validateMode(runtime: SessionRuntime, mode: CodexInputMode): Promise<void> {
    const result = await nativeRequest(runtime.rpc, 'collaborationMode/list', {});
    if (!result.data.some(preset => preset.mode === mode)) throw Object.assign(new Error('原生目录不支持所选输入模式'), { statusCode: 400 });
    if (runtime.rpc.isClosed) throw Object.assign(new Error('原生连接已断开，不能改变模式'), { statusCode: 409 });
  }

  async inputModes(sessionId?: string): Promise<CodexInputModeCatalog> {
    const runtime = sessionId === undefined ? undefined : this.sessions.get(sessionId);
    if (runtime !== undefined && !runtime.rpc.isClosed) {
      const result = await nativeRequest(runtime.rpc, 'collaborationMode/list', {});
      if (this.sessions.get(sessionId!) !== runtime || runtime.rpc.isClosed) throw Object.assign(new Error('模式目录属于旧运行实例'), { statusCode: 409 });
      return { modes: result.data.flatMap(preset => preset.mode === 'plan' || preset.mode === 'default' ? [{ id: preset.mode, label: preset.mode === 'plan' ? '计划' : '默认' }] : []), observedMode: runtime.observedMode ?? null };
    }
    const nativeVersion = await this.requireCompatibleVersion();
    const rpc = JsonRpcStdio.start({ command: this.options.command ?? 'codex', nativeVersion,
      args: ['app-server', ...(this.options.configOverrides ?? []).flatMap(value => ['-c', value])], env: { ...(this.options.env ?? process.env) } });
    try {
      await this.handshake(rpc, true);
      const result = await nativeRequest(rpc, 'collaborationMode/list', {});
      return { modes: result.data.flatMap(preset => preset.mode === 'plan' || preset.mode === 'default' ? [{ id: preset.mode, label: preset.mode === 'plan' ? '计划' : '默认' }] : []), observedMode: null };
    } finally { await rpc.kill(); }
  }
  async inputSkills(sessionId?: string, cwd?: string): Promise<import('@webdcc/protocol').InputSkillOption[]> {
    const runtime = sessionId === undefined ? undefined : this.sessions.get(sessionId);
    const directory = cwd ?? runtime?.cwd ?? process.cwd();
    if (runtime !== undefined && (runtime.cwd !== directory || runtime.rpc.isClosed)) throw unsupportedCodexInput('原生技能目录的会话或工作区已变化');
    const read = async (rpc: JsonRpcStdio) => {
      const catalog = await nativeRequest(rpc, 'skills/list', { cwds: [directory], forceReload: false });
      return catalog.data.flatMap(entry => entry.skills).map(skill => ({
        skillId: createHash('sha256').update(JSON.stringify([skill.name, skill.path])).digest('hex'),
        name: skill.name, description: skill.description, enabled: skill.enabled,
      }));
    };
    if (runtime !== undefined) {
      const skills = await read(runtime.rpc);
      if (this.sessions.get(sessionId!) !== runtime || runtime.rpc.isClosed) throw unsupportedCodexInput('技能目录属于已替换的原生会话');
      return skills;
    }
    const nativeVersion = await this.requireCompatibleVersion();
    const spec = this.buildLaunchSpec({ sessionId: 'skill-preview', cwd: directory, providerId: null });
    const rpc = JsonRpcStdio.start({ command: spec.command ?? 'codex', nativeVersion, args: spec.args,
      cwd: directory, env: { ...(this.options.env ?? process.env), ...spec.env } });
    try { await this.handshake(rpc, true); return await read(rpc); }
    finally { await rpc.kill(); }
  }

  async resolveInputSkill(sessionId: string, selection: InputSkillPart): Promise<{ path: string }> {
    const runtime = this.require(sessionId);
    const catalog = await nativeRequest(runtime.rpc, 'skills/list', { cwds: [runtime.cwd], forceReload: false });
    if (this.sessions.get(sessionId) !== runtime) throw unsupportedCodexInput('技能目录属于已替换的原生会话');
    const matches = catalog.data.flatMap(entry => entry.skills).filter(skill => skill.enabled && skill.name === selection.name
      && createHash('sha256').update(JSON.stringify([skill.name, skill.path])).digest('hex') === selection.skillId);
    if (matches.length !== 1) throw unsupportedCodexInput('技能引用不在当前原生目录中');
    return { path: matches[0]!.path };
  }
  async steer(sessionId: string, input: UserInput): Promise<void> {
    const runtime = this.require(sessionId);
    if (runtime.turnId === null || input.expectedTurnId !== undefined && input.expectedTurnId !== runtime.turnId) throw unsupportedCodexInput('当前运行轮次已变化，无法介入');
    const expectedTurnId = runtime.turnId;
    const nativeExecutionId = this.activeNativeTurnId(runtime)!;
    const content = await encodeCodexInput(input, await this.inputModalities(sessionId, input));
    if (this.sessions.get(sessionId) !== runtime || runtime.turnId !== expectedTurnId || this.activeNativeTurnId(runtime) !== nativeExecutionId) throw unsupportedCodexInput('当前运行轮次已变化，无法介入');
    await nativeRequest(runtime.rpc, 'turn/steer', { threadId: runtime.nativeId, expectedTurnId: nativeExecutionId, input: content,
      ...(input.nativeRequestId === undefined ? {} : { clientUserMessageId: input.nativeRequestId }) });
  }

  private async readPermissions(sessionId: string, runtime: SessionRuntime): Promise<void> {
    const response = await nativeRequest(runtime.rpc, 'thread/resume', { threadId: runtime.nativeId, excludeTurns: true });
    if (this.sessions.get(sessionId) !== runtime || response.thread.id !== runtime.nativeId) throw Object.assign(new Error('原生权限读取属于旧运行实例或其他会话'), { statusCode: 409 });
    runtime.permissions = codexPermissionObservation(response, 'thread/resume:policy-readback');
    this.observeMode(runtime, response);
    this.emit(sessionId, { type: 'permissions', observation: runtime.permissions });
  }

  async interrupt(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (runtime?.turnId === null || runtime?.turnId === undefined) return;
    await nativeRequest(runtime.rpc, 'turn/interrupt', { threadId: runtime.nativeId, turnId: this.activeNativeTurnId(runtime)! });
  }

  async respond(sessionId: string, decision: ApprovalDecision): Promise<NativeInteractionSubmission> {
    const runtime = this.sessions.get(sessionId);
    const pending = runtime?.approvals.get(decision.approvalId);
    if (runtime === undefined || pending === undefined) throw Object.assign(new Error('Codex 审批已结束或不存在'), { statusCode: 409 });
    if (pending.submitted) throw Object.assign(new Error('回应已提交，等待原生确认'), { statusCode: 409 });
    if (pending.kind === 'permissions') {
      if (!['grant-turn', 'grant-session', 'deny-permissions'].includes(decision.optionId)) throw Object.assign(new Error('额外权限选项无效'), { statusCode: 400 });
      const response: PermissionsRequestApprovalResponse = { scope: decision.optionId === 'grant-session' ? 'session' : 'turn', permissions: decision.optionId === 'deny-permissions' ? {} : {
        ...(pending.permissions?.network == null ? {} : { network: pending.permissions.network }),
        ...(pending.permissions?.fileSystem == null ? {} : { fileSystem: pending.permissions.fileSystem }),
      } };
      pending.submitted = true; pending.decision = decision.optionId;
      try { runtime.rpc.respond(pending.requestId, response); } catch (error) { pending.submitted = false; pending.decision = undefined; throw error; }
      return { confirmed: false };
    }
    if (pending.kind === 'elicitation') throw Object.assign(new Error('请使用原生表单回应此请求'), { statusCode: 400 });
    if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision.optionId)) throw Object.assign(new Error('审批选项无效'), { statusCode: 400 });
    const runtimeRpc = runtime.rpc;
    const decisionValue = pending.kind === 'legacyExec' || pending.kind === 'legacyPatch'
      ? (decision.optionId === 'accept' ? 'approved' : decision.optionId === 'acceptForSession' ? 'approved_for_session' : 'denied')
      : decision.optionId;
    pending.submitted = true;
    pending.decision = decision.optionId;
    try { runtimeRpc.respond(pending.requestId, pending.kind === 'userInput' ? { answers: {} } : { decision: decisionValue }); }
    catch (error) { pending.submitted = false; pending.decision = undefined; throw error; }
    return { confirmed: false };
  }

  async answer(sessionId: string, questionId: string, answer: unknown): Promise<{ submitted: boolean; questionIds?: string[]; confirmed?: boolean }> {
    const runtime = this.sessions.get(sessionId);
    const candidates = [...(runtime?.approvals ?? [])].filter(([id, pending]) => (pending.kind === 'userInput' || pending.kind === 'elicitation') && pending.questionIds?.some(nativeId => nativeId === questionId || `${id}:${nativeId}` === questionId));
    const entry = candidates.length === 1 ? candidates[0] : undefined;
    if (runtime === undefined || entry === undefined) throw Object.assign(new Error('Codex 问题已结束或不存在'), { statusCode: 409 });
    const [id, pending] = entry;
    if (pending.submitted) throw Object.assign(new Error('答案已提交，等待原生确认'), { statusCode: 409 });
    if (pending.kind === 'elicitation') {
      const response = elicitationResponse(pending.elicitation!, answer);
      pending.submitted = true; pending.outcome = response.action;
      try { runtime.rpc.respond(pending.requestId, response); } catch (error) { pending.submitted = false; pending.outcome = undefined; throw error; }
      return { submitted: true, confirmed: false, questionIds: pending.questions!.map(question => question.questionId) };
    }
    const nativeId = pending.questionIds?.find(nativeId => nativeId === questionId || `${id}:${nativeId}` === questionId);
    if (nativeId === undefined) throw new Error('原生问题身份不一致');
    const value = normalizeQuestionAnswer(answer).values;
    pending.answers ??= Object.create(null) as Record<string, { answers: string[] }>;
    pending.answers[nativeId] = { answers: value };
    if (Object.keys(pending.answers).length < (pending.questionIds?.length ?? 0)) return { submitted: false };
    pending.submitted = true;
    try { runtime.rpc.respond(pending.requestId, { answers: pending.answers }); }
    catch (error) { pending.submitted = false; throw error; }
    return { submitted: true, confirmed: false, questionIds: (pending.questionIds ?? []).map(question => `${id}:${question}`) };
  }

  /** 打断时把挂起的审批回 decline，避免 JSON-RPC 请求悬空 */
  async cancelPending(sessionId: string): Promise<NativeInteractionSubmission> {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return { confirmed: true };
    for (const [approvalId, pending] of [...runtime.approvals]) {
      void approvalId;
      if (pending.nativeThreadId !== undefined && pending.nativeThreadId !== runtime.nativeId) continue;
      if (pending.submitted) continue;
      const decisionValue = pending.kind === 'legacyExec' || pending.kind === 'legacyPatch' ? 'denied' : 'decline';
      pending.submitted = true; pending.outcome = 'cancel'; pending.decision = 'cancel';
      try { runtime.rpc.respond(pending.requestId, pending.kind === 'elicitation' ? { action: 'cancel', content: null, _meta: null }
        : pending.kind === 'permissions' ? { permissions: {}, scope: 'turn' } : pending.kind === 'userInput' ? { answers: {} } : { decision: decisionValue });
      } catch (error) { pending.submitted = false; pending.outcome = undefined; pending.decision = undefined; throw error; }
    }
    return { confirmed: false };
  }

  debugProcesses(): { sessionId: string; pid: number; dirs: Record<string, string> }[] {
    return [...this.sessions].map(([sessionId, runtime]) => ({
      sessionId,
      pid: runtime.pid,
      dirs: {
        HOME: process.env['HOME'] ?? '',
        CODEX_HOME: this.options.env?.['CODEX_HOME'] ?? process.env['CODEX_HOME'] ?? '',
      },
    }));
  }

  async dispose(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return;
    this.sessions.delete(sessionId);
    await runtime.rpc.kill().catch(() => undefined);
    if (runtime.peer && (runtime.rpc.child.exitCode !== null || runtime.rpc.child.signalCode !== null)) rmSync(runtime.peer.directory, { recursive: true, force: true });
  }

  nativePeerConnection(sessionId: string) {
    const runtime = this.require(sessionId);
    if (!runtime.peer || runtime.rpc.isClosed || !runtime.nativeId || !runtime.codexHome) return undefined;
    return { socketPath: runtime.peer.socketPath, nativeId: runtime.nativeId, nativeVersion: runtime.nativeVersion, codexHome: runtime.codexHome, command: this.options.command ?? 'codex', record: runtime.peer.record };
  }

  async nativeState(sessionId: string) {
    const runtime = this.require(sessionId);
    await runtime.ready;
    const current = (): void => { if (this.sessions.get(sessionId) !== runtime || runtime.rpc.isClosed) throw Object.assign(new Error('原生运行实例已更换或断开'), { statusCode: 409 }); };
    let state: Awaited<ReturnType<typeof codexNativeState>> | undefined;
    // These are read-only snapshots. Never retry a goal mutation or model input.
    for (let attempt = 0; attempt < 3; attempt++) {
      const observation = runtime.goalObservation ?? 0;
      const value = await codexNativeState(runtime.rpc, runtime.nativeId, current);
      if ((runtime.goalObservation ?? 0) === observation) { state = value; break; }
    }
    if (state === undefined) throw Object.assign(new Error('原生目标在读取期间持续变化，当前状态尚未确认，请重新读取'),
      { statusCode: 409, code: 'native-state-changed' });
    return { ...state, model: runtime.model ?? runtime.nativeModel ?? null, effort: runtime.reasoningEffort ?? runtime.nativeEffort ?? null, permissions: runtime.permissions,
      transport: 'live', turnActive: runtime.turnId !== null, activeTurnId: this.activeNativeTurnId(runtime),
      review: runtime.activeReviewRoot === undefined ? null : { rootTurnId: runtime.activeReviewRoot,
        executionTurnId: runtime.reviewRoots?.get(runtime.activeReviewRoot)?.executionTurnId ?? null,
        executionTurnIds: [...runtime.reviewRoots?.get(runtime.activeReviewRoot)?.executionTurnIds ?? []] },
      interactions: [...runtime.approvals].map(([id, pending]) => ({ id, kind: pending.kind, submitted: pending.submitted === true })) };
  }
  nativeTerminalEnvironment(): Record<string, string | undefined> { return { ...(this.options.env ?? process.env) }; }

  async nativeCatalog(sessionId: string) {
    const runtime = this.require(sessionId);
    await runtime.ready;
    const current = (): void => { if (this.sessions.get(sessionId) !== runtime || runtime.rpc.isClosed) throw Object.assign(new Error('原生运行实例已更换或断开'), { statusCode: 409 }); };
    return { nativeId: runtime.nativeId, version: runtime.nativeVersion, ...(await codexNativeCatalog(runtime.rpc, runtime.nativeId, runtime.cwd, current)) };
  }

  async executeNativeControl(sessionId: string, value: unknown): Promise<unknown> {
    const action = parseCodexNativeAction(value);
    const runtime = this.require(sessionId);
    await runtime.ready;
    if (['compact', 'archive', 'unarchive', 'fork', 'review'].includes(action.type) && (runtime.turnId !== null || runtime.approvals.size > 0)) throw Object.assign(new Error('请等待原生轮次和交互结束后操作'), { statusCode: 409, code: 'native-control-rejected' });
    if (this.sessions.get(sessionId) !== runtime || runtime.rpc.isClosed) throw Object.assign(new Error('原生实例已断开'), { statusCode: 409, code: 'native-control-rejected' });
    const result = await executeCodexNativeControl(runtime.rpc, runtime.nativeId, runtime.cwd, action, () => {
      if (this.sessions.get(sessionId) !== runtime || runtime.rpc.isClosed || runtime.turnId !== null || runtime.approvals.size > 0) throw Object.assign(new Error('原生 Review 实例或运行状态已变化，Review 未提交'), { statusCode: 409, code: 'native-control-rejected' });
    });
    if (this.sessions.get(sessionId) !== runtime) throw Object.assign(new Error('原生运行实例已变化，结果需核对'), { statusCode: 409 });
    if (action.type === 'review') this.acceptReview(sessionId, runtime, result);
    return result;
  }

  async readNativeHistory(sessionId: string, options: { cursor?: string; offset?: number; limit: number }) {
    const runtime = this.require(sessionId);
    await runtime.ready;
    if (options.offset !== undefined && options.offset !== 0) throw Object.assign(new Error('Codex 历史使用不透明游标，请勿使用 offset'), { statusCode: 400 });
    const result = await nativeRequest(runtime.rpc, 'thread/turns/list', { threadId: runtime.nativeId, limit: options.limit,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }), sortDirection: 'desc', itemsView: 'full' });
    if (this.sessions.get(sessionId) !== runtime) throw Object.assign(new Error('原生运行实例已变化'), { statusCode: 409 });
    return result;
  }
  private async restoreHistory(sessionId: string, runtime: SessionRuntime): Promise<void> {
    const turns: Awaited<ReturnType<typeof nativeRequest<'thread/turns/list'>>>['data'] = [];
    let cursor: string | undefined;
    do {
      const page = await nativeRequest(runtime.rpc, 'thread/turns/list', { threadId: runtime.nativeId, limit: 100, sortDirection: 'asc', itemsView: 'full', ...(cursor ? { cursor } : {}) });
      turns.push(...page.data); cursor = page.nextCursor ?? undefined;
      if (turns.length > 500 || turns.some(turn => turn.itemsView !== 'full' || turn.status === 'inProgress')) throw Object.assign(new Error('原生历史未完整结束，返回状态需核对'), { code: 'uncertain' });
    } while (cursor);
    const records: NativeHistoryRecord[] = turns.map((turn, index) => ({ nativeSeq: index, nativeTurnId: turn.id,
      at: new Date((turn.completedAt ?? turn.startedAt ?? 0) * 1000).toISOString(), native: turn,
      admittedInputs: turn.items.flatMap(item => item.type === 'userMessage' && item.clientId ? [{ nativeRequestId: item.clientId, text: item.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') }] : []),
      events: [{ type: 'turn.start' as const, nativeTurnId: turn.id }, ...turn.items.flatMap(item => {
        const kind = item.type === 'userMessage' ? 'user.message' : mapItemKind(item.type);
        const data = item.type === 'userMessage' ? { text: item.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'), ...(item.clientId ? { clientCommandId: item.clientId } : {}) } : mapItemData(item as unknown as Record<string, unknown>);
        return [...codexAsyncQuestionEvents(item as unknown as Record<string, unknown>, runtime.nativeId), { type: 'item.complete' as const, itemKey: item.id, kind, data, native: item }];
      }), { type: 'turn.end' as const, nativeTurnId: turn.id, status: turn.status === 'failed' ? 'failed' as const : turn.status === 'interrupted' ? 'interrupted' as const : 'completed' as const }] }));
    if (this.sessions.get(sessionId) !== runtime) throw Object.assign(new Error('原生返回实例已变化'), { code: 'uncertain' });
    this.emit(sessionId, { type: 'history', nativeId: runtime.nativeId, records });
    const observation = runtime.goalObservation ?? 0;
    const goal = await nativeRequest(runtime.rpc, 'thread/goal/get', { threadId: runtime.nativeId });
    if (this.sessions.get(sessionId) !== runtime || runtime.rpc.isClosed) throw Object.assign(new Error('原生返回实例已变化，目标结果需核对'), { code: 'uncertain' });
    // A live notification already projected the newer goal. The original get
    // response remains in the native ledger, but must not replace that goal.
    if ((runtime.goalObservation ?? 0) !== observation) return;
    this.onNotification(sessionId, goal.goal ? { method: 'thread/goal/updated', params: { threadId: runtime.nativeId, turnId: null, goal: goal.goal } }
      : { method: 'thread/goal/cleared', params: { threadId: runtime.nativeId } });
  }

  /** Recover async cards and native answer receipts without inventing a live turn. */
  private async restoreAsyncQuestions(sessionId: string, runtime: SessionRuntime): Promise<void> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await nativeRequest(runtime.rpc, 'thread/turns/list', { threadId: runtime.nativeId, limit: 100, sortDirection: 'asc', itemsView: 'full', ...(cursor ? { cursor } : {}) });
      if (this.sessions.get(sessionId) !== runtime || page.data.some(turn => turn.itemsView !== 'full')) throw Object.assign(new Error('异步问题历史未完整确认'), { code: 'uncertain' });
      for (const turn of page.data) for (const item of turn.items) {
        const record = item as unknown as Record<string, unknown>;
        for (const question of codexAsyncQuestions(record, runtime.nativeId)) {
          (runtime.asyncQuestions ??= new Map()).set(question.questionId, question);
          this.emit(sessionId, { type: 'item.complete', itemKey: `question-${question.questionId}`, kind: 'question', data: question, native: item, scope: 'session' });
        }
        if (item.type === 'userMessage') {
          const { text, replies } = nativeAsyncReplies(record);
          for (const reply of replies) (runtime.asyncAnswered ??= new Set()).add(reply.questionItemId);
          // Local receipts also identify native's oversized-ID fallback replies.
          if (replies.length > 0 || item.clientId) this.emit(sessionId, { type: 'item.complete', itemKey: item.id, kind: 'user.message', data: { text, ...(item.clientId ? { clientCommandId: item.clientId } : {}) }, native: item, scope: 'session' });
        }
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor && seen.has(cursor)) throw Object.assign(new Error('异步问题历史游标重复，请核对原生历史'), { code: 'uncertain' });
      if (cursor) seen.add(cursor);
    } while (cursor);
  }

  async nativeProcessStart(sessionId: string, params: NativeProcessStart, onOutput: (delta: NativeProcessDelta) => void): Promise<NativeProcessCompletion> {
    const runtime = this.require(sessionId); await runtime.ready;
    const policy = runtime.permissions?.policy as { sandbox?: NativeParams<'command/exec'>['sandboxPolicy'] } | undefined;
    if (policy?.sandbox == null) throw Object.assign(new Error('尚未读回原生沙箱，不能启动原生命令'), { statusCode: 409, code: 'native-control-rejected' });
    const detach = runtime.rpc.onNotification(frame => {
      if (this.sessions.get(sessionId) !== runtime || frame['method'] !== 'command/exec/outputDelta') return;
      const delta = frame['params'] as { processId?: string } & NativeProcessDelta;
      if (delta.processId === params.processId && ['stdout', 'stderr'].includes(delta.stream) && typeof delta.deltaBase64 === 'string' && typeof delta.capReached === 'boolean') onOutput(delta);
    });
    try {
      return await nativeRequest(runtime.rpc, 'command/exec', { ...params, cwd: runtime.cwd, sandboxPolicy: policy.sandbox,
        tty: true, streamStdin: true, streamStdoutStderr: true, disableTimeout: true }, 0);
    } finally { detach(); }
  }
  async nativeProcessWrite(sessionId: string, params: { processId: string; deltaBase64?: string; closeStdin?: boolean }): Promise<void> {
    await nativeRequest(this.require(sessionId).rpc, 'command/exec/write', params);
  }
  async nativeProcessResize(sessionId: string, params: { processId: string; size: { rows: number; cols: number } }): Promise<void> {
    await nativeRequest(this.require(sessionId).rpc, 'command/exec/resize', params);
  }
  async nativeProcessTerminate(sessionId: string, params: { processId: string }): Promise<void> {
    await nativeRequest(this.require(sessionId).rpc, 'command/exec/terminate', params);
  }

  private require(sessionId: string): SessionRuntime {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) throw new Error('codex: 会话未创建');
    return runtime;
  }

  private nativeTurnId(params: Record<string, unknown>, runtime?: SessionRuntime): string | undefined {
    const fromParams = typeof params['turnId'] === 'string' ? params['turnId'] : undefined;
    const turn = params['turn'];
    const fromTurn = typeof turn === 'object' && turn !== null && typeof (turn as { id?: unknown }).id === 'string' ? String((turn as { id: string }).id) : undefined;
    const item = params['item'];
    const fromItem = typeof item === 'object' && item !== null && typeof (item as { turnId?: unknown }).turnId === 'string' ? String((item as { turnId: string }).turnId) : undefined;
    const raw = fromParams ?? fromTurn ?? fromItem;
    if (raw === undefined || runtime?.reviewRoots === undefined || runtime.reviewRoots.has(raw)) return raw;
    // Only an observed Review operation can make its execution turn an alias.
    // A general rootTurnId is provenance, not a turn identity substitution.
    for (const [root, review] of runtime?.reviewRoots ?? []) {
      if (raw !== undefined && review.executionTurnIds.has(raw)) return root;
    }
    return raw;
  }

  private rememberTurn(runtime: SessionRuntime, nativeTurnId: string): void {
    const turns = runtime.observedTurns ??= new Set<string>();
    turns.add(nativeTurnId);
    if (turns.size > 128) turns.delete(turns.values().next().value!);
  }

  private activeNativeTurnId(runtime: SessionRuntime): string | null {
    if (runtime.turnId === null) return null;
    const review = runtime.activeReviewRoot === runtime.turnId ? runtime.reviewRoots?.get(runtime.turnId) : undefined;
    return review?.executionTurnId ?? runtime.turnId;
  }

  private acceptReview(sessionId: string, runtime: SessionRuntime, value: unknown): void {
    validateNativeResult('review/start', value, runtime.nativeVersion);
    const accepted = value as ReviewStartResponse;
    if (accepted.reviewThreadId !== runtime.nativeId) throw Object.assign(new Error('原生 Review 接受结果属于其他会话，需核对'), { statusCode: 409, code: 'uncertain' });
    this.beginReview(sessionId, runtime, accepted, 'accepted');
  }

  private beginReview(sessionId: string, runtime: SessionRuntime, params: Record<string, unknown>, source: 'marker' | 'accepted' = 'marker'): void {
    const root = this.nativeTurnId(params);
    if (root === undefined) return;
    const reviews = runtime.reviewRoots ??= new Map();
    if (reviews.has(root)) return;
    const completed = runtime.completedTurns?.has(root) === true;
    reviews.set(root, { completed, executionTurnIds: new Set() });
    if (reviews.size > 1024) reviews.delete(reviews.keys().next().value!);
    // A same-thread native mode marker proves that the root operation began,
    // even before its separate execution turn emits turn/started.
    if (completed || source === 'accepted' && runtime.turnId !== null && runtime.turnId !== root) return;
    if (runtime.turnId === root) { runtime.activeReviewRoot = root; return; }
    runtime.turnId = root; runtime.activeReviewRoot = root;
    runtime.turnStartedAt = this.now(); this.rememberTurn(runtime, root);
    this.emit(sessionId, { type: 'turn.start', nativeTurnId: root, native: params });
  }

  // ---------- 通知 ----------

  private observeSubagent(sessionId: string, runtime: SessionRuntime, frame: Frame): void {
    const params = (frame['params'] ?? {}) as Record<string, unknown>;
    const thread = (params['thread'] ?? {}) as Record<string, unknown>;
    const item = (params['item'] ?? {}) as Record<string, unknown>;
    const source = thread['source'] as { subAgent?: { thread_spawn?: { parent_thread_id?: string; agent_path?: string } } } | undefined;
    const spawn = source?.subAgent?.thread_spawn;
    const actor = typeof params['threadId'] === 'string' ? params['threadId'] : typeof thread['id'] === 'string' ? thread['id'] : undefined;
    const children = runtime.subagents ??= new Map();
    const ownsActor = actor === runtime.nativeId || actor !== undefined && children.has(actor);
    const publish = (child: CodexSubagentIdentity, output?: unknown, snapshot?: CodexSubagentSnapshot): void => {
      children.set(child.childId, child);
      const itemKey = snapshot === undefined ? `codex-subagent-${child.childId}`
        : `codex-subagent-collab-${JSON.stringify([child.childId, snapshot.senderThreadId, snapshot.nativeTurnId ?? null, snapshot.callId, snapshot.callStatus])}`;
      // A persisted progress chunk is not an immutable native item completion.
      const outputInProgress = output !== null && typeof output === 'object'
        && ['resultStart', 'resultDelta', 'commandStart', 'commandDelta'].some(key => Object.hasOwn(output, key));
      this.emit(sessionId, { type: 'item.complete', kind: 'tool.call', itemKey, scope: 'session',
        ...(snapshot?.nativeTurnId === undefined ? {} : { nativeTurnId: snapshot.nativeTurnId }),
        data: { name: 'subagent', label: child.agentPath ?? child.childId, input: { ...child },
          status: outputInProgress ? 'running' : child.nativeStatus === 'failed' || child.nativeStatus === 'errored' || child.nativeStatus === 'interrupted' ? 'failed'
            : child.nativeStatus === 'completed' ? 'completed' : child.nativeStatus === 'shutdown' ? 'stopped'
              : child.nativeStatus === 'pendingInit' ? 'pending' : child.nativeStatus === 'running' || child.nativeStatus === 'waiting' ? 'running' : 'unknown',
          ...(output === undefined ? {} : { output }) }, native: frame });
    };
    if (frame['method'] === 'thread/started' && actor !== undefined && actor !== runtime.nativeId) {
      const parent = typeof thread['parentThreadId'] === 'string' ? thread['parentThreadId'] : spawn?.parent_thread_id;
      if (parent === runtime.nativeId || parent !== undefined && children.has(parent)) publish({
        ...children.get(actor), agent: 'codex', childId: actor, parentThreadId: parent, nativeStatus: children.get(actor)?.nativeStatus ?? 'unknown',
        ...(typeof spawn?.agent_path === 'string' ? { agentPath: spawn.agent_path } : {}),
        ...(typeof thread['model'] === 'string' ? { model: thread['model'] } : {}),
        ...(typeof thread['cliVersion'] === 'string' ? { nativeVersion: thread['cliVersion'] } : {}),
        ...(typeof thread['path'] === 'string' ? { rolloutPath: thread['path'] } : {}),
      });
    }
    if (ownsActor && item['type'] === 'subAgentActivity' && typeof item['agentThreadId'] === 'string' && item['agentThreadId'] !== runtime.nativeId) {
      const id = item['agentThreadId'];
      const previous = children.get(id);
      // Interacting with an ancestor or peer does not create a parent relation.
      if (item['kind'] === 'started' || previous !== undefined) publish({
        ...previous, agent: 'codex', childId: id, parentThreadId: previous?.parentThreadId ?? actor!,
        nativeStatus: previous?.nativeStatus ?? (item['kind'] === 'completed' ? 'completed' : 'unknown'),
        ...(typeof item['agentPath'] === 'string' ? { agentPath: item['agentPath'] } : {}),
        ...(typeof item['model'] === 'string' ? { model: item['model'] } : {}),
      });
    }
    const collab = ownsActor && actor !== undefined && item['type'] === 'collabAgentToolCall' && item['senderThreadId'] === actor
      && typeof item['id'] === 'string' && typeof item['tool'] === 'string';
    if (collab && item['tool'] === 'spawnAgent' && Array.isArray(item['receiverThreadIds'])) {
      for (const id of item['receiverThreadIds']) if (typeof id === 'string' && id !== runtime.nativeId && !children.has(id)) publish({
        agent: 'codex', childId: id, parentThreadId: actor!, nativeStatus: 'unknown',
        ...(typeof item['model'] === 'string' ? { model: item['model'] } : {}),
      });
    }
    if (collab) {
      const origin = { callId: item['id'] as string, senderThreadId: actor!, nativeTurnId: this.nativeTurnId(params) };
      const key = codexSubagentSnapshotKey(origin);
      const calls = runtime.collabCalls ??= new Map();
      const call = calls.get(key);
      if (frame['method'] === 'item/started' && !call?.completed && call?.startFrame === undefined) {
        calls.set(key, { startFrame: runtime.frameSeq, completed: false });
      } else if (frame['method'] === 'item/completed' && !call?.completed) {
        const callStatus = typeof item['status'] === 'string' ? item['status'] : 'unknown';
        const terminal = ['completed', 'failed', 'interrupted'].includes(callStatus);
        const states = item['agentsStates'];
        const direct = runtime.subagentStateFrames ??= new Map();
        const appliedStarts = runtime.subagentSnapshotStarts ??= new Map();
        if (states !== null && typeof states === 'object' && !Array.isArray(states)) for (const [id, value] of Object.entries(states)) {
          const child = children.get(id);
          if (child === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) continue;
          const state = value as { status?: unknown; message?: unknown };
          if (typeof state.status !== 'string' || state.message !== null && typeof state.message !== 'string') continue;
          // A caller snapshot has no child-turn revision. Keep it as evidence
          // when a direct state or a newer query superseded its starting point.
          const applied = terminal && NATIVE_COLLAB_TOOLS.has(item['tool'] as string) && NATIVE_COLLAB_STATES.has(state.status)
            && (call?.startFrame === undefined
              ? child.nativeStatus === 'unknown' && !direct.has(id) && !appliedStarts.has(id)
              : (direct.get(id) ?? -1) <= call.startFrame && (appliedStarts.get(id) ?? -1) <= call.startFrame);
          const snapshot: CodexSubagentSnapshot = { ...origin, tool: item['tool'] as string, callStatus,
            status: state.status, message: state.message, applied };
          if (applied) appliedStarts.set(id, call?.startFrame ?? runtime.frameSeq);
          publish(applied ? { ...child, nativeStatus: state.status } : child, { collabSnapshot: snapshot }, snapshot);
        }
        calls.set(key, { ...call, completed: terminal });
      }
    }
    if (actor === undefined || actor === runtime.nativeId) return;
    const turn = (params['turn'] ?? {}) as { id?: string; rootTurnId?: string; status?: string; error?: unknown };
    // rootTurnId identifies delegated root work, not the immediate parent.
    // Unknown lineage stays in the raw ledger until native supplies an edge.
    const child = children.get(actor);
    if (child === undefined) return;
    const nativeTurnId = this.nativeTurnId(params);
    const observed = runtime.subagentTurns ??= new Map();
    const knownTurns = observed.get(actor) ?? new Set<string>();
    observed.set(actor, knownTurns);
    const completedTurns = runtime.subagentTurnCompletions ??= new Set();
    const completedMessages = runtime.subagentMessageCompletions ??= new Set();
    const completedCommands = runtime.subagentCommandCompletions ??= new Set();
    if (frame['method'] === 'turn/started' && nativeTurnId !== undefined) {
      if (knownTurns.has(nativeTurnId)) return;
      knownTurns.add(nativeTurnId);
      (runtime.subagentStateFrames ??= new Map()).set(actor, runtime.frameSeq);
      publish({ ...child, nativeTurnId, ...(turn.rootTurnId === undefined ? {} : { rootTurnId: turn.rootTurnId }), nativeStatus: 'running' },
        { turn: { id: nativeTurnId, status: turn.status ?? 'inProgress' } });
    } else if (frame['method'] === 'turn/completed' && nativeTurnId !== undefined) {
      knownTurns.add(nativeTurnId);
      completedTurns.add(JSON.stringify([actor, nativeTurnId]));
      if (child.nativeTurnId === undefined || child.nativeTurnId === nativeTurnId) (runtime.subagentStateFrames ??= new Map()).set(actor, runtime.frameSeq);
      publish({ ...child, ...(child.nativeTurnId === undefined ? { nativeTurnId } : {}),
        ...(child.nativeTurnId === undefined || child.nativeTurnId === nativeTurnId ? { nativeStatus: turn.status ?? 'unknown' } : {}) },
        { turn: { id: nativeTurnId, status: turn.status ?? 'unknown', error: turn.error } });
    } else if (frame['method'] === 'thread/status/changed') {
      const status = params['status'] as { type?: string; activeFlags?: string[] } | undefined;
      if (status?.type === 'active') {
        (runtime.subagentStateFrames ??= new Map()).set(actor, runtime.frameSeq);
        publish({ ...child, nativeStatus: status.activeFlags?.length && status.activeFlags.every(flag => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput') ? 'waiting' : 'running' });
      }
      // Idle/systemError alone is not evidence of a successful/failed task.
    } else if (frame['method'] === 'item/agentMessage/delta' && nativeTurnId !== undefined && typeof params['itemId'] === 'string'
      && params['itemId'] !== '' && typeof params['delta'] === 'string') {
      if (completedTurns.has(JSON.stringify([actor, nativeTurnId])) || completedMessages.has(subagentMessageKey(actor, nativeTurnId, params['itemId']))) return;
      if (child.nativeTurnId === undefined || child.nativeTurnId === nativeTurnId) (runtime.subagentStateFrames ??= new Map()).set(actor, runtime.frameSeq);
      publish(child, { resultDelta: { nativeTurnId, itemId: params['itemId'], text: params['delta'] } });
    } else if ((frame['method'] === 'item/started' || frame['method'] === 'item/completed') && nativeTurnId !== undefined
      && item['type'] === 'agentMessage' && typeof item['id'] === 'string' && item['id'] !== '' && typeof item['text'] === 'string') {
      const key = subagentMessageKey(actor, nativeTurnId, item['id']);
      if (completedMessages.has(key)) return;
      const result = { nativeTurnId, itemId: item['id'], text: item['text'], nativePhase: item['phase'] };
      if (frame['method'] === 'item/started') {
        if (!completedTurns.has(JSON.stringify([actor, nativeTurnId]))) publish(child, { resultStart: result });
      } else {
        completedMessages.add(key);
        publish(child, { result });
      }
    } else if (frame['method'] === 'item/commandExecution/outputDelta' && nativeTurnId !== undefined && nativeTurnId !== '' && typeof params['itemId'] === 'string'
      && params['itemId'] !== '' && typeof params['delta'] === 'string') {
      if (completedTurns.has(JSON.stringify([actor, nativeTurnId])) || completedCommands.has(subagentCommandKey(actor, nativeTurnId, params['itemId']))) return;
      if (child.nativeTurnId === undefined || child.nativeTurnId === nativeTurnId) (runtime.subagentStateFrames ??= new Map()).set(actor, runtime.frameSeq);
      publish(child, { commandDelta: { nativeTurnId, itemId: params['itemId'], text: params['delta'] } });
    } else if ((frame['method'] === 'item/started' || frame['method'] === 'item/completed') && nativeTurnId !== undefined && nativeTurnId !== '' && validCodexCommandItem(item)) {
      const id = item['id'] as string; const key = subagentCommandKey(actor, nativeTurnId, id);
      if (completedCommands.has(key)) return;
      if (frame['method'] === 'item/started' && completedTurns.has(JSON.stringify([actor, nativeTurnId]))) return;
      if (child.nativeTurnId === undefined || child.nativeTurnId === nativeTurnId) (runtime.subagentStateFrames ??= new Map()).set(actor, runtime.frameSeq);
      const command = { nativeTurnId, itemId: id, native: item };
      if (frame['method'] === 'item/started') publish(child, { commandStart: command });
      else { completedCommands.add(key); publish(child, { command }); }
    }
  }

  private onNotification(sessionId: string, frame: Frame): void {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return;
    const method = String(frame['method'] ?? '');
    const params = (frame['params'] ?? {}) as Record<string, unknown>;
    const route = routeNotification(method);
    runtime.frameSeq += 1;
    const frameKey = `${method.replace(/[^a-zA-Z0-9]+/g, '-')}-${runtime.frameSeq}`;

    this.observeSubagent(sessionId, runtime, frame);
    const thread = (params['thread'] ?? {}) as { id?: unknown };
    const nativeThreadId = params['threadId'] ?? params['conversationId'] ?? thread.id;
    const resolvesRequest = route === 'serverRequest/resolved' && [...runtime.approvals.values()].some(pending =>
      pending.requestId === params['requestId'] && (pending.nativeThreadId ?? runtime.nativeId) === nativeThreadId);
    if (runtime.nativeId !== '' && typeof nativeThreadId === 'string' && nativeThreadId !== runtime.nativeId && !resolvesRequest) {
      // Keep every notification in the native ledger without admitting child
      // turns, answers, errors, goals or settings into the parent runtime.
      this.emit(sessionId, { type: 'item.complete', itemKey: `foreign-${frameKey}`, kind: 'internal',
        data: { nativeType: method }, scope: 'session', native: frame });
      return;
    }

    switch (route) {
      case 'thread/status': {
        if (params['threadId'] !== runtime.nativeId) return;
        const observed = params['status'] as { type?: unknown; activeFlags?: unknown } | null;
        let status: 'running' | 'waiting' | 'idle' | 'error' | undefined;
        if (observed?.type === 'idle') status = 'idle';
        else if (observed?.type === 'systemError') status = 'error';
        else if (observed?.type === 'active' && Array.isArray(observed.activeFlags) && observed.activeFlags.every(flag => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput')) status = observed.activeFlags.length > 0 ? 'waiting' : 'running';
        if (status !== undefined) this.emit(sessionId, { type: 'status', source: 'native-thread', status, scope: 'session', native: frame });
        else this.emit(sessionId, { type: 'item.complete', itemKey: frameKey, kind: 'internal', data: { nativeType: method }, scope: 'session', native: frame });
        return;
      }
      case 'serverRequest/resolved': {
        if (typeof params['requestId'] !== 'string' && typeof params['requestId'] !== 'number') return;
        const entry = [...runtime.approvals].find(([, pending]) => pending.requestId === params['requestId']
          && (pending.nativeThreadId ?? runtime.nativeId) === params['threadId']);
        if (entry === undefined) return;
        const [approvalId, pending] = entry;
        runtime.approvals.delete(approvalId);
        if (pending.kind === 'userInput' || pending.kind === 'elicitation') {
          for (const question of pending.questions ?? []) this.emit(sessionId, {
            type: 'item.complete', itemKey: `question-resolved-${question.questionId}`, kind: 'question',
            nativeTurnId: pending.nativeTurnId,
            ...(pending.sessionScoped ? { scope: 'session' as const } : {}),
            data: { ...question, status: pending.submitted && pending.outcome !== 'cancel' && pending.outcome !== 'decline' ? 'answered' : 'skipped',
              resolution: pending.submitted ? 'native-acknowledged' : 'external', ...(pending.outcome === undefined ? {} : { outcome: pending.outcome }) }, native: frame,
          });
        } else this.emit(sessionId, {
          type: 'item.complete', itemKey: `approval-${approvalId}`, kind: 'approval.resolved',
          nativeTurnId: pending.nativeTurnId,
          ...(pending.sessionScoped ? { scope: 'session' as const } : {}),
          data: { approvalId, optionId: pending.decision ?? 'resolved-externally', by: pending.submitted ? 'user' : 'other' }, native: frame,
        });
        return;
      }
      case 'turn/started': {
        let nativeTurnId = this.nativeTurnId(params);
        const turn = params['turn'] as { rootTurnId?: unknown } | undefined;
        const provenance = typeof turn?.rootTurnId === 'string' ? turn.rootTurnId : undefined;
        const candidate = provenance === undefined ? undefined : runtime.reviewRoots?.get(provenance);
        const root = nativeTurnId !== undefined && runtime.reviewRoots?.has(nativeTurnId) ? nativeTurnId
          : candidate !== undefined && (!candidate.completed || nativeTurnId !== undefined && candidate.executionTurnIds.has(nativeTurnId)) ? provenance : undefined;
        const review = root === undefined ? undefined : runtime.reviewRoots?.get(root);
        if (review !== undefined) {
          if (review.completed || runtime.turnId !== root) {
            this.emit(sessionId, { type: 'item.complete', itemKey: 'late-review-start-' + frameKey, kind: 'internal',
              data: { nativeType: method }, native: params, scope: 'session' });
            return;
          }
          review.executionTurnId = nativeTurnId;
          if (nativeTurnId !== undefined) review.executionTurnIds.add(nativeTurnId);
          nativeTurnId = root; runtime.activeReviewRoot = root;
        } else runtime.activeReviewRoot = undefined;
        if (nativeTurnId !== undefined) {
          if (nativeTurnId !== runtime.turnId) runtime.generationStartedAt = null;
          runtime.turnId = nativeTurnId;
          this.rememberTurn(runtime, nativeTurnId);
          runtime.turnStartedAt = this.now();
        }
        this.emit(sessionId, { type: 'turn.start', nativeTurnId, native: params });
        return;
      }
      case 'turn/completed': {
        const turn = (params['turn'] ?? {}) as { id?: string; status?: string };
        const nativeTurnId = turn.id ?? this.nativeTurnId(params) ?? runtime.turnId;
        const root = this.nativeTurnId(params, runtime);
        if (root !== undefined && nativeTurnId !== root && runtime.reviewRoots?.has(root)) {
          // Native Review suppresses execution completion and closes its root
          // operation separately. Keep any execution terminal as evidence.
          this.emit(sessionId, { type: 'item.complete', itemKey: 'review-execution-end-' + frameKey, kind: 'internal',
            data: { nativeType: method }, native: params, scope: 'session' });
          return;
        }
        if (nativeTurnId != null) {
          const completed = runtime.completedTurns ??= new Set();
          completed.add(nativeTurnId);
          if (completed.size > 1024) completed.delete(completed.values().next().value!);
        }
        if (nativeTurnId != null && runtime.reviewRoots?.has(nativeTurnId)) {
          runtime.reviewRoots.get(nativeTurnId)!.completed = true;
          if (runtime.activeReviewRoot === nativeTurnId) runtime.activeReviewRoot = undefined;
        }
        const usage = (params['usage'] ?? undefined) as { inputTokens?: number; outputTokens?: number } | undefined;
        const generationMs = endGeneration(runtime, nativeTurnId ?? undefined, this.now());
        for (const [key, summary] of runtime.reasoningSummaries ?? []) {
          if (summary.nativeTurnId === nativeTurnId && summary.content?.size) {
            this.emit(sessionId, { type: 'item.complete', itemKey: (JSON.parse(key) as [unknown, string])[1], kind: 'reasoning',
              nativeTurnId: nativeTurnId ?? undefined, data: { ...reasoningData(summary), incomplete: true }, native: params });
            completeReasoning(runtime, key);
          }
        }
        if (nativeTurnId != null) for (const event of (runtime.plans ??= new CodexPlanStreams()).endTurn(nativeTurnId)) {
          this.emit(sessionId, { ...event, native: params });
        }
        this.emit(sessionId, {
          type: 'turn.end',
          nativeTurnId: nativeTurnId ?? undefined,
          status: turn.status === 'interrupted' ? 'interrupted' : turn.status === 'failed' ? 'failed' : 'completed',
          ...(usage === undefined ? {} : { usage: { ...usage, scope: 'turn' as const, ...(generationMs === undefined ? {} : { generationMs }) } }),
          native: params,
        });
        if (runtime.turnId === nativeTurnId) runtime.turnId = null;
        for (const key of runtime.started) {
          if ((JSON.parse(key) as [string | null, string])[0] === nativeTurnId) runtime.started.delete(key);
        }
        for (const [key, summary] of runtime.reasoningSummaries ?? []) {
          if (summary.nativeTurnId === nativeTurnId) completeReasoning(runtime, key);
        }
        return;
      }
      case 'item/started': {
        const item = (params['item'] ?? {}) as Record<string, unknown>;
        const itemId = String(item['id'] ?? `item-${frameKey}`);
        const type = String(item['type'] ?? '');
        if (type === 'enteredReviewMode') this.beginReview(sessionId, runtime, params);
        if (type === 'plan' && typeof item['text'] === 'string') {
          for (const event of (runtime.plans ??= new CodexPlanStreams()).start(itemId, this.nativeTurnId(params, runtime) ?? runtime.turnId ?? undefined, item['text'])) {
            this.emit(sessionId, { ...event, native: item });
          }
          return;
        }
        if (type === 'agentMessage' || type === 'reasoning' || type === 'reasoningSummary') beginGeneration(runtime, this.nativeTurnId(params, runtime), this.now());
        if (type === 'agentMessage') runtime.started.add(JSON.stringify([this.nativeTurnId(params, runtime) ?? runtime.turnId, itemId]));
        const kind = mapItemKind(type);
        if (kind === 'internal') return;
        let data = mapItemData(item, 'started');
        if (type === 'reasoning') {
          const nativeTurnId = this.nativeTurnId(params, runtime) ?? runtime.turnId;
          const key = JSON.stringify([nativeTurnId, itemId]);
          if (runtime.completedReasoning?.has(key)) return;
          const summaries = runtime.reasoningSummaries ??= new Map();
          const summary = summaries.get(key) ?? {
            nativeTurnId, started: false, parts: new Map(
              (Array.isArray(item['summary']) ? item['summary'] : []).flatMap((part, index) => typeof part === 'string' ? [[index, part] as const] : [])),
          };
          summaries.set(key, summary);
          summary.started = true;
          for (const [index, text] of (Array.isArray(item['summary']) ? item['summary'] : []).entries()) {
            if (typeof text === 'string' && !summary.parts.has(index)) summary.parts.set(index, text);
          }
          const content = summary.content ??= new Map();
          for (const [index, text] of (Array.isArray(item['content']) ? item['content'] : []).entries()) {
            if (typeof text === 'string' && !content.has(index)) content.set(index, text);
          }
          data = reasoningData(summary);
        }
        this.emit(sessionId, {
          type: 'item.start',
          itemKey: itemId,
          kind,
          data,
          nativeTurnId: this.nativeTurnId(params, runtime),
          native: item,
        });
        return;
      }
      case 'item/completed': {
        const item = (params['item'] ?? {}) as Record<string, unknown>;
        const itemId = String(item['id'] ?? `item-${frameKey}`);
        const type = String(item['type'] ?? '');
        if (type === 'enteredReviewMode') this.beginReview(sessionId, runtime, params);
        if (type === 'plan' && typeof item['text'] === 'string') {
          for (const event of (runtime.plans ??= new CodexPlanStreams()).complete(itemId, this.nativeTurnId(params, runtime) ?? runtime.turnId ?? undefined, item['text'])) {
            this.emit(sessionId, { ...event, native: item });
          }
          return;
        }
        if (type === 'userMessage') {
          const { text, replies } = nativeAsyncReplies(item);
          for (const reply of replies) (runtime.asyncAnswered ??= new Set()).add(reply.questionItemId);
          this.emit(sessionId, { type: 'item.complete', itemKey: itemId, kind: 'user.message', nativeTurnId: this.nativeTurnId(params, runtime), native: item,
            data: { text, ...(typeof item['clientId'] === 'string' ? { clientCommandId: item['clientId'] } : {}) } });
          return;
        }
        for (const question of codexAsyncQuestions(item, runtime.nativeId)) {
          if (runtime.asyncAnswered?.has(question.questionId) || runtime.asyncQuestions?.has(question.questionId)) continue;
          (runtime.asyncQuestions ??= new Map()).set(question.questionId, question);
          this.emit(sessionId, { type: 'item.complete', itemKey: `question-${question.questionId}`, kind: 'question', data: question, native: item, scope: 'session', nativeTurnId: this.nativeTurnId(params, runtime) });
        }
        if (type === 'agentMessage') runtime.lastAssistantText = String(item['text'] ?? '');
        const kind = mapItemKind(type);
        if (kind === 'internal') {
          this.emit(sessionId, {
            type: 'item.complete',
            itemKey: `internal-${itemId}`,
            kind: 'internal',
            data: { nativeType: type === '' ? 'item' : type },
            native: item,
            nativeTurnId: this.nativeTurnId(params, runtime),
          });
          return;
        }
        let data = mapItemData(item, 'completed');
        if (type === 'reasoning') {
          const key = JSON.stringify([this.nativeTurnId(params, runtime) ?? runtime.turnId, itemId]);
          const pending = runtime.reasoningSummaries?.get(key);
          if (pending?.content?.size && (!Array.isArray(item['content']) || item['content'].length === 0)) {
            data = { ...(data as EventData['reasoning']), nativeContent: reasoningData(pending).nativeContent, incomplete: true };
          }
          completeReasoning(runtime, key);
        }
        // 路径统一成相对工作区（改动卡片与 diff 标签都用相对路径）
        if (kind === 'file.change') {
          const changeData = data as EventData['file.change'];
          changeData.changes = changeData.changes.map((change) => ({
            ...change,
            path: change.path.startsWith(runtime.cwd) ? change.path.slice(runtime.cwd.length).replace(/^\/+/, '') : change.path,
          }));
        }
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: itemId,
          kind,
          data,
          native: item,
          nativeTurnId: this.nativeTurnId(params, runtime),
        });
        return;
      }
      case 'agentMessage/delta': {
        beginGeneration(runtime, this.nativeTurnId(params, runtime), this.now());
        const itemId = String(params['itemId'] ?? '');
        const nativeTurnId = this.nativeTurnId(params, runtime) ?? runtime.turnId ?? undefined;
        const key = JSON.stringify([nativeTurnId ?? null, itemId]);
        if (!runtime.started.has(key)) {
          runtime.started.add(key);
          this.emit(sessionId, { type: 'item.start', itemKey: itemId, kind: 'assistant.message', data: { text: '' }, nativeTurnId });
        }
        this.emit(sessionId, { type: 'item.delta', itemKey: itemId, field: 'text', append: String(params['delta'] ?? ''), nativeTurnId });
        return;
      }
      case 'reasoning/summaryTextDelta':
      case 'reasoning/textDelta': {
        const itemId = String(params['itemId'] ?? '');
        const nativeTurnId = this.nativeTurnId(params, runtime) ?? runtime.turnId;
        const key = JSON.stringify([nativeTurnId, itemId]);
        if (runtime.completedReasoning?.has(key)) return;
        const body = route === 'reasoning/textDelta';
        const index = body ? params['contentIndex'] : params['summaryIndex'] ?? 0;
        if (!Number.isSafeInteger(index) || Number(index) < 0) {
          this.emit(sessionId, { type: 'item.complete', itemKey: `invalid-reasoning-index-${frameKey}`, kind: 'unknown',
            data: { nativeType: method }, native: params, nativeTurnId: nativeTurnId ?? undefined });
          return;
        }
        beginGeneration(runtime, nativeTurnId ?? undefined, this.now());
        const summaries = runtime.reasoningSummaries ??= new Map();
        const summary = summaries.get(key) ?? { nativeTurnId, started: false, parts: new Map<number, string>() };
        summaries.set(key, summary);
        const parts = body ? summary.content ??= new Map<number, string>() : summary.parts;
        parts.set(Number(index), `${parts.get(Number(index)) ?? ''}${String(params['delta'] ?? '')}`);
        if (!summary.started) {
          summary.started = true;
          this.emit(sessionId, { type: 'item.start', itemKey: itemId, kind: 'reasoning', data: { text: '' }, nativeTurnId: nativeTurnId ?? undefined });
        }
        this.emit(sessionId, { type: 'item.update', itemKey: itemId, nativeTurnId: nativeTurnId ?? undefined, data: reasoningData(summary) });
        return;
      }
      case 'reasoning/summaryPartAdded': {
        const itemId = String(params['itemId'] ?? '');
        const nativeTurnId = this.nativeTurnId(params, runtime) ?? runtime.turnId;
        const key = JSON.stringify([nativeTurnId, itemId]);
        const index = params['summaryIndex'] ?? 0;
        if (!Number.isSafeInteger(index) || Number(index) < 0) {
          this.emit(sessionId, { type: 'item.complete', itemKey: `invalid-reasoning-index-${frameKey}`, kind: 'unknown',
            data: { nativeType: method }, native: params, nativeTurnId: nativeTurnId ?? undefined });
          return;
        }
        if (!runtime.completedReasoning?.has(key)) {
          const summaries = runtime.reasoningSummaries ??= new Map();
          const summary = summaries.get(key) ?? { nativeTurnId, started: false, parts: new Map<number, string>() };
          summaries.set(key, summary);
          if (!summary.parts.has(Number(index))) summary.parts.set(Number(index), '');
          if (summary.started) this.emit(sessionId, { type: 'item.update', itemKey: itemId, nativeTurnId: nativeTurnId ?? undefined,
            data: reasoningData(summary) });
        }
        // 已知通知：并入 reasoning，不算 unknown（F12）
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: `internal-reasoning-part-${String(params['itemId'] ?? '')}-${String(params['summaryIndex'] ?? 0)}`,
          kind: 'internal',
          data: { nativeType: method },
          native: params,
          nativeTurnId: nativeTurnId ?? undefined,
        });
        return;
      }
      case 'commandExecution/outputDelta': {
        this.emit(sessionId, { type: 'item.delta', itemKey: String(params['itemId'] ?? ''), field: 'output', append: String(params['delta'] ?? ''), nativeTurnId: this.nativeTurnId(params, runtime) });
        return;
      }
      case 'tokenUsage': {
        const tokenUsage = (params['tokenUsage'] ?? {}) as { total?: Record<string, number>; last?: Record<string, number> };
        const currentTurn = tokenUsage.last ?? tokenUsage.total ?? {};
        const inputTokens = Number(currentTurn['inputTokens'] ?? 0);
        const outputTokens = Number(currentTurn['outputTokens'] ?? 0);
        if (inputTokens === 0 && outputTokens === 0) return;
        const generationMs = endGeneration(runtime, this.nativeTurnId(params, runtime), this.now());
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: `usage-${frameKey}`,
          kind: 'usage',
          data: { inputTokens, outputTokens, cacheReadInputTokens: currentTurn['cachedInputTokens'], cacheCreationInputTokens: currentTurn['cacheWriteInputTokens'], reasoningOutputTokens: currentTurn['reasoningOutputTokens'], ...(generationMs === undefined ? { scope: 'turn' as const } : { scope: 'attempt' as const, generationMs }) },
          native: params,
        });
        return;
      }
      case 'title': {
        const title = String(params['name'] ?? params['title'] ?? '');
        if (title !== '') this.options.onTitle?.(sessionId, title);
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: `internal-title-${frameKey}`,
          kind: 'internal',
          data: { nativeType: 'thread/name/updated', ...(title === '' ? {} : { title }) },
          native: params,
        });
        return;
      }
      case 'error': {
        const message = (params['message'] ?? params['error'] ?? '未知错误') as unknown;
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: `error-${frameKey}`,
          kind: 'error',
          data: { message: typeof message === 'string' ? message : JSON.stringify(message) },
          native: params,
        });
        return;
      }
      case 'goal/updated': {
        const goal = (params['goal'] ?? {}) as { threadId?: string; createdAt?: number; updatedAt?: number; objective?: string; status?: string; tokensUsed?: number; tokenBudget?: number | null; timeUsedSeconds?: number };
        if (typeof goal.createdAt === 'number' && typeof goal.updatedAt === 'number') {
          if (runtime.goalVersion?.createdAt === goal.createdAt && runtime.goalVersion.updatedAt > goal.updatedAt) {
            this.emit(sessionId, { type: 'item.complete', itemKey: `outdated-goal-${frameKey}`, kind: 'internal', data: { nativeType: 'thread/goal/updated' }, native: params });
            return;
          }
          runtime.goalVersion = { createdAt: goal.createdAt, updatedAt: goal.updatedAt };
        }
        runtime.goalObservation = (runtime.goalObservation ?? 0) + 1;
        const status = goal.status === 'complete' || goal.status === 'completed' ? 'completed'
          : goal.status === 'active' || goal.status === 'paused' || goal.status === 'blocked' || goal.status === 'usageLimited' || goal.status === 'budgetLimited' ? goal.status : 'unknown';
        runtime.goalId = `${goal.threadId ?? runtime.nativeId}:${goal.createdAt ?? 'legacy'}`;
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: `goal-${runtime.nativeId}`,
          kind: 'goal',
          ...(params['turnId'] === null ? { scope: 'session' as const } : {}),
          ...(typeof params['turnId'] === 'string' ? { nativeTurnId: params['turnId'] } : {}),
          data: {
            objective: String(goal.objective ?? ''),
            status,
            goalId: runtime.goalId,
            ...(goal.status === undefined ? {} : { nativeStatus: goal.status }),
            ...(typeof goal.tokensUsed === 'number' ? { tokensUsed: goal.tokensUsed } : {}),
            ...(goal.tokenBudget === null || typeof goal.tokenBudget === 'number' ? { tokenBudget: goal.tokenBudget } : {}),
            ...(typeof goal.timeUsedSeconds === 'number' ? { timeUsedSeconds: goal.timeUsedSeconds } : {}),
          },
          native: params,
        });
        return;
      }
      case 'goal/cleared': {
        runtime.goalObservation = (runtime.goalObservation ?? 0) + 1;
        runtime.goalVersion = undefined;
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: `goal-${runtime.nativeId}`,
          kind: 'goal',
          scope: 'session',
          data: { objective: '', status: 'cleared', goalId: runtime.goalId ?? `${runtime.nativeId}:legacy` },
          native: params,
        });
        return;
      }
      case 'plan/updated': {
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: `plan-${frameKey}`,
          kind: 'plan',
          data: { items: mapPlanItems(params) },
          native: params,
        });
        return;
      }
      case 'plan/delta': {
        if (typeof params['turnId'] !== 'string' || typeof params['itemId'] !== 'string' || typeof params['delta'] !== 'string') {
          this.emit(sessionId, { type: 'item.complete', itemKey: 'invalid-plan-' + frameKey, kind: 'unknown',
            data: { nativeType: method }, native: params, nativeTurnId: this.nativeTurnId(params) });
          return;
        }
        for (const event of (runtime.plans ??= new CodexPlanStreams()).delta(params['itemId'], this.nativeTurnId(params, runtime) ?? params['turnId'], params['delta'])) this.emit(sessionId, event);
        return;
      }
      case 'plan/item': {
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: `plan-item-${String(params['itemId'] ?? frameKey)}-${frameKey}`,
          kind: 'plan',
          data: { items: mapPlanItems(params) },
          native: params,
        });
        return;
      }
      case 'diff/updated': {
        const diff = String(params['diff'] ?? '');
        const changes = parseUnifiedDiff(diff).map((change) => ({
          path: change.path,
          kind: change.kind,
          added: change.added,
          removed: change.removed,
          diff: change.diff,
        }));
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: `diff-${String(params['turnId'] ?? runtime.turnId ?? frameKey)}`,
          kind: 'turn.diff',
          data: { changes, status: 'completed' },
          native: params,
          nativeTurnId: this.nativeTurnId(params, runtime),
        });
        return;
      }
      case 'notice': {
        const text = String(params['summary'] ?? params['message'] ?? params['details'] ?? method);
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: `notice-${method}-${frameKey}`,
          kind: 'notice',
          data: { level: method === 'warning' ? 'warning' : 'info', text, nativeType: method },
          native: params,
        });
        return;
      }
      case 'internal': {
        if (method === 'thread/settings/updated' && params['threadId'] === runtime.nativeId) {
          try {
            const { threadSettings } = nativeSettingsNotification(params, runtime.nativeVersion);
            this.observeMode(runtime, { model: threadSettings.model, reasoningEffort: threadSettings.effort, collaborationMode: threadSettings.collaborationMode });
          } catch { /* Keep malformed observations in the native ledger without claiming a mode. */ }
        }
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: `internal-${method}-${frameKey}`,
          kind: 'internal',
          data: { nativeType: method },
          native: params,
        });
        return;
      }
      default: {
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: `unknown-${method}-${frameKey}`,
          kind: 'unknown',
          data: { nativeType: method },
          native: params,
        });
      }
    }
  }

  // ---------- 服务端反向请求（审批 / 提问） ----------

  private requestChild(runtime: SessionRuntime, threadId: unknown): CodexSubagentIdentity | undefined {
    if (threadId === undefined || threadId === runtime.nativeId) return undefined;
    const child = typeof threadId === 'string' ? runtime.subagents?.get(threadId) : undefined;
    if (child === undefined) throw Object.assign(new Error('Reverse request belongs to another native thread'), { code: -32602 });
    return child;
  }

  private onServerRequest(sessionId: string, frame: Frame): unknown {
    const runtime = this.sessions.get(sessionId);
    const method = String(frame['method'] ?? '');
    const id = frame['id'];
    if (typeof id !== 'string' && typeof id !== 'number') throw Object.assign(new Error('Invalid native request ID'), { code: -32600 });
    if (runtime !== undefined && (method === 'mcpServer/elicitation/request' || method === 'item/permissions/requestApproval')) {
      validateNativeServerParams(method, frame['params'], runtime.nativeVersion);
      const params = frame['params'] as McpServerElicitationRequestParams | PermissionsRequestApprovalParams;
      const child = this.requestChild(runtime, params.threadId);
      const approvalId = `${runtime.processToken}:${typeof id}:${id}`;
      if (runtime.approvals.has(approvalId)) return undefined;
      if (method === 'item/permissions/requestApproval') {
        const permission = params as PermissionsRequestApprovalParams;
        runtime.approvals.set(approvalId, { requestId: id, nativeThreadId: params.threadId, sessionScoped: child !== undefined,
          kind: 'permissions', permissions: permission.permissions, nativeTurnId: permission.turnId });
        this.emit(sessionId, { type: 'item.complete', itemKey: `approval-${approvalId}`, kind: 'approval.request', nativeTurnId: permission.turnId, native: frame,
          ...(child === undefined ? {} : { scope: 'session' as const }),
          data: { approvalId, title: child === undefined ? '原生额外权限' : `子 Agent ${child.agentPath ?? child.childId} · 原生额外权限`, tool: 'request_permissions', reason: permission.reason ?? undefined,
            detail: JSON.stringify({ cwd: permission.cwd, environmentId: permission.environmentId, permissions: permission.permissions }, null, 2),
            options: [{ id: 'grant-turn', label: '仅本轮允许' }, { id: 'grant-session', label: '本会话允许' }, { id: 'deny-permissions', label: '拒绝额外权限' }] } });
      } else {
        const elicitation = params as McpServerElicitationRequestParams;
        const question: EventData['question'] = { questionId: `${approvalId}:elicitation`, groupId: approvalId, prompt: elicitation.message,
          header: `${child === undefined ? '' : `子 Agent ${child.agentPath ?? child.childId} · `}MCP · ${elicitation.serverName}`, allowsFreeText: false, isSecret: elicitation.mode !== 'url' && schemaHasSecrets(elicitation.requestedSchema),
          elicitation: elicitation.mode === 'url' ? { kind: 'url', serverName: elicitation.serverName, url: elicitation.url, elicitationId: elicitation.elicitationId }
            : { kind: 'form', serverName: elicitation.serverName, schema: elicitation.requestedSchema as Record<string, unknown> } };
        runtime.approvals.set(approvalId, { requestId: id, nativeThreadId: params.threadId, kind: 'elicitation', elicitation, questionIds: ['elicitation'], questions: [question], sessionScoped: child !== undefined || elicitation.turnId === null, nativeTurnId: elicitation.turnId ?? undefined });
        this.emit(sessionId, { type: 'item.complete', itemKey: `question-${approvalId}`, kind: 'question', data: question, native: frame,
          ...(child !== undefined || elicitation.turnId === null ? { scope: 'session' as const } : {}),
          ...(elicitation.turnId === null ? {} : { nativeTurnId: elicitation.turnId }) });
      }
      return undefined;
    }
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'execCommandApproval', 'applyPatchApproval', 'item/tool/requestUserInput'].includes(method)) {
      this.emit(sessionId, { type: 'item.complete', itemKey: `unsupported-${String(id)}`, kind: 'unknown', data: { nativeType: method }, native: frame });
      throw Object.assign(new Error(`Unsupported native request: ${method}`), { code: -32601 });
    }
    const params = (frame['params'] ?? {}) as Record<string, unknown>;
    const nativeThreadId = params['threadId'] === undefined ? params['conversationId'] : params['threadId'];
    const child = runtime === undefined ? undefined : this.requestChild(runtime, nativeThreadId);

    const options = ((): { id: string; label: string }[] => {
      switch (method) {
        case 'item/commandExecution/requestApproval':
        case 'item/fileChange/requestApproval':
          return [
            { id: 'accept', label: '允许一次' },
            { id: 'acceptForSession', label: '本会话都允许' },
            { id: 'decline', label: '拒绝' },
          ];
        case 'execCommandApproval':
        case 'applyPatchApproval':
          return [
            { id: 'accept', label: '允许一次' },
            { id: 'acceptForSession', label: '本会话都允许' },
            { id: 'decline', label: '拒绝' },
          ];
        case 'item/tool/requestUserInput':
          return [{ id: 'answer', label: '回答' }];
        default:
          return [{ id: 'accept', label: '允许' }];
      }
    })();

    const kind: PendingApproval['kind'] =
      method === 'item/commandExecution/requestApproval'
        ? 'commandExecution'
        : method === 'item/fileChange/requestApproval'
          ? 'fileChange'
          : method === 'execCommandApproval'
            ? 'legacyExec'
            : method === 'applyPatchApproval'
              ? 'legacyPatch'
              : 'userInput';

    const approvalId = `${runtime?.processToken ?? 'p'}:${typeof id}:${id}`;
    if (runtime?.approvals.has(approvalId)) return undefined;
    runtime?.approvals.set(approvalId, { requestId: id, nativeThreadId: typeof nativeThreadId === 'string' ? nativeThreadId : runtime.nativeId,
      sessionScoped: child !== undefined, kind, nativeTurnId: this.nativeTurnId(params, child === undefined ? runtime : undefined) });
    if (kind === 'userInput' && Array.isArray(params['questions'])) {
      const questions = params['questions'] as { id: string; question?: string; header?: string; options?: { label: string; description?: string }[] | null; isOther?: boolean; isSecret?: boolean }[];
      const items = questions.map(question => ({ questionId: `${approvalId}:${question.id}`, groupId: approvalId, prompt: question.question ?? '请回答',
        header: child === undefined ? question.header : `子 Agent ${child.agentPath ?? child.childId}${question.header === undefined ? '' : ` · ${question.header}`}`, isSecret: question.isSecret === true,
        ...(typeof params['isBlocking'] === 'boolean' ? { isBlocking: params['isBlocking'] } : {}),
        allowsFreeText: question.isSecret === true || question.options == null || question.isOther !== false, options: question.options?.map(option => ({ id: option.label, label: option.label, description: option.description })) }));
      runtime?.approvals.set(approvalId, { requestId: id, nativeThreadId: typeof nativeThreadId === 'string' ? nativeThreadId : runtime.nativeId,
        sessionScoped: child !== undefined, kind, nativeTurnId: this.nativeTurnId(params, child === undefined ? runtime : undefined), questionIds: questions.map(question => question.id), questions: items });
      for (const question of items) this.emit(sessionId, { type: 'item.complete', itemKey: `question-${approvalId}-${question.questionId.slice(approvalId.length + 1)}`, kind: 'question', data: question, native: frame,
        ...(child === undefined ? {} : { scope: 'session' as const }) });
      return undefined;
    }

    const detail = JSON.stringify(params['command'] ?? params['commandActions'] ?? params['reason'] ?? params, null, 2);
    this.emit(sessionId, {
      type: 'item.complete',
      itemKey: `approval-${approvalId}`,
      kind: 'approval.request',
      nativeTurnId: this.nativeTurnId(params, child === undefined ? runtime : undefined),
      native: frame,
      ...(child === undefined ? {} : { scope: 'session' as const }),
      data: {
        approvalId,
        title: (() => {
          const command = Array.isArray(params['command'])
            ? (params['command'] as unknown[]).map((part) => String(part)).join(' ')
            : typeof params['command'] === 'string'
              ? params['command']
              : '';
          const base = kind === 'fileChange' || kind === 'legacyPatch' ? 'apply_patch' : 'exec_command';
          const title = command === '' ? base : `${base} · ${command}`;
          return child === undefined ? title : `子 Agent ${child.agentPath ?? child.childId} · ${title}`;
        })(),
        detail: detail.length > 2000 ? `${detail.slice(0, 2000)}…` : detail,
        tool: kind === 'fileChange' || kind === 'legacyPatch' ? 'apply_patch' : 'exec_command',
        options,
      },
    });
    // 真实决定由 respond() 通过 rpc.respond 发出；这里返回 undefined 让 JsonRpcStdio 不要立即回包
    return undefined;
  }
}
