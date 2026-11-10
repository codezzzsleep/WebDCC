import { spawnSync } from 'node:child_process';
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
} from '@webdcc/protocol';
import { JsonRpcStdio, type Frame } from './rpc.js';

export const PINNED_VERSION = '0.167.0';

export interface CodexAdapterOptions {
  command?: string;
  /** 额外的 -c 覆盖（Provider 注入用，M6 会用到） */
  configOverrides?: string[];
  env?: NodeJS.ProcessEnv;
  onTitle?: (sessionId: string, title: string) => void;
}

interface PendingApproval {
  requestId: number;
  kind: 'commandExecution' | 'fileChange' | 'legacyExec' | 'legacyPatch' | 'userInput';
}

interface SessionRuntime {
  nativeId: string;
  rpc: JsonRpcStdio;
  cwd: string;
  turnId: string | null;
  turnStartedAt: number;
  approvals: Map<string, PendingApproval>;
  lastAssistantText: string;
}

const ACCESS_MODES = [
  { id: 'read-only', label: '只读' },
  { id: 'workspace', label: '工作区可写' },
  { id: 'workspace-auto', label: '工作区可写 + 自动审批' },
  { id: 'danger-full-access', label: '完全访问' },
];

function accessParams(mode: string | undefined): Record<string, unknown> {
  switch (mode) {
    // 原生值，仅供验收脚本触发"每条命令都问"的审批；不作为界面档位
    case 'untrusted':
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write', approvalsReviewer: 'user' };
    case 'read-only':
      return { approvalPolicy: 'on-request', sandbox: 'read-only', approvalsReviewer: 'user' };
    case 'workspace':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'user' };
    case 'workspace-auto':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'auto_review' };
    case 'danger-full-access':
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
      return 'command';
    case 'fileChange':
      return 'file.change';
    case 'plan':
      return 'plan';
    case 'imageView':
      return 'file.read';
    default:
      return 'tool.call';
  }
}

