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
  NativeHistoryRecord,
  AnswerSubmission,
  AccessModeOption,
  NativeInteractionSubmission,
  NativeDshRpcCaptureMetadata,
} from '@webdcc/protocol';
import { buildFileChanges, isValidEventData, traceFrame, ulid, normalizeQuestionAnswer, nativeAccessMode } from '@webdcc/protocol';
import { dshBaseUrl, DshHostClient, DshRpcError, startSidecar, type Sidecar, type StreamFrame, type DshRpcObservation, type DshBinaryUploadObservation } from './host.js';
import type { DshHistoryRecord, DshSubagentPrompt, DshSubagentInterrupt } from './contracts.js';
import { DshHistoryBridge, type DshOpening } from './history.js';
import { DshAssistantBridge } from './assistant.js';
import { readDshHostIdentity, requireDshBaseline, type DshHostIdentity } from './identity.js';
import { DSH_NATIVE_CONTROLS, dshNativeActionMetadata, dshNativeCall, dshNativeError, dshPublicValue, dshRevision, parseDshNativeAction } from './native.js';
import { DshWorkspaceBridge } from './workspaces.js';
import { dshInputCapabilities, dshInputRoute, type DshInputModality } from './input-capabilities.js';
import { dshInputParts, dshInputUnsupported, encodeDshInput, validateDshInputParts, type DshResolvableInput, type DshResolvedAttachment } from './input.js';

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
  attachBrowserCookie?: string;
  traceSink?: TraceSink;
  traceSinkFactory?: (sessionId: string) => TraceSink;
  nativeRecorder?: { directory: string; module: string; env?: Record<string, string> };
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
  'session/control',
  'session/state',
  'session/projections',
  'session/search',
  'session/rename',
  'session/fork',
  'workspace/pinSession',
  'workspace/unpinSession',
  'workspace/archiveSession',
  'workspace/unarchiveSession',
  'agentPresets/list',
  'agentPresets/read',
  'agentPresets/select',
  'skills/list',
  'pluginInventory/list',
  'llm/listProviders',
  'llm/listConfigurableProviders',
  'llm/discoverModels',
  'goals/get',
  'goals/create',
  'goals/edit',
  'goals/pause',
  'goals/resume',
  'goals/complete',
  'goals/clear',
  'schedule/catalog',
  'schedule/list',
  'schedule/view',
  'schedule/history',
  'schedule/create',
  'schedule/edit',
  'schedule/run',
  'job/list',
  'job/kill',
  'actionCards/act',
  'forgePanel/follow',
  'forgePanel/branches',
  'forgePanel/requestWorktree',
  'forgePanel/cancelWorktree',
  'forgePanel/restoreWorktree',
  'forgePanel/retryWorktree',
  'forgePanel/stopCreation',
  'forgePanel/refresh',
  'session/follow',
  'session/observeProjections',
  'session/page',
  'session/prompt',
  'session/cancel',
  'session/modelCatalog',
  'session/selectModel',
  'settings/describe',
  'permissionPresets/catalog',
  'settings/update',
  'settings/mutate',
  'credentials/set',
  'commands/execute',
  'commands/list',
  'subagents/prompt',
  'subagents/interruptByParent',
  '$events',
  '$events/result',
  'userQuestions/answer',
  'userQuestions/attachWait',
]);

export function isAllowedEndpoint(endpoint: string): boolean {
  return ALLOWED_ENDPOINTS.has(endpoint);
}

/** Finite unary discovery methods that remain readable after capture loss. */
const DSH_READ_RPC_ENDPOINTS: ReadonlySet<string> = new Set([
  'session/list', 'session/search', 'session/state', 'session/projections', 'session/page', 'session/modelCatalog',
  'agentPresets/list', 'agentPresets/read', 'skills/list', 'pluginInventory/list', 'llm/listProviders', 'goals/get',
  'schedule/catalog', 'schedule/list', 'schedule/view', 'schedule/history', 'forgePanel/branches', 'settings/describe',
  'permissionPresets/catalog', 'commands/list',
  'llm/listConfigurableProviders', 'llm/discoverModels',
]);

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
  callId?: string;
  durableId?: string;
  generation?: number;
  continued?: boolean;
  sent?: boolean;
  waitStream?: string;
  remainingMs?: number;
}

interface SessionRuntime {
  identity?: CreateOpts['runtime'];
  envelopeId?: number;
  nativeId: string;
  workspaceId: string;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string;
  followStream: string | null;
  permissionStream?: string;
  lastSeq: number;
  turnStartedAt: number;
  pending: Map<string, PendingInteraction>;
  children: Map<string, string>;
  approvals: Map<string, { callId?: string; toolName: string; eventId?: string }>;
  history?: DshHistoryBridge;
  historyRecord?: NativeHistoryRecord;
  historyRecords?: NativeHistoryRecord[];
  nativeTurnId?: string;
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
  assistantBridge?: DshAssistantBridge;
  assistantBuffered?: Record<string, unknown>[];
  assistantKeys?: Set<string>;
  assistantSettlements?: Map<number, { type: string; data: Record<string, unknown>; native: unknown; envelopeId?: number }>;
  projections?: { asOfSeq: number; values: Record<string, unknown> };
  modelObservation?: { provider?: string; model?: string; reasoningEffort?: string; source: string; nativeSeq?: number };
  controlState?: unknown;
}

