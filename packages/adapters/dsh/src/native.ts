import { createHash } from 'node:crypto';
import { validateDshArgs } from './contracts.js';
import catalog from '../../../../fixtures/dsh/host-api-catalog.json' with { type: 'json' };

export interface DshGoalRef { id: string; revision: number }
export type DshTiming =
  | { kind: 'after'; after_seconds: number }
  | { kind: 'at'; at: string | { date: string; time: string; time_zone: string } }
  | { kind: 'every'; every_seconds: number }
  | { kind: 'daily'; daily: { time: string; time_zone: string } }
  | { kind: 'weekly'; weekly: { time: string; time_zone: string; weekdays: number[] } }
  | { kind: 'cron'; cron: { expression: string; time_zone: string } }
  | { kind: 'rrule'; rrule: string };
export type DshScheduleTarget = { kind: 'session'; sessionId: string } | { kind: 'new' | 'new_once'; create?: { cwd?: string; agentPreset?: string } };
export interface DshScheduleCreate { title: string; prompt: string; timing: DshTiming; target?: DshScheduleTarget }
export type DshScheduleEdit =
  | { id: string; action: 'update'; expectedUpdatedAt: string; patch: Partial<DshScheduleCreate> & { active?: boolean } }
  | { id: string; action: 'delete'; expectedUpdatedAt: string };
export type DshNativeControl =
  | { type: 'model'; provider: string; model: string; reasoningEffort?: string }
  | { type: 'preset'; agentPreset: string }
  | { type: 'rename'; title: string }
  | { type: 'pin'; pinned: boolean }
  | { type: 'archive'; archived: boolean; stopActivity?: boolean }
  | { type: 'fork'; atSeq?: number; allowMigration?: boolean }
  | { type: 'compact' }
  | { type: 'settings-mutate'; ns: string; ops: Record<string, unknown>[]; expectedRevision: number }
  | { type: 'goal-create'; objective: string; maxGoalRounds?: number }
  | { type: 'goal-edit'; ref: DshGoalRef; objective?: string; maxGoalRounds?: number }
  | { type: 'goal-pause' | 'goal-resume' | 'goal-complete' | 'goal-clear'; ref: DshGoalRef }
  | { type: 'schedule-create'; request: DshScheduleCreate }
  | { type: 'schedule-edit'; request: DshScheduleEdit }
  | { type: 'schedule-run'; id: string }
  | { type: 'child-prompt'; childSessionId: string; text: string; delivery: 'queue' | 'steer'; requestId: string }
  | { type: 'child-interrupt'; childSessionId: string }
  | { type: 'job-kill'; jobId: string }
  | { type: 'card-dismiss'; callId: string }
  | { type: 'forge-worktree'; from: string | null }
  | { type: 'forge-cancel' | 'forge-restore' | 'forge-retry' | 'forge-stop' | 'forge-refresh' };
export type DshNativeAction = DshNativeControl & { revision: string };

