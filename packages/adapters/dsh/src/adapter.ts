import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
  TraceSink,
  TraceFrame,
} from '@webdcc/protocol';
import { buildFileChanges, isValidEventData, traceFrame, ulid } from '@webdcc/protocol';
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
  traceSink?: TraceSink;
  traceSinkFactory?: (sessionId: string) => TraceSink;
  nativeRecorder?: { directory: string; module: string };
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
  'settings/describe',
  'settings/update',
  'credentials/set',
  'commands/execute',
  'commands/list',
  'subagents/prompt',
  'subagents/interruptByUser',
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
  'request/context',
  'system/message',
  'session/title-llm-request',
  'session-log-deepseek/delivery-accepted',
  'assistant/attempt',
  'llm/retry',
  'llm/retry-started',
]);

interface PendingInteraction {
  kind: 'approval' | 'question';
  eventId: string;
  questionIds?: string[];
  answers?: Map<string, { id: string; selected: string[]; custom?: string }>;
}

interface SessionRuntime {
  nativeId: string;
  workspaceId: string;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string;
  followStream: string | null;
  lastSeq: number;
  turnStartedAt: number;
  pending: Map<string, PendingInteraction>;
  toolCalls: Map<string, { itemKey: string; kind: EventKind; data: EventData[EventKind]; name: string; input: Record<string, unknown> }>;
  /** callId → 工具入参：审批请求里只有 toolName 和 callId，标题需要从工具调用取命令（F11） */
  toolInputs: Map<string, Record<string, unknown>>;
  assistantKey: string;
  assistantText: string;
  reasoningKey: string;
  reasoningText: string;
  streamedAssistant: boolean;
  streamedReasoning: boolean;
  generationStartedAt: number | null;
  frameSeq: number;
}

interface DshCatalogModel {
  id?: string;
  name?: string;
}

interface DshCatalogGroup {
  id?: string;
  models?: DshCatalogModel[];
}

interface DshModelCatalog {
  default?: { provider?: string; model?: string };
  models?: DshCatalogModel[];
  groups?: DshCatalogGroup[];
}

