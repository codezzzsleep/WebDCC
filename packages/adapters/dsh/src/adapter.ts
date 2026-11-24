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
  NativeRuntimeContext,
  UserInput,
  TraceSink,
  TraceFrame,
  NativeHistoryRecord,
  AnswerSubmission,
  AccessModeOption,
  NativeInteractionSubmission,
  NativeDshRpcCaptureMetadata,
  SlashCommand,
  SlashControlResult,
  ResolvedInputContent,
  DshSubagentCatalog,
  DshSubagentHistory,
  DshSubagentHistoryOptions,
  DshSubagentState,
  DshSubagentReadTarget,
  DshSubagentControlTarget,
  DshSubagentInterruptReceipt,
  DshSubagentPromptOptions,
  DshSubagentPromptReceipt,
  DshSubagentInputReference,
  DshSubagentInputObservation,
  DshQuestionWaitOpening,
} from '@webdcc/protocol';
import { buildFileChanges, isValidEventData, traceFrame, ulid, normalizeQuestionAnswer, nativeAccessMode, slashCommandFor, parseSlashInput } from '@webdcc/protocol';
import { dshBaseUrl, DshHostClient, DshRpcError, startSidecar, type Sidecar, type StreamFrame, type DshRpcObservation, type DshBinaryUploadObservation } from './host.js';
import { validateDshArgs, type DshHistoryRecord, type DshPage, type DshSubagentPrompt, type DshSubagentInterrupt } from './contracts.js';
import { DshHistoryBridge, type DshOpening } from './history.js';
import { DshAssistantBridge, failedDshAttemptDetails } from './assistant.js';
import { DshRetryDisplay } from './retry.js';
import { readDshHostIdentity, requireDshBaseline, type DshHostIdentity } from './identity.js';
import { DSH_BASELINE_VERSION, dshRuntimeContract, dshRuntimeSummary, isSupportedDshVersion, SUPPORTED_DSH_VERSIONS } from './runtime.js';
import { DshSystemMessages } from './system-messages.js';
import slashCatalog from './slash-catalog.json' with { type: 'json' };
import { dshCommandAliases, mapDshCommands, type DshCommandDescriptor } from './commands.js';
import { dshGoalChange, dshGoalProjection } from './goals.js';
import { DSH_NATIVE_CONTROLS, dshNativeActionMetadata, dshNativeCall, dshNativeError, dshPublicValue, dshRevision, parseDshNativeAction } from './native.js';
import { DshWorkspaceBridge } from './workspaces.js';
import { randomUUID } from 'node:crypto';
import { sameDshApproval, sameDshQuestionDelivery, isDshQuestionAttempt, type DshApprovalAttempt, type DshApprovalDelivery,
  type DshQuestionAttempt, type DshQuestionDelivery } from '@webdcc/protocol';
import { dshSubagentCatalog, dshSubagentAddress, checkDshSubagentPage, dshSubagentSummary, dshSubagentDescriptorSeq, dshSubagentInputHash } from './subagents.js';
import { dshQuestionSignature, dshQuestionRecoverySignature, dshQuestionAnswers, dshQuestionResult, sameDshQuestionAnswers, type DshQuestionResult } from './questions.js';
import { dshInputCapabilities, dshInputRoute, type DshInputModality } from './input-capabilities.js';
import { dshInputParts, dshInputUnsupported, encodeDshInput, validateDshInputParts, type DshResolvableInput, type DshResolvedAttachment } from './input.js';

export const PINNED_VERSION = DSH_BASELINE_VERSION;

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
  'subagents/interruptByUser',
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
  questionItems?: EventData['question'][];
  answers?: Map<string, { id: string; selected: string[]; custom?: string }>;
  callId?: string;
  durableId?: string;
  generation?: number;
  continued?: boolean;
  timed?: boolean;
  sent?: boolean;
  sending?: boolean;
  answerAttempt?: object;
  acceptedReply?: boolean;
  approvalTool?: string;
  approvalItem?: EventData['approval.request'];
  approvalAgentId?: string;
  approvalDeliveryId?: string;
  questionAgentId?: string;
  questionDeliveryId?: string;
  questionSignature?: string;
  transportClosed?: boolean;
  settlement?: DshQuestionResult;
  waitClosers?: Set<() => void>;
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
  questionResults?: Map<string, { result: DshQuestionResult; native: unknown; seq?: number }>;
  children: Map<string, string>;
  approvals: Map<string, { callId?: string; toolName: string; eventId?: string }>;
  history?: DshHistoryBridge;
  historyRecord?: NativeHistoryRecord;
  historyRecords?: NativeHistoryRecord[];
  systemMessages?: DshSystemMessages;
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
  retries?: DshRetryDisplay;
  assistantBridge?: DshAssistantBridge;
  assistantBuffered?: Record<string, unknown>[];
  assistantKeys?: Set<string>;
  assistantSettlements?: Map<number, { type: string; data: Record<string, unknown>; native: unknown; envelopeId?: number }>;
  projections?: { asOfSeq: number; values: Record<string, unknown> };
  goalObservation?: { data: EventData['goal']; throughSeq: number; projection: boolean };
  modelObservation?: { provider?: string; model?: string; publicModelId?: string; reasoningEffort?: string; source: string; nativeSeq?: number };
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

interface DshModelSelection { provider: string; model: string; reasoningEffort?: string }

