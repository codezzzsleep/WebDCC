import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
  UserInput,
  TraceSink,
  TraceFrame,
} from '@webdcc/protocol';
import { traceFrame } from '@webdcc/protocol';
import { isValidEventData } from '@webdcc/protocol';
import { normalizeQuestionAnswer } from '@webdcc/protocol';
import { JsonRpcStdio, type Frame } from './rpc.js';
import { nativeRequest } from './controls.js';
import type { ThreadStartParams } from './schema/v2/ThreadStartParams.js';
import type { TurnStartParams } from './schema/v2/TurnStartParams.js';

export const PINNED_VERSION = '0.167.0';

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
  kind: 'commandExecution' | 'fileChange' | 'legacyExec' | 'legacyPatch' | 'userInput';
  questionIds?: string[];
  answers?: Record<string, { answers: string[] }>;
}

interface SessionRuntime {
  nativeId: string;
  pid: number;
  /** 每个 app-server 进程一个 token：JSON-RPC 的 request id 在每个进程里从 0/1 开始，
   *  resume 后会与上一进程的 id 重复，必须拼上 token 才能全局唯一 */
  processToken: string;
  /** resume 之后等线程真正挂上（thread/started）再发首轮 */
  ready: Promise<void>;
  rpc: JsonRpcStdio;
  cwd: string;
  /** 当前访问模式：在下一次 turn/start 里带上（F6） */
  accessMode: string | null;
  /** 当前模型：换模型后下一次 turn/start 带上（AG-*-12） */
  model: string | null;
  reasoningEffort: string | null;
  turnId: string | null;
  frameSeq: number;
  turnStartedAt: number;
  /** 模型输出开始时间；用于把 tok/s 的分母限制在生成阶段。 */
  generationStartedAt: number | null;
  approvals: Map<string, PendingApproval>;
  lastAssistantText: string;
  /** 已经发过 item.start 的条目（Codex 的 agentMessage 不一定有 item/started） */
  started: Set<string>;
}

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
      return {};
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
  | 'turn/started'
  | 'turn/completed'
  | 'item/started'
  | 'item/completed'
  | 'agentMessage/delta'
  | 'reasoning/summaryTextDelta'
  | 'reasoning/summaryPartAdded'
  | 'commandExecution/outputDelta'
  | 'tokenUsage'
  | 'title'
  | 'error'
  | 'goal/updated'
  | 'goal/cleared'
  | 'plan/updated'
  | 'plan/item'
  | 'diff/updated'
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
    case 'turn/diff/updated':
      return 'diff/updated';
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
    case 'item/plan/delta':
      return 'plan/item';
    case 'thread/started':
    case 'thread/status/changed':
    case 'serverRequest/resolved':
    case 'account/rateLimits/updated':
    case 'remoteControl/status/changed':
    case 'item/commandExecution/terminalInteraction':
    case 'item/mcpToolCall/progress':
    case 'item/reasoning/textDelta':
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