const fields: Record<DshNativeControl['type'], readonly string[]> = {
  model: ['provider', 'model', 'reasoningEffort'], preset: ['agentPreset'], rename: ['title'], pin: ['pinned'], archive: ['archived', 'stopActivity'], fork: ['atSeq', 'allowMigration'], compact: [],
  'settings-mutate': ['ns', 'ops', 'expectedRevision'], 'goal-create': ['objective', 'maxGoalRounds'], 'goal-edit': ['ref', 'objective', 'maxGoalRounds'],
  'goal-pause': ['ref'], 'goal-resume': ['ref'], 'goal-complete': ['ref'], 'goal-clear': ['ref'],
  'schedule-create': ['request'], 'schedule-edit': ['request'], 'schedule-run': ['id'],
  'child-prompt': ['childSessionId', 'text', 'delivery', 'requestId'], 'child-interrupt': ['childSessionId'], 'job-kill': ['jobId'], 'card-dismiss': ['callId'],
  'forge-worktree': ['from'], 'forge-cancel': [], 'forge-restore': [], 'forge-retry': [], 'forge-stop': [], 'forge-refresh': [],
};
export const DSH_NATIVE_CONTROLS = Object.keys(fields) as DshNativeControl['type'][];
export function dshNativeError(message: string, statusCode = 400): Error { return Object.assign(new Error(message), { statusCode }); }
export function parseDshNativeAction(value: unknown): DshNativeAction {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw dshNativeError('DSH action must be an object');
  const action = value as Record<string, unknown>;
  const type = action['type'];
  if (typeof type !== 'string' || !Object.hasOwn(fields, type)) throw dshNativeError('Unknown DSH control');
  if (typeof action['revision'] !== 'string' || action['revision'].length === 0 || action['revision'].length > 512) throw dshNativeError('DSH action requires a state revision');
  if (Object.keys(action).some(key => !['type', 'revision', ...fields[type as DshNativeControl['type']]].includes(key))) throw dshNativeError('Unknown DSH action field');
  const result = structuredClone(action) as DshNativeAction;
  // Bind identities only after validation. The UI never supplies an endpoint,
  // parentSessionId or agentId that can escape the retained Session.
  const call = dshNativeCall(result, 'bound-session');
  try { validateDshArgs(call.endpoint, call.args); } catch (error) { throw dshNativeError(error instanceof Error ? error.message : 'Invalid DSH action'); }
  if (result.type === 'pin' && typeof result.pinned !== 'boolean' || result.type === 'archive' && (typeof result.archived !== 'boolean' || result.stopActivity !== undefined && typeof result.stopActivity !== 'boolean')) throw dshNativeError('DSH organization flags must be booleans');
  if (result.type === 'child-prompt' && !['queue', 'steer'].includes(result.delivery)) throw dshNativeError('Unknown child delivery');
  if (result.type === 'settings-mutate' && (!Number.isSafeInteger(result.expectedRevision) || result.expectedRevision < 0 || result.ops.length === 0)) throw dshNativeError('Settings require a native revision and at least one operation');
  if (result.type.startsWith('goal-')) {
    const goal = result as { ref?: DshGoalRef; objective?: string; maxGoalRounds?: number };
    if (goal.ref !== undefined && (!Number.isSafeInteger(goal.ref.revision) || goal.ref.revision <= 0)) throw dshNativeError('Goal revision must be a positive integer');
    if (goal.maxGoalRounds !== undefined && (!Number.isSafeInteger(goal.maxGoalRounds) || goal.maxGoalRounds <= 0)) throw dshNativeError('Goal round limit must be a positive integer');
    if (goal.objective !== undefined && goal.objective.trim() === '') throw dshNativeError('Goal objective must not be empty');
    if (result.type === 'goal-edit' && goal.objective === undefined && goal.maxGoalRounds === undefined) throw dshNativeError('Goal edit is empty');
  }
  if (result.type === 'schedule-create') validateDshTiming(result.request.timing);
  if (result.type === 'schedule-edit') {
    if (typeof result.request.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(result.request.expectedUpdatedAt))) throw dshNativeError('Schedule edit requires its native updatedAt');
    if (result.request.action === 'update') {
      if (Object.keys(result.request.patch).length === 0) throw dshNativeError('Schedule edit is empty');
      if (result.request.patch.timing !== undefined) validateDshTiming(result.request.patch.timing);
    }
  }
  return result;
}

/** Preserve native wall-time + IANA-zone semantics. Reject ambiguous naive
 * timestamps; DST gaps/overlaps remain the native scheduler's decision. */
export function validateDshTiming(timing: DshTiming): void {
  if (timing.kind === 'after' || timing.kind === 'every') {
    const seconds = timing.kind === 'after' ? timing.after_seconds : timing.every_seconds;
    if (!Number.isSafeInteger(seconds) || seconds <= 0) throw dshNativeError('Schedule interval must be a positive integer');
  }
  if (timing.kind === 'at' && typeof timing.at === 'string' && (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(timing.at) || !Number.isFinite(Date.parse(timing.at)))) throw dshNativeError('Schedule timestamp requires an explicit UTC offset');
  const local = timing.kind === 'at' && typeof timing.at === 'object' ? timing.at : timing.kind === 'daily' ? timing.daily : timing.kind === 'weekly' ? timing.weekly : timing.kind === 'cron' ? timing.cron : undefined;
  if (local !== undefined) {
    try { new Intl.DateTimeFormat('en', { timeZone: local.time_zone }).format(0); } catch { throw dshNativeError('Schedule time zone must be UTC or an IANA zone'); }
    if (local.time_zone === '') throw dshNativeError('Schedule time zone must be explicit');
  }
  if (timing.kind === 'weekly' && (timing.weekly.weekdays.length === 0 || new Set(timing.weekly.weekdays).size !== timing.weekly.weekdays.length || timing.weekly.weekdays.some(day => !Number.isSafeInteger(day) || day < 1 || day > 7))) throw dshNativeError('Weekly weekdays must be unique ISO weekdays');
}

