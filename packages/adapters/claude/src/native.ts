import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Ajv } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ElicitationResult, ModelInfo, Options, SDKSessionInfo, SessionMessage, ThinkingConfig } from '@anthropic-ai/claude-agent-sdk';

export type ClaudeNativeAction =
  | { type: 'model'; model: string }
  | { type: 'effort'; effort: string }
  | { type: 'thinking'; thinking: ThinkingConfig | null }
  | { type: 'output'; schema: Record<string, unknown> | null }
  | { type: 'checkpoints'; enabled: boolean }
  | { type: 'resume-at'; messageId: string }
  | { type: 'rewind'; messageId: string; dryRun: boolean }
  | { type: 'rename'; title: string; revision: string }
  | { type: 'tag'; tag: string | null; revision: string }
  | { type: 'fork'; messageId?: string; title?: string }
  | { type: 'delete'; revision: string; confirmNativeId: string }
  | { type: 'mcp-reconnect'; serverName: string }
  | { type: 'mcp-toggle'; serverName: string; enabled: boolean }
  | { type: 'mcp-resource'; serverName: string; uri: string }
  | { type: 'reload-skills' }
  | { type: 'reload-plugins'; holdOnCacheImpact: boolean }
  | { type: 'reload-output-styles' }
  | { type: 'background'; toolUseId?: string }
  | { type: 'stop-task'; taskId: string; runId?: string }
  | { type: 'refresh' }
  | { type: 'elicitation'; requestId: string; action: 'accept' | 'decline' | 'cancel'; content?: unknown }
  | { type: 'dialog'; requestId: string; behavior: 'completed' | 'cancelled'; result?: unknown };

export interface ClaudeNativeOptions {
  thinking?: Options['thinking'];
  outputFormat?: Options['outputFormat'];
  enableFileCheckpointing?: boolean;
  resumeSessionAt?: string;
}
/** User replies are always ephemeral; a schema may declare secrets only after journal admission. */
export function classifySensitive(action: ClaudeNativeAction): boolean {
  return action.type === 'elicitation' || action.type === 'dialog';
}
export function claudeNativeActionCatalog(models: ModelInfo[]) {
  const text = { type: 'string', minLength: 1 };
  const boolean = { type: 'boolean' };
  const definitions: [string, string, Record<string, unknown>, string[], boolean?][] = [
    ['model', '更换原生模型', { model: { type: 'string', enum: models.map(model => model.value) } }, ['model'], true],
    ['effort', '更改原生 effort', { effort: { type: 'string', enum: [...new Set(models.flatMap(model => model.supportedEffortLevels ?? []))] } }, ['effort']],
    ['thinking', '更改会话 thinking', { thinking: { anyOf: [{ type: 'null' }, { type: 'object', properties: { type: { enum: ['adaptive', 'enabled', 'disabled'] }, budgetTokens: { type: 'integer', minimum: 1024 }, display: { enum: ['summarized', 'omitted'] } }, required: ['type'], additionalProperties: false }] } }, ['thinking'], true],
    ['output', '结构化输出 schema', { schema: { type: ['object', 'null'] } }, ['schema'], true],
    ['checkpoints', '原生文件检查点', { enabled: boolean }, ['enabled'], true],
    ['resume-at', '从原生助手消息恢复', { messageId: text }, ['messageId'], true],
    ['rewind', '预览或还原已跟踪文件', { messageId: text, dryRun: boolean }, ['messageId', 'dryRun']],
    ['rename', '修改原生会话标题', { title: text, revision: text }, ['title', 'revision']],
    ['tag', '修改原生会话标签', { tag: { type: ['string', 'null'] }, revision: text }, ['tag', 'revision']],
    ['fork', '分叉原生会话', { messageId: text, title: text }, []],
    ['delete', '删除原生会话及原生历史', { revision: text, confirmNativeId: text }, ['revision', 'confirmNativeId'], true],
    ['mcp-reconnect', '重连原生 MCP', { serverName: text }, ['serverName']],
    ['mcp-toggle', '开关会话 MCP', { serverName: text, enabled: boolean }, ['serverName', 'enabled']],
    ['mcp-resource', '读取 MCP UI resource', { serverName: text, uri: { type: 'string', pattern: '^ui://' } }, ['serverName', 'uri']],
    ['reload-skills', '刷新原生 skills', {}, []],
    ['reload-plugins', '刷新原生 plugins', { holdOnCacheImpact: boolean }, ['holdOnCacheImpact']],
    ['reload-output-styles', '刷新原生输出样式', {}, []],
    ['background', '将前台任务放入后台', { toolUseId: text }, []],
    ['stop-task', '停止指定原生任务', { taskId: text, runId: text }, ['taskId']],
    ['refresh', '读取原生用量与上下文', {}, []],
    ['elicitation', '回答原生 MCP 请求', { requestId: text, action: { enum: ['accept', 'decline', 'cancel'] }, content: {} }, ['requestId', 'action']],
    ['dialog', '回答已注册原生对话', { requestId: text, behavior: { enum: ['completed', 'cancelled'] }, result: {} }, ['requestId', 'behavior']],
  ];
  return definitions.map(([type, label, properties, required, requiresIdle]) => ({ type, label, supported: true, scope: 'native-session', requiresIdle: requiresIdle ?? false,
    sensitive: type === 'elicitation' || type === 'dialog', schema: { type: 'object', properties: { type: { const: type }, ...properties }, required: ['type', ...required], additionalProperties: false } }));
}

