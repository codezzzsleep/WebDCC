import type { DshSettingsView } from '@webdcc/protocol';

export const OFFICIAL_DSH_PROVIDERS = new Set(['deepseek-official', 'deepseek-account']);

const OFFICIAL_REASONING_EFFORTS = ['off', 'low', 'high', 'max'];
const OFFICIAL_DEFAULT_CONTEXT_WINDOW = 1_000_000;
const OFFICIAL_DEFAULT_MAX_TOKENS = 256_000;
const THIRD_PARTY_DEFAULT_CONTEXT_WINDOW = 1_000_000;
const THIRD_PARTY_DEFAULT_MAX_TOKENS = 128_000;

export function dshCapabilities(providerKey: string, model: string, provider: Record<string, unknown>, namespaces: Record<string, unknown>[]): Pick<DshSettingsView, 'official' | 'reasoningEfforts' | 'defaultReasoning' | 'contextWindow' | 'maxTokens'> {
  const official = OFFICIAL_DSH_PROVIDERS.has(providerKey);
  const officialNamespace = namespaces.find((item) => item['ns'] === (providerKey === 'deepseek-account' ? 'llm-deepseek-account' : 'llm-deepseek'));
  const officialValue = (officialNamespace?.['value'] ?? {}) as Record<string, unknown>;
  const models = Array.isArray(provider['models']) ? provider['models'] as Record<string, unknown>[] : [];
  const modelEntry = models.find((entry) => entry['id'] === model) ?? {};
  const officialModels = Array.isArray(officialValue['models']) ? officialValue['models'] as Record<string, unknown>[] : [];
  const officialModel = officialModels.find((entry) => entry['id'] === model) ?? {};
  const efforts = provider['reasoningEfforts'];
  const modelEfforts = modelEntry['reasoningEfforts'];
  const effortObject = (official ? undefined : (modelEfforts ?? efforts)) as Record<string, unknown> | undefined;
  const reasoningEfforts = official
    ? OFFICIAL_REASONING_EFFORTS
    : effortObject !== undefined && effortObject !== null && typeof effortObject === 'object' ? Object.keys(effortObject) : [];
  const defaultReasoning = official
    ? 'high'
    : typeof provider['reasoning'] === 'string' ? String(provider['reasoning']) : undefined;
  // Keep the two adapter families independent. A custom pi-ai route must not
  // inherit a value from the official DeepSeek namespace (or an old 262,144
  // token default that may still be present there).
  const contextWindow = Number(official
    ? officialModel['contextWindow'] ?? officialValue['defaultContextWindow'] ?? OFFICIAL_DEFAULT_CONTEXT_WINDOW
    : modelEntry['contextWindow'] ?? provider['defaultContextWindow'] ?? THIRD_PARTY_DEFAULT_CONTEXT_WINDOW);
  const maxTokens = Number(official
    ? officialModel['maxTokens'] ?? officialValue['maxTokens'] ?? OFFICIAL_DEFAULT_MAX_TOKENS
    : modelEntry['maxTokens'] ?? provider['defaultMaxTokens'] ?? THIRD_PARTY_DEFAULT_MAX_TOKENS);
  return {
    official,
    reasoningEfforts,
    ...(defaultReasoning === undefined ? {} : { defaultReasoning }),
    ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
    ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
  };
}

