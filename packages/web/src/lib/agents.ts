/** 三个 Harness 的展示信息，以及"Provider + 模型"选择的共用逻辑 */
import type { AgentMeta, MetaResponse, ProviderDto } from '@webdcc/protocol';

export const AGENT_IDS = ['dsh', 'codex', 'claude-code'] as const;
export type AgentKey = (typeof AGENT_IDS)[number];

export const AGENT_TEXT: Record<AgentKey, { name: string; mark: string; strength: string; nativeLabel: string }> = {
  dsh: {
    name: 'DeepSeek Harness',
    mark: 'DS',
    strength: '用 DSH 里你已经配好的模型、技能和子 Agent。',
    nativeLabel: 'DSH Provider',
  },
  codex: {
    name: 'Codex',
    mark: 'CX',
    strength: '从 Provider 中选择模型；每个 Provider 可维护多个模型。',
    nativeLabel: 'Codex Provider',
  },
  'claude-code': {
    name: 'Claude Code',
    mark: 'CC',
    strength: '从 Provider 中选择模型；每个 Provider 可维护多个模型。',
    nativeLabel: 'Claude Provider',
  },
};

export function agentText(agent: string): { name: string; mark: string; strength: string; nativeLabel: string } {
  return AGENT_TEXT[agent as AgentKey] ?? { name: agent, mark: '??', strength: '', nativeLabel: '原生配置' };
}

const SOURCE_LABEL: Record<string, string> = {
  manual: '手动添加',
  'codex-config': '导入自 Codex 配置',
  'claude-settings': '导入自 Claude 设置',
  dsh: '导入自 DSH',
  paste: '粘贴导入',
};

export function sourceLabel(source: string | undefined): string {
  return SOURCE_LABEL[source ?? 'manual'] ?? source ?? '手动添加';
}

/** 该 Agent 需要的协议（10.2）。三个 Agent 都通过 Provider + model 工作。 */
export function isCompatible(agent: string, provider: ProviderDto): boolean {
  if (agent === 'codex') return provider.protocols.includes('openai-responses');
  if (agent === 'claude-code') return provider.protocols.includes('anthropic-messages');
  return false;
}

export function incompatibleReason(agent: string): string {
  if (agent === 'dsh') return 'DSH 当前没有可用 Provider';
  if (agent === 'codex') return '没有 OpenAI Responses 地址，Codex 用不了';
  return '没有 Anthropic 兼容地址，Claude Code 用不了';
}

export interface ModelGroup {
  key: string;
  providerId: string | null;
  title: string;
  note?: string;
  models: string[];
  disabled: boolean;
  reason?: string;
}

export interface ModelChoice {
  providerId: string | null;
  model: string;
  reasoningEffort?: string;
}

const REASONING_DEFAULT_PREFIX = 'wdcc:reasoning-default:';
const ACCESS_MODE_DEFAULT_PREFIX = 'wdcc:access-mode-default:';

function readPreference(prefix: string, agent: string): string | undefined {
  try {
    const value = window.localStorage.getItem(prefix + agent);
    return value === null || value.trim() === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

function writePreference(prefix: string, agent: string, value: string): void {
  try {
    window.localStorage.setItem(prefix + agent, value);
  } catch {
    // Browser storage may be unavailable; the current session still works.
  }
}

/** Last user-selected reasoning level used as the next-session default. */
export function rememberedReasoning(agent: string): string | undefined {
  return readPreference(REASONING_DEFAULT_PREFIX, agent);
}

export function rememberReasoning(agent: string, effort: string): void {
  writePreference(REASONING_DEFAULT_PREFIX, agent, effort);
}

/** Last user-selected access mode used as the next-session default. */
export function rememberedAccessMode(agent: string): string | undefined {
  return readPreference(ACCESS_MODE_DEFAULT_PREFIX, agent);
}

export function rememberAccessMode(agent: string, mode: string): void {
  writePreference(ACCESS_MODE_DEFAULT_PREFIX, agent, mode);
}

export function modelGroups(agent: string, meta: AgentMeta | undefined, providers: ProviderDto[]): ModelGroup[] {
  const groups: ModelGroup[] = [];
  if (agent === 'dsh') {
    groups.push({ key: 'dsh-provider', providerId: null, title: 'DSH Provider', models: (meta?.models ?? []).map((model) => model.id), disabled: false, note: '模型由 DSH Provider 提供' });
  }
  for (const provider of providers) {
    const compatible = isCompatible(agent, provider);
    if (!compatible) continue;
    const notes: string[] = [sourceLabel(provider.source)];
    if (provider.note !== undefined) notes.push(provider.note);
    if (agent === 'codex' && compatible && provider.codexCatalogPath === undefined && !provider.models.some((model) => model.startsWith('gpt-'))) {
      notes.push('需要模型目录，否则工具可能不可用');
    }
    groups.push({
      key: provider.id,
      providerId: provider.id,
      title: provider.name,
      note: notes.join(' · '),
      models: provider.models,
      disabled: false,
    });
  }
  return groups;
}

/** 默认选择第一个可用 Provider；Provider 是 Agent 选择模型的唯一来源。 */
export function defaultChoice(agent: string, meta: AgentMeta | undefined, providers: ProviderDto[]): ModelChoice {
  const sameSource = agent === 'codex' ? 'codex-config' : agent === 'claude-code' ? 'claude-settings' : '';
  const compatible = providers.filter((provider) => isCompatible(agent, provider));
  const preferred =
    compatible.find((provider) => provider.source === sameSource && provider.models.length > 0) ?? compatible.find((provider) => provider.models.length > 0);
  const remembered = rememberedReasoning(agent);
  const withDefaultReasoning = agent === 'codex' || agent === 'claude-code' ? { reasoningEffort: remembered ?? 'medium' } : {};
  if (preferred !== undefined) return { providerId: preferred.id, model: preferred.models[0] ?? '', ...withDefaultReasoning };
  return { providerId: null, model: agent === 'dsh' ? (meta?.models?.[0]?.id ?? '') : '', ...withDefaultReasoning };
}

export function agentStatusLine(agent: string, meta: MetaResponse | null, providers: ProviderDto[], dsh?: { connected: boolean; mode: string; url: string | null } | null): string {
  const info = meta?.agents[agent];
  if (info === undefined) return '这个 Agent 没有启用';
  if (!info.installed) return info.notes?.[0] ?? '服务器上没有安装';
  if (agent === 'dsh' && dsh !== undefined && dsh !== null) {
    if (dsh.mode === 'attach') return dsh.connected ? `已连接本机 DSH · ${hostOf(dsh.url)}` : '还没有连接 DSH';
    return dsh.connected ? 'WebDCC 自己拉起的 DSH' : 'DSH 未运行';
  }
  const choice = defaultChoice(agent, info, providers);
  const provider = providers.find((item) => item.id === choice.providerId);
  const who = provider === undefined ? agentText(agent).nativeLabel : provider.name;
  return choice.model === '' ? who : `${who} · ${choice.model}`;
}

function hostOf(url: string | null): string {
  if (url === null) return '';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function agentAvailable(agent: string, meta: MetaResponse | null): boolean {
  const info = meta?.agents[agent];
  return info !== undefined && info.installed !== false;
}
