import { createHash } from 'node:crypto';
import { DshHostClient } from '@webdcc/adapter-dsh';
import type { DshDefaultModelUpdate, DshProviderUpdate, DshSettingsPreview, DshSettingsTarget, DshSettingsView } from '@webdcc/protocol';
import type { DshConnection, DshConnectionStore } from './dsh-connection.js';
import { dshCapabilities, OFFICIAL_DSH_PROVIDERS } from './dsh-capabilities.js';

interface Namespace {
  ns: string;
  revision: number;
  value: unknown;
  user?: unknown;
  secrets: { path: string[]; set: boolean }[];
}
interface Description { writable: boolean; namespaces: Namespace[] }
type SetOp = { op: 'set'; path: string[]; value: unknown };
interface Context { client: DshHostClient; target: DshSettingsTarget; description: Description }
interface Plan { context: Context; namespace: Namespace; ops: SetOp[]; preview: DshSettingsPreview }

const error = (message: string, statusCode = 400, code = 'invalid-settings'): Error => Object.assign(new Error(message), { statusCode, code });
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const targetOf = (connection: DshConnection): DshSettingsTarget => ({ id: createHash('sha256').update(JSON.stringify([connection.url, connection.connectedAt])).digest('hex'), url: connection.url, scope: 'host-profile', applies: 'live' });

function validate(value: unknown, fields: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw error('需要配置变更对象');
  const body = record(value);
  if (Object.keys(body).some(key => !fields.includes(key))) throw error('配置字段或作用域无效；凭据和默认模型请使用各自的操作');
  for (const field of ['providerKey', 'model', 'targetId']) if (typeof body[field] !== 'string' || body[field].trim() === '') throw error(`需要 ${field}`);
  if (!Number.isSafeInteger(body['expectedRevision']) || Number(body['expectedRevision']) < 0) throw error('需要读取时的 expectedRevision');
  for (const field of ['previousModel', 'name', 'reasoningEffort']) if (body[field] !== undefined && (typeof body[field] !== 'string' || body[field].trim() === '')) throw error(`${field} 必须是非空字符串`);
  return body;
}

/** Native settings own persistence. Each user action performs one namespace
 * mutation with the exact Host and revision that the editor reviewed. */
export class DshSettingsService {
  constructor(private readonly connections: DshConnectionStore) {}

  private assertTarget(target: DshSettingsTarget): void {
    const current = this.connections.connection;
    if (current === null || targetOf(current).id !== target.id) throw error('目标 DSH Host 已变化，请刷新配置后重试', 409, 'settings-target-changed');
  }

  private async context(targetId?: string): Promise<Context> {
    const connection = this.connections.connection;
    if (connection === null) throw error('DSH 尚未连接', 503);
    const target = targetOf(connection);
    if (targetId !== undefined && target.id !== targetId) throw error('目标 DSH Host 已变化，请刷新配置后重试', 409, 'settings-target-changed');
    const client = new DshHostClient(connection.url);
    client.useCookie(connection.cookie);
    const description = await client.rpc<Description>('settings/describe', {});
    this.assertTarget(target);
    return { client, description, target };
  }

  private namespace(ctx: Context, ns: string, expectedRevision?: number): Namespace {
    const namespace = ctx.description.namespaces.find(entry => entry.ns === ns);
    if (namespace === undefined || !Number.isSafeInteger(namespace.revision) || namespace.revision < 0) throw error(`DSH 配置 ${ns} 不可用`, 409);
    if (expectedRevision !== undefined && namespace.revision !== expectedRevision) throw error('DSH 配置已被其他客户端修改，请刷新后重试', 409, 'settings-stale');
    if (expectedRevision !== undefined && !ctx.description.writable) throw error('DSH 当前配置不可写', 409);
    return namespace;
  }