export function nativeError(message: string, statusCode = 400): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
export function nativeValidationError(message: string, statusCode = 400): Error & { statusCode: number; code: string } {
  return Object.assign(nativeError(message, statusCode), { code: 'native-control-rejected' });
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function nonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 4096) throw nativeValidationError(`${label} 无效`);
}
export function parseClaudeNativeAction(value: unknown): ClaudeNativeAction {
  const action = record(value);
  nonempty(action['type'], 'Claude action');
  const strings: Record<string, string[]> = {
    model: ['model'], effort: ['effort'], 'resume-at': ['messageId'], rewind: ['messageId'], rename: ['title', 'revision'],
    tag: ['revision'], delete: ['revision', 'confirmNativeId'], 'mcp-reconnect': ['serverName'], 'mcp-toggle': ['serverName'],
    'mcp-resource': ['serverName', 'uri'], 'stop-task': ['taskId'], elicitation: ['requestId'], dialog: ['requestId'],
  };
  for (const key of strings[action['type']] ?? []) nonempty(action[key], key);
  const booleans: Record<string, string> = { rewind: 'dryRun', checkpoints: 'enabled', 'mcp-toggle': 'enabled', 'reload-plugins': 'holdOnCacheImpact' };
  const bool = booleans[action['type']];
  if (bool !== undefined && typeof action[bool] !== 'boolean') throw nativeValidationError(`${bool} 必须为布尔值`);
  switch (action['type']) {
    case 'thinking': {
      if (action['thinking'] !== null) {
        const thinking = record(action['thinking']);
        if (!['adaptive', 'enabled', 'disabled'].includes(String(thinking['type']))) throw nativeValidationError('thinking.type 无效');
        if (thinking['type'] === 'enabled' && (!Number.isSafeInteger(thinking['budgetTokens']) || Number(thinking['budgetTokens']) < 1024)) throw nativeValidationError('thinking budgetTokens 必须为至少 1024 的整数');
        if (thinking['display'] !== undefined && !['summarized', 'omitted'].includes(String(thinking['display']))) throw nativeValidationError('thinking.display 无效');
        const allowed = thinking['type'] === 'disabled' ? ['type'] : thinking['type'] === 'adaptive' ? ['type', 'display'] : ['type', 'display', 'budgetTokens'];
        if (Object.keys(thinking).some(key => !allowed.includes(key))) throw nativeValidationError('未知 thinking 参数');
      }
      break;
    }
    case 'output': if (action['schema'] !== null) validateJsonSchema(action['schema']); break;
    case 'fork':
      if (action['messageId'] !== undefined) nonempty(action['messageId'], 'messageId');
      if (action['title'] !== undefined) nonempty(action['title'], 'title');
      break;
    case 'tag': if (action['tag'] !== null) nonempty(action['tag'], 'tag'); break;
    case 'elicitation': if (!['accept', 'decline', 'cancel'].includes(String(action['action']))) throw nativeValidationError('elicitation.action 无效'); break;
    case 'dialog': if (!['completed', 'cancelled'].includes(String(action['behavior']))) throw nativeValidationError('dialog.behavior 无效'); break;
    case 'background': if (action['toolUseId'] !== undefined) nonempty(action['toolUseId'], 'toolUseId'); break;
    case 'model': case 'effort': case 'checkpoints': case 'resume-at': case 'rewind': case 'rename': case 'delete':
    case 'mcp-reconnect': case 'mcp-toggle': case 'mcp-resource': case 'reload-skills': case 'reload-plugins':
    case 'reload-output-styles': case 'stop-task': case 'refresh': break;
    default: throw nativeValidationError(`未知 Claude action: ${action['type']}`);
  }
  const fields: Record<string, string[]> = {
    thinking: ['thinking'], output: ['schema'], checkpoints: ['enabled'], tag: ['tag', 'revision'], fork: ['messageId', 'title'],
    background: ['toolUseId'], 'stop-task': ['taskId', 'runId'], elicitation: ['requestId', 'action', 'content'], dialog: ['requestId', 'behavior', 'result'],
  };
  const allowed = ['type', ...(fields[action['type']] ?? [...(strings[action['type']] ?? []), ...(bool === undefined ? [] : [bool])])];
  if (Object.keys(action).some(key => !allowed.includes(key))) throw nativeValidationError('未知 Claude action 参数');
  return action as unknown as ClaudeNativeAction;
}