export function dshNativeCall(action: DshNativeControl, nativeId: string): { endpoint: string; args: Record<string, unknown> } {
  const request = (endpoint: string, value: unknown) => ({ endpoint, args: { request: value } });
  switch (action.type) {
    case 'model': return request('session/selectModel', { sessionId: nativeId, provider: action.provider, model: action.model, ...(action.reasoningEffort === undefined ? {} : { reasoningEffort: action.reasoningEffort }) });
    case 'preset': return { endpoint: 'agentPresets/select', args: { agentId: nativeId, agentPreset: action.agentPreset } };
    case 'rename': return request('session/rename', { sessionId: nativeId, title: action.title });
    case 'pin': return request(action.pinned ? 'workspace/pinSession' : 'workspace/unpinSession', { sessionId: nativeId });
    case 'archive': return request(action.archived ? 'workspace/archiveSession' : 'workspace/unarchiveSession', { sessionId: nativeId, ...(action.archived && action.stopActivity !== undefined ? { stopActivity: action.stopActivity } : {}) });
    case 'fork': return request('session/fork', { sessionId: nativeId, ...(action.atSeq === undefined ? {} : { atSeq: action.atSeq }), ...(action.allowMigration === undefined ? {} : { allowMigration: action.allowMigration }) });
    case 'compact': return { endpoint: 'commands/execute', args: { agentId: nativeId, line: '/compact', submittedAttachments: [] } };
    case 'settings-mutate': return { endpoint: 'settings/mutate', args: { ns: action.ns, ops: action.ops, expectedRevision: action.expectedRevision } };
    case 'goal-create': return { endpoint: 'goals/create', args: { agentId: nativeId, request: { objective: action.objective, ...(action.maxGoalRounds === undefined ? {} : { maxGoalRounds: action.maxGoalRounds }) } } };
    case 'goal-edit': return { endpoint: 'goals/edit', args: { agentId: nativeId, ref: action.ref, request: { ...(action.objective === undefined ? {} : { objective: action.objective }), ...(action.maxGoalRounds === undefined ? {} : { maxGoalRounds: action.maxGoalRounds }) } } };
    case 'goal-pause': case 'goal-resume': case 'goal-complete': case 'goal-clear': return { endpoint: `goals/${action.type.slice(5)}`, args: { agentId: nativeId, ref: action.ref } };
    case 'schedule-create': return request('schedule/create', action.request);
    case 'schedule-edit': return request('schedule/edit', action.request);
    case 'schedule-run': return request('schedule/run', { id: action.id });
    case 'child-prompt': return request('subagents/prompt', { requestId: action.requestId, parentSessionId: nativeId, childSessionId: action.childSessionId, mode: 'continuable', delivery: action.delivery, content: [{ type: 'text', text: action.text }] });
    case 'child-interrupt': return { endpoint: 'subagents/interruptByParent', args: { childSessionId: action.childSessionId, parentSessionId: nativeId, mode: 'continuable' } };
    case 'job-kill': return request('job/kill', { sessionId: nativeId, jobId: action.jobId });
    case 'card-dismiss': return { endpoint: 'actionCards/act', args: { agentId: nativeId, callId: action.callId, verb: 'dismiss', payload: {} } };
    case 'forge-worktree': return { endpoint: 'forgePanel/requestWorktree', args: { sessionId: nativeId, from: action.from } };
    case 'forge-cancel': case 'forge-restore': case 'forge-retry': case 'forge-stop': case 'forge-refresh': {
      const methods = { 'forge-cancel': 'cancelWorktree', 'forge-restore': 'restoreWorktree', 'forge-retry': 'retryWorktree', 'forge-stop': 'stopCreation', 'forge-refresh': 'refresh' };
      return { endpoint: `forgePanel/${methods[action.type]}`, args: { sessionId: nativeId } };
    }
  }
}

export function dshActionSensitive(action: DshNativeControl): boolean {
  return action.type === 'settings-mutate' || action.type === 'child-prompt' || action.type === 'goal-create' || action.type === 'goal-edit' || action.type === 'schedule-create' || action.type === 'schedule-edit';
}

