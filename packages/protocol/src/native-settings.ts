export interface DshSettingsTarget {
  id: string;
  url: string;
  scope: 'host-profile';
  applies: 'live';
}

export interface DshSettingsView {
  writable: boolean;
  target: DshSettingsTarget;
  providerKey: string;
  provider: Record<string, unknown>;
  providers?: { id: string; name: string }[];
  defaultModel: { provider: string; model: string; reasoningEffort?: string };
  official: boolean;
  reasoningEfforts: string[];
  defaultReasoning?: string;
  contextWindow?: number;
  maxTokens?: number;
  providerRevision: number;
  defaultModelRevision: number;
}

export interface DshProviderUpdate {
  targetId: string;
  expectedRevision: number;
  providerKey: string;
  model: string;
  previousModel?: string;
  name?: string;
  baseURL?: string;
  apiKeyEnv?: string;
  reasoningEfforts?: string[] | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
}

export interface DshDefaultModelUpdate {
  targetId: string;
  expectedRevision: number;
  providerKey: string;
  model: string;
  reasoningEffort?: string;
}

export interface DshSettingsPreview {
  target: DshSettingsTarget;
  namespace: 'llm-pi-ai' | 'agent-default-model';
  expectedRevision: number;
  changes: { path: string[]; before?: unknown; after: unknown }[];
}

export interface DshProviderCreate extends DshProviderUpdate {
  api: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
  baseURL: string;
  apiKeyEnv: string;
}

export interface DshCredentialUpdate {
  targetId: string;
  expectedRevision: number;
  providerKey: string;
  apiKeyEnv: string;
  apiKey: string;
}
