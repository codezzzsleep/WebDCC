import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
import { isValidEventData, ulid } from '@webdcc/protocol';
import { DshHostClient, startSidecar, type Sidecar, type StreamFrame } from './host.js';

export const PINNED_VERSION = '0.2.2-rc.1';

export interface DshAdapterOptions {
  port?: number;
  host?: string;
  env?: Record<string, string>;
  command?: string;
  /** attach：连接用户已经在运行的 DSH；spawn：自己拉起侧车（默认） */
  mode?: 'attach' | 'spawn';
  attachUrl?: string;
  attachCookie?: string;
}

/** 扫描 /proc，找同一 DSH_HOME 上已在运行的 dsh 进程（spawn 模式的冲突检查） */
export function findDshProcessOn(home: string): number | undefined {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let argv: string[];
    let env: string[];
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean);
    } catch {
      continue;
    }
    if (!argv.some((arg) => arg === 'dsh' || arg.endsWith('/dsh'))) continue;
    if (!argv.includes('web')) continue;
    const dshHome = env.find((item) => item.startsWith('DSH_HOME='))?.slice('DSH_HOME='.length) ?? join(homedir(), '.dsh');
    if (dshHome === home) return pid;
  }
  return undefined;
}

/** SPEC 5.4.8 的端点白名单（3.3 的机器检查依据） */
export const ALLOWED_ENDPOINTS: ReadonlySet<string> = new Set([
  'workspace/create',
  'workspace/follow',
  'session/create',
  'session/list',
  'session/follow',
  'session/page',
  'session/prompt',
  'session/cancel',
  'session/modelCatalog',
  'session/selectModel',
  'commands/execute',
  '$events',
  '$events/result',
  'userQuestions/answer',
]);

export function isAllowedEndpoint(endpoint: string): boolean {
  return ALLOWED_ENDPOINTS.has(endpoint);
}

/** commands/execute 只允许两种情况：访问模式界面生成的 /permission，或用户本人输入的命令原文 */
export function isAllowedCommandLine(line: string, userText?: string): boolean {
  if (/^\/permission\s+(read-only|workspace-write|danger-full-access|auto)$/.test(line)) return true;
  return userText !== undefined && line === userText;
}

const ACCESS_MODES = [
  { id: 'read-only', label: '仅可查看' },
  { id: 'workspace-write', label: '工作区内修改' },
  { id: 'danger-full-access', label: '完全权限' },
  { id: 'auto', label: '自动审查（实验）' },
];

/** DSH 工具名 → 我方 kind（SPEC 5.4 映射） */
export function toolKind(name: string): EventKind {
  switch (name) {
    case 'bash':
      return 'command';
    case 'read':
    case 'read_image':
    case 'glob':
    case 'grep':
      return 'file.read';
    case 'write':
    case 'edit':
      return 'file.change';
    case 'todo_write':
      // 任务清单只由 todo/write 事件生成；工具调用本身按 tool.call 处理（SPEC-M8 F2）
      return 'tool.call';
    default:
      return 'tool.call';
  }
}

const INTERNAL_EVENTS = new Set([
  'request/header',
  'step/start',
  'step/end',
  'agent/inbox/spliced',
  'session/end-seed',
  'job/registered',
  'job/settled',
  'command/run',
  'command/done',
  'approval/asked',
  'approval/decided',
  'request/context',
  'system/message',
  'session/title-llm-request',
  'session-log-deepseek/delivery-accepted',
]);

interface PendingInteraction {
  kind: 'approval' | 'question';
  eventId: string;
}

interface SessionRuntime {
  nativeId: string;
  workspaceId: string;
  followStream: string | null;
  lastSeq: number;
  turnStartedAt: number;
  pending: Map<string, PendingInteraction>;
  toolCalls: Map<string, { itemKey: string; kind: EventKind; data: EventData[EventKind] }>;
  assistantKey: string;
  assistantText: string;
  reasoningKey: string;
}

export class DshAdapter implements AgentAdapter {
  readonly id = 'dsh' as const;
  private readonly listeners: ((sessionId: string, event: AdapterEvent) => void)[] = [];
  private readonly sessions = new Map<string, SessionRuntime>();
  private sidecar: Sidecar | null = null;
  private client: DshHostClient | null = null;
  private clientId = '';
  private booting: Promise<void> | null = null;
  private options: DshAdapterOptions;

