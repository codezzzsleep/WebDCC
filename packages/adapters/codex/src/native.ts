import { Ajv } from 'ajv';
import { nativeRequest } from './controls.js';
import type { JsonRpcStdio } from './rpc.js';

export type CodexNativeAction =
  | { type: 'goal-set'; objective: string; tokenBudget?: number }
  | { type: 'goal-pause' | 'goal-resume' | 'goal-clear' | 'compact' | 'archive' | 'unarchive' | 'refresh-skills' }
  | { type: 'rename'; title: string }
  | { type: 'fork'; lastTurnId?: string }
  | { type: 'review'; target: { type: 'uncommittedChanges' } | { type: 'baseBranch'; branch: string } | { type: 'commit'; sha: string; title: string | null } };

const string = { type: 'string', minLength: 1, maxLength: 16_384 };
const variants = [
  { types: ['goal-set'], properties: { objective: string, tokenBudget: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }, required: ['objective'] },
  { types: ['goal-pause', 'goal-resume', 'goal-clear', 'compact', 'archive', 'unarchive', 'refresh-skills'], properties: {}, required: [] },
  { types: ['rename'], properties: { title: { ...string, maxLength: 200 } }, required: ['title'] },
  { types: ['fork'], properties: { lastTurnId: string }, required: [] },
  { types: ['review'], properties: { target: { oneOf: [
    { type: 'object', properties: { type: { const: 'uncommittedChanges' } }, required: ['type'], additionalProperties: false },
    { type: 'object', properties: { type: { const: 'baseBranch' }, branch: string }, required: ['type', 'branch'], additionalProperties: false },
    { type: 'object', properties: { type: { const: 'commit' }, sha: { type: 'string', pattern: '^[a-fA-F0-9]{7,64}$' }, title: { type: ['string', 'null'], maxLength: 200 } }, required: ['type', 'sha', 'title'], additionalProperties: false },
  ] } }, required: ['target'] },
];
const schemas = variants.flatMap(variant => variant.types.map(type => ({ type: 'object', properties: { type: { const: type }, ...variant.properties }, required: ['type', ...variant.required], additionalProperties: false })));
const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });
const validate = ajv.compile({ oneOf: schemas });
export function parseCodexNativeAction(value: unknown): CodexNativeAction {
  if (!validate(value)) throw Object.assign(new Error('原生控制参数无效或操作不受支持'), { statusCode: 400, code: 'native-control-rejected' });
  return value as CodexNativeAction;
}

const labels: Record<CodexNativeAction['type'], string> = {
  'goal-set': '设置原生目标', 'goal-pause': '暂停原生目标', 'goal-resume': '恢复原生目标', 'goal-clear': '清除原生目标',
  rename: '修改原生标题', fork: '分叉原生会话', compact: '压缩原生上下文', archive: '归档原生会话', unarchive: '恢复原生归档',
  review: '启动原生 Review', 'refresh-skills': '重新读取原生 Skills',
};
export const codexNativeActions = schemas.map(schema => ({ type: schema.properties.type.const, label: labels[schema.properties.type.const as CodexNativeAction['type']],
  supported: true, scope: 'session', requiresIdle: ['compact', 'archive', 'unarchive', 'fork', 'review'].includes(schema.properties.type.const), schema }));

export async function codexNativeState(rpc: JsonRpcStdio, nativeId: string, current: () => void) {
  const [thread, goal] = await Promise.all([
    nativeRequest(rpc, 'thread/read', { threadId: nativeId, includeTurns: false }),
    nativeRequest(rpc, 'thread/goal/get', { threadId: nativeId }),
  ]);
  current();
  if (thread.thread.id !== nativeId || goal.goal !== null && goal.goal.threadId !== nativeId) throw Object.assign(new Error('原生状态返回了不同会话'), { statusCode: 409 });
  return { nativeId, thread: thread.thread, goal: goal.goal };
}

export async function codexNativeCatalog(rpc: JsonRpcStdio, nativeId: string, cwd: string, current: () => void) {
  // Read-only discovery errors do not turn unknown account/rate limits into 0.
  const results = await Promise.allSettled([
    nativeRequest(rpc, 'model/list', { includeHidden: false, limit: 100 }),
    nativeRequest(rpc, 'mcpServerStatus/list', { threadId: nativeId, limit: 100 }),
    nativeRequest(rpc, 'skills/list', { cwds: [cwd], forceReload: false }),
    nativeRequest(rpc, 'account/read', { refreshToken: false }),
    nativeRequest(rpc, 'account/rateLimits/read', {}),
  ]);
  current();
  const names = ['models', 'mcp', 'skills', 'account', 'rateLimits'];
  return { actions: codexNativeActions, ...Object.fromEntries(results.map((result, index) => [names[index]!,
    result.status === 'fulfilled' ? { available: true, value: result.value } : { available: false, reason: '原生读取失败或当前账号不可用' }])),
    unsupported: { plugins: '原生插件接口仍在开发中；请使用原生 CLI', realtime: '锁定基线没有验证的启动接口',
      login: '账号只读状态；交互登录使用原生 CLI', queue: '原生队列管理尚未验证，Web 队列保持独立' } };
}

export async function executeCodexNativeControl(rpc: JsonRpcStdio, nativeId: string, cwd: string, action: CodexNativeAction): Promise<unknown> {
  switch (action.type) {
    case 'goal-set': return nativeRequest(rpc, 'thread/goal/set', { threadId: nativeId, origin: 'user', objective: action.objective, ...(action.tokenBudget === undefined ? {} : { tokenBudget: action.tokenBudget }) });
    case 'goal-pause': case 'goal-resume': return nativeRequest(rpc, 'thread/goal/set', { threadId: nativeId, origin: 'user', status: action.type === 'goal-pause' ? 'paused' : 'active' });
    case 'goal-clear': return nativeRequest(rpc, 'thread/goal/clear', { threadId: nativeId, origin: 'user' });
    case 'rename': return nativeRequest(rpc, 'thread/name/set', { threadId: nativeId, name: action.title });
    case 'archive': return nativeRequest(rpc, 'thread/archive', { threadId: nativeId });
    case 'unarchive': return nativeRequest(rpc, 'thread/unarchive', { threadId: nativeId });
    case 'fork': return nativeRequest(rpc, 'thread/fork', { threadId: nativeId, ...(action.lastTurnId === undefined ? {} : { lastTurnId: action.lastTurnId }), excludeTurns: true });
    case 'compact': await nativeRequest(rpc, 'thread/compact/start', { threadId: nativeId }); return { submitted: true, confirmed: false, note: '等待原生压缩终态通知' };
    case 'review': return nativeRequest(rpc, 'review/start', { threadId: nativeId, delivery: 'inline', target: action.target });
    case 'refresh-skills': return nativeRequest(rpc, 'skills/list', { cwds: [cwd], forceReload: true });
  }
}