const labels: Record<DshNativeControl['type'], string> = {
  model: '选择原生模型', preset: '选择 Preset', rename: '重命名会话', pin: '置顶会话', archive: '归档会话', fork: '从历史分叉', compact: '压缩上下文',
  'settings-mutate': '修改 Host 设置', 'goal-create': '创建目标', 'goal-edit': '修改目标', 'goal-pause': '暂停目标', 'goal-resume': '继续目标', 'goal-complete': '完成目标', 'goal-clear': '清除目标',
  'schedule-create': '创建日程', 'schedule-edit': '修改日程', 'schedule-run': '立即运行日程', 'child-prompt': '发送子 Agent 消息', 'child-interrupt': '停止子 Agent', 'job-kill': '停止后台 Job', 'card-dismiss': '关闭原生卡片',
  'forge-worktree': '申请工作树', 'forge-cancel': '取消工作树申请', 'forge-restore': '恢复工作树', 'forge-retry': '重试工作树创建', 'forge-stop': '停止工作树创建', 'forge-refresh': '刷新 Forge',
};
const required: Partial<Record<DshNativeControl['type'], string[]>> = {
  model: ['provider', 'model'], preset: ['agentPreset'], rename: ['title'], pin: ['pinned'], archive: ['archived'], 'settings-mutate': ['ns', 'ops', 'expectedRevision'],
  'goal-create': ['objective'], 'goal-edit': ['ref'], 'goal-pause': ['ref'], 'goal-resume': ['ref'], 'goal-complete': ['ref'], 'goal-clear': ['ref'],
  'schedule-create': ['request'], 'schedule-edit': ['request'], 'schedule-run': ['id'], 'child-prompt': ['childSessionId', 'text', 'delivery', 'requestId'], 'child-interrupt': ['childSessionId'], 'job-kill': ['jobId'], 'card-dismiss': ['callId'], 'forge-worktree': ['from'],
};
const parameter = (endpoint: string, name: string): Record<string, unknown> => {
  const endpoints = catalog.endpoints as Record<string, { parameters: { name: string; jsonSchema?: object }[] }>;
  return structuredClone(endpoints[endpoint]?.parameters.find(value => value.name === name)?.jsonSchema ?? { type: 'string' }) as Record<string, unknown>;
};
const objectProperties = (endpoint: string, name = 'request') => (parameter(endpoint, name)['properties'] ?? {}) as Record<string, Record<string, unknown>>;
function property(type: DshNativeControl['type'], key: string): Record<string, unknown> {
  if (type === 'model') return objectProperties('session/selectModel')[key] ?? { type: 'string' };
  if (type.startsWith('goal-')) return key === 'ref' ? { ...parameter('goals/edit', 'ref'), readOnly: true, entitySource: 'goal' } : objectProperties('goals/create')[key] ?? { type: 'string' };
  if (type === 'settings-mutate') return { ...parameter('settings/mutate', key), ...(key === 'expectedRevision' ? { readOnly: true, entitySource: 'settings.revision' } : {}) };
  if (type === 'schedule-create') return parameter('schedule/create', 'request');
  if (type === 'schedule-edit') return { ...parameter('schedule/edit', 'request'), entitySource: 'schedules', nativeCasField: 'expectedUpdatedAt' };
  if (key === 'pinned' || key === 'archived' || key === 'stopActivity' || key === 'allowMigration') return { type: 'boolean' };
  if (key === 'atSeq') return { type: 'integer', minimum: 0, entitySource: 'history' };
  if (key === 'from') return { oneOf: [{ type: 'string' }, { type: 'null' }] };
  if (key === 'delivery') return { type: 'string', enum: ['queue', 'steer'] };
  if (key === 'requestId') return { type: 'string', readOnly: true, generated: 'commandId' };
  if (key === 'agentPreset') return parameter('agentPresets/select', 'agentPreset');
  return { type: 'string', ...(key === 'childSessionId' ? { entitySource: 'children' } : key === 'jobId' ? { entitySource: 'jobs' } : key === 'callId' ? { entitySource: 'projections.actionCards' } : {}) };
}
/** Finite forms for the shared UI; type/revision stay in the dispatch envelope.
 * Entity-owned native CAS fields are selected from authoritative objects. */