  constructor(options: DshAdapterOptions = {}) {
    this.options = options;
  }

  onEvent(cb: (sessionId: string, event: AdapterEvent) => void): void {
    this.listeners.push(cb);
  }

  private emit(sessionId: string, event: AdapterEvent): void {
    for (const listener of this.listeners) listener(sessionId, event);
  }

  async probe(): Promise<ProbeResult> {
    if ((this.options.mode ?? 'spawn') === 'spawn') {
      const dshHome = this.options.env?.['DSH_HOME'] ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh');
      const running = findDshProcessOn(dshHome);
      if (running !== undefined) {
        return {
          installed: false,
          pinnedVersion: PINNED_VERSION,
          auth: 'unknown',
          notes: [`检测到已有 DSH 在使用 ${dshHome}，请改用 attach 模式`],
        };
      }
    }
    const result = spawnSync(this.options.command ?? 'dsh', ['--version'], { encoding: 'utf8' });
    if (result.status !== 0) {
      return { installed: false, pinnedVersion: PINNED_VERSION, auth: 'unknown', notes: ['服务器上没有安装 DSH'] };
    }
    const version = (result.stdout ?? '').trim();
    return {
      installed: true,
      version,
      pinnedVersion: PINNED_VERSION,
      auth: 'ok',
      notes: version === PINNED_VERSION ? [] : [`版本 ${version} 与锁定版本 ${PINNED_VERSION} 不一致`],
    };
  }

  async listModels(): Promise<ModelOption[]> {
    return [];
  }

  accessModes(): { id: string; label: string }[] {
    return ACCESS_MODES;
  }

  /** 3.3 的机器检查入口：只启动一个只监听 127.0.0.1 的侧车 */
  buildLaunchSpec(): LaunchSpec {
    const port = String(this.options.port ?? process.env['WDCC_DSH_PORT'] ?? 3091);
    return {
      command: this.options.command ?? 'dsh',
      args: ['web', '--no-open', '--port', port, '--host', '127.0.0.1'],
      env: { ...(this.options.env ?? {}) },
    };
  }

  private async ensureSidecar(): Promise<DshHostClient> {
    if (this.client !== null) return this.client;
    if ((this.options.mode ?? 'spawn') === 'attach') {
      this.booting ??= (async () => {
        const url = new URL(this.options.attachUrl ?? 'http://127.0.0.1:3080');
        const cookie = this.options.attachCookie ?? '';
        if (cookie === '') throw Object.assign(new Error('需要重新连接 DSH：请粘贴 DSH 当前的访问链接'), { code: 'dsh-needs-link' });
        const client = new DshHostClient(Number(url.port || 80));
        client.useCookie(cookie);
        await client.connect();
        client.openStream('$events', {}, (frame) => this.onEventFrame('', frame));
        this.client = client;
      })();
      await this.booting;
      if (this.client === null) throw new Error('dsh: 连接 DSH 失败');
      return this.client;
    }
    const dshHome = this.options.env?.['DSH_HOME'] ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh');
    const running = findDshProcessOn(dshHome);
    if (running !== undefined) {
      throw Object.assign(new Error(`检测到已有 DSH 在使用 ${dshHome}，请改用 attach 模式`), { code: 'dsh-home-in-use' });
    }
    this.booting ??= (async () => {
      const spec = this.buildLaunchSpec();
      this.sidecar = await startSidecar({
        port: Number((spec.args ?? [])[3] ?? process.env['WDCC_DSH_PORT'] ?? 3091),
        env: { ...process.env, ...spec.env },
        ...(spec.command === undefined ? {} : { command: spec.command }),
      });
      const client = new DshHostClient(this.sidecar.port);
      await client.authenticate(this.sidecar.tokenUrl);
      await client.connect();
      client.openStream('$events', {}, (frame) => this.onEventFrame('', frame));
      this.client = client;
    })();
    await this.booting;
    if (this.client === null) throw new Error('dsh: 侧车启动失败');
    return this.client;
  }

  private async permission(client: DshHostClient, nativeId: string, accessMode: string | undefined): Promise<void> {
    if (accessMode === undefined) return;
    const line = `/permission ${accessMode}`;
    if (!isAllowedCommandLine(line)) throw new Error(`dsh: 不允许的 commands/execute line: ${line}`);
    await client.rpc('commands/execute', { agentId: nativeId, line, submittedAttachments: [] }).catch(() => undefined);
  }