  private view(ctx: Context): DshSettingsView {
    const llm = this.namespace(ctx, 'llm-pi-ai');
    const defaults = this.namespace(ctx, 'agent-default-model');
    const value = record(defaults.value);
    const providers = record(record(llm.value)['providers']);
    const providerKey = typeof value['provider'] === 'string' ? value['provider'] : Object.keys(providers)[0] ?? '';
    const provider = record(providers[providerKey]);
    const model = typeof value['model'] === 'string' ? value['model'] : '';
    return { writable: ctx.description.writable, target: ctx.target, providerKey, provider, defaultModel: { provider: providerKey, model, ...(typeof value['reasoningEffort'] === 'string' ? { reasoningEffort: value['reasoningEffort'] } : {}) },
      ...dshCapabilities(providerKey, model, provider, ctx.description.namespaces as unknown as Record<string, unknown>[]), providerRevision: llm.revision, defaultModelRevision: defaults.revision };
  }

  async read(): Promise<DshSettingsView> { return this.view(await this.context()); }

  private async providerPlan(value: unknown): Promise<Plan> {
    // Keep the official-provider refusal independent of connection availability.
    if (OFFICIAL_DSH_PROVIDERS.has(String(record(value)['providerKey']))) throw error('官方 Provider 由 DSH 原生设置管理', 409);
    const body = validate(value, ['targetId', 'expectedRevision', 'providerKey', 'model', 'previousModel', 'name', 'baseURL', 'reasoningEfforts', 'contextWindow', 'maxTokens']) as unknown as DshProviderUpdate;
    if (body.baseURL !== undefined) {
      if (typeof body.baseURL !== 'string') throw error('Base URL 必须是字符串');
      let url: URL;
      try { url = new URL(body.baseURL); } catch { throw error('Base URL 无效'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.hash !== '') throw error('Base URL 必须是不含凭据的 HTTP(S) 地址');
    }
    for (const size of [body.contextWindow, body.maxTokens]) if (size != null && (!Number.isSafeInteger(size) || size <= 0)) throw error('模型容量必须是正整数');
    if (body.reasoningEfforts != null && (!Array.isArray(body.reasoningEfforts) || body.reasoningEfforts.some(item => typeof item !== 'string' || item.trim() === '') || new Set(body.reasoningEfforts).size !== body.reasoningEfforts.length)) throw error('思考等级必须是无重复的非空字符串列表');
    const context = await this.context(body.targetId);
    const namespace = this.namespace(context, 'llm-pi-ai', body.expectedRevision);
    const providers = record(record(namespace.value)['providers']);
    const provider = record(providers[body.providerKey]);
    if (Object.keys(provider).length === 0) throw error('DSH Provider 已不存在，请刷新目录', 409);
    const models = Array.isArray(provider['models']) ? provider['models'].map(record) : [];
    if (models.some(model => typeof model['id'] !== 'string') || new Set(models.map(model => model['id'])).size !== models.length) throw error('DSH 原生模型目录无效或存在重复 ID', 409);
    const wanted = body.previousModel ?? body.model;
    const index = models.findIndex(model => model['id'] === wanted);
    const collision = models.findIndex(model => model['id'] === body.model);
    if (body.previousModel !== undefined && index < 0) throw error('待编辑模型已不存在，请刷新目录', 409);
    if (collision >= 0 && collision !== index) throw error('目标模型 ID 已存在，不能覆盖另一个模型', 409);
    const defaults = record(this.namespace(context, 'agent-default-model').value);
    if (body.previousModel !== undefined && body.previousModel !== body.model && defaults['provider'] === body.providerKey && defaults['model'] === body.previousModel) throw error('请先选择其他默认模型，再重命名当前默认模型', 409);
    const previous = index < 0 ? {} : models[index]!;
    const next: Record<string, unknown> = { ...previous, id: body.model, ...(body.name === undefined ? index < 0 ? { name: body.model } : {} : { name: body.name }),
      ...(body.reasoningEfforts == null ? {} : { reasoningEfforts: Object.fromEntries(body.reasoningEfforts.map(effort => [effort, effort])) }),
      ...(body.contextWindow === undefined ? {} : { contextWindow: body.contextWindow }), ...(body.maxTokens === undefined ? {} : { maxTokens: body.maxTokens }) };
    for (const field of ['reasoningEfforts', 'contextWindow', 'maxTokens'] as const) if (body[field] === null) delete next[field];
    const ops: SetOp[] = [];
    const changes: DshSettingsPreview['changes'] = [];
    if (body.baseURL !== undefined && body.baseURL !== provider['baseURL']) {
      const path = ['providers', body.providerKey, 'baseURL'];
      ops.push({ op: 'set', path, value: body.baseURL }); changes.push({ path, before: provider['baseURL'], after: body.baseURL });
    }
    if (!equal(previous, next)) {
      const path = ['providers', body.providerKey, 'models'];
      // Arrays replace as a whole. Never restate a redacted model array when
      // it contains secrets; use native field edits in that case.
      if (namespace.secrets.some(secret => secret.set && path.every((part, i) => secret.path[i] === part))) throw error('模型数组含原生隐藏凭据，请在 DSH 原生字段编辑器修改', 409);
      const nextModels = index < 0 ? [...models, next] : models.map((model, i) => i === index ? next : model);
      ops.push({ op: 'set', path, value: nextModels });
      changes.push({ path: [...path, String(index < 0 ? models.length : index)], before: index < 0 ? undefined : previous, after: next });
    }
    return { context, namespace, ops, preview: { target: context.target, namespace: 'llm-pi-ai', expectedRevision: body.expectedRevision, changes } };
  }

  private async defaultPlan(value: unknown): Promise<Plan> {
    const body = validate(value, ['targetId', 'expectedRevision', 'providerKey', 'model', 'reasoningEffort']) as unknown as DshDefaultModelUpdate;
    const context = await this.context(body.targetId);
    const namespace = this.namespace(context, 'agent-default-model', body.expectedRevision);
    const provider = record(record(record(this.namespace(context, 'llm-pi-ai').value)['providers'])[body.providerKey]);
    if (OFFICIAL_DSH_PROVIDERS.has(body.providerKey) || !Array.isArray(provider['models']) || !provider['models'].some(model => record(model)['id'] === body.model)) throw error('此入口只能选择当前第三方目录中的模型', 409);
    const before = record(namespace.value);
    const patch = { provider: body.providerKey, model: body.model, ...(body.reasoningEffort === undefined ? {} : { reasoningEffort: body.reasoningEffort }) };
    const ops = Object.entries(patch).filter(([key, after]) => !equal(before[key], after)).map(([key, after]): SetOp => ({ op: 'set', path: [key], value: after }));
    return { context, namespace, ops, preview: { target: context.target, namespace: 'agent-default-model', expectedRevision: body.expectedRevision, changes: ops.map(op => ({ path: op.path, before: before[op.path[0]!], after: op.value })) } };
  }

  async previewProvider(value: unknown): Promise<DshSettingsPreview> { return (await this.providerPlan(value)).preview; }
  async previewDefault(value: unknown): Promise<DshSettingsPreview> { return (await this.defaultPlan(value)).preview; }

  private async apply(plan: Plan): Promise<DshSettingsView> {
    this.assertTarget(plan.context.target);
    if (plan.ops.length > 0) {
      try { await plan.context.client.rpc('settings/mutate', { ns: plan.namespace.ns, ops: plan.ops, expectedRevision: plan.namespace.revision }); }
      catch (nativeError) {
        const code = (nativeError as { code?: string }).code;
        if (code === 'settings/conflict' || code === 'settings/rejected') throw error(String(nativeError), 409, code);
        throw nativeError;
      }
    }
    // Re-read the same Host; a replacement connection must not supply the
    // supposed result of the prior Host's mutation.
    const context = await this.context(plan.context.target.id);
    const namespace = this.namespace(context, plan.namespace.ns);
    for (const op of plan.ops) {
      const actual = op.path.reduce<unknown>((node, part) => Array.isArray(node) ? node[Number(part)] : record(node)[part], namespace.value);
      if (!equal(actual, op.value)) throw error('原生配置未确认目标值，请刷新后核对；不会写本机配置', 409, 'settings-unconfirmed');
    }
    return this.view(context);
  }

  async updateProvider(value: unknown): Promise<DshSettingsView> { return this.apply(await this.providerPlan(value)); }
  async updateDefault(value: unknown): Promise<DshSettingsView> { return this.apply(await this.defaultPlan(value)); }
}