export function mapItemData(item: Record<string, unknown>): EventData[EventKind] {
  const type = String(item['type'] ?? '');
  switch (type) {
    case 'agentMessage':
      {
        const nativePhase = typeof item['phase'] === 'string' ? item['phase'] : undefined;
        const phase = nativePhase === 'final_answer' || nativePhase === 'partial_answer' ? 'final' : 'interim';
        return { text: String(item['text'] ?? ''), phase, ...(nativePhase === undefined ? {} : { nativePhase }) };
      }
    case 'reasoning':
      return { text: Array.isArray(item['summary']) ? (item['summary'] as { text?: string }[]).map((part) => part.text ?? '').join('') : '' };
    case 'commandExecution':
      return {
        command: String(item['command'] ?? ''),
        ...(typeof item['cwd'] === 'string' ? { cwd: item['cwd'] } : {}),
        ...(typeof item['exitCode'] === 'number' ? { exitCode: item['exitCode'] } : {}),
        ...(typeof item['aggregatedOutput'] === 'string' ? { outputTail: item['aggregatedOutput'].split('\n').slice(-200).join('\n') } : {}),
        status: item['status'] === 'failed' ? 'failed' : item['status'] === 'inProgress' ? 'running' : 'completed',
      };
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
        status: item['status'] === 'failed' ? 'failed' : 'completed',
      };
    }
    case 'plan':
      return {
        items: (Array.isArray(item['items']) ? (item['items'] as Record<string, unknown>[]) : []).map((step) => ({
          text: String(step['step'] ?? step['text'] ?? ''),
          status: step['status'] === 'completed' ? 'completed' : step['status'] === 'inProgress' ? 'in_progress' : 'pending',
        })),
      };
    case 'imageView':
      return { path: String(item['path'] ?? '') };
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
  static replay(sessionId = 'replay'): { feed: (frame: TraceFrame) => AdapterEvent[]; adapter: CodexAdapter; replies: unknown[] } {
    const adapter = new CodexAdapter();
    const replies: unknown[] = [];
    const runtime: SessionRuntime = {
      nativeId: '', pid: 0, processToken: 'replay', ready: Promise.resolve(),
      rpc: { respond: (id: string | number, result: unknown) => replies.push({ id, result }) } as unknown as JsonRpcStdio,
      cwd: '.', accessMode: null, model: null, reasoningEffort: null, turnId: null,
      frameSeq: 0, turnStartedAt: 0, generationStartedAt: null, approvals: new Map(), lastAssistantText: '', started: new Set(),
    };
    adapter.sessions.set(sessionId, runtime);
    let events: AdapterEvent[] = [];
    adapter.onEvent((_id, event) => events.push(event));
    return { adapter, replies, feed(frame) {
      events = []; adapter.replayTime = frame.t;
      const raw = frame.frame as Frame;
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

  private emit(sessionId: string, event: AdapterEvent): void {
    if (event.type === 'item.complete' && !isValidEventData(event.kind, event.data)) {
      const degraded: AdapterEvent = {
        type: 'item.complete',
        itemKey: event.itemKey,
        kind: 'unknown',
        data: { nativeType: event.kind },
        native: event.native ?? event.data,
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
      compatible: version === PINNED_VERSION,
      auth: 'unknown',
      notes: version === PINNED_VERSION ? [] : [`版本 ${version} 与锁定版本 ${PINNED_VERSION} 不一致`],
    };
  }

  async listModels(): Promise<ModelOption[]> {
    return [{ id: 'gpt-5', label: 'GPT-5' }];
  }

  /** Codex app-server does not expose a command catalog; /model is the
   * WebDCC mapping backed by the native model picker. Keep it explicit so the
   * slash menu does not claim that Codex has no commands. */
  async slashCommands(): Promise<{ name: string; description?: string }[]> {
    return [{ name: '/model', description: '打开 Provider 和模型选择' }];
  }

  /** 换模型（AG-*-12）：下一次 turn/start 带上新模型 */
  /** 访问模式来自 app-server 的 permissionProfile/list（MODE-codex-01） */
  async listAccessModes(): Promise<{ id: string; label: string }[]> {
    if ((await this.probe()).compatible === false) return ACCESS_MODES;
    const labels: Record<string, string> = {
      ':read-only': '只读',
      ':workspace': '工作区可写',
      ':danger-full-access': '完全访问',
    };
    const rpc = JsonRpcStdio.start({ command: 'codex', args: ['app-server'], env: { ...(this.options.env ?? process.env) } });
    try {
      await nativeRequest(rpc, 'initialize', { clientInfo: { name: 'webdcc', title: 'WebDCC', version: '0.1.0' }, capabilities: null });
      rpc.notify('initialized');
      const result = await nativeRequest(rpc, 'permissionProfile/list', {});
      const modes = (result.data ?? [])
        .filter((entry) => typeof entry.id === 'string')
        .map((entry) => ({ id: String(entry.id), label: labels[String(entry.id)] ?? String(entry.id) }));
      return modes.length === 0 ? ACCESS_MODES : modes;
    } catch {
      return ACCESS_MODES;
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
    runtime.accessMode = mode;
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
      args.push('-c', `model_provider=${key}`);
      args.push('-c', `model_providers.${key}.name="${provider.name}"`);
      const baseUrl = provider.endpoints?.['openai-responses'] ?? provider.baseUrl;
      args.push('-c', `model_providers.${key}.base_url="${baseUrl}"`);
      args.push('-c', `model_providers.${key}.wire_api="responses"`);
      args.push('-c', `model_providers.${key}.env_key="WDCC_PROVIDER_KEY"`);
      if (provider.codexCatalogPath !== undefined) args.push('-c', `model_catalog_json="${provider.codexCatalogPath}"`);
      if (provider.apiKey !== undefined) env['WDCC_PROVIDER_KEY'] = provider.apiKey;
    }
    if (opts.model !== undefined) args.push('-c', `model="${opts.model}"`);
    if (opts.recordingEndpoint?.codexProvider !== undefined) args.push('-c', `model_providers.${opts.recordingEndpoint.codexProvider}.base_url=${JSON.stringify(opts.recordingEndpoint.url)}`);
    return { command: this.options.command ?? 'codex', args, env };
  }

  private startProcess(sessionId: string, opts: CreateOpts): SessionRuntime {
    const spec = this.buildLaunchSpec(opts);
    let traceIndex = 0;
    const traceStarted = this.now();
    const runtimeRef: { current?: SessionRuntime } = {};
    const rpc = JsonRpcStdio.start({
      command: spec.command ?? 'codex',
      args: spec.args ?? [],
      cwd: opts.cwd,
      env: { ...(this.options.env ?? process.env), ...spec.env },
      onFrame: (direction, frame) => traceFrame(this.options.traceSink ?? opts.traceSink, { i: ++traceIndex, t: this.now() - traceStarted, dir: direction, ch: 'rpc', frame }),
      onExit: () => {
        if (this.sessions.get(sessionId) !== runtimeRef.current) return;
        if (runtimeRef.current?.turnId !== null && runtimeRef.current?.turnId !== undefined) this.emit(sessionId, { type: 'turn.end', nativeTurnId: runtimeRef.current.turnId, status: 'failed', native: { reason: 'process-exited' } });
      },
    });
    let markReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const runtime: SessionRuntime = {
      nativeId: '',
      pid: rpc.child.pid ?? 0,
      processToken: randomUUID(),
      ready,
      rpc,
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

  private async handshake(rpc: JsonRpcStdio): Promise<void> {
    await nativeRequest(rpc, 'initialize', {
      clientInfo: { name: 'webdcc', title: 'WebDCC', version: '0.1.0' },
      capabilities: null,
    });
    rpc.notify('initialized');
  }

  async create(opts: CreateOpts): Promise<{ nativeId: string }> {
    await this.requirePinnedVersion();
    const runtime = this.startProcess(opts.sessionId, opts);
    try {
    await this.handshake(runtime.rpc);
    const response = await nativeRequest(runtime.rpc, 'thread/start', buildThreadStartParams(opts));
    runtime.nativeId = response.thread.id;
    return { nativeId: runtime.nativeId };
    } catch (error) { await this.dispose(opts.sessionId); throw error; }
  }

  async resume(opts: CreateOpts & { nativeId: string }): Promise<void> {
    await this.requirePinnedVersion();
    const runtime = this.startProcess(opts.sessionId, opts);
    try {
    if (process.env['WDCC_DEBUG_CODEX'] === '1') console.error('[codex] resume process started');
    await this.handshake(runtime.rpc);
    if (process.env['WDCC_DEBUG_CODEX'] === '1') console.error('[codex] initialize done, resuming');
    const response = await nativeRequest(runtime.rpc, 'thread/resume', {
      threadId: opts.nativeId,
      excludeTurns: true,
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...accessParams(opts.accessMode),
    });
    runtime.nativeId = response.thread.id;
    // thread/resume 返回后线程可能还没挂上；等 thread/started 或最多 2 秒
    await Promise.race([runtime.ready, new Promise((resolve) => setTimeout(resolve, 2000))]);
    if (process.env['WDCC_DEBUG_CODEX'] === '1') console.error('[codex] resumed', runtime.nativeId);
    } catch (error) { await this.dispose(opts.sessionId); throw error; }
  }

  private async requirePinnedVersion(): Promise<void> {
    const probe = await this.probe();
    if (!probe.installed || probe.version !== PINNED_VERSION) throw Object.assign(new Error(`Codex 版本不兼容：需要 ${PINNED_VERSION}，实际 ${probe.version ?? '未知'}`), { statusCode: 503, code: 'native-version-incompatible' });
  }

  async send(sessionId: string, input: UserInput): Promise<void> {
    const runtime = this.require(sessionId);
    runtime.started.clear();
    runtime.generationStartedAt = null;
    const startedAt = this.now();
    await Promise.race([runtime.ready, new Promise((resolve) => setTimeout(resolve, 2000))]);
    if (process.env['WDCC_DEBUG_CODEX'] === '1') console.error('[codex] turn/start →', runtime.nativeId, 'model=', runtime.model);
    const response = await nativeRequest(runtime.rpc,
      'turn/start',
      buildTurnStartParams(runtime.nativeId, input.text, runtime.accessMode, runtime.model, runtime.reasoningEffort, input.images, runtime.cwd),
    );
    if (process.env['WDCC_DEBUG_CODEX'] === '1') console.error('[codex] turn started', response.turn?.id);
    runtime.turnId = response.turn.id;
    runtime.turnStartedAt = startedAt;
  }

  async interrupt(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (runtime?.turnId === null || runtime?.turnId === undefined) return;
    await nativeRequest(runtime.rpc, 'turn/interrupt', { threadId: runtime.nativeId, turnId: runtime.turnId });
  }

  async respond(sessionId: string, decision: ApprovalDecision): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    const pending = runtime?.approvals.get(decision.approvalId);
    if (runtime === undefined || pending === undefined) throw Object.assign(new Error('Codex 审批已结束或不存在'), { statusCode: 409 });
    if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision.optionId)) throw Object.assign(new Error('审批选项无效'), { statusCode: 400 });
    const runtimeRpc = runtime.rpc;
    const decisionValue = pending.kind === 'legacyExec' || pending.kind === 'legacyPatch'
      ? (decision.optionId === 'accept' ? 'approved' : decision.optionId === 'acceptForSession' ? 'approved_for_session' : 'denied')
      : decision.optionId;
    runtimeRpc.respond(pending.requestId, pending.kind === 'userInput' ? { answers: {} } : { decision: decisionValue });
    runtime.approvals.delete(decision.approvalId);
  }

  async answer(sessionId: string, questionId: string, answer: unknown): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    const candidates = [...(runtime?.approvals ?? [])].filter(([id, pending]) => pending.kind === 'userInput' && pending.questionIds?.some(nativeId => nativeId === questionId || `${id}:${nativeId}` === questionId));
    const entry = candidates.length === 1 ? candidates[0] : undefined;
    if (runtime === undefined || entry === undefined) throw new Error('Codex 问题已结束或不存在');
    const [id, pending] = entry;
    const nativeId = pending.questionIds?.find(nativeId => nativeId === questionId || `${id}:${nativeId}` === questionId);
    if (nativeId === undefined) throw new Error('原生问题身份不一致');
    const value = normalizeQuestionAnswer(answer).values;
    pending.answers ??= Object.create(null) as Record<string, { answers: string[] }>;
    pending.answers[nativeId] = { answers: value };
    if (Object.keys(pending.answers).length < (pending.questionIds?.length ?? 0)) return;
    runtime.rpc.respond(pending.requestId, { answers: pending.answers });
    runtime.approvals.delete(id);
  }

  /** 打断时把挂起的审批回 decline，避免 JSON-RPC 请求悬空 */
  async cancelPending(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return;
    for (const [approvalId, pending] of [...runtime.approvals]) {
      runtime.approvals.delete(approvalId);
      const decisionValue = pending.kind === 'legacyExec' || pending.kind === 'legacyPatch' ? 'denied' : 'decline';
      runtime.rpc.respond(pending.requestId, pending.kind === 'userInput' ? { answers: {} } : { decision: decisionValue });
    }
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
  }

  private require(sessionId: string): SessionRuntime {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) throw new Error('codex: 会话未创建');
    return runtime;
  }

  private nativeTurnId(params: Record<string, unknown>): string | undefined {
    const fromParams = typeof params['turnId'] === 'string' ? params['turnId'] : undefined;
    const turn = params['turn'];
    const fromTurn = typeof turn === 'object' && turn !== null && typeof (turn as { id?: unknown }).id === 'string' ? String((turn as { id: string }).id) : undefined;
    const item = params['item'];
    const fromItem = typeof item === 'object' && item !== null && typeof (item as { turnId?: unknown }).turnId === 'string' ? String((item as { turnId: string }).turnId) : undefined;
    return fromParams ?? fromTurn ?? fromItem;
  }

  // ---------- 通知 ----------

  private onNotification(sessionId: string, frame: Frame): void {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return;
    const method = String(frame['method'] ?? '');
    const params = (frame['params'] ?? {}) as Record<string, unknown>;
    const route = routeNotification(method);
    runtime.frameSeq += 1;
    const frameKey = `${method.replace(/[^a-zA-Z0-9]+/g, '-')}-${runtime.frameSeq}`;

    switch (route) {
      case 'turn/started': {
        this.emit(sessionId, { type: 'turn.start', nativeTurnId: this.nativeTurnId(params), native: params });
        return;
      }
      case 'turn/completed': {
        const turn = (params['turn'] ?? {}) as { id?: string; status?: string };
        const usage = (params['usage'] ?? undefined) as { inputTokens?: number; outputTokens?: number } | undefined;
        const generationMs = runtime.generationStartedAt === null ? undefined : Math.max(1, this.now() - runtime.generationStartedAt);
        runtime.generationStartedAt = null;
        this.emit(sessionId, {
          type: 'turn.end',
          nativeTurnId: turn.id ?? this.nativeTurnId(params),
          status: turn.status === 'interrupted' ? 'interrupted' : turn.status === 'failed' ? 'failed' : 'completed',
          ...(usage === undefined ? {} : { usage: { ...usage, scope: 'turn' as const, ...(generationMs === undefined ? {} : { generationMs }) } }),
          native: params,
        });
        runtime.turnId = null;
        runtime.started.clear();
        return;
      }
      case 'item/started': {
        const item = (params['item'] ?? {}) as Record<string, unknown>;
        const itemId = String(item['id'] ?? `item-${frameKey}`);
        const type = String(item['type'] ?? '');
        if (type === 'agentMessage' || type === 'reasoning' || type === 'reasoningSummary') runtime.generationStartedAt ??= this.now();
        const kind = mapItemKind(type);
        if (kind === 'internal') return;
        this.emit(sessionId, {
          type: 'item.start',
          itemKey: itemId,
          kind,
          data: mapItemData(item),
          nativeTurnId: this.nativeTurnId(params),
          native: item,
        });
        return;
      }
      case 'item/completed': {
        const item = (params['item'] ?? {}) as Record<string, unknown>;
        const itemId = String(item['id'] ?? `item-${frameKey}`);
        const type = String(item['type'] ?? '');
        if (type === 'agentMessage') runtime.lastAssistantText = String(item['text'] ?? '');
        const kind = mapItemKind(type);
        if (kind === 'internal') {
          this.emit(sessionId, {
            type: 'item.complete',
            itemKey: `internal-${itemId}`,
            kind: 'internal',
            data: { nativeType: type === '' ? 'item' : type },
            native: item,
            nativeTurnId: this.nativeTurnId(params),
          });
          return;
        }
        const data = mapItemData(item);
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
          nativeTurnId: this.nativeTurnId(params),
        });
        return;
      }
      case 'agentMessage/delta': {
        runtime.generationStartedAt ??= this.now();
        const itemId = String(params['itemId'] ?? '');
        if (!runtime.started.has(itemId)) {
          runtime.started.add(itemId);
          this.emit(sessionId, { type: 'item.start', itemKey: itemId, kind: 'assistant.message', data: { text: '' }, nativeTurnId: this.nativeTurnId(params) });
        }
        this.emit(sessionId, { type: 'item.delta', itemKey: itemId, field: 'text', append: String(params['delta'] ?? '') });
        return;
      }
      case 'reasoning/summaryTextDelta': {
        runtime.generationStartedAt ??= this.now();
        const itemId = String(params['itemId'] ?? '');
        if (!runtime.started.has(itemId)) {
          runtime.started.add(itemId);
          this.emit(sessionId, { type: 'item.start', itemKey: itemId, kind: 'reasoning', data: { text: '' }, nativeTurnId: this.nativeTurnId(params) });
        }
        this.emit(sessionId, { type: 'item.delta', itemKey: itemId, field: 'text', append: String(params['delta'] ?? '') });
        return;
      }
      case 'reasoning/summaryPartAdded': {
        // 已知通知：并入 reasoning，不算 unknown（F12）
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: `internal-reasoning-part-${String(params['itemId'] ?? '')}-${String(params['summaryIndex'] ?? 0)}`,
          kind: 'internal',
          data: { nativeType: method },
          native: params,
        });
        return;
      }
      case 'commandExecution/outputDelta': {
        this.emit(sessionId, { type: 'item.delta', itemKey: String(params['itemId'] ?? ''), field: 'output', append: String(params['delta'] ?? '') });
        return;
      }
      case 'tokenUsage': {
        const tokenUsage = (params['tokenUsage'] ?? {}) as { total?: Record<string, number>; last?: Record<string, number> };
        const currentTurn = tokenUsage.last ?? tokenUsage.total ?? {};
        const inputTokens = Number(currentTurn['inputTokens'] ?? 0);
        const outputTokens = Number(currentTurn['outputTokens'] ?? 0);
        if (inputTokens === 0 && outputTokens === 0) return;
        const generationMs = runtime.generationStartedAt === null ? undefined : Math.max(1, this.now() - runtime.generationStartedAt);
        runtime.generationStartedAt = null;
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: `usage-${frameKey}`,
          kind: 'usage',
          data: { inputTokens, outputTokens, cacheReadInputTokens: currentTurn['cachedInputTokens'], reasoningOutputTokens: currentTurn['reasoningOutputTokens'], ...(generationMs === undefined ? { scope: 'turn' as const } : { scope: 'attempt' as const, generationMs }) },
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
        const goal = (params['goal'] ?? {}) as { objective?: string; status?: string; tokensUsed?: number };
        const status = goal.status === 'completed' || goal.status === 'paused' ? goal.status : goal.status === 'cleared' ? 'cleared' : 'active';
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: `goal-${frameKey}`,
          kind: 'goal',
          data: {
            objective: String(goal.objective ?? ''),
            status,
            ...(typeof goal.tokensUsed === 'number' ? { tokensUsed: goal.tokensUsed } : {}),
          },
          native: params,
        });
        return;
      }
      case 'goal/cleared': {
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: `goal-cleared-${frameKey}`,
          kind: 'goal',
          data: { objective: '', status: 'cleared' },
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
          nativeTurnId: this.nativeTurnId(params),
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

  private onServerRequest(sessionId: string, frame: Frame): unknown {
    const runtime = this.sessions.get(sessionId);
    const method = String(frame['method'] ?? '');
    const id = frame['id'];
    if (typeof id !== 'string' && typeof id !== 'number') throw Object.assign(new Error('Invalid native request ID'), { code: -32600 });
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'execCommandApproval', 'applyPatchApproval', 'item/tool/requestUserInput'].includes(method)) {
      this.emit(sessionId, { type: 'item.complete', itemKey: `unsupported-${String(id)}`, kind: 'unknown', data: { nativeType: method }, native: frame });
      throw Object.assign(new Error(`Unsupported native request: ${method}`), { code: -32601 });
    }
    const params = (frame['params'] ?? {}) as Record<string, unknown>;

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
    runtime?.approvals.set(approvalId, { requestId: id, kind });
    if (kind === 'userInput' && Array.isArray(params['questions'])) {
      const questions = params['questions'] as { id: string; question?: string; header?: string; options?: { label: string; description?: string }[]; isOther?: boolean }[];
      runtime?.approvals.set(approvalId, { requestId: id, kind, questionIds: questions.map(question => question.id) });
      for (const question of questions) this.emit(sessionId, { type: 'item.complete', itemKey: `question-${approvalId}-${question.id}`, kind: 'question', data: { questionId: `${approvalId}:${question.id}`, prompt: question.question ?? '请回答', header: question.header, allowsFreeText: question.isOther ?? true, options: question.options?.map(option => ({ id: option.label, label: option.label, description: option.description })) }, native: frame });
      return undefined;
    }

    const detail = JSON.stringify(params['command'] ?? params['commandActions'] ?? params['reason'] ?? params, null, 2);
    this.emit(sessionId, {
      type: 'item.complete',
      itemKey: `approval-${approvalId}`,
      kind: 'approval.request',
      data: {
        approvalId,
        title: (() => {
          const command = Array.isArray(params['command'])
            ? (params['command'] as unknown[]).map((part) => String(part)).join(' ')
            : typeof params['command'] === 'string'
              ? params['command']
              : '';
          const base = kind === 'fileChange' || kind === 'legacyPatch' ? 'apply_patch' : 'exec_command';
          return command === '' ? base : `${base} · ${command}`;
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