export function mapItemData(item: Record<string, unknown>): EventData[EventKind] {
  const type = String(item['type'] ?? '');
  switch (type) {
    case 'agentMessage':
      return { text: String(item['text'] ?? ''), phase: item['phase'] === 'final' ? 'final' : 'interim' };
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
    case 'fileChange': {
      const changes = Array.isArray(item['changes']) ? (item['changes'] as Record<string, unknown>[]) : [];
      return {
        changes: changes.map((change) => ({
          path: String(change['path'] ?? ''),
          kind: change['kind'] === 'add' ? 'add' : change['kind'] === 'delete' ? 'delete' : 'modify',
          added: 0,
          removed: 0,
        })),
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
export function buildThreadStartParams(opts: CreateOpts): Record<string, unknown> {
  return {
    cwd: opts.cwd,
    ...(opts.model === undefined ? {} : { model: opts.model }),
    ...accessParams(opts.accessMode),
  };
}

/** 纯函数：turn/start 参数 */
export function buildTurnStartParams(threadId: string, text: string): Record<string, unknown> {
  return { threadId, input: [{ type: 'text', text, text_elements: [] }] };
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex' as const;
  private readonly listeners: ((sessionId: string, event: AdapterEvent) => void)[] = [];
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly options: CodexAdapterOptions;

  constructor(options: CodexAdapterOptions = {}) {
    this.options = options;
  }

  onEvent(cb: (sessionId: string, event: AdapterEvent) => void): void {
    this.listeners.push(cb);
  }

  private emit(sessionId: string, event: AdapterEvent): void {
    for (const listener of this.listeners) listener(sessionId, event);
  }

  async probe(): Promise<ProbeResult> {
    const result = spawnSync(this.options.command ?? 'codex', ['--version'], { encoding: 'utf8' });
    if (result.status !== 0) {
      return { installed: false, pinnedVersion: PINNED_VERSION, auth: 'unknown', notes: ['服务器上没有安装 Codex CLI'] };
    }
    const version = (result.stdout ?? '').trim().replace(/^codex-cli\s+/, '');
    return {
      installed: true,
      version,
      pinnedVersion: PINNED_VERSION,
      auth: 'unknown',
      notes: version === PINNED_VERSION ? [] : [`版本 ${version} 与锁定版本 ${PINNED_VERSION} 不一致`],
    };
  }

  async listModels(): Promise<ModelOption[]> {
    return [{ id: 'gpt-5', label: 'GPT-5' }];
  }

  accessModes(): { id: string; label: string }[] {
    return ACCESS_MODES;
  }

  /** 3.3 的机器检查入口：纯函数，不启动进程 */
  buildLaunchSpec(opts: CreateOpts): LaunchSpec {
    const args = ['app-server'];
    for (const override of this.options.configOverrides ?? []) args.push('-c', override);
    if (opts.model !== undefined) args.push('-c', `model="${opts.model}"`);
    return { command: this.options.command ?? 'codex', args, env: {} };
  }

  private startProcess(sessionId: string, opts: CreateOpts): SessionRuntime {
    const spec = this.buildLaunchSpec(opts);
    const rpc = JsonRpcStdio.start({
      command: spec.command ?? 'codex',
      args: spec.args ?? [],
      cwd: opts.cwd,
      env: { ...(this.options.env ?? process.env), ...spec.env },
    });
    const runtime: SessionRuntime = {
      nativeId: '',
      rpc,
      cwd: opts.cwd,
      turnId: null,
      turnStartedAt: 0,
      approvals: new Map(),
      lastAssistantText: '',
    };
    rpc.onNotification((frame) => this.onNotification(sessionId, frame));
    rpc.onServerRequest((frame) => this.onServerRequest(sessionId, frame));
    this.sessions.set(sessionId, runtime);
    return runtime;
  }

  private async handshake(rpc: JsonRpcStdio): Promise<void> {
    await rpc.request('initialize', {
      clientInfo: { name: 'webdcc', title: 'WebDCC', version: '0.1.0' },
      capabilities: null,
    });
    rpc.notify('initialized');
  }

  async create(opts: CreateOpts): Promise<{ nativeId: string }> {
    const runtime = this.startProcess(opts.sessionId, opts);
    await this.handshake(runtime.rpc);
    const response = await runtime.rpc.request<{ thread: { id: string } }>('thread/start', buildThreadStartParams(opts));
    runtime.nativeId = response.thread.id;
    return { nativeId: runtime.nativeId };
  }

  async resume(opts: CreateOpts & { nativeId: string }): Promise<void> {
    const runtime = this.startProcess(opts.sessionId, opts);
    if (process.env['WDCC_DEBUG_CODEX'] === '1') console.error('[codex] resume process started');
    await this.handshake(runtime.rpc);
    if (process.env['WDCC_DEBUG_CODEX'] === '1') console.error('[codex] initialize done, resuming');
    const response = await runtime.rpc.request<{ thread: { id: string } }>('thread/resume', {
      threadId: opts.nativeId,
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...accessParams(opts.accessMode),
    });
    runtime.nativeId = response.thread.id;
    if (process.env['WDCC_DEBUG_CODEX'] === '1') console.error('[codex] resumed', runtime.nativeId);
  }

  async send(sessionId: string, input: UserInput): Promise<void> {
    const runtime = this.require(sessionId);
    const startedAt = Date.now();
    if (process.env['WDCC_DEBUG_CODEX'] === '1') console.error('[codex] turn/start →', runtime.nativeId);
    const response = await runtime.rpc.request<{ turn: { id: string } }>('turn/start', buildTurnStartParams(runtime.nativeId, input.text));
    if (process.env['WDCC_DEBUG_CODEX'] === '1') console.error('[codex] turn started', response.turn?.id);
    runtime.turnId = response.turn.id;
    runtime.turnStartedAt = startedAt;
  }

  async interrupt(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (runtime?.turnId === null || runtime?.turnId === undefined) return;
    await runtime.rpc.request('turn/interrupt', { threadId: runtime.nativeId, turnId: runtime.turnId });
  }

  async respond(sessionId: string, decision: ApprovalDecision): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    const pending = runtime?.approvals.get(decision.approvalId);
    if (runtime === undefined || pending === undefined) return;
    runtime.approvals.delete(decision.approvalId);
    const runtimeRpc = runtime.rpc;
    const decisionValue = pending.kind === 'legacyExec' || pending.kind === 'legacyPatch'
      ? (decision.optionId === 'accept' ? 'approved' : decision.optionId === 'acceptForSession' ? 'approved_for_session' : 'denied')
      : decision.optionId;
    runtimeRpc.respond(pending.requestId, pending.kind === 'userInput' ? { answers: {} } : { decision: decisionValue });
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

  // ---------- 通知 ----------

  private onNotification(sessionId: string, frame: Frame): void {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return;
    const method = String(frame['method'] ?? '');
    const params = (frame['params'] ?? {}) as Record<string, unknown>;

    switch (method) {
      case 'turn/started': {
        this.emit(sessionId, { type: 'status', status: 'running' });
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: `turn-${String(runtime.turnId ?? 'unknown')}`,
          kind: 'turn.started',
          data: {},
        });
        return;
      }
      case 'turn/completed': {
        const turn = (params['turn'] ?? {}) as { id?: string; status?: string };
        const usage = (params['usage'] ?? undefined) as { inputTokens?: number; outputTokens?: number } | undefined;
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: `turn-${turn.id ?? runtime.turnId ?? 'unknown'}`,
          kind: 'turn.completed',
          data: {
            status: turn.status === 'interrupted' ? 'interrupted' : turn.status === 'failed' ? 'failed' : 'completed',
            durationMs: Date.now() - runtime.turnStartedAt,
            ...(usage === undefined ? {} : { usage }),
          },
        });
        runtime.turnId = null;
        this.emit(sessionId, { type: 'status', status: 'idle' });
        return;
      }
      case 'item/started': {
        const item = (params['item'] ?? {}) as Record<string, unknown>;
        const itemId = String(item['id'] ?? '');
        const type = String(item['type'] ?? '');
        this.emit(sessionId, {
          type: 'item.start',
          itemKey: itemId,
          kind: mapItemKind(type),
          data: mapItemData(item),
        });
        return;
      }
      case 'item/completed': {
        const item = (params['item'] ?? {}) as Record<string, unknown>;
        const itemId = String(item['id'] ?? '');
        const type = String(item['type'] ?? '');
        if (type === 'agentMessage') runtime.lastAssistantText = String(item['text'] ?? '');
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: itemId,
          kind: mapItemKind(type),
          data: mapItemData(item),
          native: item,
        });
        return;
      }
      case 'item/agentMessage/delta': {
        this.emit(sessionId, { type: 'item.delta', itemKey: String(params['itemId'] ?? ''), field: 'text', append: String(params['delta'] ?? '') });
        return;
      }
      case 'item/reasoning/summaryTextDelta': {
        this.emit(sessionId, { type: 'item.delta', itemKey: String(params['itemId'] ?? ''), field: 'text', append: String(params['delta'] ?? '') });
        return;
      }
      case 'item/commandExecution/outputDelta': {
        this.emit(sessionId, { type: 'item.delta', itemKey: String(params['itemId'] ?? ''), field: 'output', append: String(params['delta'] ?? '') });
        return;
      }
      case 'thread/tokenUsage/updated': {
        const usage = (params['usage'] ?? {}) as { inputTokens?: number; outputTokens?: number };
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: `usage-${Date.now().toString(36)}`,
          kind: 'usage',
          data: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
        });
        return;
      }
      case 'thread/name/updated': {
        const title = String(params['name'] ?? params['title'] ?? '');
        if (title !== '') this.options.onTitle?.(sessionId, title);
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: `internal-title-${Date.now().toString(36)}`,
          kind: 'internal',
          data: { nativeType: 'thread/name/updated' },
          native: params,
        });
        return;
      }
      case 'error': {
        const message = (params['message'] ?? params['error'] ?? '未知错误') as unknown;
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: `error-${Date.now().toString(36)}`,
          kind: 'error',
          data: { message: typeof message === 'string' ? message : JSON.stringify(message) },
        });
        return;
      }
      case 'turn/plan/updated':
      case 'turn/diff/updated':
      case 'thread/status/changed':
      case 'serverRequest/resolved':
      case 'account/rateLimits/updated':
      case 'warning':
      case 'configWarning':
      case 'deprecationNotice':
      case 'remoteControl/status/changed':
      case 'thread/started':
      case 'thread/goal/cleared':
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: `internal-${method}-${Date.now().toString(36)}`,
          kind: 'internal',
          data: { nativeType: method },
          native: params,
        });
        return;
      default:
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: `unknown-${method}-${Date.now().toString(36)}`,
          kind: 'unknown',
          data: { nativeType: method },
          native: params,
        });
    }
  }

  // ---------- 服务端反向请求（审批 / 提问） ----------

  private onServerRequest(sessionId: string, frame: Frame): unknown {
    const runtime = this.sessions.get(sessionId);
    const method = String(frame['method'] ?? '');
    const id = Number(frame['id']);
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

    const approvalId = String(id);
    runtime?.approvals.set(approvalId, { requestId: id, kind });

    const detail = JSON.stringify(params['command'] ?? params['commandActions'] ?? params['reason'] ?? params, null, 2);
    this.emit(sessionId, {
      type: 'item.complete',
      itemKey: `approval-${approvalId}`,
      kind: 'approval.request',
      data: {
        approvalId,
        title: kind === 'fileChange' || kind === 'legacyPatch' ? 'Codex 请求修改文件' : 'Codex 请求运行命令',
        detail: detail.length > 2000 ? `${detail.slice(0, 2000)}…` : detail,
        options,
      },
    });
    this.emit(sessionId, { type: 'status', status: 'waiting' });
    // 真实决定由 respond() 通过 rpc.respond 发出；这里返回 undefined 让 JsonRpcStdio 不要立即回包
    return undefined;
  }
}