function validator(schema: Record<string, unknown>) {
  const dialect = String(schema['$schema'] ?? '');
  const options = { strict: false, allErrors: true, validateFormats: true, allowUnionTypes: true };
  const ajv = dialect.includes('2020-12') ? new Ajv2020(options) : dialect.includes('2019-09') ? new Ajv2019(options) : new Ajv(options);
  ajv.addFormat('password', true);
  ajv.addFormat('email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  ajv.addFormat('uri', value => { try { new URL(value); return true; } catch { return false; } });
  ajv.addFormat('date', value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)));
  ajv.addFormat('date-time', value => /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)));
  // No remote schema fetching: unresolved external refs fail instead of issuing arbitrary network requests.
  const validate = ajv.compile(schema);
  return { validate, ajv };
}
export function validateJsonSchema(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw nativeValidationError('需要 JSON schema 对象');
  if (JSON.stringify(value).length > 128 * 1024) throw nativeValidationError('JSON schema 超过 128 KiB');
  try { validator(value as Record<string, unknown>); } catch (error) { throw nativeValidationError(`JSON schema 无效: ${String(error)}`); }
}
export function elicitationResult(schema: Record<string, unknown> | undefined, action: 'accept' | 'decline' | 'cancel', content?: unknown): ElicitationResult {
  if (action !== 'accept') return { action };
  if (schema === undefined) return { action };
  validateJsonSchema(schema);
  const { validate, ajv } = validator(schema);
  if (!validate(content)) throw nativeValidationError(`表单不符合原生 schema: ${ajv.errorsText(validate.errors)}`);
  return { action, content: content as ElicitationResult['content'] };
}