  /** 所有 RPC 都经过白名单检查 */
  private async call<T>(client: DshHostClient, endpoint: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!isAllowedEndpoint(endpoint)) throw new Error(`dsh: 端点不在白名单内：${endpoint}`);
    return client.rpc<T>(endpoint, args);
  }

  async create(opts: CreateOpts): Promise<{ nativeId: string }> {
    const client = await this.ensureSidecar();
    const workspace = await client.rpc<{ workspace: { workspaceId: string } }>('workspace/create', {
      request: { path: opts.cwd },
    });
    const created = await client.rpc<{ sessionId: string }>('session/create', {
      request: { workspaceId: workspace.workspace.workspaceId },
    });
    const runtime: SessionRuntime = {
      nativeId: created.sessionId,
      workspaceId: workspace.workspace.workspaceId,
      followStream: null,
      lastSeq: 0,
      turnStartedAt: 0,
      pending: new Map(),
      toolCalls: new Map(),
      assistantKey: '',
      assistantText: '',
      reasoningKey: '',
    };
    this.sessions.set(opts.sessionId, runtime);
    await this.permission(client, created.sessionId, opts.accessMode);
    this.openFollow(opts.sessionId, runtime);
    return { nativeId: created.sessionId };
  }

  async resume(opts: CreateOpts & { nativeId: string }): Promise<void> {
    const client = await this.ensureSidecar();
    const workspace = await client.rpc<{ workspace: { workspaceId: string } }>('workspace/create', {
      request: { path: opts.cwd },
    });
    const runtime: SessionRuntime = {
      nativeId: opts.nativeId,
      workspaceId: workspace.workspace.workspaceId,
      followStream: null,
      lastSeq: 0,
      turnStartedAt: 0,
      pending: new Map(),
      toolCalls: new Map(),
      assistantKey: '',
      assistantText: '',
      reasoningKey: '',
    };
    this.sessions.set(opts.sessionId, runtime);
    this.openFollow(opts.sessionId, runtime);
  }

  private openFollow(sessionId: string, runtime: SessionRuntime): void {
    const client = this.client;
    if (client === null) return;
    runtime.followStream = client.openStream(
      'session/follow',
      { request: { address: { kind: 'session', sessionId: runtime.nativeId }, activate: true, assistantStream: true } },
      (frame) => this.onEventFrame(sessionId, frame),
    );
  }

  async send(sessionId: string, input: UserInput): Promise<void> {
    const client = await this.ensureSidecar();
    const runtime = this.require(sessionId);
    runtime.turnStartedAt = Date.now();
    const content: Record<string, unknown>[] = [{ type: 'text', text: input.text }];
    for (const image of input.images ?? []) content.push({ type: 'image', path: image.path, mime: image.mime });
    await this.call(client, 'session/prompt', {
      request: { requestId: ulid(), sessionId: runtime.nativeId, mode: 'queue', content },
    });
  }

  async interrupt(sessionId: string): Promise<void> {
    const client = await this.ensureSidecar();
    const runtime = this.require(sessionId);
    await this.call(client, 'session/cancel', { request: { sessionId: runtime.nativeId } });
  }

  async respond(sessionId: string, decision: ApprovalDecision): Promise<void> {
    const client = await this.ensureSidecar();
    const runtime = this.require(sessionId);
    runtime.pending.delete(decision.approvalId);
    await this.call(client, '$events/result', {
      clientId: this.clientId,
      eventId: decision.approvalId,
      outcome: { kind: 'result', value: decision.optionId },
    });
  }

  async answer(sessionId: string, questionId: string, answer: unknown): Promise<void> {
    const client = await this.ensureSidecar();
    const runtime = this.require(sessionId);
    runtime.pending.delete(questionId);
    const value = (answer as { selected?: string[]; custom?: string }) ?? {};
    const answers = [{ id: questionId, selected: value.selected ?? [], ...(value.custom === undefined || value.custom === '' ? {} : { custom: value.custom }) }];
    await this.call(client, '$events/result', {
      clientId: this.clientId,
      eventId: questionId,
      outcome: { kind: 'result', value: { answers } },
    });
  }

  /** 运行期切换连接（设置页粘贴 DSH 链接后调用） */
  async setAttach(url: string, cookie: string): Promise<void> {
    await this.shutdown();
    this.options = { ...this.options, mode: 'attach', attachUrl: url, attachCookie: cookie };
  }

  /** 关闭侧车（进程级清理，测试与平台退出时调用） */
  async shutdown(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    await this.sidecar?.stop().catch(() => undefined);
    this.client = null;
    this.sidecar = null;
    this.booting = null;
  }

  debugProcesses(): { sessionId: string; pid: number; dirs: Record<string, string> }[] {
    const pid = this.sidecar?.child.pid ?? 0;
    return [...this.sessions.keys()].map((sessionId) => ({
      sessionId,
      pid,
      dirs: {
        HOME: process.env['HOME'] ?? '',
        DSH_HOME: this.options.env?.['DSH_HOME'] ?? process.env['DSH_HOME'] ?? '',
        WDCC_DSH_MODE: 'spawn',
      },
    }));
  }

  async dispose(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return;
    this.sessions.delete(sessionId);
    if (runtime.followStream !== null) this.client?.closeStream(runtime.followStream);
  }

  private require(sessionId: string): SessionRuntime {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) throw new Error('dsh: 会话未创建');
    return runtime;
  }

  // ---------- 事件帧 ----------

  private frameValue(frame: StreamFrame): Record<string, unknown> | undefined {
    const value = frame.value;
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  }

  private onEventFrame(sessionId: string, frame: StreamFrame): void {
    const value = this.frameValue(frame);
    if (value === undefined) return;

    if (value['type'] === 'ready') {
      this.clientId = String(value['clientId'] ?? '');
      return;
    }
    if (value['type'] === 'waterfall') {
      this.onWaterfall(sessionId, value);
      return;
    }
    if (value['type'] === 'assistant-stream') {
      this.onAssistantStream(sessionId, value);
      return;
    }
    if (value['type'] === 'snapshot') return;
    if (value['type'] !== 'event') return;

    const event = (value['event'] ?? {}) as Record<string, unknown>;
    const type = String(event['type'] ?? '');
    const seq = Number(event['seq'] ?? 0);
    const data = (event['data'] ?? {}) as Record<string, unknown>;
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return;
    if (seq > 0 && seq <= runtime.lastSeq) return; // nativeSeq 去重
    if (seq > 0) runtime.lastSeq = seq;
    this.onDshEvent(sessionId, runtime, type, data, seq, event);
  }

  private onDshEvent(
    sessionId: string,
    runtime: SessionRuntime,
    type: string,
    data: Record<string, unknown>,
    nativeSeq: number,
    native: unknown,
  ): void {
    const complete = (itemKey: string, kind: EventKind, eventData: EventData[EventKind], fallbackNative?: unknown): void => {
      // 数据不合格就降级为 unknown 并保留原始帧，绝不让前端拿到错的形状（F2）
      if (!isValidEventData(kind, eventData)) {
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey,
          kind: 'unknown',
          data: { nativeType: type },
          native: fallbackNative ?? { type, data },
          nativeSeq,
        });
        return;
      }
      this.emit(sessionId, { type: 'item.complete', itemKey, kind, data: eventData, nativeSeq, native });
    };

    switch (type) {
      case 'turn/start': {
        runtime.assistantKey = '';
        runtime.reasoningKey = '';
        this.emit(sessionId, { type: 'status', status: 'running' });
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: `turn-start-${nativeSeq}`,
          kind: 'turn.started',
          data: {},
          nativeSeq,
          native,
        });
        return;
      }
      case 'turn/end': {
        if (process.env['WDCC_DEBUG_DSH'] === '1') console.error('[dsh] turn/end', JSON.stringify(data).slice(0, 200));
        const reason = (data['reason'] ?? {}) as { kind?: string };
        const interrupted = reason.kind === 'interrupted' || reason.kind === 'cancelled' || reason.kind === 'aborted';
        const status = interrupted ? 'interrupted' : reason.kind === 'failed' || reason.kind === 'error' ? 'failed' : 'completed';
        complete(`turn-end-${nativeSeq}`, 'turn.completed', { status, durationMs: Date.now() - runtime.turnStartedAt });
        this.emit(sessionId, { type: 'status', status: 'idle' });
        return;
      }
      case 'assistant/message': {
        const message = (data['message'] ?? {}) as { content?: Record<string, unknown>[] };
        const content = message.content ?? [];
        const text = content.filter((block) => block['type'] === 'text').map((block) => String(block['text'] ?? '')).join('\n');
        const reasoning = content.filter((block) => block['type'] === 'reasoning').map((block) => String(block['text'] ?? '')).join('');
        if (reasoning !== '') complete(`reasoning-${nativeSeq}`, 'reasoning', { text: reasoning });
        if (text !== '') complete(`msg-${nativeSeq}`, 'assistant.message', { text, phase: 'final' });
        runtime.assistantText = '';
        return;
      }
      case 'tool/call': {
        if (process.env['WDCC_DEBUG_DSH'] === '1') console.error('[dsh] call', JSON.stringify(data).slice(0, 200));
        const name = String(data['name'] ?? '');
        const callId = String(data['callId'] ?? nativeSeq);
        const kind = toolKind(name);
        const input = (() => {
          try {
            return JSON.parse(String(data['arguments'] ?? '{}')) as Record<string, unknown>;
          } catch {
            return {};
          }
        })();
        const eventData: EventData[EventKind] =
          kind === 'command'
            ? { command: String(input['command'] ?? ''), status: 'running' }
            : kind === 'file.read'
              ? { path: String(input['file_path'] ?? input['pattern'] ?? '') }
              : { name, input, status: 'running' };
        runtime.toolCalls.set(callId, { itemKey: `tool-${callId}`, kind, data: eventData });
        this.emit(sessionId, { type: 'item.start', itemKey: `tool-${callId}`, kind, data: eventData, native });
        return;
      }
      case 'tool/result': {
        if (process.env['WDCC_DEBUG_DSH'] === '1') console.error('[dsh] result', JSON.stringify(data).slice(0, 200));
        const resultMessage = (data['message'] ?? {}) as Record<string, unknown>;
        const callId = String(data['toolCallId'] ?? resultMessage['toolCallId'] ?? resultMessage['callId'] ?? '');
        const item = runtime.toolCalls.get(callId);
        runtime.toolCalls.delete(callId);
        if (process.env['WDCC_DEBUG_DSH'] === '1') console.error('[dsh] result lookup', callId, item === undefined ? 'MISS' : item.kind);
        if (item === undefined) return;
        const payload = (data['message'] ?? {}) as { content?: { text?: string }[]; isError?: boolean };
        const output = (payload.content ?? []).map((part) => part.text ?? '').join('');
        const isError = payload.isError === true;
        if (item.kind === 'command') {
          this.emit(sessionId, {
            type: 'item.complete',
            itemKey: item.itemKey,
            kind: 'command',
            data: { ...(item.data as EventData['command']), status: isError ? 'failed' : 'completed', outputTail: output.slice(-4000) },
            nativeSeq,
            native,
          });
        } else if (item.kind === 'file.read') {
          this.emit(sessionId, { type: 'item.complete', itemKey: item.itemKey, kind: 'file.read', data: item.data as EventData['file.read'], nativeSeq, native });
        } else if (item.kind === 'file.change') {
          this.emit(sessionId, {
            type: 'item.complete',
            itemKey: item.itemKey,
            kind: 'file.change',
            data: { changes: [], status: isError ? 'failed' : 'completed' },
            nativeSeq,
            native,
          });
        } else {
          this.emit(sessionId, {
            type: 'item.complete',
            itemKey: item.itemKey,
            kind: item.kind,
            data: { ...(item.data as EventData['tool.call']), status: isError ? 'failed' : 'completed', output },
            nativeSeq,
            native,
          });
        }
        return;
      }
      case 'todo/write': {
        const todos = (data['todos'] as { content?: string; status?: string }[]) ?? [];
        complete(`plan-${nativeSeq}`, 'plan', {
          items: todos.map((todo) => ({
            text: String(todo.content ?? ''),
            status: todo.status === 'completed' ? 'completed' : todo.status === 'in_progress' ? 'in_progress' : 'pending',
          })),
        });
        return;
      }
      case 'session/title': {
        complete(`internal-title-${nativeSeq}`, 'internal', { nativeType: 'session/title' });
        return;
      }
      case 'user/message':
        return;
      default: {
        if (INTERNAL_EVENTS.has(type)) {
          complete(`internal-${type}-${nativeSeq}`, 'internal', { nativeType: type });
          return;
        }
        complete(`unknown-${type}-${nativeSeq}`, 'unknown', { nativeType: type });
      }
    }
  }

  private onAssistantStream(sessionId: string, value: Record<string, unknown>): void {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return;
    const frame = (value['frame'] ?? {}) as Record<string, unknown>;
    if (frame['type'] !== 'chunk') return;
    const chunk = (frame['chunk'] ?? {}) as Record<string, unknown>;
    const kind = String(chunk['type'] ?? '');
    if (kind === 'block-start') {
      const blockType = String(chunk['blockType'] ?? '');
      if (blockType === 'reasoning') {
        runtime.reasoningKey = `reasoning-live-${Date.now().toString(36)}`;
        this.emit(sessionId, { type: 'item.start', itemKey: runtime.reasoningKey, kind: 'reasoning', data: { text: '' } });
      } else {
        runtime.assistantKey = `msg-live-${Date.now().toString(36)}`;
        this.emit(sessionId, { type: 'item.start', itemKey: runtime.assistantKey, kind: 'assistant.message', data: { text: '' } });
      }
      return;
    }
    if (kind === 'text-delta') {
      if (runtime.assistantKey === '') {
        runtime.assistantKey = `msg-live-${Date.now().toString(36)}`;
        this.emit(sessionId, { type: 'item.start', itemKey: runtime.assistantKey, kind: 'assistant.message', data: { text: '' } });
      }
      this.emit(sessionId, { type: 'item.delta', itemKey: runtime.assistantKey, field: 'text', append: String(chunk['text'] ?? '') });
      return;
    }
    if (kind === 'reasoning-delta') {
      if (runtime.reasoningKey === '') {
        runtime.reasoningKey = `reasoning-live-${Date.now().toString(36)}`;
        this.emit(sessionId, { type: 'item.start', itemKey: runtime.reasoningKey, kind: 'reasoning', data: { text: '' } });
      }
      this.emit(sessionId, { type: 'item.delta', itemKey: runtime.reasoningKey, field: 'text', append: String(chunk['text'] ?? '') });
      return;
    }
    if (kind === 'usage') {
      const usage = (chunk['usage'] ?? {}) as { inputTokens?: number; outputTokens?: number };
      this.emit(sessionId, {
        type: 'item.complete',
        itemKey: `usage-${Date.now().toString(36)}`,
        kind: 'usage',
        data: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      });
    }
  }

  private onWaterfall(sessionId: string, value: Record<string, unknown>): void {
    const event = String(value['event'] ?? '');
    const eventId = String(value['eventId'] ?? '');
    const agentId = String(value['agentId'] ?? '');
    // $events 是全局流：按 nativeId 找到对应会话
    let target = sessionId;
    if (target === '') {
      for (const [localId, runtime] of this.sessions) {
        if (runtime.nativeId === agentId) {
          target = localId;
          break;
        }
      }
    }
    if (target === '') return;
    const runtime = this.sessions.get(target);
    if (runtime === undefined) return;
    const request = (value['request'] ?? {}) as Record<string, unknown>;

    if (event === 'approval/request') {
      runtime.pending.set(eventId, { kind: 'approval', eventId });
      this.emit(target, {
        type: 'item.complete',
        itemKey: `approval-${eventId}`,
        kind: 'approval.request',
        data: {
          approvalId: eventId,
          title: `DSH 请求使用 ${String(request['toolName'] ?? '工具')}`,
          detail: JSON.stringify(request, null, 2).slice(0, 2000),
          options: [
            { id: 'allowed-once', label: '允许一次' },
            { id: 'rejected', label: '拒绝' },
          ],
        },
      });
      this.emit(target, { type: 'status', status: 'waiting' });
      return;
    }

    if (event === 'user-questions/request') {
      runtime.pending.set(eventId, { kind: 'question', eventId });
      const questions = (request['questions'] as Record<string, unknown>[]) ?? [];
      const first = questions[0] ?? {};
      this.emit(target, {
        type: 'item.complete',
        itemKey: `question-${eventId}`,
        kind: 'question',
        data: {
          questionId: eventId,
          prompt: String(first['question'] ?? '请回答'),
          ...(first['header'] === undefined ? {} : { header: String(first['header']) }),
          options: ((first['options'] as Record<string, unknown>[]) ?? []).map((option) => ({
            id: String(option['label'] ?? ''),
            label: String(option['label'] ?? ''),
            ...(option['description'] === undefined ? {} : { description: String(option['description']) }),
          })),
          multiSelect: first['multiSelect'] === true,
          allowsFreeText: true,
        },
      });
      this.emit(target, { type: 'status', status: 'waiting' });
    }
  }
}