export function dshNativeActionMetadata(compatible: boolean, deployment: Record<string, unknown> = {}) {
  const available = (name: string): boolean => (deployment[name] as { unavailable?: boolean } | undefined)?.unavailable !== true;
  return DSH_NATIVE_CONTROLS.map(type => {
    const section = type === 'model' ? 'models' : type === 'preset' ? 'presets' : type.startsWith('goal-') ? 'goal' : type.startsWith('schedule-') ? 'schedules' : type.startsWith('forge-') ? 'forge' : type === 'job-kill' ? 'jobs' : type === 'settings-mutate' ? 'settings' : 'commands';
    const properties = Object.fromEntries(fields[type].map(key => [key, property(type, key)]));
    const groups = (deployment['models'] as { groups?: { id: string; models?: { id: string }[] }[] } | undefined)?.groups ?? [];
    if (type === 'model') { properties['provider'] = { type: 'string', enum: groups.map(group => group.id) }; properties['model'] = { type: 'string', enum: [...new Set(groups.flatMap(group => group.models?.map(model => model.id) ?? []))] }; }
    if (type === 'preset') properties['agentPreset'] = { type: 'string', enum: (deployment['presets'] as { presets?: { id: string; broken?: string }[] } | undefined)?.presets?.filter(preset => preset.broken === undefined).map(preset => preset.id) ?? [] };
    const goal = deployment['goal'] as { id?: string; revision?: number } | undefined;
    if (type.startsWith('goal-') && type !== 'goal-create' && goal?.id !== undefined) properties['ref'] = { ...properties['ref'], default: { id: goal.id, revision: goal.revision } };
    const commandsValue = deployment['commands'] as { commands?: { name?: string }[] } | { name?: string }[] | undefined;
    const commands = Array.isArray(commandsValue) ? commandsValue : commandsValue?.commands ?? [];
    const session = deployment['session'] as { state?: { cursor?: number; active?: boolean; running?: boolean }; projections?: { asOfSeq?: number; values?: { sessionListMetadata?: { blank?: boolean } } } } | undefined;
    const requiresBlankSession = type === 'preset' || type === 'forge-worktree' || type === 'forge-cancel';
    const blankConfirmed = session?.projections?.values?.sessionListMetadata?.blank === true && typeof session.state?.cursor === 'number'
      && (session.projections?.asOfSeq ?? -1) >= session.state.cursor && session.state.running === false;
    const worktree = (deployment['forge'] as { worktree?: { editable?: boolean; created?: unknown; creation?: unknown; restoration?: unknown } } | undefined)?.worktree;
    const forgeAvailable = type === 'forge-worktree' ? worktree?.editable === true && worktree.created === null && worktree.creation === null
      : type === 'forge-cancel' ? worktree?.created === null && worktree.creation === null
      : type === 'forge-restore' ? worktree?.created !== undefined && worktree.created !== null && worktree.restoration === null && session?.state?.running === false : true;
    const objectAvailable = type === 'compact' ? commands.some(command => command.name === 'compact' || command.name === '/compact')
      : type.startsWith('goal-') && type !== 'goal-create' ? goal?.id !== undefined
      : type === 'model' ? groups.length > 0 : true;
    return { type, label: labels[type], supported: compatible && available(section) && objectAvailable && forgeAvailable && (!requiresBlankSession || blankConfirmed) && (type !== 'preset' || session?.state?.active === true), scope: type === 'settings-mutate' || type.startsWith('schedule-') ? 'host' : 'session',
      requiresIdle: type === 'preset' || type === 'compact' || type === 'forge-worktree' || type === 'forge-cancel' || type === 'forge-restore', requiresBlankSession,
      sensitive: ['settings-mutate', 'child-prompt', 'goal-create', 'goal-edit', 'schedule-create', 'schedule-edit'].includes(type),
      schema: { type: 'object', properties, required: required[type] ?? [], additionalProperties: false },
    };
  });
}

/** Catalogs describe credentials; they never disclose credential values or
 * auth URL query/userinfo to the browser or ordinary action receipts. */
export function dshPublicValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dshPublicValue);
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); } catch { return '[invalid URL]'; }
    }
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(?:api.?key|authorization|cookie|password|secret|access.?token|refresh.?token|token|credentials)$/i.test(key) ? '[redacted]' : dshPublicValue(item)]));
}
export function dshRevision(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