interface DshCatalogModel {
  id?: string;
  name?: string;
  reasoning?: { efforts?: { id: string; name?: string }[]; defaultEffort?: string };
  inputModalities?: DshInputModality[];
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

interface DshPermissionCatalog { options: { value: string; name: string; description?: string }[]; defaultOptions: { value: string; name: string; description?: string }[]; defaultPreset: string }

/** Return the provider required by DSH's session/selectModel RPC. */
export function providerForModel(catalog: DshModelCatalog, model: string): string | undefined {
  const providers = (catalog.groups ?? []).filter(group => typeof group.id === 'string' && (group.models ?? []).some(candidate => candidate.id === model)).map(group => group.id as string);
  if (providers.length > 1) return undefined;
  if (providers.length === 1) return providers[0];
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
  private readonly workspaceState = new DshWorkspaceBridge();
  private booting: Promise<void> | null = null;
  private options: DshAdapterOptions;
  private traceSeq = 0;
  private readonly nativeSinks = new Map<string, NonNullable<CreateOpts['nativeEvents']>>();
  private globalNativeSink?: NonNullable<CreateOpts['nativeEvents']>;
  private rpcWritesBlocked = false;
  private readonly traceSinks = new Map<string, TraceSink>();
  private trace(sessionId: string, dir: 'in' | 'out', ch: string, frame: unknown): boolean {
    const observation = { i: ++this.traceSeq, t: 0, dir, ch, frame };
    const receipt = (sessionId === '' ? this.globalNativeSink : this.nativeSinks.get(sessionId))?.record(observation);
    const runtime = this.sessions.get(sessionId);
    if (runtime !== undefined) runtime.envelopeId = receipt?.envelopeId;
    traceFrame(this.options.traceSink ?? this.traceSinks.get(sessionId) ?? this.options.traceSinkFactory?.(sessionId || 'dsh-host'), observation);
    return receipt?.accepted !== false;
  }

  constructor(options: DshAdapterOptions = {}) {
    this.options = options;
  }

  /** Host diagnostics have their own scope; never borrow a Web Session owner. */
  bindGlobalNativeEvents(sink: NonNullable<CreateOpts['nativeEvents']>): void { this.globalNativeSink = sink; }

  private recordRpc(sessionId: string, observation: DshRpcObservation, host: DshHostIdentity | undefined, epoch: number, generation: number,
    sink: NonNullable<CreateOpts['nativeEvents']> | undefined, runtime: SessionRuntime | undefined, inputReference?: { fileIds: string[]; nativeRequestId?: string }): boolean {
    const frame = {
      frame: observation.frame, ...(inputReference === undefined ? {} : { inputReference }),
      dshTransport: { endpoint: observation.endpoint, rpcId: observation.rpcId, coverage: observation.capture.coverage,
        ...(observation.httpStatus === undefined ? {} : { httpStatus: observation.httpStatus }),
        ...(observation.dir !== 'out' || observation.capture.jsonBytes === undefined ? {} : { byteLength: observation.capture.jsonBytes }),
        ...(host?.status !== 'verified' || host.fingerprint === undefined ? {} : { verifiedHostFingerprint: host.fingerprint }), hostEpoch: epoch, muxGeneration: generation } satisfies NativeDshRpcCaptureMetadata,
    };
    const transport = { i: ++this.traceSeq, t: 0, dir: observation.dir, ch: `rpc:${observation.endpoint}`, frame };
    const receipt = sink?.record(transport);
    if (runtime !== undefined && this.sessions.get(sessionId) === runtime) runtime.envelopeId = receipt?.envelopeId;
    traceFrame(this.options.traceSink ?? this.traceSinks.get(sessionId) ?? this.options.traceSinkFactory?.(sessionId || 'dsh-host'), transport);
    return receipt?.accepted !== false;
  }

  /** Recorded mux frames pass through the live stream and event handlers. */
  static replay(sessionId = 'replay'): { feed: (frame: TraceFrame) => AdapterEvent[]; adapter: DshAdapter; replies: unknown[] } {
    const adapter = new DshAdapter();
    const runtime: SessionRuntime = {
      nativeId: '', workspaceId: '', followStream: null, lastSeq: 0, turnStartedAt: 0,
      pending: new Map(), children: new Map(), approvals: new Map(), toolCalls: new Map(), toolInputs: new Map(), assistantKey: '', assistantText: '',
      reasoningKey: '', reasoningText: '', streamedAssistant: false, streamedReasoning: false, generationStartedAt: null, frameSeq: 0,
    };
    adapter.sessions.set(sessionId, runtime);
    const replies: unknown[] = [];
    adapter.client = { connect: async () => undefined, rpc: async (endpoint: string, args: unknown) => { replies.push({ endpoint, args }); return { accepted: true }; } } as unknown as DshHostClient;
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

  private nativeRevision(runtime: SessionRuntime): string {
    return dshRevision({ host: this.observedHost?.fingerprint, hostEpoch: this.hostEpoch, muxGeneration: this.muxGeneration,
      runtime: runtime.identity, nativeId: runtime.nativeId, workspaceId: runtime.workspaceId,
      projections: runtime.projections, state: runtime.controlState, selected: runtime.modelObservation, organization: this.workspaceState.organization(runtime.nativeId) });
  }

  async nativeState(sessionId: string): Promise<unknown> {
    const runtime = this.require(sessionId);
    const client = await this.ensureSidecar();
    const [host, state, projections] = await Promise.all([
      this.hostIdentity(), this.call(client, 'session/state', { request: { sessionId: runtime.nativeId } }, sessionId),
      this.call<{ asOfSeq: number; values: Record<string, unknown> }>(client, 'session/projections', { request: { sessionId: runtime.nativeId } }, sessionId),
    ]);
    if (this.sessions.get(sessionId) !== runtime || this.client !== client) throw dshNativeError('DSH runtime was replaced', 409);
    runtime.controlState = state;
    this.applyProjections(sessionId, runtime, projections);
    const selected = runtime.projections?.values['modelSelection'] ?? runtime.modelObservation ?? { source: 'unavailable-in-api' };
    return { revision: this.nativeRevision(runtime), nativeId: runtime.nativeId, workspaceId: runtime.workspaceId, host,
      transport: client.isConnected ? 'live' : 'reconnecting', state: dshPublicValue(state), projections: dshPublicValue(runtime.projections), selected: dshPublicValue(selected),
      credentialMode: this.options.attachBrowserCookie !== undefined || (this.options.mode ?? 'spawn') === 'spawn' ? 'native-browser-shared-peer' : 'native-operator-single-socket',
      organization: this.workspaceState.organization(runtime.nativeId),
      capture: { writesBlocked: this.rpcWritesBlocked, status: this.rpcWritesBlocked ? 'incomplete' : 'observing' },
      children: [...runtime.children].map(([nativeId, mode]) => ({ nativeId, mode, parentSessionId: runtime.nativeId, continuable: mode === 'continuable' })),
      interactions: [...runtime.pending].map(([requestId, pending]) => ({ requestId, kind: pending.kind, callId: pending.callId, durableId: pending.durableId,
        questionIds: pending.questionIds, status: pending.generation !== this.muxGeneration ? 'uncertain' : pending.sent ? 'sent' : 'pending', continued: pending.continued, remainingMs: pending.remainingMs })),
      surfaceOwnership: { status: 'blocked', reason: 'External native owners require native release/arbitration evidence; a platform lease cannot release them' },
    };
  }

  async nativeCatalog(sessionId: string): Promise<unknown> {
    const runtime = this.require(sessionId);
    const state = await this.nativeState(sessionId) as { revision: string; host: DshHostIdentity; selected: unknown };
    const client = await this.ensureSidecar();
    const calls: Record<string, () => Promise<unknown>> = {
      models: () => this.modelCatalog(client), presets: () => this.call(client, 'agentPresets/list'),
      permissions: () => this.call(client, 'permissionPresets/catalog'), commands: () => this.call(client, 'commands/list', { agentId: runtime.nativeId }),
      skills: () => this.call(client, 'skills/list', { request: { sessionId: runtime.nativeId } }),
      plugins: () => this.call(client, 'pluginInventory/list'), providers: () => this.call(client, 'llm/listProviders'),
      settings: () => this.call(client, 'settings/describe'), goal: () => this.call(client, 'goals/get', { agentId: runtime.nativeId }),
      schedules: () => this.call(client, 'schedule/list', { request: { limit: 100, offset: 0 } }),
      scheduleRules: () => this.call(client, 'schedule/catalog'), jobs: () => client.snapshot('job/list', { request: { sessionId: runtime.nativeId } }),
      forge: () => client.snapshot('forgePanel/follow', { sessionId: runtime.nativeId }),
    };
    const names = Object.keys(calls);
    const results = await Promise.allSettled(names.map(name => calls[name]!()));
    if (this.sessions.get(sessionId) !== runtime || this.client !== client) throw dshNativeError('DSH runtime was replaced', 409);
    const catalog = Object.fromEntries(results.map((result, index) => [names[index]!, result.status === 'fulfilled' ? dshPublicValue(result.value) : { unavailable: true, reason: 'Native endpoint is unavailable in this Host composition' }]));
    return { ...catalog, revision: this.nativeRevision(runtime), nativeId: runtime.nativeId, workspaceId: runtime.workspaceId, host: state.host, selected: state.selected, workspaces: structuredClone(this.workspaceState.snapshot),
      actions: dshNativeActionMetadata(state.host.status === 'verified', { ...catalog, session: { state: runtime.controlState, projections: runtime.projections } }),
      controls: state.host.status === 'verified' ? DSH_NATIVE_CONTROLS : [],
      unsupported: { profileIdentity: 'The API does not identify the current profile directory/name',
        dynamicPlugins: 'isolated-native-surface-required', mcp: 'native composition/plugin surface; no frozen generic MCP administration RPC',
        cardActions: 'only dismiss is exposed until a registered kind/schema has been verified',
        forgeRemoteWrites: 'native-surface-confirmation-required', login: 'authenticated-native-surface-required',
        rewind: 'no frozen native rewind endpoint; fork preserves an exact event prefix', speech: 'native-surface-and-device-required',
        sharing: 'native-surface-and-publish-conditions-required' },
    };
  }

  async executeNativeControl(sessionId: string, value: unknown): Promise<unknown> {
    let nativeDispatched = false;
    try {
      const action = parseDshNativeAction(value);
      const runtime = this.require(sessionId);
      const state = await this.nativeState(sessionId) as { revision: string; host: DshHostIdentity };
      requireDshBaseline(state.host);
      if (state.revision !== action.revision) throw dshNativeError('DSH state changed; refresh before submitting this action', 409);
      const client = await this.ensureSidecar();
      if (action.type === 'child-prompt' || action.type === 'child-interrupt') this.requireChild(sessionId, action.childSessionId);
      if (action.type === 'model') {
        const catalog = await this.modelCatalog(client);
        const selected = catalog.groups?.find(group => group.id === action.provider)?.models?.find(model => model.id === action.model);
        if (selected === undefined) throw dshNativeError('Model/provider route is absent from this Host catalog');
        if (action.reasoningEffort !== undefined && !selected.reasoning?.efforts?.some(effort => effort.id === action.reasoningEffort)) throw dshNativeError('Reasoning effort is absent from this exact model route');
      }
      if (action.type === 'preset') {
        const catalog = await this.call<{ presets: { id: string; broken?: string }[] }>(client, 'agentPresets/list');
        if (!catalog.presets.some(preset => preset.id === action.agentPreset && preset.broken === undefined)) throw dshNativeError('Preset is missing or cannot compose');
      }
      if (action.type === 'settings-mutate') {
        const description = await this.call<{ writable: boolean; namespaces: { ns: string; revision: number }[] }>(client, 'settings/describe');
        if (!description.writable) throw dshNativeError('This Host profile does not accept settings writes', 409);
        const namespace = description.namespaces.find(namespace => namespace.ns === action.ns);
        if (namespace === undefined || namespace.revision !== action.expectedRevision) throw dshNativeError('Settings namespace or native revision changed', 409);
      }
      if (action.type === 'compact') {
        const commands = await this.slashCommands(sessionId);
        if (!commands.some(command => command.name === '/compact')) throw dshNativeError('This Session has no native compact command', 409);
      }
      if (action.type === 'job-kill') {
        const rows = await client.snapshot<{ jobs: { id: string; owner?: string; status: string }[] }>('job/list', { request: { sessionId: runtime.nativeId } });
        if (!rows.jobs.some(job => job.id === action.jobId && (job.owner === undefined || job.owner === runtime.nativeId) && job.status === 'running')) throw dshNativeError('Job is absent, ended, or belongs to a different Session', 409);
      }
      if (action.type === 'preset' || action.type === 'forge-worktree' || action.type === 'forge-cancel') {
        const current = runtime.controlState as { cursor?: number; active?: boolean; running?: boolean } | undefined;
        const metadata = runtime.projections?.values['sessionListMetadata'] as { blank?: boolean } | undefined;
        if (metadata?.blank !== true || typeof current?.cursor !== 'number' || (runtime.projections?.asOfSeq ?? -1) < current.cursor) throw dshNativeError('The exact native projection does not confirm a Session before its first turn', 409);
        if (current.running !== false || action.type === 'preset' && current.active !== true) throw dshNativeError('The native Session is busy or not active', 409);
      }
      if (action.type === 'forge-worktree' || action.type === 'forge-cancel' || action.type === 'forge-restore') {
        const panel = await client.snapshot<{ worktree?: { editable?: boolean; created?: unknown; creation?: unknown; restoration?: unknown; missing?: unknown } }>('forgePanel/follow', { sessionId: runtime.nativeId });
        const worktree = panel.worktree;
        if (worktree === undefined) throw dshNativeError('Native Forge worktree state is unavailable', 409);
        if (action.type === 'forge-worktree' && worktree.editable !== true || action.type !== 'forge-restore' && (worktree.created !== null || worktree.creation !== null)) throw dshNativeError('The native worktree request is locked or its creation is running', 409);
        if (action.type === 'forge-restore' && (worktree.created === null || worktree.created === undefined || worktree.restoration !== null || (runtime.controlState as { running?: boolean } | undefined)?.running !== false)) throw dshNativeError('The native worktree cannot be restored while absent or busy', 409);
      }
      // Catalog and Forge preflight can await native reads. Verify the actual
      // bootstrap once more at dispatch, rather than trusting the earlier cut.
      const freshHost = await this.hostIdentity();
      requireDshBaseline(freshHost);
      if (freshHost.fingerprint === undefined || freshHost.fingerprint !== state.host.fingerprint || this.sessions.get(sessionId) !== runtime || this.client !== client || this.nativeRevision(runtime) !== action.revision) throw dshNativeError('DSH Host or Session changed during control preflight', 409);
      const call = dshNativeCall(action, runtime.nativeId);
      nativeDispatched = true;
      let result: unknown;
      try { result = await this.call<unknown>(client, call.endpoint, call.args, sessionId); }
      catch (error) {
        if (error instanceof DshRpcError || (error as { statusCode?: number })?.statusCode === 401) throw error;
        throw Object.assign(dshNativeError('DSH control outcome is uncertain; reconcile before retrying', 503), { code: 'uncertain' });
      }
      if (this.sessions.get(sessionId) !== runtime || this.client !== client) throw Object.assign(dshNativeError('DSH action outcome belongs to a replaced runtime', 409), { code: 'uncertain' });
      if (action.type === 'model') runtime.modelObservation = { provider: action.provider, model: action.model, reasoningEffort: action.reasoningEffort, source: 'session/selectModel' };
      // Native cards explicitly distinguish accepted from confirmed settlement.
      if (action.type === 'card-dismiss') {
        const outcome = result as { status?: string; reason?: string };
        if (outcome.status === 'refused') throw dshNativeError(outcome.reason ?? 'Native card refused the action', 409);
        return { result: dshPublicValue(result), confirmed: outcome.status === 'settled', nativeId: runtime.nativeId };
      }
      if (action.type === 'compact') {
        const outcome = result as { result?: { kind?: string; text?: string } };
        if (outcome.result?.kind !== 'success') throw dshNativeError(outcome.result?.text ?? 'Native compact command failed', 409);
      }
      // A confirmed mutation followed by a read failure must not invite the
      // browser to repeat its external effect. Preserve its receipt separately.
      const refreshed = await this.nativeState(sessionId).catch(() => ({ unavailable: true, reason: 'Native action succeeded; state refresh is unavailable' }));
      return { result: dshPublicValue(result), nativeId: runtime.nativeId, state: refreshed };
    } catch (error) {
      if (nativeDispatched) throw error;
      const rejection = error instanceof Error ? error : dshNativeError('DSH control was rejected before dispatch');
      const reasonCode = (rejection as { code?: string }).code;
      throw Object.assign(rejection, { code: 'native-control-rejected', ...(reasonCode === undefined ? {} : { reasonCode }) });
    }
  }

  async listNativeSessions(options: { cursor?: string; query?: string } = {}): Promise<unknown> {
    const client = await this.ensureSidecar();
    const result = options.query === undefined
      ? await this.call(client, 'session/list', { _request: options.cursor === undefined ? {} : { cursor: options.cursor } })
      : await this.call(client, 'session/search', { request: { query: options.query } });
    return { host: await this.hostIdentity(), result: dshPublicValue(result) };
  }

  async readNativeHistory(sessionId: string, options: { cursor?: string; offset?: number; limit: number }): Promise<unknown> {
    const runtime = this.require(sessionId);
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 200 || options.offset !== undefined && options.offset !== 0) throw dshNativeError('DSH history requires a native cursor and limit 1–200');
    const beforeSeq = options.cursor === undefined ? undefined : Number(options.cursor);
    if (beforeSeq !== undefined && (!/^\d+$/.test(options.cursor ?? '') || !Number.isSafeInteger(beforeSeq))) throw dshNativeError('Invalid DSH history cursor');
    const client = await this.ensureSidecar();
    const page = await this.call<{ records: DshHistoryRecord[]; hasMore: boolean }>(client, 'session/page', { request: { address: { kind: 'session', sessionId: runtime.nativeId }, maxMessages: options.limit, ...(beforeSeq === undefined ? {} : { beforeSeq }) } }, sessionId);
    if (this.sessions.get(sessionId) !== runtime) throw dshNativeError('DSH runtime was replaced', 409);
    return { nativeId: runtime.nativeId, records: page.records, hasMore: page.hasMore, nextCursor: page.records[0]?.event.seq.toString() };
  }

  onEvent(cb: (sessionId: string, event: AdapterEvent) => void): void {
    this.listeners.push(cb);
  }

  bindRuntime(sessionId: string, identity: NonNullable<CreateOpts['runtime']>): void {
    const runtime = this.sessions.get(sessionId);
    if (runtime !== undefined) runtime.identity = identity;
  }

  private emit(sessionId: string, event: AdapterEvent): void {
    const runtime = this.sessions.get(sessionId);
    if (runtime?.identity !== undefined) event = { ...event, runtime: runtime.identity };
    if (runtime?.envelopeId !== undefined) event = { ...event, nativeEnvelopeId: runtime.envelopeId };
    if (runtime?.nativeTurnId !== undefined && event.scope !== 'session'
      && (event.type === 'item.start' || event.type === 'item.delta' || event.type === 'item.update' || event.type === 'item.complete'
        || event.type === 'item.cancel' || event.type === 'turn.start' || event.type === 'turn.end') && event.nativeTurnId === undefined) {
      event = { ...event, nativeTurnId: runtime.nativeTurnId };
    }
    if (runtime?.historyRecord !== undefined && event.type !== 'history') { runtime.historyRecord.events.push(event); return; }
    for (const listener of this.listeners) listener(sessionId, event);
  }

  async probe(): Promise<ProbeResult> {
    if ((this.options.mode ?? 'spawn') === 'attach') {
      const identity = await this.hostIdentity().catch(() => undefined);
      return { installed: identity !== undefined, ...(identity?.version === undefined ? {} : { version: identity.version }), pinnedVersion: PINNED_VERSION,
        auth: this.options.attachCookie ? 'ok' : 'missing', compatible: identity?.status === 'verified',
        notes: identity?.status === 'verified' ? [] : [identity?.reason ?? '目标 DSH Host 身份尚未验证'] };
    }
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
      const groups = catalog.groups ?? [];
      if (groups.length === 0) return (catalog.models ?? []).filter(model => typeof model.id === 'string').map(model => ({ id: model.id as string, label: model.name ?? model.id as string }));
      const inputs = await dshInputCapabilities(catalog, <T>(endpoint: string, args?: Record<string, unknown>) => this.call<T>(client, endpoint, args));
      return groups.flatMap(group => (group.models ?? []).filter(model => typeof model.id === 'string').map(model => ({
        id: providerForModel(catalog, model.id as string) === undefined ? `dsh:${Buffer.from(JSON.stringify([group.id, model.id])).toString('base64url')}` : model.id as string,
        label: `${model.name ?? model.id} · ${group.id}`,
        reasoningEfforts: model.reasoning?.efforts?.map(effort => effort.id), defaultReasoningEffort: model.reasoning?.defaultEffort,
        ...(inputs.get(dshInputRoute(group.id ?? '', model.id as string))?.inputModalities === undefined ? {} : { inputModalities: inputs.get(dshInputRoute(group.id ?? '', model.id as string))!.inputModalities }),
        isDefault: catalog.default?.provider === group.id && catalog.default?.model === model.id, source: 'session/modelCatalog',
      })));
    } catch {
      return [];
    }
  }