export interface ClaudeHistoryPage<T> { entries: T[]; nextOffset: number; hasMore: boolean; source: 'claude-sdk'; revision?: string; searchScope?: 'page' }
export function historyRevision(info: SDKSessionInfo): string {
  return createHash('sha256').update(JSON.stringify([info.sessionId, info.lastModified, info.fileSize, info.customTitle, info.tag])).digest('hex');
}
const sdkUrl = pathToFileURL(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')).href;
// The filesystem SDK functions have no profile option. Keep profile environment confined to a fixed worker,
// rather than changing the server's process.env across concurrent hosts. No shell or caller-supplied code.
const HISTORY_WORKER = `import { readFileSync } from 'node:fs';
const sdk = await import(process.argv[1]);
const request = JSON.parse(readFileSync(0, 'utf8'));
const methods = {list: sdk.listSessions, info: sdk.getSessionInfo, messages: sdk.getSessionMessages,
subagents: sdk.listSubagents, submessages: sdk.getSubagentMessages, rename: sdk.renameSession,
tag: sdk.tagSession, fork: sdk.forkSession, delete: sdk.deleteSession};
try { const result = await methods[request.method](...request.args); process.stdout.write(JSON.stringify({result: result ?? null})); }
catch (error) { process.stdout.write(JSON.stringify({error: error instanceof Error ? error.message : String(error)})); process.exitCode = 1; }`;

export class ClaudeNativeHistory {
  constructor(private readonly env?: Record<string, string>) {}
  private call<T>(method: string, args: unknown[]): Promise<T> {
    return new Promise((resolve, reject) => {
      const child = execFile(process.execPath, ['--input-type=module', '-e', HISTORY_WORKER, sdkUrl],
        { env: { ...process.env, ...this.env }, timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
          try {
            const reply = JSON.parse(stdout) as { result?: T; error?: string };
            if (reply.error !== undefined) reject(nativeError(reply.error, 502));
            else if (error !== null) reject(nativeError('Claude 原生历史读取失败', 502));
            else resolve(reply.result as T);
          } catch { reject(nativeError('Claude 原生历史响应无效或超时', 502)); }
        });
      child.stdin?.end(JSON.stringify({ method, args }));
      child.stdin?.on('error', () => reject(nativeError('Claude 原生历史 worker 输入中断', 502)));
    });
  }
  async list(cwd: string, offset = 0, limit = 50, query?: string): Promise<ClaudeHistoryPage<SDKSessionInfo & { revision: string }>> {
    pageBounds(offset, limit);
    const entries = await this.call<SDKSessionInfo[]>('list', [{ dir: cwd, offset, limit: limit + 1, includeWorktrees: true, includeProgrammatic: true }]);
    // Search is explicitly limited to this native page; callers can continue using nextOffset.
    const page = entries.slice(0, limit);
    return { entries: page.filter(info => query === undefined || `${info.summary}\n${info.customTitle ?? ''}\n${info.firstPrompt ?? ''}\n${info.tag ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(info => ({ ...info, revision: historyRevision(info) })), nextOffset: offset + page.length, hasMore: entries.length > limit, source: 'claude-sdk', ...(query === undefined ? {} : { searchScope: 'page' }) };
  }
  async info(cwd: string, nativeId: string): Promise<SDKSessionInfo & { revision: string }> {
    const info = await this.call<SDKSessionInfo | null>('info', [nativeId, { dir: cwd }]);
    if (info === null) throw nativeError('Claude 原生会话不存在或不可读', 404);
    return { ...info, revision: historyRevision(info) };
  }
  async messages(cwd: string, nativeId: string, offset = 0, limit = 100, agentId?: string): Promise<ClaudeHistoryPage<SessionMessage>> {
    pageBounds(offset, limit);
    const info = await this.info(cwd, nativeId);
    const args = agentId === undefined ? [nativeId, { dir: cwd, offset, limit: limit + 1, includeSystemMessages: true }] : [nativeId, agentId, { dir: cwd, offset, limit: limit + 1 }];
    const entries = await this.call<SessionMessage[]>(agentId === undefined ? 'messages' : 'submessages', args);
    const after = await this.info(cwd, nativeId);
    if (after.revision !== info.revision) throw nativeError('读取期间原生历史已改变，请重新加载分页', 409);
    return { entries: entries.slice(0, limit), nextOffset: offset + Math.min(limit, entries.length), hasMore: entries.length > limit, revision: info.revision, source: 'claude-sdk' };
  }
  subagents(cwd: string, nativeId: string): Promise<string[]> { return this.call('subagents', [nativeId, { dir: cwd }]); }
  async mutate(cwd: string, nativeId: string, action: Extract<ClaudeNativeAction, { type: 'rename' | 'tag' | 'delete' | 'fork' }>): Promise<unknown> {
    const info = await this.info(cwd, nativeId);
    if ('revision' in action && action.revision !== info.revision) throw nativeValidationError('原生会话已改变，请刷新后重试', 409);
    // SDK JSONL mutations are append operations, not compare-and-swap. The revision check detects
    // pre-existing external changes; an external writer racing the append is not fenced by this API.
    switch (action.type) {
      case 'fork': return this.call('fork', [nativeId, { dir: cwd, upToMessageId: action.messageId, title: action.title }]);
      case 'rename': await this.call('rename', [nativeId, action.title, { dir: cwd }]); break;
      case 'tag': await this.call('tag', [nativeId, action.tag, { dir: cwd }]); break;
      case 'delete': if (action.confirmNativeId !== nativeId) throw nativeValidationError('删除确认目标不一致'); await this.call('delete', [nativeId, { dir: cwd }]); return { deleted: true, nativeId };
    }
    return this.info(cwd, nativeId);
  }
}
export function pageBounds(offset: number, limit: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw nativeError('Claude 分页参数无效');
}