/** Native 0.2.2-rc.1 wire projection separates the next selection from last use. */
function projectedModelSelection(value: unknown): DshModelSelection | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const projection = value as { next?: unknown; lastUsed?: unknown };
  const selected = projection.next ?? projection.lastUsed;
  if (selected === null || typeof selected !== 'object') return undefined;
  const model = selected as Partial<DshModelSelection>;
  if (typeof model.provider !== 'string' || typeof model.model !== 'string' || model.reasoningEffort !== undefined && typeof model.reasoningEffort !== 'string') return undefined;
  return { provider: model.provider, model: model.model, ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }) };
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
  private modelPublicIds = new Map<string, string>();
  private sidecar: Sidecar | null = null;
  private client: DshHostClient | null = null;
  private clientId = '';
  private readonly workspaceState = new DshWorkspaceBridge();
  private booting: Promise<void> | null = null;
  private options: DshAdapterOptions;
  private traceSeq = 0;
  private readonly nativeSinks = new Map<string, NonNullable<CreateOpts['nativeEvents']>>();
  private readonly capabilityGeneration = ulid();
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
        ...(host?.status !== 'verified' || host.fingerprint === undefined ? {} : { verifiedHostFingerprint: host.fingerprint }),
        ...(!isSupportedDshVersion(host?.version) ? {} : { nativeVersion: host.version, contractHash: dshRuntimeContract(host.version).schemaHash }), hostEpoch: epoch, muxGeneration: generation } satisfies NativeDshRpcCaptureMetadata,
    };
    const transport = { i: ++this.traceSeq, t: 0, dir: observation.dir, ch: `rpc:${observation.endpoint}`, frame };
    const receipt = sink?.record(transport);
    if (runtime !== undefined && this.sessions.get(sessionId) === runtime) runtime.envelopeId = receipt?.envelopeId;
    traceFrame(this.options.traceSink ?? this.traceSinks.get(sessionId) ?? this.options.traceSinkFactory?.(sessionId || 'dsh-host'), transport);
    return receipt?.accepted !== false;
  }

  /** Recorded mux frames pass through the live stream and event handlers. */
  static replay(sessionId = 'replay', nativeId = '', nativeVersion = DSH_BASELINE_VERSION): { feed: (frame: TraceFrame) => AdapterEvent[]; adapter: DshAdapter; replies: unknown[] } {
    dshRuntimeContract(nativeVersion);
    const adapter = new DshAdapter();
    adapter.replaying = true;
    const runtime: SessionRuntime = {
      nativeId, workspaceId: '', followStream: null, lastSeq: 0, turnStartedAt: 0,
      pending: new Map(), children: new Map(), approvals: new Map(), toolCalls: new Map(), toolInputs: new Map(), assistantKey: '', assistantText: '',
      reasoningKey: '', reasoningText: '', streamedAssistant: false, streamedReasoning: false, generationStartedAt: null, frameSeq: 0,
    };
    adapter.sessions.set(sessionId, runtime);
    const replies: unknown[] = [];
    adapter.client = { nativeVersion, connect: async () => undefined, rpc: async (endpoint: string, args: unknown) => { replies.push({ endpoint, args }); return { accepted: true }; } } as unknown as DshHostClient;
    let events: AdapterEvent[] = [];
    adapter.onEvent((_id, event) => events.push(event));
    const requests = new Map<string, { endpoint: string; args: Record<string, unknown>; context: string }>();
    const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const replayRpc = (frame: TraceFrame): void => {
      const capture = object(frame.frame), transport = object(capture['dshTransport']), message = object(capture['frame']);
      const endpoint = frame.ch.slice(4), rpcId = message['rpcId'];
      if (!['session/modelCatalog', 'session/selectModel', 'session/projections'].includes(endpoint)
        || transport['coverage'] !== 'complete' || transport['endpoint'] !== endpoint || typeof rpcId !== 'string' || transport['rpcId'] !== rpcId) return;
      const context = JSON.stringify([transport['verifiedHostFingerprint'], transport['hostEpoch'], transport['muxGeneration']]);
      if (frame.dir === 'out' && message['type'] === 'client-request' && message['method'] === endpoint) {
        if (requests.size < 1024) requests.set(rpcId, { endpoint, args: object(object(message['payload'])['args']), context });
        return;
      }
      if (frame.dir !== 'in' || message['type'] !== 'server-response') return;
      const request = requests.get(rpcId); requests.delete(rpcId);
      const result = object(message['result']);
      if (request?.endpoint !== endpoint || request.context !== context || result['ok'] !== true
        || typeof transport['httpStatus'] === 'number' && (transport['httpStatus'] < 200 || transport['httpStatus'] >= 300)) return;
      const value = object(result['value']);
      if (endpoint === 'session/modelCatalog') {
        if (Array.isArray(value['groups'])) adapter.cacheModelCatalog(value as unknown as DshModelCatalog);
        return;
      }
      const target = object(request.args['request']);
      if (runtime.nativeId === '' || target['sessionId'] !== runtime.nativeId) return;
      if (endpoint === 'session/selectModel') {
        if (typeof target['provider'] !== 'string' || typeof target['model'] !== 'string'
          || target['reasoningEffort'] !== undefined && typeof target['reasoningEffort'] !== 'string') return;
        try { adapter.confirmModelSelection(sessionId, runtime, value, target['provider'], target['model'], target['reasoningEffort'] as string | undefined); }
        catch { /* A rejected native confirmation must not create an observation. */ }
      } else if (value['kind'] !== 'cached' && Number.isSafeInteger(value['asOfSeq']) && typeof value['asOfSeq'] === 'number'
        && value['asOfSeq'] >= (runtime.projections?.asOfSeq ?? -1) && value['values'] !== null && typeof value['values'] === 'object' && !Array.isArray(value['values'])) {
        adapter.applyProjections(sessionId, runtime, { asOfSeq: value['asOfSeq'], values: object(value['values']) });
        const selected = projectedModelSelection(object(value['values'])['modelSelection']);
        if (selected !== undefined) adapter.observeModelSelection(sessionId, runtime, selected, 'session/projections:modelSelection.next');
      }
    };
    return { adapter, replies, feed(frame) {
      events = []; adapter.replayTime = frame.t;
      if (frame.dir === 'in' && frame.ch.startsWith('mux:')) adapter.onEventFrame(sessionId, frame.frame as StreamFrame);
      else if (frame.ch.startsWith('rpc:')) replayRpc(frame);
      return events.length > 0 ? [...events] : [{ type: 'item.complete', itemKey: `transport-${frame.ch}-${frame.i}`, kind: 'internal', data: { nativeType: frame.ch }, native: frame.frame }];
    } };
  }

  private replayTime?: number;
  private replaying = false;
  private now(): number { return this.replayTime ?? Date.now(); }

  private nativeRevision(runtime: SessionRuntime): string {
    return dshRevision({ host: this.observedHost?.fingerprint, hostEpoch: this.hostEpoch, muxGeneration: this.muxGeneration,
      runtime: runtime.identity, nativeId: runtime.nativeId, workspaceId: runtime.workspaceId,
      contract: this.observedHost?.contract?.schemaHash, projections: runtime.projections, state: runtime.controlState, selected: runtime.modelObservation, organization: this.workspaceState.organization(runtime.nativeId) });
  }

  async nativeState(sessionId: string): Promise<unknown> {
    const runtime = this.require(sessionId);
    const client = await this.ensureSidecar();
    const [host, state, projections] = await Promise.all([
      this.hostIdentity(), this.call(client, 'session/state', { request: { sessionId: runtime.nativeId } }, sessionId),
      this.call<{ asOfSeq: number; values: Record<string, unknown> }>(client, 'session/projections', { request: { sessionId: runtime.nativeId } }, sessionId),
      this.modelCatalog(client),
    ]);
    if (this.sessions.get(sessionId) !== runtime || this.client !== client) throw dshNativeError('DSH runtime was replaced', 409);
    runtime.controlState = state;
    this.applyProjections(sessionId, runtime, projections);
    const projected = projectedModelSelection(runtime.projections?.values['modelSelection']);
    if (projected !== undefined) this.observeModelSelection(sessionId, runtime, projected, 'session/projections:modelSelection.next');
    const selected = runtime.modelObservation ?? { source: 'unavailable-in-api' };
    return { revision: this.nativeRevision(runtime), nativeId: runtime.nativeId, workspaceId: runtime.workspaceId, host,
      transport: client.isConnected ? 'live' : 'reconnecting', state: dshPublicValue(state), projections: dshPublicValue(runtime.projections), selected: dshPublicValue(selected),
      credentialMode: this.options.attachBrowserCookie !== undefined || (this.options.mode ?? 'spawn') === 'spawn' ? 'native-browser-shared-peer' : 'native-operator-single-socket',
      organization: this.workspaceState.organization(runtime.nativeId),
      systemSections: this.systemMessages(runtime).snapshot(),
      capture: { writesBlocked: this.rpcWritesBlocked, status: this.rpcWritesBlocked ? 'incomplete' : 'observing' },
      children: [...runtime.children].map(([nativeId, mode]) => ({ nativeId, mode, parentSessionId: runtime.nativeId, continuable: mode === 'continuable' })),
      interactions: [...runtime.pending].map(([requestId, pending]) => ({ requestId, kind: pending.kind, callId: pending.callId, durableId: pending.durableId,
        questionIds: pending.questionIds, status: pending.generation !== this.muxGeneration || pending.transportClosed && !pending.continued ? 'uncertain' : pending.sent ? 'sent' : 'pending', continued: pending.continued })),
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
      contract: dshRuntimeSummary(client.nativeVersion),
      actions: dshNativeActionMetadata(state.host.status === 'verified', { ...catalog, session: { state: runtime.controlState, projections: runtime.projections } }, client.nativeVersion),
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
      const client = await this.ensureSidecar();
      const action = parseDshNativeAction(value, client.nativeVersion);
      const runtime = this.require(sessionId);
      const state = await this.nativeState(sessionId) as { revision: string; host: DshHostIdentity };
      requireDshBaseline(state.host);
      if (state.revision !== action.revision) throw dshNativeError('DSH state changed; refresh before submitting this action', 409);
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
      const call = dshNativeCall(action, runtime.nativeId, client.nativeVersion);
      nativeDispatched = true;
      let result: unknown;
      try { result = await this.call<unknown>(client, call.endpoint, call.args, sessionId); }
      catch (error) {
        if (error instanceof DshRpcError || (error as { statusCode?: number })?.statusCode === 401) throw error;
        throw Object.assign(dshNativeError('DSH control outcome is uncertain; reconcile before retrying', 503), { code: 'uncertain' });
      }
      if (this.sessions.get(sessionId) !== runtime || this.client !== client) throw Object.assign(dshNativeError('DSH action outcome belongs to a replaced runtime', 409), { code: 'uncertain' });
      if (action.type === 'model') this.confirmModelSelection(sessionId, runtime, result, action.provider, action.model, action.reasoningEffort);
      if (action.type === 'child-interrupt') return { result, id: action.childSessionId, confirmed: false, nativeId: runtime.nativeId };
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

  private async childReadContext(sessionId: string, target?: DshSubagentReadTarget) {
    const runtime = this.sessions.get(sessionId);
    const nativeId = runtime?.nativeId ?? target?.nativeId;
    if (typeof nativeId !== 'string' || nativeId === '' || target !== undefined && target.nativeId !== nativeId)
      throw dshNativeError('DSH 父会话没有可确认的原生身份', 409);
    const client = await this.ensureSidecar();
    const epoch = this.hostEpoch; const generation = this.muxGeneration;
    const current = (): void => {
      if (this.sessions.get(sessionId) !== runtime || this.client !== client || epoch !== this.hostEpoch || generation !== this.muxGeneration)
        throw dshNativeError('DSH 子 Agent 读取属于旧连接，请刷新', 409);
    };
    current();
    if (runtime === undefined) { requireDshBaseline(await this.hostIdentity()); current(); }
    const baseline = await this.call<{ kind: string; asOfSeq: number; values: Record<string, unknown> } | null>(client, 'session/projections', { request: { sessionId: nativeId } }, sessionId);
    current();
    if (baseline?.kind !== 'sequenced' || !Number.isSafeInteger(baseline.asOfSeq) || baseline.asOfSeq < -1 || !baseline.values)
      throw dshNativeError('DSH 父会话目录尚未恢复，无法确认子 Agent 身份', 409);
    const children = dshSubagentCatalog(nativeId, baseline.values['subagentCatalog']);
    const catalogKey = JSON.stringify(baseline.values['subagentCatalog']);
    if (runtime !== undefined) this.applyProjections(sessionId, runtime, baseline);
    const guard = (): void => {
      current();
      if (runtime !== undefined && JSON.stringify(runtime.projections?.values['subagentCatalog']) !== catalogKey)
        throw dshNativeError('DSH 子 Agent 目录已变化，请刷新', 409);
    };
    guard();
    return { client, nativeId, children, baseline, guard };
  }

  async listSubagents(sessionId: string, target?: DshSubagentReadTarget): Promise<DshSubagentCatalog> {
    const context = await this.childReadContext(sessionId, target);
    const items: DshSubagentCatalog['items'] = [];
    // Bound concurrent passive reads without dropping catalog members.
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, context.children.length) }, async () => {
      for (;;) {
        const position = index++; const child = context.children[position];
        if (child === undefined) return;
        if (child.mode === 'external') { items[position] = { ...child, status: 'unknown', error: '外部执行没有本地子会话，原生接口未提供其当前状态或历史' }; continue; }
        try {
          context.guard();
          const projection = await this.call(context.client, 'session/projections', { request: { sessionId: child.childId } }, sessionId);
          context.guard();
          const state = await this.call<DshSubagentState>(context.client, 'session/state', { request: { sessionId: child.childId } }, sessionId);
          context.guard();
          const page = await this.call<DshPage>(context.client, 'session/page', { request: { address: dshSubagentAddress(child), throughSeq: state.cursor, maxMessages: 5 } }, sessionId);
          context.guard();
          checkDshSubagentPage(page, state.cursor);
          items[position] = dshSubagentSummary(child, state, page, dshSubagentDescriptorSeq(projection, child));
        } catch (error) { items[position] = { ...child, status: 'unknown', error: error instanceof Error ? error.message : '原生子会话状态无法读取' }; }
      }
    }));
    context.guard();
    return { nativeId: context.nativeId, asOfSeq: context.baseline.asOfSeq, items };
  }

  async readSubagentHistory(sessionId: string, childSessionId: string, options: DshSubagentHistoryOptions, target?: DshSubagentReadTarget): Promise<DshSubagentHistory> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 200
      || options.throughSeq !== undefined && (!Number.isSafeInteger(options.throughSeq) || options.throughSeq < -1)
      || options.beforeSeq !== undefined && (!Number.isSafeInteger(options.beforeSeq) || options.beforeSeq < 0)) throw dshNativeError('DSH 子会话历史分页参数无效', 400);
    const context = await this.childReadContext(sessionId, target);
    const child = context.children.find(entry => entry.childId === childSessionId);
    if (child === undefined) throw dshNativeError('子 Agent 不属于当前父会话', 409);
    const address = dshSubagentAddress(child);
    const projection = await this.call(context.client, 'session/projections', { request: { sessionId: child.childId } }, sessionId);
    context.guard();
    const ownDescriptorSeq = dshSubagentDescriptorSeq(projection, child);
    const throughSeq = options.throughSeq ?? (await this.call<DshSubagentState>(context.client, 'session/state', { request: { sessionId: child.childId } }, sessionId)).cursor;
    context.guard();
    const page = await this.call<DshPage>(context.client, 'session/page', { request: { address, maxMessages: options.limit, throughSeq,
      ...(options.beforeSeq === undefined ? {} : { beforeSeq: options.beforeSeq }) } }, sessionId);
    context.guard();
    checkDshSubagentPage(page, throughSeq, options.beforeSeq);
    return { address, cursor: page.cursor, records: page.records, hasMore: page.hasMore,
      ...(ownDescriptorSeq === undefined ? {} : { ownDescriptorSeq }),
      ...(page.records[0] === undefined ? {} : { nextCursor: page.records[0].event.seq }) };
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
    if ((this.options.mode ?? 'spawn') === 'attach' || this.client !== null && this.sidecar !== null) {
      let needsReconnect = false;
      const identity = await this.hostIdentity().catch(error => {
        if ((error as { code?: string }).code === 'dsh-host-version-changed') { needsReconnect = true; return this.observedHost; }
        return undefined;
      });
      return { installed: identity !== undefined, ...(identity?.version === undefined ? {} : { version: identity.version }), pinnedVersion: PINNED_VERSION,
        auth: this.client?.cookieHeader || this.options.attachCookie ? 'ok' : 'missing', compatible: identity?.status === 'verified' && !needsReconnect, supportedVersions: SUPPORTED_DSH_VERSIONS,
        notes: needsReconnect ? ['DSH 运行时已变化，请重新连接 Host 后使用对应合同'] : identity?.status === 'verified' ? [] : [identity?.reason ?? '目标 DSH Host 身份尚未验证'],
        runtimeContext: this.capabilityContext(identity) };
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
      compatible: isSupportedDshVersion(version), supportedVersions: SUPPORTED_DSH_VERSIONS,
      notes: isSupportedDshVersion(version) ? [] : [`DSH ${version} 没有已审核的运行时合同`],
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
    const catalog = await this.call<DshModelCatalog>(client, 'session/modelCatalog', {});
    if (this.client !== client) throw dshNativeError('模型目录属于旧 Host，请重新读取', 409);
    this.cacheModelCatalog(catalog);
    return catalog;
  }

  private cacheModelCatalog(catalog: DshModelCatalog): void {
    const ids = new Map<string, string>();
    for (const group of catalog.groups ?? []) for (const model of group.models ?? []) {
      if (typeof group.id !== 'string' || typeof model.id !== 'string') continue;
      ids.set(JSON.stringify([group.id, model.id]), providerForModel(catalog, model.id) === undefined
        ? `dsh:${Buffer.from(JSON.stringify([group.id, model.id])).toString('base64url')}` : model.id);
    }
    this.modelPublicIds = ids;
  }

  private observeModelSelection(sessionId: string, runtime: SessionRuntime, selected: DshModelSelection, source: string, force = false): void {
    const publicModelId = this.modelPublicIds.get(JSON.stringify([selected.provider, selected.model]));
    const previous = runtime.modelObservation;
    const changed = previous?.provider !== selected.provider || previous.model !== selected.model || previous.reasoningEffort !== selected.reasoningEffort || previous.publicModelId !== publicModelId;
    runtime.model = selected.model; runtime.modelProvider = selected.provider; runtime.reasoningEffort = selected.reasoningEffort;
    runtime.modelObservation = { ...selected, ...(publicModelId === undefined ? {} : { publicModelId }), source };
    if (changed || force) this.emit(sessionId, { type: 'item.complete', itemKey: `model-observation-${++runtime.frameSeq}`, kind: 'internal', scope: 'session',
      data: { nativeType: source }, native: { ...runtime.modelObservation } });
  }

  private confirmModelSelection(sessionId: string, runtime: SessionRuntime, result: unknown, provider: string, model: string, reasoningEffort?: string): void {
    const selected = (result as { selected?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } } | null)?.selected;
    if (selected?.provider !== provider || selected.model !== model || reasoningEffort !== undefined && selected.reasoningEffort !== reasoningEffort
      || selected.reasoningEffort !== undefined && typeof selected.reasoningEffort !== 'string') {
      throw Object.assign(dshNativeError('原生未确认所选模型或思考等级，请重新读取状态后再操作', 409), { code: 'uncertain' });
    }
    this.observeModelSelection(sessionId, runtime, { provider, model, ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort as string }) }, 'session/selectModel:selected', true);
  }

  private async selectModel(client: DshHostClient, runtime: SessionRuntime, model: string, reasoningEffort?: string, expectedRoute?: { provider: string; model: string }): Promise<void> {
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
    const selectedModel = catalog.groups?.find(group => group.id === provider)?.models?.find(candidate => candidate.id === model);
    if (reasoningEffort !== undefined && !selectedModel?.reasoning?.efforts?.some(effort => effort.id === reasoningEffort)) {
      throw Object.assign(dshNativeError('此原生 Provider/模型未声明所选思考等级', 400), { code: 'native-control-rejected' });
    }
    const request = {
      sessionId: runtime.nativeId,
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    };
    const sessionId = [...this.sessions].find(([, current]) => current === runtime)?.[0];
    if (sessionId === undefined) throw dshNativeError('DSH runtime was replaced', 409);
    const current = projectedModelSelection(runtime.projections?.values['modelSelection']) ?? runtime.modelObservation;
    if (expectedRoute !== undefined && (current?.provider !== expectedRoute.provider || current.model !== expectedRoute.model)) throw dshNativeError('原生模型已变化，请重新读取后再调整思考等级', 409);
    const result = await this.call(client, 'session/selectModel', { request }, sessionId);
    if (this.sessions.get(sessionId) !== runtime || this.client !== client) throw Object.assign(dshNativeError('模型切换结果属于旧运行实例，请重新核对', 409), { code: 'uncertain' });
    this.confirmModelSelection(sessionId, runtime, result, provider, model, reasoningEffort);
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
    // Metadata/model discovery and session creation can arrive concurrently.
    // A process started by this adapter belongs to the pending boot, rather
    // than being an unrelated host using the same native home.
    if (this.booting !== null) {
      await this.booting;
      if (this.client !== null) return this.client;
      throw new Error('dsh: 侧车启动失败');
    }
    if (this.client !== null) {
      if (!this.replaying) requireDshBaseline(await this.hostIdentity());
      await this.client.connect(); return this.client;
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
        if (epoch !== this.hostEpoch) throw new Error('DSH 连接启动已取消');
        this.client = client;
        this.sidecar = sidecar;
        const identity = await this.hostIdentity();
        requireDshBaseline(identity);
        client.bindNativeVersion(identity.version ?? DSH_BASELINE_VERSION);
        await client.connect();
        this.spawnedConnectionAt = sidecar === null ? '' : new Date().toISOString();
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
  private spawnedConnectionAt = '';
  /** The browser surface consumes the current owned Host credential in memory.
   * Attach mode continues to use its persisted native browser exchange. */
  nativeBrowserConnection(): { url: string; browserCookie: string; connectedAt: string } | null | undefined {
    if ((this.options.mode ?? 'spawn') === 'attach') return undefined;
    const sidecar = this.sidecar;
    const cookie = this.client?.cookieHeader;
    if (sidecar === null || sidecar.child.exitCode !== null || sidecar.child.signalCode !== null
      || cookie === undefined || !/^dsh-auth-[^=;]+=v1\./.test(cookie) || this.spawnedConnectionAt === '') return null;
    return { url: dshBaseUrl(sidecar.port), browserCookie: cookie, connectedAt: this.spawnedConnectionAt };
  }
  private hostEndpoint(): string {
    return dshBaseUrl(this.options.attachUrl ?? (this.sidecar?.port ?? this.options.port ?? 3091));
  }
  private capabilityContext(identity?: DshHostIdentity): NativeRuntimeContext {
    return {
      hostId: dshRevision({ endpoint: identity?.url ?? this.hostEndpoint() }),
      source: 'native-bootstrap',
      status: identity?.fingerprint === undefined ? 'unverified' : 'observed',
      ...(identity?.fingerprint === undefined ? {} : { hostFingerprint: identity.fingerprint }),
      // The pinned native bootstrap exposes neither OS nor a profile name/path.
      profile: { scope: 'current-host-profile', status: identity?.status === 'verified' ? 'unavailable-in-api' : 'unverified' },
      connectionRevision: dshRevision({ adapter: this.capabilityGeneration, hostEpoch: this.hostEpoch, muxGeneration: this.muxGeneration }),
      ...(identity?.status !== 'verified' || identity.version === undefined ? {} : { protocol: dshRuntimeSummary(identity.version) }),
    };
  }
  async hostIdentity(): Promise<DshHostIdentity> {
    const epoch = this.hostEpoch;
    const endpoint = this.hostEndpoint();
    const cookie = (this.options.mode ?? 'spawn') === 'attach' ? this.options.attachBrowserCookie : this.client?.cookieHeader;
    const identity = await readDshHostIdentity(endpoint, cookie);
    if (epoch !== this.hostEpoch) throw dshNativeError('DSH Host was replaced during identity verification', 409);
    this.observedHost = structuredClone(identity);
    if (identity.status === 'verified' && identity.version !== undefined) this.client?.bindNativeVersion(identity.version);
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
  private applyProjections(sessionId: string, runtime: SessionRuntime, baseline: { asOfSeq: number; values: Record<string, unknown> }, replace = false, source = 'session/control', origin: unknown = baseline, observesGoal = true): void {
    if (!replace && baseline.asOfSeq < (runtime.projections?.asOfSeq ?? -1)) return;
    const previous = runtime.projections;
    runtime.projections = structuredClone(baseline);
    if (observesGoal && Object.hasOwn(baseline.values, 'goal')) {
      const goal = dshGoalProjection(baseline.values['goal']);
      if (goal !== undefined) this.projectGoal(sessionId, runtime, goal, baseline.asOfSeq, origin, true, replace);
      else this.emit(sessionId, { type: 'item.complete', itemKey: `unknown-goal-projection-${baseline.asOfSeq}`, kind: 'unknown',
        data: { nativeType: 'session/projections:goal' }, scope: 'session', native: origin });
    }
    const selected = projectedModelSelection(baseline.values['modelSelection']);
    if (selected !== undefined && JSON.stringify(previous?.values['modelSelection']) !== JSON.stringify(baseline.values['modelSelection'])) {
      this.observeModelSelection(sessionId, runtime, selected, 'session/projections:modelSelection.next');
    }
    runtime.children.clear();
    this.systemMessages(runtime).baseline(baseline.values['systemSections']);
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
    this.applyProjections(sessionId, runtime, { asOfSeq: value['seq'], values }, false, source, value,
      (value['changes'] as { key: string }[]).some(change => change.key === 'goal'));
  }

  private systemMessages(runtime: SessionRuntime): DshSystemMessages {
    const format = dshRuntimeContract(this.client?.nativeVersion ?? DSH_BASELINE_VERSION).systemMessages;
    if (runtime.systemMessages === undefined || runtime.systemMessages.snapshot().format !== format) runtime.systemMessages = new DshSystemMessages(format);
    return runtime.systemMessages;
  }

  private projectGoal(sessionId: string, runtime: SessionRuntime, data: EventData['goal'], throughSeq: number, native: unknown, projection = false, replace = false): void {
    const previous = runtime.goalObservation;
    if (!replace && previous !== undefined && (throughSeq < previous.throughSeq || !projection && previous.projection && throughSeq <= previous.throughSeq
      || data.goalId !== undefined && data.goalId === previous.data.goalId && (data.nativeRevision ?? 0) < (previous.data.nativeRevision ?? 0))) return;
    runtime.goalObservation = { data, throughSeq, projection };
    if (previous !== undefined && JSON.stringify(previous.data) === JSON.stringify(data)) return;
    this.emit(sessionId, { type: 'item.complete', itemKey: `goal-${projection ? 'projection' : 'change'}-${throughSeq}`,
      kind: 'goal', data, nativeSeq: throughSeq, native, scope: 'session' });
  }
  private projectContinuedQuestions(sessionId: string, runtime: SessionRuntime, value: unknown): void {
    const projection = value as { active?: { callId: string; state: string; questions: { id: string; question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }[] }[]; settled?: { callId: string; answers: { id: string; selected: string[]; custom?: string }[] }[] } | undefined;
    for (const question of projection?.active ?? []) {
      if (question.state !== 'continued') continue;
      const eventId = `dsh-continued:${question.callId}`;
      const existing = [...runtime.pending.values()].find(pending => pending.kind === 'question' && pending.callId === question.callId);
      if (existing !== undefined) {
        existing.generation = this.muxGeneration;
        if (!existing.continued) { existing.timed = true; this.settleQuestion(sessionId, runtime, existing, { kind: 'continued' }, question); }
        continue;
      }
      const questionItems: EventData['question'][] = question.questions.map(item => ({
        questionId: `${eventId}:${item.id}`, groupId: eventId, toolCallId: question.callId, prompt: item.question, header: item.header,
        options: item.options?.map(option => ({ id: option.label, label: option.label, description: option.description })), multiSelect: item.multiSelect, allowsFreeText: true,
        isBlocking: false,
        dshQuestion: { nativeId: runtime.nativeId, callId: question.callId, itemId: item.id, timed: true, phase: 'continued' },
      }));
      runtime.pending.set(eventId, { kind: 'question', eventId, callId: question.callId, questionIds: question.questions.map(item => item.id), questionItems, generation: this.muxGeneration, continued: true });
      for (const data of questionItems) this.emit(sessionId, { type: 'item.complete', itemKey: `question-${data.questionId}`, kind: 'question', data, native: question });
    }
    for (const settled of projection?.settled ?? []) {
      const answers = dshQuestionAnswers(settled.answers);
      if (answers === undefined) continue;
      const result = { kind: 'answered', answers } as const;
      runtime.questionResults ??= new Map(); runtime.questionResults.set(settled.callId, { result, native: settled });
      for (const pending of [...runtime.pending.values()]) if (pending.kind === 'question' && pending.callId === settled.callId)
        this.settleQuestion(sessionId, runtime, pending, result, settled);
    }
  }

  private settleQuestion(sessionId: string, runtime: SessionRuntime, pending: PendingInteraction, result: DshQuestionResult, native: unknown, nativeSeq?: number): void {
    if (runtime.pending.get(pending.eventId) !== pending) return;
    if (result.kind === 'continued') {
      if (!pending.timed || pending.continued) return;
      const submitted = pending.sent || pending.sending;
      pending.continued = true; pending.transportClosed = true;
      pending.sent = false; pending.sending = false; pending.answerAttempt = undefined; pending.acceptedReply = false;
      this.releaseQuestionWaits(pending);
      pending.questionItems = pending.questionItems?.map(question => ({ ...question, isBlocking: false,
        ...(pending.callId === undefined ? {} : { dshQuestion: { nativeId: runtime.nativeId, callId: pending.callId, itemId: question.dshQuestion?.itemId ?? question.questionId.slice(pending.eventId.length + 1), timed: true, phase: 'continued' as const } }),
        ...(submitted ? { submission: 'failed' as const, submissionError: '前台等待已结束，可明确提交稍后回答。' } : {}) }));
      for (const question of pending.questionItems ?? []) this.emit(sessionId, { type: 'item.complete', itemKey: `question-${question.questionId}`, kind: 'question',
        data: question, native, nativeSeq });
      return;
    }
    const complete = result.kind === 'answered' && result.answers.length === pending.questionIds?.length
      && result.answers.every(answer => pending.questionIds?.includes(answer.id));
    const local = complete && pending.continued === true && pending.acceptedReply === true && sameDshQuestionAnswers(result.answers, pending.answers);
    pending.settlement = result;
    runtime.pending.delete(pending.eventId);
    this.releaseQuestionWaits(pending);
    for (const question of pending.questionItems ?? []) this.emit(sessionId, { type: 'item.complete', itemKey: `question-${question.questionId}`, kind: 'question', data: {
      ...question, status: complete ? 'answered' : 'skipped',
      ...(result.kind === 'cancelled' ? { outcome: 'cancel' as const } : {}),
      resolution: complete ? local ? 'native-acknowledged' : 'native-resolved' : result.kind === 'cancelled' ? 'external' : 'outcome-unknown',
    }, native, nativeSeq });
  }

  private releaseQuestionWaits(pending: PendingInteraction): void {
    for (const close of [...pending.waitClosers ?? []]) close();
  }

  async claimDshQuestionWait(sessionId: string, questionId: string, signal: AbortSignal): Promise<DshQuestionWaitOpening | undefined> {
    const runtime = this.require(sessionId); const client = await this.ensureSidecar();
    requireDshBaseline(await this.hostIdentity());
    const pending = [...runtime.pending.values()].find(item => item.kind === 'question' && item.questionItems?.some(question => question.questionId === questionId));
    const generation = this.muxGeneration; const epoch = this.hostEpoch;
    const current = (): boolean => !signal.aborted && this.sessions.get(sessionId) === runtime && this.client === client
      && this.muxGeneration === generation && this.hostEpoch === epoch && pending !== undefined && runtime.pending.get(pending.eventId) === pending;
    if (!current() || pending?.timed !== true || pending.continued || pending.sent || pending.transportClosed || !pending.callId || pending.generation !== generation)
      throw dshNativeError('原生前台问题已经结束或需要重新同步', 409);
    if (!this.trace(sessionId, 'out', 'openStream:userQuestions/attachWait', { agentId: runtime.nativeId, callId: pending.callId }))
      throw dshNativeError('原生等待订阅未持久化，尚未取得等待', 503);
    return new Promise((resolve, reject) => {
      let resolveClosed!: () => void; const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
      let opened = false; let released = false; let streamId: string | undefined;
      const close = (): void => {
        if (released) return; released = true;
        clearTimeout(timer); signal.removeEventListener('abort', close); pending.waitClosers?.delete(close);
        if (streamId !== undefined) {
          try { this.trace(sessionId, 'out', 'closeStream:userQuestions/attachWait', { streamId }); }
          catch { /* Releasing an owned wait cannot depend on storage being available. */ }
          client.closeStream(streamId);
        }
        resolveClosed(); if (!opened) resolve(undefined);
      };
      const timer = setTimeout(() => { reject(dshNativeError('原生等待流没有返回开场信息', 503)); close(); }, 10_000);
      pending.waitClosers ??= new Set(); pending.waitClosers.add(close); signal.addEventListener('abort', close, { once: true });
      try {
        streamId = client.openStream('userQuestions/attachWait', { agentId: runtime.nativeId, callId: pending.callId }, frame => {
          let captured = false;
          try { captured = this.trace(sessionId, 'in', 'mux:userQuestions/attachWait', frame); } catch { /* Capture failure releases the claim. */ }
          if (!captured) { reject(dshNativeError('原生等待开场未持久化', 503)); close(); return; }
          if (!current() || frame.type === 'end' || frame.type === 'error') { close(); return; }
          if (frame.type !== 'item' || opened) return;
          const remaining = (frame.value as { remainingMs?: unknown } | null)?.remainingMs;
          if (!Number.isSafeInteger(remaining) || typeof remaining !== 'number' || remaining < 0 || remaining > 2_147_483_647) { reject(dshNativeError('原生等待流的剩余时间无效', 503)); close(); return; }
          opened = true; clearTimeout(timer);
          resolve({ callId: pending.callId!, remainingMs: remaining, closed });
        });
        if (released) client.closeStream(streamId);
      } catch (error) { reject(error); close(); }
    });
  }

  async timeoutDshQuestion(sessionId: string, questionId: string, signal: AbortSignal, guard?: () => void): Promise<void> {
    const runtime = this.require(sessionId); const client = await this.ensureSidecar();
    requireDshBaseline(await this.hostIdentity());
    const pending = [...runtime.pending.values()].find(item => item.kind === 'question' && item.questionItems?.some(question => question.questionId === questionId));
    const generation = this.muxGeneration; const epoch = this.hostEpoch; const clientId = this.clientId;
    if (signal.aborted || this.sessions.get(sessionId) !== runtime || this.client !== client || pending?.timed !== true
      || pending.continued || pending.sent || pending.sending || pending.transportClosed || pending.generation !== generation || clientId === '') throw dshNativeError('原生前台等待已经结束', 409);
    guard?.();
    await this.call(client, '$events/result', { clientId, eventId: pending.eventId, outcome: { kind: 'rejected', error: {
      name: 'UserQuestionError', code: 'ASK_TIMED_OUT', message: 'ask_user_question timed out before the user answered',
    } } }, sessionId);
    if (this.sessions.get(sessionId) !== runtime || this.client !== client || generation !== this.muxGeneration || epoch !== this.hostEpoch)
      throw Object.assign(dshNativeError('前台等待结果属于旧连接，原生状态待核对', 503), { code: 'uncertain' });
  }
  private newHost(endpoint: string | number): DshHostClient {
    const host = new DshHostClient(endpoint, { onState: state => {
      if (this.client !== host) return;
      if (state === 'reconnecting' || state === 'auth-required') {
        this.modelPublicIds.clear();
        this.clientId = ''; this.muxGeneration++; this.observedHost = undefined; this.workspaceState.invalidate();
        for (const [id, runtime] of this.sessions) {
          for (const pending of runtime.pending.values()) this.releaseQuestionWaits(pending);
          runtime.history?.invalidate(); runtime.projections = undefined; runtime.goalObservation = undefined; runtime.children.clear(); runtime.modelObservation = undefined;
          this.emit(id, { type: 'permissions', observation: { effective: null, source: 'dsh.connection', scope: 'session' } });
        }
      }
      for (const [id, runtime] of this.sessions) this.emit(id, {
        type: 'item.complete', itemKey: `dsh-connection-${++runtime.frameSeq}`, kind: 'notice',
        data: { level: state === 'online' ? 'info' : 'warning', text: state === 'online' ? 'DSH 连接已恢复，正在同步会话' : state === 'auth-required' ? 'DSH 登录已过期，请重新连接' : 'DSH 连接中断，正在重连', nativeType: `dsh.connection.${state}` },
      });
    } });
    return host;
  }

  /** 斜杠命令目录（F8 / SL-02）：来自 DSH 的 commands/list */
  async previewSlashCommands() {
    await this.ensureSidecar();
    requireDshBaseline(await this.hostIdentity());
    return { commands: dshCommandAliases(slashCatalog.commands.map(command => ({ ...command, route: 'native-control' as const, source: `DSH ${slashCatalog.nativeVersion} 基线预览` }))), complete: false,
      reason: '创建前展示 DSH 原生基线指令；发送时创建会话，并按该会话的实际目录核对。' };
  }

  async slashCommands(sessionId: string): Promise<SlashCommand[]> {
    const runtime = this.sessions.get(sessionId);
    const client = await this.ensureSidecar();
    const result = await this.call<{ commands?: DshCommandDescriptor[] } | DshCommandDescriptor[]>(client, 'commands/list', {
        agentId: runtime?.nativeId ?? '',
      });
      const commands = Array.isArray(result) ? result : result.commands ?? [];
      return mapDshCommands(commands);
  }

  async executeSlashControl(sessionId: string, line: string, options: { contentParts?: ResolvedInputContent } = {}): Promise<SlashControlResult> {
    const runtime = this.require(sessionId); const client = await this.ensureSidecar();
    const generation = this.muxGeneration;
    const input = { text: line, ...(options.contentParts === undefined ? {} : { contentParts: options.contentParts }) } as UserInput & DshResolvableInput;
    const encoded = await encodeDshInput(input, { inputModalities: ['text', 'image'], uploadFile: (part, bytes) => this.uploadNativeFile(sessionId, runtime, client, part, bytes) });
    const command = slashCommandFor(await this.slashCommands(sessionId), line);
    // Native UI resolves localized spellings before calling commands/execute,
    // whose registry accepts only the exact registered name. Retain argument
    // bytes and the original Web request; capture the actual canonical RPC.
    const parsed = parseSlashInput(line);
    const nativeLine = command && parsed ? `${command.name}${parsed.rawArguments}` : line;
    if (this.sessions.get(sessionId) !== runtime || this.client !== client || generation !== this.muxGeneration) throw Object.assign(new Error('DSH 指令运行实例已变化'), { code: 'native-control-rejected', statusCode: 409 });
    const result = await this.call<{ commandId: string; result: { kind: 'success' | 'error'; text?: string } } | undefined>(client, 'commands/execute', { agentId: runtime.nativeId, line: nativeLine, submittedAttachments: encoded.submittedAttachments }, sessionId);
    if (this.sessions.get(sessionId) !== runtime || this.client !== client || generation !== this.muxGeneration) throw Object.assign(new Error('DSH 指令结果需要核对'), { code: 'uncertain' });
    if (!result || typeof result.commandId !== 'string' || !result.commandId || !['success', 'error'].includes(result.result?.kind)) {
      return { failed: true, text: 'DSH 未返回可确认的原生指令执行结果，请读取原生状态。', result };
    }
    return { text: result.result.text ?? '', result, failed: result.result.kind === 'error',
      ...(result.result.kind === 'success' && command?.definitionId === '@deepseek-ai/dsh-session-log-export' ? {
        confirmed: true, form: 'dsh-export' as const, download: { kind: 'dsh-session-log' as const, nativeId: runtime.nativeId },
      } : {}),
    };
  }

  async sendSubagent(sessionId: string, childSessionId: string, text: string, options: DshSubagentPromptOptions = { requestId: ulid(), delivery: 'queue' }, target?: DshSubagentControlTarget): Promise<DshSubagentPromptReceipt> {
    let dispatched = false;
    try {
      if (typeof text !== 'string' || text.trim() === '') throw dshNativeError('需要子 Agent 消息', 400);
      const client = await this.ensureSidecar(); const host = await this.hostIdentity(); requireDshBaseline(host);
      const context = await this.childReadContext(sessionId, target);
      if (context.children.find(entry => entry.childId === childSessionId)?.mode !== 'continuable') throw dshNativeError('子 Agent 不属于此父会话，或此原生模式不能继续', 409);
      const state = await this.call<DshSubagentState>(client, 'session/state', { request: { sessionId: childSessionId } }, sessionId);
      if (!Number.isSafeInteger(state.cursor) || state.cursor < -1) throw dshNativeError('子 Agent 输入水位待确认', 409);
      const args: DshSubagentPrompt = { request: { requestId: options.requestId, childSessionId, delivery: options.delivery, content: [{ type: 'text', text }],
        ...(options.clientTimeZone === undefined ? {} : { clientTimeZone: options.clientTimeZone }) } };
      validateDshArgs('subagents/prompt', args, client.nativeVersion);
      const freshHost = await this.hostIdentity(); requireDshBaseline(freshHost);
      if (context.client !== client || host.fingerprint === undefined || freshHost.fingerprint !== host.fingerprint) throw dshNativeError('DSH Host 在子消息核对期间已变化', 409);
      context.guard(); target?.guard?.(); options.beforeDispatch?.(state.cursor);
      dispatched = true;
      const receipt = await this.call<{ messageId: string }>(client, 'subagents/prompt', { ...args }, sessionId);
      context.guard(); target?.guard?.();
      if (typeof receipt.messageId !== 'string' || receipt.messageId === '') throw new Error('原生未返回消息接收身份');
      return { accepted: true, messageId: receipt.messageId, requestId: options.requestId };
    } catch (error) {
      if (!dispatched) throw Object.assign(error instanceof Error ? error : dshNativeError('子消息未通过核对'), { code: 'native-control-rejected' });
      if (error instanceof DshRpcError && ['subagent/delivery-unavailable', 'subagent/not-resumable', 'subagent/unauthorized', 'subagent/invalid-time-zone', 'subagent/attachment-invalid', 'gateway/bad-request', 'remote-access/denied'].includes(error.code))
        return { accepted: false, failed: true, requestId: options.requestId, rejection: { code: error.code, message: error.message } };
      throw Object.assign(dshNativeError('子消息接收结果未确认，请先核对原生队列或历史，不要自动重发', 503), { code: 'uncertain' });
    }
  }

  async findSubagentInput(sessionId: string, childSessionId: string, reference: DshSubagentInputReference, target?: DshSubagentReadTarget): Promise<DshSubagentInputObservation | undefined> {
    const context = await this.childReadContext(sessionId, target);
    const child = context.children.find(entry => entry.childId === childSessionId);
    if (child?.mode !== 'continuable' || reference.parentSessionId !== context.nativeId || reference.childSessionId !== childSessionId)
      throw dshNativeError('子消息接收查询身份已变化', 409);
    const state = await this.call<DshSubagentState>(context.client, 'session/state', { request: { sessionId: childSessionId } }, sessionId); context.guard();
    const queued = state.queue?.filter(item => item.rpcId === reference.nativeRequestId && dshSubagentInputHash(item.content) === reference.contentHash) ?? [];
    if (queued.length > 1) throw dshNativeError('同一子输入身份对应多个原生队列项，结果待核对', 409);
    if (queued[0]) return { messageId: queued[0].id, source: 'queue' };
    if (reference.afterSeq === undefined) return undefined;
    let beforeSeq: number | undefined;
    for (;;) {
      const page = await this.call<DshPage>(context.client, 'session/page', { request: { address: dshSubagentAddress(child), throughSeq: state.cursor, maxMessages: 200,
        ...(beforeSeq === undefined ? {} : { beforeSeq }) } }, sessionId); context.guard(); checkDshSubagentPage(page, state.cursor, beforeSeq);
      const found = page.records.filter(record => {
        const data = record.event.data as { id?: unknown; source?: { kind?: string; rpcId?: string }; content?: unknown };
        return record.event.seq > reference.afterSeq! && record.event.type === 'user/message' && data?.source?.kind === 'user'
          && data.source.rpcId === reference.nativeRequestId && typeof data.id === 'string' && dshSubagentInputHash(data.content) === reference.contentHash;
      });
      if (found.length > 1) throw dshNativeError('同一子输入身份对应多个原生消息，结果待核对', 409);
      if (found[0]) return { messageId: (found[0].event.data as { id: string }).id, seq: found[0].event.seq, source: 'history' };
      const first = page.records[0]?.event.seq;
      if (!page.hasMore || first === undefined || first <= reference.afterSeq) return undefined;
      beforeSeq = first;
    }
  }

  async interruptSubagent(sessionId: string, childSessionId: string, target?: DshSubagentControlTarget): Promise<DshSubagentInterruptReceipt> {
    let dispatched = false;
    try {
      const client = await this.ensureSidecar();
      const host = await this.hostIdentity(); requireDshBaseline(host);
      const context = await this.childReadContext(sessionId, target);
      const child = context.children.find(entry => entry.childId === childSessionId);
      if (child?.mode !== 'continuable') throw dshNativeError('子 Agent 不属于此父会话，或此原生模式不支持独立停止', 409);
      const freshHost = await this.hostIdentity(); requireDshBaseline(freshHost);
      if (context.client !== client || host.fingerprint === undefined || freshHost.fingerprint !== host.fingerprint)
        throw dshNativeError('DSH Host 在子 Agent 停止核对期间已变化', 409);
      context.guard(); target?.guard?.();
      const args: DshSubagentInterrupt = { childSessionId };
      dispatched = true;
      await this.call<{ accepted: true }>(context.client, 'subagents/interruptByUser', { ...args }, sessionId);
      context.guard(); target?.guard?.();
      return { id: childSessionId, accepted: true, confirmed: false,
        address: { kind: 'subagent', parentSessionId: context.nativeId, childSessionId, mode: 'continuable' } };
    } catch (error) {
      if (dispatched) {
        if (error instanceof DshRpcError) throw error;
        throw Object.assign(dshNativeError('子 Agent 停止结果未确认，请刷新原生状态，不要自动重发', 503), { code: 'uncertain' });
      }
      throw Object.assign(error instanceof Error ? error : dshNativeError('子 Agent 停止未通过核对'), { code: 'native-control-rejected' });
    }
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
    inputReference?: { fileIds: string[]; nativeRequestId?: string }, replyGuard?: { current: () => boolean; retry: boolean }): Promise<T> {
    if (!isAllowedEndpoint(endpoint)) throw new Error(`dsh: 端点不在白名单内：${endpoint}`);
    if (replyGuard !== undefined && (endpoint !== '$events/result' || !replyGuard.current()))
      throw Object.assign(dshNativeError('原生交互投递已变化，请重新核对', 409), { nativeAdmission: 'not-submitted' });
    const request = (args['request'] ?? {}) as Record<string, unknown>;
    const address = (request['address'] ?? {}) as Record<string, unknown>;
    const nativeId = args['agentId'] ?? args['sessionId'] ?? request['sessionId'] ?? (address['kind'] === 'session' ? address['sessionId'] : undefined);
    const matches = typeof nativeId === 'string' && nativeId !== '' ? [...this.sessions].filter(([, runtime]) => runtime.nativeId === nativeId) : [];
    const owner = sessionId ?? (matches.length === 1 ? matches[0]![0] : '');
    const readonly = DSH_READ_RPC_ENDPOINTS.has(endpoint);
    if (!readonly && this.rpcWritesBlocked && replyGuard?.retry !== true) throw Object.assign(new Error('DSH native transport capture is incomplete; reconcile before another write'), { code: 'uncertain' });
    // Preserve the pre-existing intent durability gate. Actual transport
    // admission below records the independently generated native rpcId.
    let intentAccepted = false;
    try { intentAccepted = this.trace(owner, 'out', `rpc-intent:${endpoint}`, { endpoint, args }); } catch { /* Persistence failed before native dispatch. */ }
    if (!intentAccepted) { this.rpcWritesBlocked = true; throw Object.assign(new Error('原生请求未持久化或实例已替换'), { code: 'uncertain' }); }
    const host = this.observedHost === undefined ? undefined : structuredClone(this.observedHost);
    const epoch = this.hostEpoch; const generation = this.muxGeneration;
    const sink = owner === '' ? this.globalNativeSink : this.nativeSinks.get(owner);
    const runtime = this.sessions.get(owner);
    const currentCapture = (): boolean => this.hostEpoch === epoch && this.muxGeneration === generation
      && (runtime === undefined || this.sessions.get(owner) === runtime);
    return client.rpc<T>(endpoint, args, observation => {
      if (observation.dir !== 'in') return;
      // A closed owner still receives its original rejected evidence. It
      // cannot revoke admission for the replacement runtime or Host.
      if (currentCapture() && sink !== undefined && observation.capture.coverage !== 'complete') this.rpcWritesBlocked = true;
      try {
        const accepted = this.recordRpc(owner, observation, host, epoch, generation, sink, runtime, inputReference);
        if (!accepted && currentCapture()) this.rpcWritesBlocked = true;
      } catch { if (currentCapture()) this.rpcWritesBlocked = true; }
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
      return accepted && (replyGuard === undefined || replyGuard.current());
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
      else if (opts.reasoningEffort !== undefined) {
        const catalog = await this.modelCatalog(client);
        const provider = catalog.default?.provider; const model = catalog.default?.model;
        if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) throw dshNativeError('原生默认 Provider/模型待确认，无法调整思考等级', 409);
        await this.selectModel(client, runtime, `dsh:${Buffer.from(JSON.stringify([provider, model])).toString('base64url')}`, opts.reasoningEffort);
      }
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
      () => this.client?.nativeVersion ?? DSH_BASELINE_VERSION,
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
      inputModalities = await this.imageInputModalities(sessionId, runtime, client);
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
      if (typeof execution.result.text === 'string' && execution.result.text !== '') this.emit(sessionId, { type: 'item.complete', itemKey: `command-result-${++runtime.frameSeq}`,
        kind: 'assistant.message', data: { text: execution.result.text }, native: execution });
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

  private async imageInputModalities(sessionId: string, runtime: SessionRuntime, client: DshHostClient): Promise<DshInputModality[] | undefined> {
    const epoch = this.hostEpoch, generation = this.muxGeneration;
    const readSelection = async (): Promise<DshModelSelection> => {
      const projection = await this.call<{ kind?: string; asOfSeq?: number; values?: Record<string, unknown> }>(client, 'session/projections', { request: { sessionId: runtime.nativeId } }, sessionId);
      if (this.sessions.get(sessionId) !== runtime || this.client !== client || this.hostEpoch !== epoch || this.muxGeneration !== generation) throw dshInputUnsupported('DSH Host 已变化，请保留草稿并重新读取模型');
      if (projection.kind === 'cached' || !Number.isSafeInteger(projection.asOfSeq) || typeof projection.asOfSeq !== 'number' || projection.asOfSeq < 0
        || projection.asOfSeq < (runtime.projections?.asOfSeq ?? -1) || projection.values === undefined || projection.values === null || Array.isArray(projection.values)) throw dshInputUnsupported('原生模型投影未同步，请保留草稿并重新读取');
      const selected = projectedModelSelection(projection.values['modelSelection']);
      if (selected === undefined) throw dshInputUnsupported('原生当前模型尚未确认，请保留草稿并重新读取');
      this.applyProjections(sessionId, runtime, { asOfSeq: projection.asOfSeq, values: projection.values });
      this.observeModelSelection(sessionId, runtime, selected, 'session/projections:modelSelection.next');
      return selected;
    };
    const selected = await readSelection();
    const catalog = await this.modelCatalog(client);
    const inputs = await dshInputCapabilities(catalog, <T>(endpoint: string, args?: Record<string, unknown>) => this.call<T>(client, endpoint, args));
    const current = await readSelection();
    if (current.provider !== selected.provider || current.model !== selected.model) throw dshInputUnsupported('原生模型在图片准备期间已变化，请保留草稿并重新核对');
    return inputs.get(dshInputRoute(current.provider, current.model))?.inputModalities;
  }

  async validateInput(sessionId: string, input: UserInput): Promise<void> {
    const prepared = input as UserInput & DshResolvableInput;
    const parts = dshInputParts(prepared);
    const command = input.text.startsWith('/') && isAllowedCommandLine(input.text, input.text);
    let modalities: DshInputModality[] | undefined = command ? ['text', 'image'] : undefined;
    if (!command && parts.some(part => part.type === 'image')) {
      const client = await this.ensureSidecar(); const runtime = this.require(sessionId);
      modalities = await this.imageInputModalities(sessionId, runtime, client);
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
    const projections = await this.call<{ kind?: string; asOfSeq?: number; values?: Record<string, unknown> }>(client, 'session/projections', { request: { sessionId: runtime.nativeId } }, sessionId);
    if (this.sessions.get(sessionId) !== runtime || this.client !== client || projections.kind === 'cached' || typeof projections.asOfSeq !== 'number'
      || projections.asOfSeq < (runtime.projections?.asOfSeq ?? -1) || projections.values === undefined) throw dshNativeError('当前原生模型状态待确认，请重新读取后再操作', 409);
    this.applyProjections(sessionId, runtime, { asOfSeq: projections.asOfSeq, values: projections.values });
    const selected = projectedModelSelection(projections.values['modelSelection']) ?? runtime.modelObservation;
    let model = selected?.model ?? runtime.model;
    let provider = selected?.provider ?? runtime.modelProvider;
    if (model === undefined || model === '') {
      const catalog = await this.modelCatalog(client);
      model = catalog.default?.model;
      provider = catalog.default?.provider;
    }
    if (model === undefined || model === '') throw new Error('dsh: 当前会话没有可切换思考强度的模型');
    if (provider !== undefined) model = `dsh:${Buffer.from(JSON.stringify([provider, model])).toString('base64url')}`;
    await this.selectModel(client, runtime, model, effort, selected?.provider === undefined || selected.model === undefined ? undefined : { provider: selected.provider, model: selected.model });
  }

  async interrupt(sessionId: string): Promise<void> {
    const client = await this.ensureSidecar();
    const runtime = this.require(sessionId);
    await this.call(client, 'session/cancel', { request: { sessionId: runtime.nativeId } });
  }

  private approvalRevision(runtime: SessionRuntime, pending: PendingInteraction, hostId: string, hostFingerprint: string): string {
    return dshRevision({ hostId, hostFingerprint, clientId: this.clientId, epoch: this.hostEpoch, generation: this.muxGeneration,
      runtime: runtime.identity, delivery: pending.approvalDeliveryId });
  }

  async dshApprovalDelivery(sessionId: string, approvalId: string): Promise<DshApprovalDelivery | undefined> {
    const client = await this.ensureSidecar(); const runtime = this.require(sessionId); const pending = runtime.pending.get(approvalId);
    if (pending?.kind !== 'approval' || !pending.approvalAgentId || pending.approvalDeliveryId === undefined
      || pending.generation !== this.muxGeneration || this.clientId === '' || pending.sent || pending.transportClosed) return undefined;
    const clientId = this.clientId; const generation = this.muxGeneration; const epoch = this.hostEpoch;
    const host = await this.hostIdentity().catch(() => undefined);
    if (host?.status !== 'verified' || host.fingerprint === undefined || this.client !== client || this.clientId !== clientId
      || this.muxGeneration !== generation || this.hostEpoch !== epoch || this.sessions.get(sessionId) !== runtime
      || runtime.pending.get(approvalId) !== pending || pending.sent || pending.transportClosed) return undefined;
    const hostId = dshRevision({ endpoint: host.url });
    return { nativeId: runtime.nativeId, agentId: pending.approvalAgentId, eventId: pending.eventId,
      ...(pending.callId ? { callId: pending.callId } : {}), ...(pending.durableId === undefined ? {} : { durableId: pending.durableId }),
      hostId, hostFingerprint: host.fingerprint, clientId, revision: this.approvalRevision(runtime, pending, hostId, host.fingerprint) };
  }

  async retryDshApproval(sessionId: string, attempt: DshApprovalAttempt, revision: string): Promise<NativeInteractionSubmission> {
    const current = await this.dshApprovalDelivery(sessionId, attempt.delivery.eventId);
    if (current === undefined || current.revision !== revision || !sameDshApproval(attempt.delivery, current))
      throw Object.assign(dshNativeError('原审批身份或投递已变化，不能重发旧回应', 409), { nativeAdmission: 'not-submitted' });
    return this.replyApproval(sessionId, { approvalId: attempt.delivery.eventId, optionId: attempt.optionId }, current);
  }

  async respond(sessionId: string, decision: ApprovalDecision): Promise<NativeInteractionSubmission> {
    return this.replyApproval(sessionId, decision);
  }

  private async replyApproval(sessionId: string, decision: ApprovalDecision, recovery?: DshApprovalDelivery): Promise<NativeInteractionSubmission> {
    const client = await this.ensureSidecar();
    const runtime = this.require(sessionId);
    const pending = runtime.pending.get(decision.approvalId);
    if (pending?.kind !== 'approval' || pending.generation !== this.muxGeneration || this.clientId === '') throw Object.assign(new Error('DSH 审批已结束或需要重新同步'), { statusCode: 409 });
    if (pending.transportClosed) throw Object.assign(dshNativeError('审批转发已结束，原生决定待核对', 503), { code: 'uncertain' });
    if (pending.sent) throw dshNativeError('DSH approval was submitted; wait for its durable decision', 409);
    if (!['allowed-once', 'rejected'].includes(decision.optionId)) throw Object.assign(new Error('DSH 审批选项无效'), { statusCode: 400 });
    const clientId = this.clientId; const generation = this.muxGeneration; const epoch = this.hostEpoch;
    const current = (): boolean => this.sessions.get(sessionId) === runtime && this.client === client && this.clientId === clientId
      && this.muxGeneration === generation && this.hostEpoch === epoch && runtime.pending.get(decision.approvalId) === pending
      && !pending.sent && !pending.transportClosed && (recovery === undefined
        || this.approvalRevision(runtime, pending, recovery.hostId, recovery.hostFingerprint) === recovery.revision);
    if (!current()) throw Object.assign(dshNativeError('原审批投递已变化，请重新核对', 409), { nativeAdmission: 'not-submitted' });
    await this.call(client, '$events/result', {
      clientId,
      eventId: decision.approvalId,
      outcome: { kind: 'result', value: decision.optionId },
    }, sessionId, undefined, recovery === undefined ? undefined : { current, retry: true });
    if (this.sessions.get(sessionId) !== runtime || this.client !== client || this.clientId !== clientId
      || this.muxGeneration !== generation || this.hostEpoch !== epoch || pending.transportClosed || runtime.pending.get(decision.approvalId) !== pending)
      throw Object.assign(dshNativeError('审批回执属于已结束的原生交互或旧连接，本次回应结果待核对', 503), { code: 'uncertain' });
    pending.sent = true;
    return { confirmed: false };
  }

  /** 打断时把自己挂起的审批标成 cancelled（只处理本会话的） */
  async cancelPending(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return;
    const client = await this.ensureSidecar().catch(() => null);
    for (const [eventId, pending] of runtime.pending) {
      this.releaseQuestionWaits(pending);
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

  private questionRevision(runtime: SessionRuntime, pending: PendingInteraction, hostId: string, hostFingerprint: string): string {
    return dshRevision({ hostId, hostFingerprint, clientId: this.clientId, epoch: this.hostEpoch, generation: this.muxGeneration,
      runtime: runtime.identity, delivery: pending.questionDeliveryId });
  }

  async dshQuestionDelivery(sessionId: string, questionId: string): Promise<DshQuestionDelivery | undefined> {
    const client = await this.ensureSidecar(); const runtime = this.require(sessionId);
    const pending = [...runtime.pending.values()].find(item => item.kind === 'question'
      && (item.eventId === questionId || item.questionIds?.some(id => `${item.eventId}:${id}` === questionId)));
    if (pending?.kind !== 'question' || !pending.callId || pending.questionAgentId !== runtime.nativeId || !pending.questionDeliveryId
      || !pending.questionSignature || pending.questionItems?.some(item => item.isSecret) || pending.continued || pending.sent || pending.sending
      || pending.transportClosed || pending.generation !== this.muxGeneration || this.clientId === '') return undefined;
    const epoch = this.hostEpoch; const generation = this.muxGeneration; const clientId = this.clientId;
    const host = await this.hostIdentity().catch(() => undefined);
    if (host?.status !== 'verified' || host.fingerprint === undefined || this.client !== client || this.clientId !== clientId
      || this.hostEpoch !== epoch || this.muxGeneration !== generation || this.sessions.get(sessionId) !== runtime
      || runtime.pending.get(pending.eventId) !== pending || pending.continued || pending.sent || pending.sending || pending.transportClosed) return undefined;
    const hostId = dshRevision({ endpoint: host.url });
    return { nativeId: runtime.nativeId, agentId: pending.questionAgentId, eventId: pending.eventId, callId: pending.callId,
      itemIds: [...pending.questionIds ?? []], signature: pending.questionSignature, timed: pending.timed === true,
      hostId, hostFingerprint: host.fingerprint, clientId, revision: this.questionRevision(runtime, pending, hostId, host.fingerprint) };
  }

  async prepareDshQuestionAnswer(sessionId: string, questionId: string, answer: unknown): Promise<DshQuestionAttempt | undefined> {
    const delivery = await this.dshQuestionDelivery(sessionId, questionId);
    if (delivery === undefined) return undefined;
    const pending = this.require(sessionId).pending.get(delivery.eventId)!;
    const id = questionId === delivery.eventId ? delivery.itemIds[0]! : questionId.slice(delivery.eventId.length + 1);
    const { selected, custom } = normalizeQuestionAnswer(answer); const answers = new Map(pending.answers);
    answers.set(id, { id, selected: [...selected], ...(custom === undefined || custom === '' ? {} : { custom }) });
    const attempt = { delivery, answers: [...answers.values()] };
    return isDshQuestionAttempt(attempt) ? structuredClone(attempt) : undefined;
  }

  async retryDshQuestion(sessionId: string, questionId: string, attempt: DshQuestionAttempt, revision: string): Promise<AnswerSubmission> {
    const current = await this.dshQuestionDelivery(sessionId, questionId);
    if (!isDshQuestionAttempt(attempt) || current === undefined || current.revision !== revision || !sameDshQuestionDelivery(attempt.delivery, current))
      throw Object.assign(dshNativeError('原问题组身份或投递已变化，不能重发旧回答', 409), { nativeAdmission: 'not-submitted' });
    return this.replyQuestion(sessionId, questionId, undefined, { delivery: current, answers: structuredClone(attempt.answers) }, true);
  }

  async answer(sessionId: string, questionId: string, answer: unknown, prepared?: DshQuestionAttempt): Promise<AnswerSubmission> {
    return this.replyQuestion(sessionId, questionId, answer, prepared);
  }

  private async replyQuestion(sessionId: string, questionId: string, answer: unknown, prepared?: DshQuestionAttempt, retry = false): Promise<AnswerSubmission> {
    const client = await this.ensureSidecar();
    const runtime = this.require(sessionId);
    const entry = [...runtime.pending].find(([eventId, pending]) => pending.kind === 'question' && (questionId === eventId || pending.questionIds?.some(id => `${eventId}:${id}` === questionId)));
    if (entry === undefined) throw new Error('DSH 问题已结束或不存在');
    const [eventId, pending] = entry;
    if (pending.sent || pending.sending) throw dshNativeError('DSH question reply is queued; wait for native admission', 409);
    if (pending.generation !== this.muxGeneration || !pending.continued && this.clientId === '') throw Object.assign(new Error('DSH 问题需要重新同步'), { statusCode: 409 });
    if (pending.transportClosed && !pending.continued) throw dshNativeError('DSH 问题的转发已结束，等待原生结果确认', 409);
    const id = questionId === eventId ? pending.questionIds?.[0] ?? questionId : questionId.slice(eventId.length + 1);
    if (prepared !== undefined) {
      const delivery = await this.dshQuestionDelivery(sessionId, questionId);
      if (delivery === undefined || delivery.revision !== prepared.delivery.revision || !sameDshQuestionDelivery(prepared.delivery, delivery))
        throw Object.assign(dshNativeError('问题在原回答保存后已变化，未提交', 409), { nativeAdmission: 'not-submitted' });
    }
    const nextAnswers = retry ? new Map(prepared!.answers.map(item => [item.id, structuredClone(item)])) : new Map(pending.answers);
    if (!retry) {
      const { selected, custom } = normalizeQuestionAnswer(answer);
      nextAnswers.set(id, { id, selected: [...selected], ...(custom === undefined || custom === '' ? {} : { custom }) });
    }
    if (prepared !== undefined && JSON.stringify([...nextAnswers.values()]) !== JSON.stringify(prepared.answers))
      throw Object.assign(dshNativeError('原问题组答案已变化，未提交', 409), { nativeAdmission: 'not-submitted' });
    pending.answers = nextAnswers;
    if (pending.answers.size < (pending.questionIds?.length ?? 1)) return { submitted: false };
    const clientId = this.clientId; const generation = this.muxGeneration; const epoch = this.hostEpoch; const nativeId = runtime.nativeId;
    const continuedAtDispatch = pending.continued === true; let continuedAccepted = false;
    const answers = new Map(pending.answers); const attempt = {};
    pending.sending = true; pending.answerAttempt = attempt; pending.acceptedReply = false;
    const reply = (confirmed: boolean): AnswerSubmission => ({ submitted: true, confirmed,
      questionIds: (pending.questionIds ?? [id]).map(question => `${eventId}:${question}`) });
    const currentIdentity = (): boolean => this.sessions.get(sessionId) === runtime && runtime.nativeId === nativeId
      && this.client === client && (continuedAtDispatch || this.clientId === clientId) && this.muxGeneration === generation && this.hostEpoch === epoch
      && pending.answerAttempt === attempt && (runtime.pending.get(eventId) === pending || runtime.pending.get(eventId) === undefined && pending.settlement !== undefined);
    const nativeConfirmed = (): boolean => continuedAtDispatch && continuedAccepted && currentIdentity()
      && pending.settlement?.kind === 'answered' && sameDshQuestionAnswers(pending.settlement.answers, answers);
    const replyGuard = prepared === undefined ? undefined : { retry, current: (): boolean => currentIdentity()
      && runtime.pending.get(eventId) === pending && !pending.sent && !pending.continued && !pending.transportClosed
      && this.questionRevision(runtime, pending, prepared.delivery.hostId, prepared.delivery.hostFingerprint) === prepared.delivery.revision };
    try {
      if (continuedAtDispatch && pending.callId !== undefined) {
        const accepted = await this.call<boolean>(client, 'userQuestions/answer', { agentId: nativeId, callId: pending.callId, answer: { answers: [...answers.values()] } }, sessionId);
        if (accepted !== true) throw dshNativeError('The native continued question has ended', 409);
        if (!currentIdentity()) throw Object.assign(dshNativeError('继续回答的接收回执属于旧原生连接，本次结果待核对', 503), { code: 'uncertain' });
        continuedAccepted = true; pending.acceptedReply = true;
      } else await this.call(client, '$events/result', { clientId, eventId, outcome: { kind: 'result', value: { answers: [...answers.values()] } } }, sessionId, undefined, replyGuard);
      // The business result may arrive before the HTTP reply. It belongs to
      // this original call; returning its receipt never mutates a new pending.
      if (nativeConfirmed()) return reply(true);
      if (!continuedAtDispatch && pending.continued) throw Object.assign(dshNativeError('前台等待已结束，请使用稍后回答入口', 409), { nativeAdmission: 'not-submitted' });
      if (pending.settlement !== undefined) throw Object.assign(dshNativeError('原生问题已由其他结果结束，本次回答未确认', 503), { code: 'uncertain' });
      if (!currentIdentity())
        throw Object.assign(dshNativeError('问题回执属于旧连接，原生回答结果待核对', 503), { code: 'uncertain' });
      pending.sent = true;
      return reply(false);
    } catch (error) {
      if (nativeConfirmed()) return reply(true);
      if (!continuedAtDispatch && pending.continued) throw Object.assign(dshNativeError('原生前台等待已结束，原回答未被接收；请明确提交稍后回答', 409), { nativeAdmission: 'not-submitted', cause: error });
      throw error;
    } finally { if (pending.answerAttempt === attempt) { pending.sending = false; pending.answerAttempt = undefined; } }
  }

  /** 运行期切换连接（设置页粘贴 DSH 链接后调用） */
  async setAttach(url: string, cookie: string, persist?: () => Promise<void>, browserCookie?: string): Promise<void> {
    const currentUrl = this.options.attachUrl ?? (this.sidecar === null ? undefined : dshBaseUrl(this.sidecar.port));
    if (this.sessions.size > 0 && (currentUrl === undefined || dshBaseUrl(url) !== dshBaseUrl(currentUrl))) throw Object.assign(new Error('存在已关联会话，不能切换到不同 DSH Host'), { statusCode: 409 });
    const candidate = this.newHost(url);
    candidate.useCookie(browserCookie ?? cookie);
    try {
      const identity = await readDshHostIdentity(url, browserCookie ?? cookie);
      requireDshBaseline(identity);
      candidate.bindNativeVersion(identity.version ?? DSH_BASELINE_VERSION);
      await candidate.connect(); await persist?.();
    }
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
    this.modelPublicIds.clear();
    this.muxGeneration++;
    const boot = this.booting;
    const client = this.client;
    const sidecar = this.sidecar;
    this.client = null;
    this.sidecar = null;
    this.spawnedConnectionAt = '';
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
    for (const pending of runtime.pending.values()) this.releaseQuestionWaits(pending);
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
        if (pending.kind === 'approval') {
          pending.transportClosed = true;
          if (pending.approvalItem !== undefined) this.emit(id, { type: 'item.complete', itemKey: `approval-${eventId}`, kind: 'approval.request',
            data: { ...pending.approvalItem, submission: pending.sent ? 'sent' : 'uncertain' }, native: value });
          continue;
        }
        if (pending.kind === 'question' && pending.callId !== undefined) {
          // Another Client's answer and a source abort both retire this
          // delivery. Only the call's durable business result tells them apart.
          pending.transportClosed = true;
          this.releaseQuestionWaits(pending);
          if (pending.continued) continue;
          for (const question of pending.questionItems ?? []) this.emit(id, { type: 'item.complete', itemKey: `question-${question.questionId}`, kind: 'question',
            data: { ...question, submission: 'uncertain' }, native: value });
          continue;
        }
        runtime.pending.delete(eventId);
        this.releaseQuestionWaits(pending);
        for (const question of pending.questionItems ?? []) this.emit(id, { type: 'item.complete', itemKey: `question-cancelled-${question.questionId}`, kind: 'question', data: { ...question, status: 'skipped', outcome: 'cancel', resolution: 'outcome-unknown' }, native: value });
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
      case 'llm/retry':
      case 'llm/retry-started': {
        const retries = runtime.retries ??= new DshRetryDisplay();
        const view = type === 'llm/retry' ? retries.scheduled(data) : retries.started(data);
        if (view === undefined) complete(`unknown-${type}-${nativeSeq}`, 'unknown', { nativeType: type });
        else complete(view.itemKey, 'notice', view.data);
        return;
      }
      case 'request/header': {
        const header = data['header'] as { config?: { provider?: string; model?: string; reasoningEffort?: string } } | undefined;
        if (header?.config !== undefined) runtime.modelObservation = { ...header.config, source: 'request/header', nativeSeq };
        complete(`internal-header-${nativeSeq}`, 'internal', { nativeType: type }); return;
      }
      case 'agent-preset/selected': {
        const values = { ...(runtime.projections?.values ?? {}), agentPreset: data['agentPreset'] };
        this.applyProjections(sessionId, runtime, { asOfSeq: nativeSeq, values }, false, 'session/control', native, false);
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
          status: type === 'subagent/catalog' ? 'unknown' : terminal ? 'completed' : 'running',
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
        const outputLimited = reason.kind === 'max-tokens';
        const interrupted = reason.kind === 'interrupted' || reason.kind === 'cancelled' || reason.kind === 'aborted';
        const status = interrupted ? 'interrupted' : outputLimited || reason.kind === 'failed' || reason.kind === 'error' ? 'failed' : 'completed';
        if (outputLimited) complete(`dsh-output-limit-${nativeSeq}`, 'notice', {
          level: 'warning', nativeType: 'turn/end:max-tokens',
          text: 'DSH 达到原生输出 Token 上限（max-tokens）；输出或工具调用可能未完成。',
        });
        for (const view of runtime.retries?.ended(data, status) ?? []) complete(view.itemKey, 'notice', view.data);
        this.emit(sessionId, { type: 'turn.end', nativeTurnId: this.nativeTurnId(data), status, native });
        return;
      }
      case 'assistant/attempt': {
        this.cancelAssistantAttempt(sessionId, runtime);
        let details: string | undefined;
        try {
          if (!Array.isArray(data['stream'])) throw new Error('Missing assistant attempt stream');
          details = failedDshAttemptDetails(data['stream']);
        } catch {
          complete(`unknown-attempt-${nativeSeq}`, 'unknown', { nativeType: type }); return;
        }
        if (details === undefined) complete(`internal-attempt-${nativeSeq}`, 'internal', { nativeType: type });
        else complete(`failed-attempt-${nativeSeq}`, 'notice', {
          level: 'warning', text: '本次模型请求未完成；保留失败前的部分输出。', nativeType: type, details,
        });
        return;
      }
      case 'assistant/message': {
        if (data['interrupted'] !== true) for (const view of runtime.retries?.succeeded(data) ?? []) complete(view.itemKey, 'notice', view.data);
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
        const questions = [...runtime.pending.values()].filter(pending => pending.kind === 'question' && pending.callId === callId);
        if (item?.name === 'ask_user_question' || questions.length > 0) {
          const result = dshQuestionResult(data);
          runtime.questionResults ??= new Map(); runtime.questionResults.set(callId, { result, native, seq: nativeSeq });
          for (const pending of questions) this.settleQuestion(sessionId, runtime, pending, result, native, nativeSeq);
        }
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
          this.emit(sessionId, { type: 'item.complete', itemKey: item.itemKey, kind: 'file.read',
            data: { ...(item.data as EventData['file.read']), status: isError ? 'failed' : 'completed', ...(isError ? { error: output } : {}) },
            nativeSeq, native, nativeTurnId: this.nativeTurnId(data) });
        } else if (item.kind === 'file.change') {
          // C2：DSH 的 write/edit 结果不带 diff，用入参算 hunk（第 2/3 级）
          this.emit(sessionId, {
            type: 'item.complete',
            itemKey: item.itemKey,
            kind: 'file.change',
            data: { changes: isError ? [] : buildFileChanges(item.name, item.input), status: isError ? 'failed' : 'completed',
              ...(isError ? { path: String(item.input['file_path'] ?? item.input['path'] ?? ''), error: output } : {}) },
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
      case 'goal/change': {
        const goal = dshGoalChange(data);
        if (goal === undefined) complete(`unknown-goal-change-${nativeSeq}`, 'unknown', { nativeType: type });
        else this.projectGoal(sessionId, runtime, goal, nativeSeq, native);
        return;
      }
      case 'approval/asked': {
        const id = String(data['id'] ?? '');
        if (id !== '') {
          const approval = { toolName: String(data['toolName'] ?? ''), ...(typeof data['callId'] === 'string' ? { callId: data['callId'] } : {}), eventId: undefined as string | undefined };
          const matches = [...runtime.pending.values()].filter(pending => pending.kind === 'approval' && pending.durableId === undefined
            && approval.callId !== undefined && approval.callId !== '' && pending.callId === approval.callId);
          if (matches.length === 1) { matches[0]!.durableId = id; approval.eventId = matches[0]!.eventId; }
          runtime.approvals.set(id, approval);
        }
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
        // The durable audit has no responding Client. A void ACK may be an
        // idempotent no-op, even when it precedes the same-option audit.
        complete(`approval-resolved-${nativeSeq}`, 'approval.resolved', { approvalId, optionId, by: 'unknown' });
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
        if (source.kind !== 'user') {
          const content = Array.isArray(data['content']) ? data['content'] as { type?: string; text?: string }[] : [];
          complete(`internal-user-${nativeSeq}`, 'internal', { nativeType: `user/message:${source.kind ?? 'unknown'}`,
            ...(source.kind !== 'agent-message' ? {} : { dshContext: { text: content.filter(part => part.type === 'text').map(part => part.text ?? '').join(''), source: structuredClone(source) } }) });
          return;
        }
        const content = Array.isArray(data['content']) ? data['content'] as { type?: string; text?: string }[] : [];
        complete(`user-native-${String(data['id'] ?? nativeSeq)}`, 'user.message', { text: content.filter(part => part.type === 'text').map(part => part.text ?? '').join(''), ...(typeof source.rpcId === 'string' ? { clientCommandId: source.rpcId } : {}) });
        return;
      }
      case 'system/message': {
        const state = this.systemMessages(runtime).accept(type, data);
        complete(`internal-${type}-${nativeSeq}`, 'internal', { nativeType: type, ...(state.format !== 'sections' ? {} : { dshSystemSections: state }) });
        return;
      }
      case 'compaction/summary': {
        this.systemMessages(runtime).accept(type, data);
        complete(`internal-${type}-${nativeSeq}`, 'internal', { nativeType: type });
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
      const matches = [...runtime.approvals].filter(([, approval]) =>
        approval.eventId === eventId && (callId === '' || approval.callId === callId)
        || approval.eventId === undefined && callId !== '' && approval.callId === callId);
      const durableId = matches.length === 1 ? matches[0]?.[0] : undefined;
      if (durableId !== undefined) { const approval = runtime.approvals.get(durableId); if (approval !== undefined) approval.eventId = eventId; }
      const pending: PendingInteraction = { kind: 'approval', eventId, callId, durableId, approvalTool: toolName,
        approvalAgentId: String(value['agentId'] ?? ''), approvalDeliveryId: randomUUID(), generation: this.muxGeneration };
      runtime.pending.set(eventId, pending);
      const args = {
        ...(runtime.toolInputs.get(callId) ?? {}),
        ...((request['args'] ?? request['input'] ?? request['arguments'] ?? {}) as Record<string, unknown>),
      };
      const subject = String(args['command'] ?? args['file_path'] ?? args['path'] ?? '');
      const displayReason = ((request['displayReason'] ?? {}) as { zh?: string }).zh ?? '';
      pending.approvalItem = {
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
      };
      this.emit(target, { type: 'item.complete', itemKey: `approval-${eventId}`, kind: 'approval.request', data: pending.approvalItem });
      return;
    }

    if (event === 'user-questions/request') {
      const questions = (request['questions'] as Record<string, unknown>[]) ?? [];
      const ids = questions.map((question, index) => String(question['id'] ?? index));
      const wait = request['wait'] as { callId?: string; timed?: boolean } | undefined;
      const signature = dshQuestionSignature(questions);
      const calls = signature === undefined ? [] : [...runtime.toolCalls].filter(([, call]) => call.name === 'ask_user_question' && dshQuestionSignature(call.input['questions']) === signature);
      const callId = typeof wait?.callId === 'string' && wait.callId !== '' ? wait.callId : calls.length === 1 ? calls[0]?.[0] : undefined;
      const pending: PendingInteraction = { kind: 'question', eventId, questionIds: ids, generation: this.muxGeneration, callId, timed: wait?.timed === true,
        questionAgentId: agentId, questionDeliveryId: randomUUID(), questionSignature: dshQuestionRecoverySignature(questions) };
      const previous = runtime.pending.get(eventId);
      if (previous !== undefined) this.releaseQuestionWaits(previous);
      runtime.pending.set(eventId, pending);
      pending.questionItems = questions.map((first, index) => ({
          questionId: `${eventId}:${ids[index]}`,
          groupId: eventId,
          ...(callId === undefined ? {} : { toolCallId: callId }),
          ...(typeof wait?.callId !== 'string' || wait.callId === '' ? {} : { dshQuestion: { nativeId: runtime.nativeId, callId: wait.callId, itemId: ids[index]!, clientId: this.clientId, timed: wait.timed === true, phase: 'open' as const } }),
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
      }));
      for (const [index, data] of pending.questionItems.entries()) this.emit(target, { type: 'item.complete', itemKey: `question-${eventId}-${ids[index]}`, kind: 'question', data, native: value });
      const settled = callId === undefined ? undefined : runtime.questionResults?.get(callId);
      if (settled !== undefined) this.settleQuestion(target, runtime, pending, settled.result, settled.native, settled.seq);
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