  private async modelCatalog(client: DshHostClient): Promise<DshModelCatalog> {
    return this.call<DshModelCatalog>(client, 'session/modelCatalog', {});
  }

  private async selectModel(client: DshHostClient, runtime: SessionRuntime, model: string, reasoningEffort?: string): Promise<void> {
    const catalog = await this.modelCatalog(client);
    let provider: string | undefined;
    if (model.startsWith('dsh:')) {
      let route: unknown;
      try { route = JSON.parse(Buffer.from(model.slice(4), 'base64url').toString()); } catch { throw new Error('dsh: 模型路由无效'); }
      if (!Array.isArray(route) || route.length !== 2 || !route.every(value => typeof value === 'string')) throw new Error('dsh: 模型路由无效');
      [provider, model] = route as [string, string];
      if (!(catalog.groups ?? []).some(group => group.id === provider && group.models?.some(candidate => candidate.id === model))) throw new Error('dsh: 原生模型路由已不可用');
    } else provider = providerForModel(catalog, model);
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
    runtime.modelObservation = { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }), source: 'session/selectModel' };
  }

  accessModes(): { id: string; label: string }[] {
    return ACCESS_MODES;
  }

  async listAccessModes(): Promise<AccessModeOption[]> {
    const client = await this.ensureSidecar();
    const catalog = await this.call<DshPermissionCatalog>(client, 'permissionPresets/catalog');
    return catalog.options.map(option => ({ id: option.value, label: option.name, allowed: true, implemented: /^[\w.:-]+$/.test(option.value), reason: option.description, source: 'permissionPresets/catalog', scope: 'session' }));
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
      env: { ...(this.options.env ?? {}), ...(recorder === undefined ? {} : { ...recorder.env, WDCC_TRACE_DIR: recorder.directory, NODE_OPTIONS: `${this.options.env?.['NODE_OPTIONS'] ?? process.env['NODE_OPTIONS'] ?? ''} --require ${recorder.module}`.trim() }) },
    };
  }

  private async ensureSidecar(): Promise<DshHostClient> {
    if (this.client !== null) { await this.client.connect(); return this.client; }
    // Metadata/model discovery and session creation can arrive concurrently.
    // A process started by this adapter belongs to the pending boot, rather
    // than being an unrelated host using the same native home.
    if (this.booting !== null) {
      await this.booting;
      if (this.client !== null) return this.client;
      throw new Error('dsh: 侧车启动失败');
    }
    const epoch = this.hostEpoch;
    const boot = (async () => {
      let client: DshHostClient | null = null;
      let sidecar: Sidecar | null = null;
      try {
        if ((this.options.mode ?? 'spawn') === 'attach') {
          const cookie = this.options.attachCookie ?? '';
          if (cookie === '') throw Object.assign(new Error('需要重新连接 DSH：请粘贴 DSH 当前的访问链接'), { code: 'dsh-needs-link' });
          client = this.newHost(this.options.attachUrl ?? 'http://127.0.0.1:3080');
          // The Host deletes a v2 operator when its one socket closes. The
          // authority-bound v1 browser owner can reconnect and shares native
          // browser arbitration; it is not a platform-exclusive owner.
          client.useCookie(this.options.attachBrowserCookie ?? cookie);
        } else {
          const dshHome = this.options.env?.['DSH_HOME'] ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh');
          if (findDshProcessOn(dshHome) !== undefined) throw Object.assign(new Error(`检测到已有 DSH 在使用 ${dshHome}，请改用 attach 模式`), { code: 'dsh-home-in-use' });
          const spec = this.buildLaunchSpec();
          sidecar = await startSidecar({ port: this.options.port ?? Number(process.env['WDCC_DSH_PORT'] ?? 3091), env: { ...process.env, ...spec.env }, command: spec.command, args: spec.args });
          client = this.newHost(sidecar.port);
          await client.authenticate(sidecar.tokenUrl);
        }
        await client.connect();
        if (epoch !== this.hostEpoch) throw new Error('DSH 连接启动已取消');
        this.client = client;
        this.sidecar = sidecar;
        client.openStream('$events', {}, frame => { if (this.client === client) this.onEventFrame('', frame); });
        this.openControl(client);
        this.openWorkspaces(client);
        for (const [id, runtime] of this.sessions) this.openFollow(id, runtime);
      } catch (error) {
        await client?.close();
        await sidecar?.stop();
        if (this.client === client) this.client = null;
        throw error;
      }
    })();
    this.booting = boot;
    try { await boot; } finally { if (this.booting === boot) this.booting = null; }
    if (this.client === null) throw new Error('dsh: 侧车启动失败');
    return this.client;
  }

  private hostEpoch = 0;
  private muxGeneration = 0;
  private controlStream?: string;
  private observedHost?: DshHostIdentity;
  async hostIdentity(): Promise<DshHostIdentity> {
    const epoch = this.hostEpoch;
    const endpoint = this.options.attachUrl ?? (this.sidecar === null ? `http://127.0.0.1:${this.options.port ?? 3091}/` : dshBaseUrl(this.sidecar.port));
    const cookie = (this.options.mode ?? 'spawn') === 'attach' ? this.options.attachBrowserCookie : this.client?.cookieHeader;
    const identity = await readDshHostIdentity(endpoint, cookie);
    if (epoch !== this.hostEpoch) throw dshNativeError('DSH Host was replaced during identity verification', 409);
    this.observedHost = structuredClone(identity);
    return identity;
  }
  private openControl(client: DshHostClient): void {
    this.controlStream = client.openStream('session/control', {}, frame => {
      if (this.client !== client) return;
      const value = this.frameValue(frame);
      if (value?.['type'] === 'baseline') {
        const values = (value['value'] as { projections?: Record<string, { asOfSeq: number; values: Record<string, unknown> }> })?.projections ?? {};
        for (const [id, runtime] of this.sessions) {
          if (!this.trace(id, 'in', 'mux:session/control', frame)) continue;
          const baseline = values[runtime.nativeId];
          // Every new Host control generation replaces process-local state,
          // including retained sessions omitted from an empty baseline.
          this.applyProjections(id, runtime, baseline ?? { asOfSeq: -1, values: {} });
        }
      } else if (value?.['type'] === 'projection') {
        const session = [...this.sessions].find(([, runtime]) => runtime.nativeId === value['sessionId']);
        if (session !== undefined && this.trace(session[0], 'in', 'mux:session/control', frame)) this.applyProjectionChanges(session[0], session[1], value);
      }
    });
  }
  private openWorkspaces(client: DshHostClient): void {
    client.openStream('workspace/follow', {}, frame => {
      if (this.client !== client || frame.type !== 'item') return;
      for (const [id] of this.sessions) if (!this.trace(id, 'in', 'mux:workspace/follow', frame)) return;
      try { this.workspaceState.accept(frame.value); }
      catch {
        this.workspaceState.invalidate();
        for (const [id, runtime] of this.sessions) this.emit(id, { type: 'item.complete', itemKey: `dsh-workspace-error-${++runtime.frameSeq}`, kind: 'error', data: { message: 'DSH workspace baseline is invalid; reconnect to resynchronize' }, native: frame });
      }
    });
  }
  private applyProjections(sessionId: string, runtime: SessionRuntime, baseline: { asOfSeq: number; values: Record<string, unknown> }, replace = false, source = 'session/control'): void {
    if (!replace && baseline.asOfSeq < (runtime.projections?.asOfSeq ?? -1)) return;
    const previous = runtime.projections;
    runtime.projections = structuredClone(baseline);
    runtime.children.clear();
    const children = baseline.values['subagentCatalog'];
    if (Array.isArray(children)) for (const entry of children as Record<string, unknown>[]) {
      const id = entry['childSessionId'] ?? entry['sessionId'] ?? entry['id'];
      if (typeof id === 'string' && typeof entry['mode'] === 'string') runtime.children.set(id, entry['mode']);
    }
    const permission = baseline.values['permissions'] as { currentValue?: unknown } | undefined;
    const effective = typeof permission?.currentValue === 'string' ? permission.currentValue : null;
    if (previous === undefined || (previous.values['permissions'] as { currentValue?: unknown } | undefined)?.currentValue !== permission?.currentValue) this.emit(sessionId, { type: 'permissions', observation: { effective, source, scope: 'session', nativeSeq: baseline.asOfSeq } });
    this.projectContinuedQuestions(sessionId, runtime, baseline.values['userQuestions']);
  }
  private applyProjectionChanges(sessionId: string, runtime: SessionRuntime, value: Record<string, unknown>, source = 'session/control'): void {
    if (typeof value['seq'] !== 'number' || !Array.isArray(value['changes']) || value['seq'] < (runtime.projections?.asOfSeq ?? -1)) return;
    const values = { ...(runtime.projections?.values ?? {}) };
    for (const change of value['changes'] as { key: string; val?: unknown }[]) values[change.key] = change.val;
    this.applyProjections(sessionId, runtime, { asOfSeq: value['seq'], values }, false, source);
  }
  private projectContinuedQuestions(sessionId: string, runtime: SessionRuntime, value: unknown): void {
    const projection = value as { active?: { callId: string; state: string; questions: { id: string; question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }[] }[]; settled?: { callId: string; answers: { id: string; selected: string[]; custom?: string }[] }[] } | undefined;
    for (const question of projection?.active ?? []) {
      if (question.state !== 'continued') continue;
      const eventId = `dsh-continued:${question.callId}`;
      const existing = runtime.pending.get(eventId);
      if (existing !== undefined) { if (existing.continued) existing.generation = this.muxGeneration; continue; }
      runtime.pending.set(eventId, { kind: 'question', eventId, callId: question.callId, questionIds: question.questions.map(item => item.id), generation: this.muxGeneration, continued: true });
      for (const item of question.questions) this.emit(sessionId, { type: 'item.complete', itemKey: `question-${eventId}-${item.id}`, kind: 'question', data: {
        questionId: `${eventId}:${item.id}`, groupId: eventId, toolCallId: question.callId, prompt: item.question, header: item.header,
        options: item.options?.map(option => ({ id: option.label, label: option.label, description: option.description })), multiSelect: item.multiSelect, allowsFreeText: true,
      }, native: question });
    }
    for (const settled of projection?.settled ?? []) {
      const eventId = `dsh-continued:${settled.callId}`;
      const pending = runtime.pending.get(eventId);
      if (pending === undefined) continue;
      runtime.pending.delete(eventId);
      for (const questionId of pending.questionIds ?? []) this.emit(sessionId, { type: 'item.complete', itemKey: `question-${eventId}-${questionId}`, kind: 'question', data: {
        questionId: `${eventId}:${questionId}`, prompt: '', status: 'answered', resolution: pending.sent ? 'native-acknowledged' : 'external', toolCallId: settled.callId,
      }, native: settled });
    }
  }
  private newHost(endpoint: string | number): DshHostClient {
    const host = new DshHostClient(endpoint, { onState: state => {
      if (this.client !== host) return;
      if (state === 'reconnecting' || state === 'auth-required') {
        this.clientId = ''; this.muxGeneration++; this.observedHost = undefined; this.workspaceState.invalidate();
        for (const [id, runtime] of this.sessions) { runtime.history?.invalidate(); runtime.projections = undefined; runtime.children.clear(); runtime.modelObservation = undefined; this.emit(id, { type: 'permissions', observation: { effective: null, source: 'dsh.connection', scope: 'session' } }); }
      }
      for (const [id, runtime] of this.sessions) this.emit(id, {
        type: 'item.complete', itemKey: `dsh-connection-${++runtime.frameSeq}`, kind: 'notice',
        data: { level: state === 'online' ? 'info' : 'warning', text: state === 'online' ? 'DSH 连接已恢复，正在同步会话' : state === 'auth-required' ? 'DSH 登录已过期，请重新连接' : 'DSH 连接中断，正在重连', nativeType: `dsh.connection.${state}` },
      });
    } });
    return host;
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
    const runtime = this.requireChild(sessionId, childSessionId);
    const client = await this.ensureSidecar();
    const args: DshSubagentPrompt = { request: { requestId: ulid(), parentSessionId: runtime.nativeId, childSessionId, mode: 'continuable', delivery: 'queue', content: [{ type: 'text', text }] } };
    await this.call(client, 'subagents/prompt', { ...args }, sessionId);
  }

  async interruptSubagent(sessionId: string, childSessionId: string): Promise<void> {
    const runtime = this.requireChild(sessionId, childSessionId);
    const client = await this.ensureSidecar();
    const args: DshSubagentInterrupt = { childSessionId, parentSessionId: runtime.nativeId, mode: 'continuable' };
    await this.call(client, 'subagents/interruptByParent', { ...args }, sessionId);
  }

  private requireChild(sessionId: string, childSessionId: string): SessionRuntime {
    const runtime = this.require(sessionId);
    if (runtime.children.get(childSessionId) !== 'continuable') throw Object.assign(new Error('子 Agent 不属于此父会话，或不支持继续操作'), { statusCode: 409 });
    return runtime;
  }

  /** 运行中切换访问模式（F6）：/permission <preset> 只影响这一个会话 */
  async setAccessMode(sessionId: string, mode: string): Promise<{ accessMode: string }> {
    const runtime = this.require(sessionId);
    const client = await this.ensureSidecar();
    const catalog = mode === 'inherit' ? await this.call<DshPermissionCatalog>(client, 'permissionPresets/catalog') : undefined;
    if (catalog !== undefined && catalog.defaultPreset === '') throw Object.assign(new Error('DSH 原生默认权限无效'), { statusCode: 409 });
    await this.permission(client, runtime.nativeId, catalog?.defaultPreset ?? mode);
    return { accessMode: mode };
  }

  private async permission(client: DshHostClient, nativeId: string, accessMode: string | undefined): Promise<void> {
    accessMode = nativeAccessMode(accessMode);
    if (accessMode === undefined) return;
    const catalog = await this.call<DshPermissionCatalog>(client, 'permissionPresets/catalog');
    if (!catalog.options.some(option => option.value === accessMode) || !/^[\w.:-]+$/.test(accessMode)) throw Object.assign(new Error('DSH 当前权限目录不允许此模式'), { statusCode: 400 });
    const line = `/permission ${accessMode}`;
    const execution = await this.call<{ commandId: string; result: { kind: 'success' | 'error'; text?: string } } | undefined>(client, 'commands/execute', { agentId: nativeId, line, submittedAttachments: [] });
    if (typeof execution?.commandId !== 'string' || execution.commandId === '' || execution.result?.kind !== 'success') throw Object.assign(new Error(execution?.result?.text ?? 'DSH 权限命令未成功执行'), { statusCode: 409 });
  }

  /** 所有 RPC 都经过白名单检查 */
  private async call<T>(client: DshHostClient, endpoint: string, args: Record<string, unknown> = {}, sessionId?: string,
    inputReference?: { fileIds: string[]; nativeRequestId?: string }): Promise<T> {
    if (!isAllowedEndpoint(endpoint)) throw new Error(`dsh: 端点不在白名单内：${endpoint}`);
    const request = (args['request'] ?? {}) as Record<string, unknown>;
    const address = (request['address'] ?? {}) as Record<string, unknown>;
    const nativeId = args['agentId'] ?? args['sessionId'] ?? request['sessionId'] ?? (address['kind'] === 'session' ? address['sessionId'] : undefined);
    const matches = typeof nativeId === 'string' && nativeId !== '' ? [...this.sessions].filter(([, runtime]) => runtime.nativeId === nativeId) : [];
    const owner = sessionId ?? (matches.length === 1 ? matches[0]![0] : '');
    const readonly = DSH_READ_RPC_ENDPOINTS.has(endpoint);
    if (!readonly && this.rpcWritesBlocked) throw Object.assign(new Error('DSH native transport capture is incomplete; reconcile before another write'), { code: 'uncertain' });
    // Preserve the pre-existing intent durability gate. Actual transport
    // admission below records the independently generated native rpcId.
    let intentAccepted = false;
    try { intentAccepted = this.trace(owner, 'out', `rpc-intent:${endpoint}`, { endpoint, args }); } catch { /* Persistence failed before native dispatch. */ }
    if (!intentAccepted) { this.rpcWritesBlocked = true; throw Object.assign(new Error('原生请求未持久化或实例已替换'), { code: 'uncertain' }); }
    const host = this.observedHost === undefined ? undefined : structuredClone(this.observedHost);
    const epoch = this.hostEpoch; const generation = this.muxGeneration;
    const sink = owner === '' ? this.globalNativeSink : this.nativeSinks.get(owner);
    const runtime = this.sessions.get(owner);
    return client.rpc<T>(endpoint, args, observation => {
      if (observation.dir !== 'in') return;
      if (sink !== undefined && observation.capture.coverage !== 'complete') this.rpcWritesBlocked = true;
      try {
        if (!this.recordRpc(owner, observation, host, epoch, generation, sink, runtime, inputReference)) this.rpcWritesBlocked = true;
      } catch { this.rpcWritesBlocked = true; }
      // The response has already arrived. A failed observer revokes later
      // writes and must not replace this native result with an invented error.
    }, observation => {
      let accepted = false;
      try { accepted = this.recordRpc(owner, observation, host, epoch, generation, sink, runtime, inputReference); } catch { /* Uncertain before POST. */ }
      if (sink !== undefined && observation.capture.coverage !== 'complete') {
        const persistedAttachmentInput = observation.capture.coverage === 'oversize' && accepted && inputReference?.fileIds.length
          && owner !== '' && (endpoint === 'session/prompt' || endpoint === 'commands/execute');
        if (!persistedAttachmentInput) { this.rpcWritesBlocked = true; if (!readonly) accepted = false; }
      }
      if (!accepted) this.rpcWritesBlocked = true;
      return accepted;
    });
  }

  async create(opts: CreateOpts): Promise<{ nativeId: string }> {
    if (opts.nativeEvents !== undefined) this.nativeSinks.set(opts.sessionId, opts.nativeEvents);
    if (opts.traceSink !== undefined) this.traceSinks.set(opts.sessionId, opts.traceSink);
    const client = await this.ensureSidecar();
    requireDshBaseline(await this.hostIdentity());
    const workspace = await this.call<{ workspace: { workspaceId: string } }>(client, 'workspace/create', {
      request: { path: opts.cwd },
    }, opts.sessionId);
    const created = await this.call<{ sessionId: string }>(client, 'session/create', {
      request: { workspaceId: workspace.workspace.workspaceId },
    }, opts.sessionId);
    const runtime: SessionRuntime = {
      nativeId: created.sessionId,
      identity: opts.runtime,
      workspaceId: workspace.workspace.workspaceId,
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(opts.reasoningEffort === undefined ? {} : { reasoningEffort: opts.reasoningEffort }),
      followStream: null,
      lastSeq: 0,
      turnStartedAt: 0,
      pending: new Map(),
      children: new Map(),
      approvals: new Map(),
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
    if (opts.nativeEvents !== undefined) this.nativeSinks.set(opts.sessionId, opts.nativeEvents);
    if (opts.traceSink !== undefined) this.traceSinks.set(opts.sessionId, opts.traceSink);
    const client = await this.ensureSidecar();
    requireDshBaseline(await this.hostIdentity());
    const workspace = await this.call<{ workspace: { workspaceId: string } }>(client, 'workspace/create', {
      request: { path: opts.cwd },
    }, opts.sessionId);
    const runtime: SessionRuntime = {
      nativeId: opts.nativeId,
      identity: opts.runtime,
      workspaceId: workspace.workspace.workspaceId,
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(opts.reasoningEffort === undefined ? {} : { reasoningEffort: opts.reasoningEffort }),
      followStream: null,
      lastSeq: 0,
      turnStartedAt: 0,
      pending: new Map(),
      children: new Map(),
      approvals: new Map(),
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
    this.setupHistory(sessionId, runtime);
    if (!this.trace(sessionId, 'out', 'openStream:session/follow', { request: { address: { kind: 'session', sessionId: runtime.nativeId }, activate: true, assistantStream: true } })) throw Object.assign(new Error('原生订阅未持久化'), { code: 'uncertain' });
    runtime.followStream = client.openStream(
      'session/follow',
      { request: { address: { kind: 'session', sessionId: runtime.nativeId }, activate: true, assistantStream: true } },
      (frame) => { if (this.client === client && this.sessions.get(sessionId) === runtime) this.onEventFrame(sessionId, frame); },
    );
    runtime.permissionStream = client.openStream('session/observeProjections', { request: { sessionId: runtime.nativeId } }, frame => { if (this.client === client && this.sessions.get(sessionId) === runtime) this.onEventFrame(sessionId, frame); });
  }

  private setupHistory(sessionId: string, runtime: SessionRuntime): void {
    runtime.history ??= new DshHistoryBridge(runtime.nativeId,
      request => { if (this.client === null) throw new Error('DSH 尚未连接'); return this.call(this.client, 'session/page', { request }, sessionId); },
      (record, historical) => {
        runtime.lastSeq = record.event.seq;
        if (record.event.type === 'turn/start') runtime.nativeTurnId = `${runtime.nativeId}:${String((record.event.data as { turn?: unknown }).turn ?? record.event.seq)}`;
        if (historical) {
          runtime.historyRecord = { nativeSeq: record.event.seq, nativeTurnId: runtime.nativeTurnId, at: new Date(record.event.time).toISOString(), native: record.event, events: [] };
          const data = record.event.data as { target?: string; inserted?: { source?: { kind?: string; rpcId?: string }; content?: { type?: string; text?: string }[] }[] };
          if (record.event.type === 'agent/inbox/spliced' && data.target === 'next-turn') runtime.historyRecord.admittedInputs = (data.inserted ?? []).flatMap(input => input.source?.kind === 'user' && typeof input.source.rpcId === 'string' ? [{ nativeRequestId: input.source.rpcId, text: (input.content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('') }] : []);
        }
        this.onDshEvent(sessionId, runtime, record.event.type, (record.event.data ?? {}) as Record<string, unknown>, record.event.seq, record.event);
        if (runtime.historyRecord !== undefined) { runtime.historyRecords ??= []; runtime.historyRecords.push(runtime.historyRecord); runtime.historyRecord = undefined; }
      },
      opening => {
        const records = runtime.historyRecords ?? [];
        runtime.historyRecords = [];
        this.emit(sessionId, { type: 'history', nativeId: runtime.nativeId, records });
        if (opening.projections !== undefined) this.applyProjections(sessionId, runtime, opening.projections);
        runtime.assistantBridge ??= new DshAssistantBridge();
        const previousAttempt = runtime.assistantBridge.attemptId;
        const chunks = runtime.assistantBridge.baseline(opening.assistantStream);
        if (previousAttempt !== runtime.assistantBridge.attemptId) this.cancelAssistantAttempt(sessionId, runtime);
        runtime.assistantKey = ''; runtime.assistantText = ''; runtime.reasoningKey = ''; runtime.reasoningText = '';
        runtime.streamedAssistant = false; runtime.streamedReasoning = false;
        for (const chunk of chunks) this.onAssistantChunk(sessionId, { frame: { type: 'chunk', chunk } });
        // A stream gap may have advanced the durable cursor while holding its
        // settlement. A new Host baseline that no longer owns that attempt
        // releases the held durable event instead of losing it to cursor dedupe.
        for (const [seq, pending] of runtime.assistantSettlements ?? []) {
          if (seq > opening.cursor || runtime.assistantBridge.matchesSettlement(seq, pending.data)) continue;
          runtime.assistantSettlements?.delete(seq);
          const currentEnvelope = runtime.envelopeId; runtime.envelopeId = pending.envelopeId;
          this.onDshEvent(sessionId, runtime, pending.type, pending.data, seq, pending.native);
          runtime.envelopeId = currentEnvelope;
        }
        const buffered = runtime.assistantBuffered ?? []; runtime.assistantBuffered = [];
        for (const frame of buffered) this.acceptAssistantFrame(sessionId, runtime, frame);
      },
      error => { runtime.historyRecords = []; runtime.historyRecord = undefined; this.emit(sessionId, { type: 'item.complete', itemKey: `dsh-history-error-${++runtime.frameSeq}`, kind: 'error', data: { message: error.message } }); },
    );
  }

  async send(sessionId: string, input: UserInput): Promise<void> {
    const client = await this.ensureSidecar();
    const runtime = this.require(sessionId);
    const epoch = this.hostEpoch; const generation = this.muxGeneration;
    if (!this.trace(sessionId, 'out', 'input', input)) throw Object.assign(new Error('原生输入未持久化'), { code: 'uncertain' });
    const prepared = input as UserInput & DshResolvableInput;
    if (prepared.delivery !== undefined && !['send', 'queue', 'steer'].includes(prepared.delivery)) throw dshInputUnsupported('DSH delivery mode is unsupported');
    const parts = dshInputParts(prepared);
    for (const part of parts) if (!['text', 'image', 'file'].includes(part.type)) throw dshInputUnsupported(`DSH 0.2 native prompt schema does not support ${part.type} input`);
    const command = input.text.startsWith('/') && isAllowedCommandLine(input.text, input.text);
    if (prepared.delivery === 'steer') {
      if (command) throw dshInputUnsupported('Native slash commands cannot be steered into an LLM turn');
      const state = await this.call<{ running: boolean }>(client, 'session/state', { request: { sessionId: runtime.nativeId } }, sessionId);
      if (!state.running) throw dshInputUnsupported('The native Session has no running turn to steer');
    }
    let inputModalities: DshInputModality[] | undefined;
    if (parts.some(part => part.type === 'image') && !command) {
      const projections = await this.call<{ kind?: string; asOfSeq?: number; values?: { modelSelection?: { provider: string; model: string } } }>(client, 'session/projections', { request: { sessionId: runtime.nativeId } }, sessionId);
      const catalog = await this.modelCatalog(client);
      const selected = projections.values?.modelSelection ?? catalog.default;
      if (projections.kind !== 'cached' && typeof projections.asOfSeq === 'number' && projections.asOfSeq >= (runtime.projections?.asOfSeq ?? -1) && projections.values !== undefined && typeof selected?.provider === 'string' && typeof selected.model === 'string') {
        const inputs = await dshInputCapabilities(catalog, <T>(endpoint: string, args?: Record<string, unknown>) => this.call<T>(client, endpoint, args));
        inputModalities = inputs.get(dshInputRoute(selected.provider, selected.model))?.inputModalities;
      }
    }
    // Command image admission belongs to its native attachment declaration,
    // independently of the LLM selected for ordinary Session prompts.
    const encoded = await encodeDshInput(prepared, { inputModalities: command ? ['text', 'image'] : inputModalities,
      uploadFile: (part, bytes) => this.uploadNativeFile(sessionId, runtime, client, part, bytes) });
    const { submittedAttachments } = encoded;
    const fileIds = parts.flatMap(part => part.type === 'image' || part.type === 'file' ? [part.fileId] : []);
    const inputReference = fileIds.length === 0 ? undefined : { fileIds, ...(input.nativeRequestId === undefined ? {} : { nativeRequestId: input.nativeRequestId }) };
    if (this.sessions.get(sessionId) !== runtime || this.client !== client || this.hostEpoch !== epoch || this.muxGeneration !== generation) throw Object.assign(new Error('DSH runtime changed during input preparation'), { code: 'uncertain' });
    // 第一行是命令时走 commands/execute，不走 session/prompt（F8 / SL-02）
    if (command) {
      const execution = await this.call<{ result?: { kind?: string; text?: string } }>(client, 'commands/execute', { agentId: runtime.nativeId, line: input.text, submittedAttachments }, sessionId, inputReference);
      if (execution.result?.kind !== 'success') throw dshNativeError(execution.result?.text ?? 'DSH command did not succeed', 409);
      this.emit(sessionId, {
        type: 'item.complete',
        itemKey: `command-${++runtime.frameSeq}`,
        kind: 'internal',
        data: { nativeType: 'commands/execute', line: input.text } as unknown as EventData[EventKind],
      });
      this.emit(sessionId, {
        type: 'turn.end',
        status: 'completed',
      });
      return;
    }
    runtime.turnStartedAt = this.now();
    await this.call(client, 'session/prompt', {
      request: { requestId: input.nativeRequestId ?? ulid(), sessionId: runtime.nativeId, mode: prepared.delivery === 'steer' ? 'steer' : 'queue', content: encoded.content },
    }, sessionId, inputReference);
  }

  async steer(sessionId: string, input: UserInput): Promise<void> {
    return this.send(sessionId, { ...input, delivery: 'steer' } as UserInput & { delivery: 'steer' });
  }
  async validateInput(sessionId: string, input: UserInput): Promise<void> {
    const prepared = input as UserInput & DshResolvableInput;
    const parts = dshInputParts(prepared);
    const command = input.text.startsWith('/') && isAllowedCommandLine(input.text, input.text);
    let modalities: DshInputModality[] | undefined = command ? ['text', 'image'] : undefined;
    if (!command && parts.some(part => part.type === 'image')) {
      const client = await this.ensureSidecar(); const runtime = this.require(sessionId);
      const projections = await this.call<{ asOfSeq: number; values?: { modelSelection?: { provider: string; model: string } } }>(client, 'session/projections', { request: { sessionId: runtime.nativeId } }, sessionId);
      const catalog = await this.modelCatalog(client); const selected = projections.values?.modelSelection ?? catalog.default;
      if (typeof selected?.provider === 'string' && typeof selected.model === 'string') {
        const capabilities = await dshInputCapabilities(catalog, <T>(endpoint: string, args?: Record<string, unknown>) => this.call<T>(client, endpoint, args));
        modalities = capabilities.get(dshInputRoute(selected.provider, selected.model))?.inputModalities;
      }
    }
    validateDshInputParts(parts, modalities);
    if (!input.text.trim() && !parts.some(part => part.type === 'file' || part.type === 'image')) throw dshInputUnsupported('请输入正文或选择附件');
    if (input.delivery === 'steer' && command) throw dshInputUnsupported('Native slash commands cannot be steered into an LLM turn');
  }

  private async uploadNativeFile(sessionId: string, runtime: SessionRuntime, client: DshHostClient, part: DshResolvedAttachment, data: Uint8Array) {
    if (this.rpcWritesBlocked) throw Object.assign(new Error('DSH native capture is incomplete'), { code: 'uncertain' });
    const sink = this.nativeSinks.get(sessionId); const epoch = this.hostEpoch; const generation = this.muxGeneration;
    const previousFingerprint = this.observedHost?.fingerprint;
    const host = await this.hostIdentity(); requireDshBaseline(host);
    if (this.client !== client || this.sessions.get(sessionId) !== runtime || this.hostEpoch !== epoch || this.muxGeneration !== generation
      || previousFingerprint !== undefined && previousFingerprint !== host.fingerprint) throw Object.assign(new Error('DSH Host changed before file upload'), { code: 'uncertain' });
    const record = (observation: DshBinaryUploadObservation): boolean => {
      const frame = { i: ++this.traceSeq, t: 0, dir: observation.dir, ch: 'http:session/uploadFileBinary', frame: { frame: observation.frame,
        dshUpload: { coverage: observation.coverage, sessionId: runtime.nativeId, ...(observation.httpStatus === undefined ? {} : { httpStatus: observation.httpStatus }),
          hostEpoch: epoch, muxGeneration: generation, ...(host?.status === 'verified' && host.fingerprint !== undefined ? { verifiedHostFingerprint: host.fingerprint } : {}) } } };
      const receipt = sink?.record(frame);
      if (this.sessions.get(sessionId) === runtime && this.client === client && this.hostEpoch === epoch && this.muxGeneration === generation) runtime.envelopeId = receipt?.envelopeId;
      traceFrame(this.options.traceSink ?? this.traceSinks.get(sessionId), frame); return receipt?.accepted !== false;
    };
    return client.uploadFileBinary({ sessionId: runtime.nativeId, data, fileId: part.fileId, ...(part.name === undefined ? {} : { name: part.name }) }, observation => {
      if (observation.dir !== 'in') return;
      if (sink !== undefined && observation.coverage !== 'complete') this.rpcWritesBlocked = true;
      try { if (!record(observation)) this.rpcWritesBlocked = true; } catch { this.rpcWritesBlocked = true; }
    }, observation => {
      if (this.sessions.get(sessionId) !== runtime || this.client !== client || this.hostEpoch !== epoch || this.muxGeneration !== generation) return false;
      let accepted = false; try { accepted = record(observation); } catch { /* before upload */ }
      if (!accepted) this.rpcWritesBlocked = true; return accepted;
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
    const selected = (runtime.projections?.values['modelSelection'] ?? runtime.modelObservation) as { provider?: string; model?: string } | undefined;
    let model = selected?.model ?? runtime.model;
    if (model === undefined || model === '') {
      const catalog = await this.modelCatalog(client);
      model = catalog.default?.model;
    }
    if (model === undefined || model === '') throw new Error('dsh: 当前会话没有可切换思考强度的模型');
    if (selected?.provider !== undefined) model = `dsh:${Buffer.from(JSON.stringify([selected.provider, model])).toString('base64url')}`;
    await this.selectModel(client, runtime, model, effort);
  }

  async interrupt(sessionId: string): Promise<void> {
    const client = await this.ensureSidecar();
    const runtime = this.require(sessionId);
    await this.call(client, 'session/cancel', { request: { sessionId: runtime.nativeId } });
  }

  async respond(sessionId: string, decision: ApprovalDecision): Promise<NativeInteractionSubmission> {
    const client = await this.ensureSidecar();
    const runtime = this.require(sessionId);
    const pending = runtime.pending.get(decision.approvalId);
    if (pending?.kind !== 'approval' || pending.generation !== this.muxGeneration || this.clientId === '') throw Object.assign(new Error('DSH 审批已结束或需要重新同步'), { statusCode: 409 });
    if (pending.sent) throw dshNativeError('DSH approval was submitted; wait for its durable decision', 409);
    if (!['allowed-once', 'rejected'].includes(decision.optionId)) throw Object.assign(new Error('DSH 审批选项无效'), { statusCode: 400 });
    await this.call(client, '$events/result', {
      clientId: this.clientId,
      eventId: decision.approvalId,
      outcome: { kind: 'result', value: decision.optionId },
    });
    pending.sent = true;
    return { confirmed: false };
  }

  /** 打断时把自己挂起的审批标成 cancelled（只处理本会话的） */
  async cancelPending(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return;
    const client = await this.ensureSidecar().catch(() => null);
    for (const [eventId, pending] of runtime.pending) {
      if (pending.waitStream !== undefined) client?.closeStream(pending.waitStream);
      if (client === null || pending.generation !== this.muxGeneration || this.clientId === '') continue;
      if (pending.kind === 'approval') {
        await this.call(client, '$events/result', {
          clientId: this.clientId,
          eventId,
          outcome: { kind: 'result', value: 'cancelled' },
        });
        runtime.pending.delete(eventId);
      }
    }
  }

  async answer(sessionId: string, questionId: string, answer: unknown): Promise<AnswerSubmission> {
    const client = await this.ensureSidecar();
    const runtime = this.require(sessionId);
    const entry = [...runtime.pending].find(([eventId, pending]) => pending.kind === 'question' && (questionId === eventId || pending.questionIds?.some(id => `${eventId}:${id}` === questionId)));
    if (entry === undefined) throw new Error('DSH 问题已结束或不存在');
    const [eventId, pending] = entry;
    if (pending.sent) throw dshNativeError('DSH question reply is queued; wait for native admission', 409);
    if (pending.generation !== this.muxGeneration || !pending.continued && this.clientId === '') throw Object.assign(new Error('DSH 问题需要重新同步'), { statusCode: 409 });
    const id = questionId === eventId ? pending.questionIds?.[0] ?? questionId : questionId.slice(eventId.length + 1);
    const { selected, custom } = normalizeQuestionAnswer(answer);
    pending.answers ??= new Map();
    pending.answers.set(id, { id, selected, ...(custom === undefined || custom === '' ? {} : { custom }) });
    if (pending.answers.size < (pending.questionIds?.length ?? 1)) return { submitted: false };
    if (pending.continued && pending.callId !== undefined) {
      const accepted = await this.call<boolean>(client, 'userQuestions/answer', { agentId: runtime.nativeId, callId: pending.callId, answer: { answers: [...pending.answers.values()] } }, sessionId);
      if (accepted !== true) throw dshNativeError('The native continued question has ended', 409);
      pending.sent = true;
      return { submitted: true, confirmed: false, questionIds: (pending.questionIds ?? [id]).map(question => `${eventId}:${question}`) };
    }
    await this.call(client, '$events/result', { clientId: this.clientId, eventId, outcome: { kind: 'result', value: { answers: [...pending.answers.values()] } } }, sessionId);
    if (pending.waitStream !== undefined) this.client?.closeStream(pending.waitStream);
    runtime.pending.delete(eventId);
    return { submitted: true, questionIds: (pending.questionIds ?? [id]).map(question => `${eventId}:${question}`) };
  }

  /** 运行期切换连接（设置页粘贴 DSH 链接后调用） */
  async setAttach(url: string, cookie: string, persist?: () => Promise<void>, browserCookie?: string): Promise<void> {
    const currentUrl = this.options.attachUrl ?? (this.sidecar === null ? undefined : dshBaseUrl(this.sidecar.port));
    if (this.sessions.size > 0 && (currentUrl === undefined || dshBaseUrl(url) !== dshBaseUrl(currentUrl))) throw Object.assign(new Error('存在已关联会话，不能切换到不同 DSH Host'), { statusCode: 409 });
    const candidate = this.newHost(url);
    candidate.useCookie(browserCookie ?? cookie);
    try { await candidate.connect(); await persist?.(); }
    catch (error) { await candidate.close(); throw error; }
    await this.shutdown();
    this.options = { ...this.options, mode: 'attach', attachUrl: dshBaseUrl(url), attachCookie: cookie, attachBrowserCookie: browserCookie };
    this.client = candidate;
    candidate.openStream('$events', {}, frame => { if (this.client === candidate) this.onEventFrame('', frame); });
    this.openControl(candidate);
    this.openWorkspaces(candidate);
    for (const [id, runtime] of this.sessions) this.openFollow(id, runtime);
  }

  async disconnect(): Promise<void> {
    await this.shutdown();
    this.options = { ...this.options, mode: 'attach', attachCookie: '' };
  }

  /** 关闭侧车（进程级清理，测试与平台退出时调用） */
  async shutdown(): Promise<void> {
    this.hostEpoch++;
    this.clientId = '';
    this.observedHost = undefined;
    this.rpcWritesBlocked = false;
    this.workspaceState.invalidate();
    this.muxGeneration++;
    const boot = this.booting;
    const client = this.client;
    const sidecar = this.sidecar;
    this.client = null;
    this.sidecar = null;
    this.booting = null;
    for (const runtime of this.sessions.values()) { runtime.history?.invalidate(); runtime.projections = undefined; runtime.children.clear(); runtime.modelObservation = undefined; runtime.controlState = undefined; }
    await client?.close().catch(() => undefined);
    await sidecar?.stop().catch(() => undefined);
    await boot?.catch(() => undefined);
    for (const runtime of this.sessions.values()) runtime.followStream = null;
  }

  debugProcesses(): { sessionId: string; pid: number; dirs: Record<string, string> }[] {
    const pid = this.sidecar?.child.pid ?? 0;
    return [...this.sessions.keys()].map((sessionId) => ({
      sessionId,
      pid,
      dirs: {
        HOME: (this.options.mode ?? 'spawn') === 'spawn' ? process.env['HOME'] ?? '' : '',
        DSH_HOME: (this.options.mode ?? 'spawn') === 'spawn' ? this.options.env?.['DSH_HOME'] ?? process.env['DSH_HOME'] ?? '' : '',
        WDCC_DSH_MODE: this.options.mode ?? 'spawn',
      },
    }));
  }

  async dispose(sessionId: string): Promise<void> {
    this.nativeSinks.delete(sessionId);
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return;
    this.sessions.delete(sessionId);
    runtime.history?.invalidate();
    for (const pending of runtime.pending.values()) if (pending.waitStream !== undefined) this.client?.closeStream(pending.waitStream);
    if (runtime.followStream !== null) this.client?.closeStream(runtime.followStream);
    if (runtime.permissionStream !== undefined) this.client?.closeStream(runtime.permissionStream);
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
    if (!this.trace(owner, 'in', 'mux:$events', frame)) return;
    if (value === undefined) return;

    if (value['type'] === 'ready') {
      if (typeof value['clientId'] === 'string') this.clientId = value['clientId'];
      return;
    }
    if (value['type'] === 'projection' && Array.isArray(value['changes'])) {
      const runtime = this.sessions.get(sessionId);
      if (runtime !== undefined) this.applyProjectionChanges(sessionId, runtime, value, 'session/observeProjections');
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
    if (value['type'] === 'cancel') {
      const eventId = String(value['eventId'] ?? '');
      for (const [id, runtime] of this.sessions) {
        const pending = runtime.pending.get(eventId);
        if (pending === undefined) continue;
        // Cancellation of a forwarding waiter does not establish a sent
        // approval's outcome; its durable decided event remains authoritative.
        if (pending.kind === 'approval' && pending.sent) continue;
        runtime.pending.delete(eventId);
        if (pending.waitStream !== undefined) this.client?.closeStream(pending.waitStream);
        if (pending.kind === 'approval') this.emit(id, { type: 'item.complete', itemKey: `approval-cancelled-${eventId}`, kind: 'approval.resolved', data: { approvalId: eventId, optionId: 'cancelled', by: 'other' }, native: value });
        else for (const question of pending.questionIds ?? []) this.emit(id, { type: 'item.complete', itemKey: `question-cancelled-${eventId}-${question}`, kind: 'question', data: { questionId: `${eventId}:${question}`, prompt: '', status: 'skipped' }, native: value });
      }
      return;
    }
    if (value['type'] === 'snapshot') {
      const runtime = this.sessions.get(sessionId);
      if (runtime !== undefined) {
        if (runtime.nativeId === '' && this.replayTime !== undefined) runtime.nativeId = String((value['header'] as { id?: unknown })?.id ?? '');
        this.setupHistory(sessionId, runtime);
        runtime.assistantBuffered = [];
        runtime.history?.opening(value as unknown as DshOpening);
      }
      return;
    }
    if (value['type'] !== 'event') return;

    const event = (value['event'] ?? {}) as Record<string, unknown>;
    const type = String(event['type'] ?? '');
    const seq = Number(event['seq'] ?? 0);
    const data = (event['data'] ?? {}) as Record<string, unknown>;
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return;
    if (runtime.history !== undefined) {
      try { runtime.history.event({ type: 'event', event: event as unknown as DshHistoryRecord['event'] }); }
      catch (error) { this.emit(sessionId, { type: 'item.complete', itemKey: `dsh-history-error-${++runtime.frameSeq}`, kind: 'error', data: { message: error instanceof Error ? error.message : String(error) } }); }
      return;
    }
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
    if (runtime.historyRecord === undefined && ['assistant/message', 'assistant/attempt'].includes(type) && runtime.assistantBridge?.matchesSettlement(nativeSeq, data)) {
      runtime.assistantSettlements ??= new Map();
      runtime.assistantSettlements.set(nativeSeq, { type, data, native, envelopeId: runtime.envelopeId });
      return;
    }
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
      case 'request/header': {
        const header = data['header'] as { config?: { provider?: string; model?: string; reasoningEffort?: string } } | undefined;
        if (header?.config !== undefined) runtime.modelObservation = { ...header.config, source: 'request/header', nativeSeq };
        complete(`internal-header-${nativeSeq}`, 'internal', { nativeType: type }); return;
      }
      case 'agent-preset/selected': {
        const values = { ...(runtime.projections?.values ?? {}), agentPreset: data['agentPreset'] };
        this.applyProjections(sessionId, runtime, { asOfSeq: nativeSeq, values });
        complete(`internal-preset-${nativeSeq}`, 'internal', { nativeType: type }); return;
      }
      case 'subagent/catalog':
      case 'subagent/start':
      case 'subagent/updated':
      case 'subagent/end': {
        const childId = String(data['childId'] ?? data['child_id'] ?? data['agentId'] ?? '');
        const label = String(data['label'] ?? data['name'] ?? data['mode'] ?? 'DSH 子 Agent');
        const terminal = type === 'subagent/end' || data['status'] === 'completed' || data['status'] === 'failed';
        if (childId !== '' && typeof data['mode'] === 'string') runtime.children.set(childId, data['mode']);
        complete(`subagent-${childId || nativeSeq}`, 'tool.call', {
          name: 'subagent',
          label,
          input: { childId, parentSessionId: runtime.nativeId, ...(data['name'] === undefined ? {} : { name: String(data['name']) }), ...(data['mode'] === undefined ? {} : { mode: String(data['mode']) }), ...(data['status'] === undefined ? {} : { status: String(data['status']) }) },
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
      case 'approval/asked': {
        const id = String(data['id'] ?? '');
        if (id !== '') runtime.approvals.set(id, { toolName: String(data['toolName'] ?? ''), ...(typeof data['callId'] === 'string' ? { callId: data['callId'] } : {}) });
        complete(`internal-asked-${nativeSeq}`, 'internal', { nativeType: type });
        return;
      }
      case 'approval/decided': {
        // F17：审批在别的界面被处理了 → 发 approval.resolved，by='other'
        const durableId = String(data['id'] ?? '');
        const approvalId = runtime.approvals.get(durableId)?.eventId ?? String(data['eventId'] ?? data['approvalId'] ?? data['requestId'] ?? '');
        const pending = runtime.pending.get(approvalId);
        if (approvalId === '' || pending === undefined) {
          complete(`internal-decided-${nativeSeq}`, 'internal', { nativeType: type });
          return;
        }
        runtime.pending.delete(approvalId);
        runtime.approvals.delete(durableId);
        const raw = String(data['outcome'] ?? data['decision'] ?? data['optionId'] ?? 'unavailable');
        const optionId = ['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(raw) ? raw : 'unavailable';
        complete(`approval-resolved-${nativeSeq}`, 'approval.resolved', { approvalId, optionId, by: pending.sent ? 'user' : 'other' });
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
      case 'user/message': {
        const source = (data['source'] ?? {}) as { kind?: string; rpcId?: string; callId?: string };
        if (source.kind !== 'user') { complete(`internal-user-${nativeSeq}`, 'internal', { nativeType: `user/message:${source.kind ?? 'unknown'}` }); return; }
        const content = Array.isArray(data['content']) ? data['content'] as { type?: string; text?: string }[] : [];
        complete(`user-native-${String(data['id'] ?? nativeSeq)}`, 'user.message', { text: content.filter(part => part.type === 'text').map(part => part.text ?? '').join(''), ...(typeof source.rpcId === 'string' ? { clientCommandId: source.rpcId } : {}) });
        return;
      }
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
    const frame = value['frame'];
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return;
    if (runtime.history !== undefined && !runtime.history.isReady) {
      runtime.assistantBuffered ??= [];
      if (runtime.assistantBuffered.length >= 10_000) { this.rebaselineAssistant(sessionId, runtime); return; }
      runtime.assistantBuffered.push(frame as Record<string, unknown>); return;
    }
    this.acceptAssistantFrame(sessionId, runtime, frame as Record<string, unknown>);
  }
  private acceptAssistantFrame(sessionId: string, runtime: SessionRuntime, frame: Record<string, unknown>): void {
    runtime.assistantBridge ??= new DshAssistantBridge();
    const outcome = runtime.assistantBridge.accept(frame);
    if (outcome === 'rebaseline') { this.rebaselineAssistant(sessionId, runtime); return; }
    if (outcome === 'end') {
      const settlement = frame['outcome'] as { kind?: string; seq?: number; eventType?: string };
      if (settlement.kind === 'abandoned') {
        if ((runtime.assistantSettlements?.size ?? 0) !== 0) { this.rebaselineAssistant(sessionId, runtime); return; }
        this.cancelAssistantAttempt(sessionId, runtime);
      } else {
        const pending = runtime.assistantSettlements?.get(settlement.seq ?? -1);
        if (pending === undefined || pending.type !== settlement.eventType) { this.rebaselineAssistant(sessionId, runtime); return; }
        runtime.assistantSettlements?.delete(settlement.seq!);
        const retire = pending.type === 'assistant/attempt' || pending.data['interrupted'] === true;
        if (retire) this.cancelAssistantAttempt(sessionId, runtime);
        const currentEnvelope = runtime.envelopeId;
        runtime.envelopeId = pending.envelopeId;
        this.onDshEvent(sessionId, runtime, pending.type, pending.data, settlement.seq!, pending.native);
        runtime.envelopeId = currentEnvelope;
        // Completed messages belong to the durable transcript. A later failed
        // attempt must only retire its own transient rows.
        runtime.assistantKeys = new Set();
      }
    }
    if (outcome === 'chunk') this.onAssistantChunk(sessionId, { frame });
  }
  private rebaselineAssistant(sessionId: string, runtime: SessionRuntime): void {
    runtime.history?.invalidate(); runtime.assistantBuffered = [];
    if (this.client === null || !this.client.isConnected) return;
    if (runtime.followStream !== null) this.client.closeStream(runtime.followStream);
    if (runtime.permissionStream !== undefined) this.client.closeStream(runtime.permissionStream);
    this.openFollow(sessionId, runtime);
  }
  private cancelAssistantAttempt(sessionId: string, runtime: SessionRuntime): void {
    for (const itemKey of runtime.assistantKeys ?? []) this.emit(sessionId, { type: 'item.cancel', itemKey });
    runtime.assistantKeys = new Set();
    runtime.assistantKey = ''; runtime.assistantText = ''; runtime.reasoningKey = ''; runtime.reasoningText = '';
    runtime.streamedAssistant = false; runtime.streamedReasoning = false;
  }
  private assistantItemKey(runtime: SessionRuntime, kind: string, chunk: Record<string, unknown>): string {
    const attempt = runtime.assistantBridge?.attemptId;
    const key = attempt === undefined ? `${kind}-live-${++runtime.frameSeq}` : `${kind}-attempt-${attempt}-${String(chunk['index'] ?? 0)}`;
    runtime.assistantKeys ??= new Set(); runtime.assistantKeys.add(key); return key;
  }
  private onAssistantChunk(sessionId: string, value: Record<string, unknown>): void {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return;
    const frame = (value['frame'] ?? {}) as Record<string, unknown>;
    if (frame['type'] !== 'chunk') return;
    const chunk = (frame['chunk'] ?? {}) as Record<string, unknown>;
    const kind = String(chunk['type'] ?? '');
    if (runtime.generationStartedAt === null) runtime.generationStartedAt = this.now();
    if (kind === 'block-start') {
      const blockType = String(chunk['blockType'] ?? '');
      if (!['text', 'reasoning'].includes(blockType)) return;
      if (blockType === 'reasoning') {
        this.finishLiveAssistant(sessionId, runtime);
        this.finishLiveReasoning(sessionId, runtime);
        runtime.reasoningKey = this.assistantItemKey(runtime, 'reasoning', chunk);
        runtime.reasoningText = '';
        this.emit(sessionId, { type: 'item.start', itemKey: runtime.reasoningKey, kind: 'reasoning', data: { text: '' } });
      } else {
        this.finishLiveReasoning(sessionId, runtime);
        this.finishLiveAssistant(sessionId, runtime);
        runtime.assistantKey = this.assistantItemKey(runtime, 'msg', chunk);
        runtime.assistantText = '';
        this.emit(sessionId, { type: 'item.start', itemKey: runtime.assistantKey, kind: 'assistant.message', data: { text: '' } });
      }
      return;
    }
    if (kind === 'block-end') {
      const block = chunk['block'] as { type?: string; text?: string } | undefined;
      const blockType = String(chunk['blockType'] ?? block?.type ?? '');
      if (blockType !== '' && !['text', 'reasoning'].includes(blockType)) return;
      if (blockType === 'reasoning' || (blockType === '' && runtime.reasoningKey !== '' && runtime.assistantKey === '')) this.finishLiveReasoning(sessionId, runtime, block?.text);
      else this.finishLiveAssistant(sessionId, runtime, block?.text);
      return;
    }
    if (kind === 'text-delta') {
      if (runtime.assistantKey === '') {
        runtime.assistantKey = this.assistantItemKey(runtime, 'msg', chunk);
        this.emit(sessionId, { type: 'item.start', itemKey: runtime.assistantKey, kind: 'assistant.message', data: { text: '' } });
      }
      const text = String(chunk['text'] ?? '');
      runtime.assistantText += text;
      this.emit(sessionId, { type: 'item.delta', itemKey: runtime.assistantKey, field: 'text', append: text });
      return;
    }
    if (kind === 'reasoning-delta') {
      if (runtime.reasoningKey === '') {
        runtime.reasoningKey = this.assistantItemKey(runtime, 'reasoning', chunk);
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
    if (target === '') { this.delegateWaterfall(eventId); return; }
    const runtime = this.sessions.get(target);
    if (runtime === undefined) return;
    const request = (value['request'] ?? {}) as Record<string, unknown>;

    if (event === 'approval/request') {
      if (process.env['WDCC_DEBUG_DSH'] === '1') console.error('[dsh] approval/request', JSON.stringify(value).slice(0, 1200));
      const toolName = String(request['toolName'] ?? '工具');
      const callId = String(request['callId'] ?? '');
      const matches = [...runtime.approvals].filter(([, approval]) => approval.eventId === undefined && (callId !== '' ? approval.callId === callId : approval.toolName === toolName));
      const durableId = matches.length === 1 ? matches[0]?.[0] : undefined;
      if (durableId !== undefined) { const approval = runtime.approvals.get(durableId); if (approval !== undefined) approval.eventId = eventId; }
      runtime.pending.set(eventId, { kind: 'approval', eventId, callId, durableId, generation: this.muxGeneration });
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
      const wait = request['wait'] as { callId?: string; timed?: boolean } | undefined;
      const pending: PendingInteraction = { kind: 'question', eventId, questionIds: ids, generation: this.muxGeneration, callId: wait?.callId };
      runtime.pending.set(eventId, pending);
      if (wait?.timed === true && typeof wait.callId === 'string' && this.client?.isConnected) {
        const client = this.client;
        pending.waitStream = client.openStream('userQuestions/attachWait', { agentId: runtime.nativeId, callId: wait.callId }, frame => {
          if (this.client !== client || runtime.pending.get(eventId) !== pending) return;
          const remaining = (frame.value as { remainingMs?: unknown })?.remainingMs;
          if (frame.type === 'item' && typeof remaining === 'number') pending.remainingMs = Math.max(0, remaining);
        });
      }
      for (const [index, first] of questions.entries()) this.emit(target, {
        type: 'item.complete',
        itemKey: `question-${eventId}-${ids[index]}`,
        kind: 'question',
        data: {
          questionId: `${eventId}:${ids[index]}`,
          groupId: eventId,
          ...(wait?.callId === undefined ? {} : { toolCallId: wait.callId }),
          prompt: String(first['question'] ?? '请回答'),
          ...(first['header'] === undefined ? {} : { header: String(first['header']) }),
          options: ((first['options'] as Record<string, unknown>[]) ?? []).map((option) => ({
            id: String(option['label'] ?? ''),
            label: String(option['label'] ?? ''),
            ...(option['description'] === undefined ? {} : { description: String(option['description']) }),
          })),
          multiSelect: first['multiSelect'] === true,
          isSecret: first['isSecret'] === true,
          allowsFreeText: true,
        },
      });
      return;
    }
    this.emit(target, { type: 'item.complete', itemKey: `dsh-unknown-waterfall-${eventId}`, kind: 'unknown', data: { nativeType: event }, native: value });
    this.delegateWaterfall(eventId, target);
  }
  private delegateWaterfall(eventId: string, sessionId?: string): void {
    const client = this.client;
    if (client === null || this.clientId === '' || eventId === '') return;
    // Native `next` delegates to another composed answerer. Unknown reverse
    // requests never acquire an invented approval/result from WebDCC.
    void this.call(client, '$events/result', { clientId: this.clientId, eventId, outcome: { kind: 'next' } }, sessionId).catch(() => undefined);
  }
}