/** Return the provider required by DSH's session/selectModel RPC. */
export function providerForModel(catalog: DshModelCatalog, model: string): string | undefined {
  for (const group of catalog.groups ?? []) {
    if (typeof group.id === 'string' && (group.models ?? []).some((candidate) => candidate.id === model)) return group.id;
  }
  if (catalog.default?.model === model && typeof catalog.default.provider === 'string') return catalog.default.provider;
  return undefined;
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
  private traceSeq = 0;
  private readonly traceSinks = new Map<string, TraceSink>();
  private trace(sessionId: string, dir: 'in' | 'out', ch: string, frame: unknown): void {
    traceFrame(this.options.traceSink ?? this.traceSinks.get(sessionId) ?? this.options.traceSinkFactory?.(sessionId || 'dsh-host'), { i: ++this.traceSeq, t: 0, dir, ch, frame });
  }

  constructor(options: DshAdapterOptions = {}) {
    this.options = options;
  }

  /** Recorded mux frames pass through the live stream and event handlers. */
  static replay(sessionId = 'replay'): { feed: (frame: TraceFrame) => AdapterEvent[]; adapter: DshAdapter; replies: unknown[] } {
    const adapter = new DshAdapter();
    const runtime: SessionRuntime = {
      nativeId: '', workspaceId: '', followStream: null, lastSeq: 0, turnStartedAt: 0,
      pending: new Map(), toolCalls: new Map(), toolInputs: new Map(), assistantKey: '', assistantText: '',
      reasoningKey: '', reasoningText: '', streamedAssistant: false, streamedReasoning: false, generationStartedAt: null, frameSeq: 0,
    };
    adapter.sessions.set(sessionId, runtime);
    const replies: unknown[] = [];
    adapter.client = { rpc: async (endpoint: string, args: unknown) => { replies.push({ endpoint, args }); return { accepted: true }; } } as unknown as DshHostClient;
    let events: AdapterEvent[] = [];
    adapter.onEvent((_id, event) => events.push(event));
    return { adapter, replies, feed(frame) {
      events = []; adapter.replayTime = frame.t;
      if (frame.dir === 'in' && frame.ch.startsWith('mux:')) adapter.onEventFrame(sessionId, frame.frame as StreamFrame);
      return events.length > 0 ? [...events] : [{ type: 'item.complete', itemKey: `transport-${frame.ch}-${frame.i}`, kind: 'internal', data: { nativeType: frame.ch }, native: frame.frame }];
    } };
  }

  private replayTime?: number;
  private now(): number { return this.replayTime ?? Date.now(); }

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
      if (running !== undefined && this.booting === null && running !== this.sidecar?.child.pid) {
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

  /** DSH 的模型列表来自 `session/modelCatalog`（NEW-06 / AG-*-12） */
  async listModels(): Promise<ModelOption[]> {
    try {
      const client = await this.ensureSidecar();
      // 形状：{ default, routableProviders, groups: [{ id, name, models: [{ id, name }] }] }
      const catalog = await this.modelCatalog(client);
      const flat = catalog.models ?? (catalog.groups ?? []).flatMap((group) => group.models ?? []);
      return flat
        .filter((model) => typeof model.id === 'string')
        .map((model) => ({ id: String(model.id), label: String(model.name ?? model.id) }));
    } catch {
      return [];
    }
  }

  private async modelCatalog(client: DshHostClient): Promise<DshModelCatalog> {
    return this.call<DshModelCatalog>(client, 'session/modelCatalog', {});
  }

  private async selectModel(client: DshHostClient, runtime: SessionRuntime, model: string, reasoningEffort?: string): Promise<void> {
    const catalog = await this.modelCatalog(client);
    const provider = providerForModel(catalog, model);
    if (provider === undefined) throw new Error(`dsh: 模型 ${model} 不在当前 Provider 目录中`);
    const request = {
      sessionId: runtime.nativeId,
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    };
    await this.call(client, 'session/selectModel', { request });
    runtime.model = model;
    runtime.modelProvider = provider;
    if (reasoningEffort !== undefined) runtime.reasoningEffort = reasoningEffort;
  }

  accessModes(): { id: string; label: string }[] {
    return ACCESS_MODES;
  }

  /** 3.3 的机器检查入口：只启动一个只监听 127.0.0.1 的侧车 */
  buildLaunchSpec(): LaunchSpec {
    const port = String(this.options.port ?? process.env['WDCC_DSH_PORT'] ?? 3091);
    const recorder = this.options.nativeRecorder;
    const patch = recorder === undefined ? undefined : join(recorder.directory, 'dsh-recorder.patch.yml');
    if (patch !== undefined && recorder !== undefined) writeFileSync(patch, `- insert:\n    - id: webdcc-native-http-recorder\n      name: ${JSON.stringify(recorder.module)}\n`, { mode: 0o600 });
    return {
      command: this.options.command ?? 'dsh',
      args: ['web', ...(patch === undefined ? [] : ['--patch', patch]), '--no-open', '--port', port, '--host', '127.0.0.1'],
      env: { ...(this.options.env ?? {}), ...(recorder === undefined ? {} : { WDCC_TRACE_DIR: recorder.directory, NODE_OPTIONS: `${this.options.env?.['NODE_OPTIONS'] ?? process.env['NODE_OPTIONS'] ?? ''} --require ${recorder.module}`.trim() }) },
    };
  }

  private async ensureSidecar(): Promise<DshHostClient> {
    if (this.client !== null) return this.client;
    // Metadata/model discovery and session creation can arrive concurrently.
    // A process started by this adapter belongs to the pending boot, rather
    // than being an unrelated host using the same native home.
    if (this.booting !== null) {
      await this.booting;
      if (this.client !== null) return this.client;
      throw new Error('dsh: 侧车启动失败');
    }
    if ((this.options.mode ?? 'spawn') === 'attach') {
      this.booting ??= (async () => {
        const url = new URL(this.options.attachUrl ?? 'http://127.0.0.1:3080');
        const cookie = this.options.attachCookie ?? '';
        if (cookie === '') throw Object.assign(new Error('需要重新连接 DSH：请粘贴 DSH 当前的访问链接'), { code: 'dsh-needs-link' });
        const client = new DshHostClient(url.origin);
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
        port: this.options.port ?? Number(process.env['WDCC_DSH_PORT'] ?? 3091),
        env: { ...process.env, ...spec.env },
        ...(spec.command === undefined ? {} : { command: spec.command }),
        args: spec.args,
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

  /** 斜杠命令目录（F8 / SL-02）：来自 DSH 的 commands/list */
  async slashCommands(sessionId: string): Promise<{ name: string; description?: string }[]> {
    const runtime = this.sessions.get(sessionId);
    const client = await this.ensureSidecar().catch(() => null);
    if (client === null) return [];
    try {
      const result = await this.call<{ commands?: { name?: string; description?: string }[] } | { name?: string; description?: string }[]>(client, 'commands/list', {
        agentId: runtime?.nativeId ?? '',
      });
      const commands = Array.isArray(result) ? result : result.commands ?? [];
      return commands
        .filter((command) => typeof command.name === 'string')
        .map((command) => ({ name: `/${String(command.name)}`, ...(command.description === undefined ? {} : { description: command.description }) }));
    } catch {
      return [];
    }
  }

  async sendSubagent(sessionId: string, childSessionId: string, text: string): Promise<void> {
    this.require(sessionId);
    const client = await this.ensureSidecar();
    await this.call(client, 'subagents/prompt', {
      requestId: ulid(),
      childSessionId,
      delivery: 'queue',
      content: [{ type: 'text', text }],
    });
  }

  async interruptSubagent(sessionId: string, childSessionId: string): Promise<void> {
    this.require(sessionId);
    const client = await this.ensureSidecar();
    await this.call(client, 'subagents/interruptByUser', { childSessionId });
  }

  /** 运行中切换访问模式（F6）：/permission <preset> 只影响这一个会话 */
  async setAccessMode(sessionId: string, mode: string): Promise<{ accessMode: string }> {
    const runtime = this.require(sessionId);
    const client = await this.ensureSidecar();
    await this.permission(client, runtime.nativeId, mode);
    return { accessMode: mode };
  }

  private async permission(client: DshHostClient, nativeId: string, accessMode: string | undefined): Promise<void> {
    if (accessMode === undefined) return;
    const line = `/permission ${accessMode}`;
    if (!isAllowedCommandLine(line)) throw new Error(`dsh: 不允许的 commands/execute line: ${line}`);
    await this.call(client, 'commands/execute', { agentId: nativeId, line, submittedAttachments: [] });
  }

  /** 所有 RPC 都经过白名单检查 */
  private async call<T>(client: DshHostClient, endpoint: string, args: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (!isAllowedEndpoint(endpoint)) throw new Error(`dsh: 端点不在白名单内：${endpoint}`);
    const request = (args['request'] ?? {}) as Record<string, unknown>;
    const nativeId = args['agentId'] ?? args['sessionId'] ?? request['sessionId'];
    const owner = sessionId ?? [...this.sessions].find(([, runtime]) => runtime.nativeId === nativeId)?.[0] ?? '';
    const requestId = ++this.traceSeq;
    this.trace(owner, 'out', `rpc:${endpoint}`, { requestId, endpoint, args });
    try {
      const result = await client.rpc<T>(endpoint, args);
      this.trace(owner, 'in', `rpc:${endpoint}`, { requestId, endpoint, result });
      return result;
    } catch (error) {
      this.trace(owner, 'in', `rpc:${endpoint}`, { requestId, endpoint, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async create(opts: CreateOpts): Promise<{ nativeId: string }> {
    if (opts.traceSink !== undefined) this.traceSinks.set(opts.sessionId, opts.traceSink);
    const client = await this.ensureSidecar();
    const workspace = await this.call<{ workspace: { workspaceId: string } }>(client, 'workspace/create', {
      request: { path: opts.cwd },
    }, opts.sessionId);
    const created = await this.call<{ sessionId: string }>(client, 'session/create', {
      request: { workspaceId: workspace.workspace.workspaceId },
    }, opts.sessionId);
    const runtime: SessionRuntime = {
      nativeId: created.sessionId,
      workspaceId: workspace.workspace.workspaceId,
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(opts.reasoningEffort === undefined ? {} : { reasoningEffort: opts.reasoningEffort }),
      followStream: null,
      lastSeq: 0,
      turnStartedAt: 0,
      pending: new Map(),
      toolCalls: new Map(),
      toolInputs: new Map(),
      assistantKey: '',
      assistantText: '',
      reasoningKey: '',
      reasoningText: '',
      streamedAssistant: false,
      streamedReasoning: false,
      generationStartedAt: null,
      frameSeq: 0,
    };
    this.sessions.set(opts.sessionId, runtime);
    try {
      await this.permission(client, created.sessionId, opts.accessMode);
      if (opts.model !== undefined && opts.model !== '') await this.selectModel(client, runtime, opts.model, opts.reasoningEffort);
    } catch (error) { this.sessions.delete(opts.sessionId); throw error; }
    this.openFollow(opts.sessionId, runtime);
    return { nativeId: created.sessionId };
  }

  async resume(opts: CreateOpts & { nativeId: string }): Promise<void> {
    if (opts.traceSink !== undefined) this.traceSinks.set(opts.sessionId, opts.traceSink);
    const client = await this.ensureSidecar();
    const workspace = await this.call<{ workspace: { workspaceId: string } }>(client, 'workspace/create', {
      request: { path: opts.cwd },
    }, opts.sessionId);
    const runtime: SessionRuntime = {
      nativeId: opts.nativeId,
      workspaceId: workspace.workspace.workspaceId,
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(opts.reasoningEffort === undefined ? {} : { reasoningEffort: opts.reasoningEffort }),
      followStream: null,
      lastSeq: 0,
      turnStartedAt: 0,
      pending: new Map(),
      toolCalls: new Map(),
      toolInputs: new Map(),
      assistantKey: '',
      assistantText: '',
      reasoningKey: '',
      reasoningText: '',
      streamedAssistant: false,
      streamedReasoning: false,
      generationStartedAt: null,
      frameSeq: 0,
    };
    this.sessions.set(opts.sessionId, runtime);
    this.openFollow(opts.sessionId, runtime);
  }

  private openFollow(sessionId: string, runtime: SessionRuntime): void {
    const client = this.client;
    if (client === null) return;
    this.trace(sessionId, 'out', 'openStream:session/follow', { request: { address: { kind: 'session', sessionId: runtime.nativeId }, activate: true, assistantStream: true } });
    runtime.followStream = client.openStream(
      'session/follow',
      { request: { address: { kind: 'session', sessionId: runtime.nativeId }, activate: true, assistantStream: true } },
      (frame) => this.onEventFrame(sessionId, frame),
    );
  }

  async send(sessionId: string, input: UserInput): Promise<void> {
    const client = await this.ensureSidecar();
    const runtime = this.require(sessionId);
    this.trace(sessionId, 'out', 'input', input);
    // 第一行是命令时走 commands/execute，不走 session/prompt（F8 / SL-02）
    const firstLine = input.text.split(/\r?\n/)[0] ?? '';
    if (firstLine.startsWith('/') && isAllowedCommandLine(firstLine.trim(), input.text)) {
      await this.call(client, 'commands/execute', { agentId: runtime.nativeId, line: firstLine.trim(), submittedAttachments: [] });
      this.emit(sessionId, {
        type: 'item.complete',
        itemKey: `command-${++runtime.frameSeq}`,
        kind: 'internal',
        data: { nativeType: 'commands/execute', line: firstLine.trim() } as unknown as EventData[EventKind],
      });
      this.emit(sessionId, {
        type: 'turn.end',
        status: 'completed',
      });
      return;
    }
    runtime.turnStartedAt = this.now();
    const content: Record<string, unknown>[] = [{ type: 'text', text: input.text }];
    for (const image of input.images ?? []) {
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mime)) throw new Error(`DSH 不支持图片格式 ${image.mime}`);
      content.push({ type: 'image', mediaType: image.mime, data: readFileSync(image.path).toString('base64') });
    }
    await this.call(client, 'session/prompt', {
      request: { requestId: ulid(), sessionId: runtime.nativeId, mode: 'queue', content },
    });
  }

  /** 运行中换模型（AG-*-12）：DSH 用 session/selectModel */
  async setModel(sessionId: string, model: string): Promise<void> {
    const runtime = this.require(sessionId);
    const client = await this.ensureSidecar();
    await this.selectModel(client, runtime, model);
  }

  async setReasoningEffort(sessionId: string, effort: string): Promise<void> {
    const runtime = this.require(sessionId);
    const client = await this.ensureSidecar();
    let model = runtime.model;
    if (model === undefined || model === '') {
      const catalog = await this.modelCatalog(client);
      model = catalog.default?.model;
    }
    if (model === undefined || model === '') throw new Error('dsh: 当前会话没有可切换思考强度的模型');
    await this.selectModel(client, runtime, model, effort);
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

  /** 打断时把自己挂起的审批标成 cancelled（只处理本会话的） */
  async cancelPending(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return;
    const client = await this.ensureSidecar().catch(() => null);
    for (const [eventId, pending] of runtime.pending) {
      runtime.pending.delete(eventId);
      if (client === null) continue;
      if (pending.kind === 'approval') {
        await this.call(client, '$events/result', {
          clientId: this.clientId,
          eventId,
          outcome: { kind: 'result', value: 'cancelled' },
        }).catch(() => undefined);
      }
    }
  }

  async answer(sessionId: string, questionId: string, answer: unknown): Promise<void> {
    const client = await this.ensureSidecar();
    const runtime = this.require(sessionId);
    const entry = [...runtime.pending].find(([eventId, pending]) => pending.kind === 'question' && (questionId === eventId || pending.questionIds?.some(id => `${eventId}:${id}` === questionId)));
    if (entry === undefined) throw new Error('DSH 问题已结束或不存在');
    const [eventId, pending] = entry;
    const id = questionId === eventId ? pending.questionIds?.[0] ?? questionId : questionId.slice(eventId.length + 1);
    const value = (answer as { selected?: string[]; custom?: string; value?: string | string[]; text?: string }) ?? {};
    const selected = value.selected ?? (Array.isArray(value.value) ? value.value : value.value === undefined ? [] : [value.value]);
    const custom = value.custom ?? value.text;
    pending.answers ??= new Map();
    pending.answers.set(id, { id, selected, ...(custom === undefined || custom === '' ? {} : { custom }) });
    if (pending.answers.size < (pending.questionIds?.length ?? 1)) return;
    runtime.pending.delete(eventId);
    await this.call(client, '$events/result', { clientId: this.clientId, eventId, outcome: { kind: 'result', value: { answers: [...pending.answers.values()] } } }, sessionId);
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
    const owner = sessionId || [...this.sessions].find(([, runtime]) => runtime.nativeId === value?.['agentId'])?.[0] || '';
    this.trace(owner, 'in', 'mux:$events', frame);
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

  private nativeTurnId(data: Record<string, unknown>): string | undefined {
    const value = data['turnId'] ?? data['turn_id'];
    return typeof value === 'string' ? value : undefined;
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
          nativeTurnId: this.nativeTurnId(data),
        });
        return;
      }
        this.emit(sessionId, { type: 'item.complete', itemKey, kind, data: eventData, nativeSeq, native, nativeTurnId: this.nativeTurnId(data) });
    };

    switch (type) {
      case 'subagent/catalog':
      case 'subagent/start':
      case 'subagent/updated':
      case 'subagent/end': {
        const childId = String(data['childId'] ?? data['child_id'] ?? data['agentId'] ?? '');
        const label = String(data['label'] ?? data['name'] ?? data['mode'] ?? 'DSH 子 Agent');
        const terminal = type === 'subagent/end' || data['status'] === 'completed' || data['status'] === 'failed';
        complete(`subagent-${childId || nativeSeq}`, 'tool.call', {
          name: 'subagent',
          label,
          input: { childId, ...(data['name'] === undefined ? {} : { name: String(data['name']) }), ...(data['mode'] === undefined ? {} : { mode: String(data['mode']) }), ...(data['status'] === undefined ? {} : { status: String(data['status']) }) },
          status: terminal ? 'completed' : 'running',
        });
        return;
      }
      case 'turn/start': {
        runtime.assistantKey = '';
        runtime.assistantText = '';
        runtime.reasoningKey = '';
        runtime.reasoningText = '';
        runtime.streamedAssistant = false;
        runtime.streamedReasoning = false;
        runtime.generationStartedAt = null;
        this.emit(sessionId, {
          type: 'turn.start',
          nativeTurnId: this.nativeTurnId(data),
          native,
        });
        return;
      }
      case 'turn/end': {
        if (process.env['WDCC_DEBUG_DSH'] === '1') console.error('[dsh] turn/end', JSON.stringify(data).slice(0, 200));
        this.finishLiveAssistant(sessionId, runtime);
        this.finishLiveReasoning(sessionId, runtime);
        const reason = (data['reason'] ?? {}) as { kind?: string };
        const interrupted = reason.kind === 'interrupted' || reason.kind === 'cancelled' || reason.kind === 'aborted';
        const status = interrupted ? 'interrupted' : reason.kind === 'failed' || reason.kind === 'error' ? 'failed' : 'completed';
        this.emit(sessionId, { type: 'turn.end', nativeTurnId: this.nativeTurnId(data), status, native });
        return;
      }
      case 'assistant/message': {
        const message = (data['message'] ?? {}) as { content?: Record<string, unknown>[] };
        const content = message.content ?? [];
        const text = content.filter((block) => block['type'] === 'text').map((block) => String(block['text'] ?? '')).join('\n');
        const reasoning = content.filter((block) => block['type'] === 'reasoning').map((block) => String(block['text'] ?? '')).join('');
        if (runtime.reasoningKey !== '') {
          this.finishLiveReasoning(sessionId, runtime, reasoning === '' ? undefined : reasoning);
        } else if (reasoning !== '' && !runtime.streamedReasoning) {
          complete(`reasoning-${nativeSeq}`, 'reasoning', { text: reasoning, summary: true });
        }
        if (runtime.assistantKey !== '') {
          this.finishLiveAssistant(sessionId, runtime, text === '' ? undefined : text);
        } else if (text !== '' && !runtime.streamedAssistant) {
          complete(`msg-${nativeSeq}`, 'assistant.message', { text });
        }
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
              : kind === 'file.change' ? { changes: buildFileChanges(name, input), status: 'running' }
              : { name, input, status: 'running' };
        runtime.toolCalls.set(callId, { itemKey: `tool-${callId}`, kind, data: eventData, name, input });
        runtime.toolInputs.set(callId, input);
        this.emit(sessionId, { type: 'item.start', itemKey: `tool-${callId}`, kind, data: eventData, native, nativeTurnId: this.nativeTurnId(data) });
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
            nativeTurnId: this.nativeTurnId(data),
          });
        } else if (item.kind === 'file.read') {
          this.emit(sessionId, { type: 'item.complete', itemKey: item.itemKey, kind: 'file.read', data: item.data as EventData['file.read'], nativeSeq, native, nativeTurnId: this.nativeTurnId(data) });
        } else if (item.kind === 'file.change') {
          // C2：DSH 的 write/edit 结果不带 diff，用入参算 hunk（第 2/3 级）
          this.emit(sessionId, {
            type: 'item.complete',
            itemKey: item.itemKey,
            kind: 'file.change',
            data: { changes: buildFileChanges(item.name, item.input), status: isError ? 'failed' : 'completed' },
            nativeSeq,
            native,
            nativeTurnId: this.nativeTurnId(data),
          });
        } else {
          this.emit(sessionId, {
            type: 'item.complete',
            itemKey: item.itemKey,
            kind: item.kind,
            data: { ...(item.data as EventData['tool.call']), status: isError ? 'failed' : 'completed', output },
            nativeSeq,
            native,
            nativeTurnId: this.nativeTurnId(data),
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
      case 'approval/decided': {
        // F17：审批在别的界面被处理了 → 发 approval.resolved，by='other'
        const approvalId = String(data['eventId'] ?? data['approvalId'] ?? data['requestId'] ?? '');
        const pending = runtime.pending.get(approvalId);
        if (approvalId === '' || pending === undefined) {
          complete(`internal-decided-${nativeSeq}`, 'internal', { nativeType: type });
          return;
        }
        runtime.pending.delete(approvalId);
        const raw = String(data['decision'] ?? data['optionId'] ?? data['option'] ?? data['result'] ?? 'allowed-once');
        const optionId = /reject|deny|declin/i.test(raw) ? 'rejected' : /cancel/i.test(raw) ? 'cancelled' : 'allowed-once';
        complete(`approval-resolved-${nativeSeq}`, 'approval.resolved', { approvalId, optionId, by: 'other' });
        return;
      }
      case 'user-questions/answered': {
        const questionId = String(data['eventId'] ?? data['questionId'] ?? '');
        const pending = runtime.pending.get(questionId);
        if (pending !== undefined) runtime.pending.delete(questionId);
        complete(`internal-answered-${nativeSeq}`, 'internal', { nativeType: type });
        return;
      }
      case 'session/title': {
        const title = String(data['title'] ?? data['name'] ?? '');
        complete(`internal-title-${nativeSeq}`, 'internal', { nativeType: 'session/title', ...(title === '' ? {} : { title }) } as unknown as EventData[EventKind]);
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
    if (runtime.generationStartedAt === null) runtime.generationStartedAt = this.now();
    if (kind === 'block-start') {
      const blockType = String(chunk['blockType'] ?? '');
      if (blockType === 'reasoning') {
        this.finishLiveAssistant(sessionId, runtime);
        this.finishLiveReasoning(sessionId, runtime);
        runtime.reasoningKey = `reasoning-live-${++runtime.frameSeq}`;
        runtime.reasoningText = '';
        this.emit(sessionId, { type: 'item.start', itemKey: runtime.reasoningKey, kind: 'reasoning', data: { text: '' } });
      } else {
        this.finishLiveReasoning(sessionId, runtime);
        this.finishLiveAssistant(sessionId, runtime);
        runtime.assistantKey = `msg-live-${++runtime.frameSeq}`;
        runtime.assistantText = '';
        this.emit(sessionId, { type: 'item.start', itemKey: runtime.assistantKey, kind: 'assistant.message', data: { text: '' } });
      }
      return;
    }
    if (kind === 'block-end') {
      const blockType = String(chunk['blockType'] ?? '');
      if (blockType === 'reasoning' || (blockType === '' && runtime.reasoningKey !== '' && runtime.assistantKey === '')) this.finishLiveReasoning(sessionId, runtime);
      else this.finishLiveAssistant(sessionId, runtime);
      return;
    }
    if (kind === 'text-delta') {
      if (runtime.assistantKey === '') {
        runtime.assistantKey = `msg-live-${++runtime.frameSeq}`;
        this.emit(sessionId, { type: 'item.start', itemKey: runtime.assistantKey, kind: 'assistant.message', data: { text: '' } });
      }
      const text = String(chunk['text'] ?? '');
      runtime.assistantText += text;
      this.emit(sessionId, { type: 'item.delta', itemKey: runtime.assistantKey, field: 'text', append: text });
      return;
    }
    if (kind === 'reasoning-delta') {
      if (runtime.reasoningKey === '') {
        runtime.reasoningKey = `reasoning-live-${++runtime.frameSeq}`;
        this.emit(sessionId, { type: 'item.start', itemKey: runtime.reasoningKey, kind: 'reasoning', data: { text: '' } });
      }
      const text = String(chunk['text'] ?? '');
      runtime.reasoningText += text;
      this.emit(sessionId, { type: 'item.delta', itemKey: runtime.reasoningKey, field: 'text', append: text });
      return;
    }
    if (kind === 'usage') {
      const usage = (chunk['usage'] ?? {}) as { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
      const generationMs = runtime.generationStartedAt === null ? undefined : Math.max(1, this.now() - runtime.generationStartedAt);
      runtime.generationStartedAt = null;
      this.emit(sessionId, {
        type: 'item.complete',
        itemKey: `usage-${++runtime.frameSeq}`,
        kind: 'usage',
        data: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadInputTokens: usage.cacheReadTokens, cacheCreationInputTokens: usage.cacheWriteTokens, scope: 'attempt', ...(generationMs === undefined ? {} : { generationMs }) },
        native: chunk,
      });
    }
  }

  private finishLiveAssistant(sessionId: string, runtime: SessionRuntime, finalText?: string): void {
    if (runtime.assistantKey === '') return;
    const text = finalText ?? runtime.assistantText;
    const itemKey = runtime.assistantKey;
    runtime.assistantKey = '';
    runtime.assistantText = '';
    runtime.streamedAssistant = true;
    this.emit(sessionId, { type: 'item.complete', itemKey, kind: 'assistant.message', data: { text } });
  }

  private finishLiveReasoning(sessionId: string, runtime: SessionRuntime, finalText?: string): void {
    if (runtime.reasoningKey === '') return;
    const text = finalText ?? runtime.reasoningText;
    const itemKey = runtime.reasoningKey;
    runtime.reasoningKey = '';
    runtime.reasoningText = '';
    runtime.streamedReasoning = true;
    this.emit(sessionId, { type: 'item.complete', itemKey, kind: 'reasoning', data: { text, summary: true } });
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
      if (process.env['WDCC_DEBUG_DSH'] === '1') console.error('[dsh] approval/request', JSON.stringify(value).slice(0, 1200));
      runtime.pending.set(eventId, { kind: 'approval', eventId });
      const toolName = String(request['toolName'] ?? '工具');
      const callId = String(request['callId'] ?? '');
      const args = {
        ...(runtime.toolInputs.get(callId) ?? {}),
        ...((request['args'] ?? request['input'] ?? request['arguments'] ?? {}) as Record<string, unknown>),
      };
      const subject = String(args['command'] ?? args['file_path'] ?? args['path'] ?? '');
      const displayReason = ((request['displayReason'] ?? {}) as { zh?: string }).zh ?? '';
      this.emit(target, {
        type: 'item.complete',
        itemKey: `approval-${eventId}`,
        kind: 'approval.request',
        data: {
          approvalId: eventId,
          // F11：标题是工具名 + 命令原文（等宽显示）或文件路径
          title: subject === '' ? toolName : `${toolName} · ${subject}`,
          tool: toolName,
          ...(displayReason !== ''
            ? { reason: displayReason }
            : typeof request['reason'] === 'string' && String(request['reason']) !== ''
              ? { reason: request['reason'] }
              : {}),
          detail: JSON.stringify(request, null, 2).slice(0, 2000),
          options: [
            { id: 'allowed-once', label: '允许一次' },
            { id: 'rejected', label: '拒绝' },
          ],
        },
      });
      return;
    }

    if (event === 'user-questions/request') {
      const questions = (request['questions'] as Record<string, unknown>[]) ?? [];
      const ids = questions.map((question, index) => String(question['id'] ?? index));
      runtime.pending.set(eventId, { kind: 'question', eventId, questionIds: ids });
      for (const [index, first] of questions.entries()) this.emit(target, {
        type: 'item.complete',
        itemKey: `question-${eventId}-${ids[index]}`,
        kind: 'question',
        data: {
          questionId: `${eventId}:${ids[index]}`,
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
    }
  }
}
