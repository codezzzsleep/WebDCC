import { randomUuid } from './uuid.js';
/** REST 客户端（同源，Cookie 认证） */
import type {
  NativeRecoveryCapabilities,
  BrowseResponse,
  SlashCommandCatalog,
  SlashControlRequest,
  ProviderDto,
  Command,
  DraftDto,
  EventsPageResponse,
  FsListResponse,
  FsReadResponse,
  MetaResponse,
  SessionDetailResponse,
  SessionReferenceIdentity,
  SessionReferenceResponse,
  SessionUsageResponse,
  InteractionKind,
  InteractionEventResponse,
  WorkspaceDto,
  WorkspaceFileSaveRequest,
  WatchdogSettings,
  WatchdogView,
  CapabilitySnapshot,
  QueueSnapshot,
  DshSettingsView,
  DshProviderUpdate,
  DshProviderCreate,
  DshCredentialUpdate,
  DshDefaultModelUpdate,
  DshSettingsPreview,
  NativeTerminalResultsResponse,
  NativeEnvelopeSummary,
  NativeEnvelopeDetail,
  NativeOwnerDto,
  StoredEvent,
  ReconciliationView,
  NativeControlSnapshot,
  NativeActionRequest,
  NativeActionResponse,
  DshSubagentInputRequest,
  NativeActionReceipt,
  InputContent,
  InputSkillCatalog,
  ModelOption,
  CodexInputModeCatalog,
  DshSubagentCatalog,
  DshSubagentHistory,
  DshSubagentHistoryOptions,
  ClaudeConfigurationRecovery,
  DshApprovalRecoveryView,
  DshQuestionRecoveryView,
} from '@webdcc/protocol';

export interface SystemMetrics {
  at: string;
  cpu: { usagePercent: number; load1: number; processPercent: number };
  memory: { totalBytes: number; usedBytes: number; availableBytes: number; usedPercent: number; processRssBytes: number };
  network: { rxBytes: number; txBytes: number; rxBytesPerSec: number; txBytesPerSec: number };
  disk: { totalBytes: number; usedBytes: number; availableBytes: number; usedPercent: number };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init?.headers ?? {}) },
  });
  if (response.status === 401) throw Object.assign(new Error('unauthorized'), { status: 401 });
  if (!response.ok) {
    const text = await response.text();
    let message = text.slice(0, 200);
    try { message = String((JSON.parse(text) as { error?: string }).error ?? message); } catch { /* retain non-JSON diagnostic */ }
    throw Object.assign(new Error(`${response.status} ${message}`), { status: response.status });
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  sessionReferenceIdentity: (id: string) => request<SessionReferenceIdentity>(`/api/sessions/${encodeURIComponent(id)}/reference`),
  prepareSessionReference: (id: string) => request<SessionReferenceResponse>(`/api/sessions/${encodeURIComponent(id)}/reference`, { method: 'POST', body: '{}' }),
  sessionUsage: (id: string, signal: AbortSignal) => request<SessionUsageResponse>(`/api/sessions/${encodeURIComponent(id)}/usage`, { signal }),
  nativeTerminalResults: (sessionId: string, signal?: AbortSignal): Promise<NativeTerminalResultsResponse> => request(`/api/sessions/${encodeURIComponent(sessionId)}/native-terminal-results`, { signal }),
  inputModes: (sessionId?: string): Promise<CodexInputModeCatalog> => request(`/api/agents/codex/input-modes${sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(sessionId)}`}`),
  nativeDshSurface: () => request<{ status: string; writable: boolean }>('/api/dsh/native-surface'),
  openNativeDshSurface: (sessionId: string) => request<{ actionUrl: string; ticket: string; expiresAt: string }>('/api/dsh/native-surface/open', { method: 'POST', body: JSON.stringify({ sessionId }) }),
  downloadDshSessionLog: async (sessionId: string, commandId: string): Promise<{ blob: Blob; filename: string }> => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/dsh-export?commandId=${encodeURIComponent(commandId)}`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`会话下载失败：${response.status} ${(await response.text()).slice(0, 200)}`);
    if (response.headers.get('content-type')?.split(';')[0] !== 'application/zip') throw new Error('原生导出没有返回 ZIP 文件');
    const filename = /filename="([^"]+)"/u.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'dsh-session.zip';
    return { blob: await response.blob(), filename };
  },
  nativeControls: (sessionId: string, catalog = false) => request<NativeControlSnapshot>(`/api/sessions/${encodeURIComponent(sessionId)}/native${catalog ? '?catalog=1' : ''}`),
  inputSkills: (agent: string, workspaceId: string, sessionId?: string) => {
    const query = new URLSearchParams({ workspaceId, ...(sessionId === undefined ? {} : { sessionId }) });
    return request<InputSkillCatalog>(`/api/agents/${encodeURIComponent(agent)}/input-skills?${query}`);
  },
  claudeConfiguration: (sessionId: string) => request<ClaudeConfigurationRecovery>(`/api/sessions/${encodeURIComponent(sessionId)}/native/claude-configuration`),
  connectNativeControls: (sessionId: string, commandId: string) => request<NativeActionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/native/connect`, { method: 'POST', body: JSON.stringify({ commandId, action: { type: 'connect' } }) }),
  nativeAction: (sessionId: string, value: NativeActionRequest) => request<NativeActionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/native/actions`, { method: 'POST', body: JSON.stringify(value) }),
  nativeActionReceipt: (sessionId: string, commandId: string) => request<NativeActionReceipt>(`/api/sessions/${encodeURIComponent(sessionId)}/native/actions/${encodeURIComponent(commandId)}`),
  nativeHistory: (sessionId: string, options: { cursor?: string; offset?: number } = {}) => {
    const query = new URLSearchParams({ limit: '50', ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(options.offset === undefined ? {} : { offset: String(options.offset) }) });
    return request<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/native/history?${query}`);
  },
  nativeEvents: (sessionId?: string, after = 0) => request<{ records: NativeEnvelopeSummary[]; next: number; projectionVersion: number }>(`/api/native-events?after=${after}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`),
  nativeEvent: (id: number) => request<NativeEnvelopeDetail>(`/api/native-events/${id}`),
  eventEvidence: (sessionId: string, seq: number) => request<{ event: StoredEvent; envelope: NativeEnvelopeDetail | null }>(`/api/sessions/${encodeURIComponent(sessionId)}/events/${seq}/evidence`),
  runtime: (sessionId: string) => request<{ owner: NativeOwnerDto | null }>(`/api/sessions/${encodeURIComponent(sessionId)}/runtime`),
  reconciliation: (sessionId: string) => request<{ reconciliation: ReconciliationView | null; capabilities?: NativeRecoveryCapabilities }>(`/api/sessions/${encodeURIComponent(sessionId)}/reconciliation`),
  reconcile: (sessionId: string) => request<ReconciliationView>(`/api/sessions/${encodeURIComponent(sessionId)}/reconciliation`, { method: 'POST', body: '{}' }),
  applyReconciliation: (sessionId: string, revision: string) => request<ReconciliationView>(`/api/sessions/${encodeURIComponent(sessionId)}/reconciliation/apply`, { method: 'POST', body: JSON.stringify({ revision }) }),
  queue: (sessionId: string) => request<QueueSnapshot>(`/api/sessions/${encodeURIComponent(sessionId)}/queue`),
  reorderQueue: (sessionId: string, commandIds: string[], expectedRevision: string) => request<QueueSnapshot>(`/api/sessions/${encodeURIComponent(sessionId)}/queue`,
    { method: 'PATCH', body: JSON.stringify({ commandIds, expectedRevision }) }),
  cancelQueued: (sessionId: string, commandId: string) => request<void>(`/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(commandId)}`, { method: 'DELETE' }),
  capabilities: (workspaceId?: string) => request<CapabilitySnapshot>(`/api/capabilities${workspaceId === undefined ? '' : `?workspaceId=${encodeURIComponent(workspaceId)}`}`),
  watchdog: () => request<WatchdogView>('/api/watchdog'),
  updateWatchdog: (settings: Partial<WatchdogSettings>) => request<WatchdogView>('/api/watchdog', { method: 'PATCH', body: JSON.stringify(settings) }),
  cancelWatchdog: (id: string) => request<WatchdogView>(`/api/watchdog/sessions/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }),
  meta: () => request<MetaResponse>('/api/meta'),
  systemMetrics: () => request<SystemMetrics>('/api/system/metrics'),
  workspaces: () => request<WorkspaceDto[]>('/api/workspaces'),
  archiveWorkspace: (id: string, archived: boolean) => request<WorkspaceDto>(`/api/workspaces/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify({ archived }) }),
  removeWorkspace: (id: string) => request<void>(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  createWorkspace: (input: { name: string; path: string }) =>
    request<WorkspaceDto>('/api/workspaces', { method: 'POST', body: JSON.stringify(input) }),
  browse: (path?: string) =>
    request<BrowseResponse>(`/api/fs/browse${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`),
  createDirectory: (parent: string, name: string) => request<{ path: string }>('/api/fs/mkdir', { method: 'POST', body: JSON.stringify({ parent, name }) }),
  fs: (workspaceId: string, path: string) =>
    request<FsListResponse | FsReadResponse>(`/api/workspaces/${workspaceId}/fs?path=${encodeURIComponent(path)}`),
  createWorkspaceEntry: (workspaceId: string, input: { path: string; kind: 'file' | 'dir'; content?: string }) =>
    request<{ path: string; kind: 'file' | 'dir' }>(`/api/workspaces/${workspaceId}/fs`, { method: 'POST', body: JSON.stringify(input) }),
  saveWorkspaceFile: (workspaceId: string, input: WorkspaceFileSaveRequest) =>
    request<FsReadResponse>(`/api/workspaces/${workspaceId}/fs`, { method: 'PUT', body: JSON.stringify(input) }),
  rawUrl: (workspaceId: string, path: string) =>
    `/api/workspaces/${workspaceId}/raw?path=${encodeURIComponent(path)}`,
  copyAttachmentToWorkspace: (workspaceId: string, fileId: string) => request<{ path: string; fileId: string }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/attach`, { method: 'POST', body: JSON.stringify({ fileId }) }),
  previewWorkspaceFile: (workspaceId: string, path: string, content?: string, external = false) => request<{ url: string; expiresAt: number }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/preview`, { method: 'POST', body: JSON.stringify({ path, external, ...(content === undefined ? {} : { content }) }) }),
  feed: (after: number) => request<{ entries: { feedSeq: number; sessionId: string; patch: Record<string, unknown> }[] }>(`/api/feed?after=${after}`),
  session: (id: string) => request<SessionDetailResponse>(`/api/sessions/${id}`),
  interaction: (sessionId: string, kind: InteractionKind, id: string) => request<InteractionEventResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/interactions/${kind}?${new URLSearchParams({ interactionId: id })}`),
  dshApprovalRecovery: (sessionId: string, approvalId: string) => request<DshApprovalRecoveryView>(`/api/sessions/${encodeURIComponent(sessionId)}/dsh/approval-recovery?${new URLSearchParams({ approvalId })}`),
  dshQuestionRecovery: (sessionId: string, questionId: string) => request<DshQuestionRecoveryView>(`/api/sessions/${encodeURIComponent(sessionId)}/dsh/question-recovery?${new URLSearchParams({ questionId })}`),
  events: (id: string, params: { before?: number; after?: number; limit?: number }) => {
    const search = new URLSearchParams();
    if (params.before !== undefined) search.set('before', String(params.before));
    if (params.after !== undefined) search.set('after', String(params.after));
    search.set('limit', String(params.limit ?? 200));
    return request<EventsPageResponse>(`/api/sessions/${id}/events?${search.toString()}`);
  },
  exportUrl: (id: string) => `/api/sessions/${id}/export`,
  draft: (id: string) => request<DraftDto>(`/api/sessions/${id}/draft`),
  saveDraft: (id: string, text: string, fileIds: string[]) =>
    request<DraftDto>(`/api/sessions/${id}/draft`, { method: 'PUT', body: JSON.stringify({ text, fileIds }) }),
  saveInputDraft: (id: string, text: string, contentParts: InputContent, expectedRevision: number) =>
    request<DraftDto>(`/api/sessions/${id}/draft`, { method: 'PUT', body: JSON.stringify({ text, contentParts, expectedRevision,
      fileIds: contentParts.parts.flatMap(part => part.type === 'image' || part.type === 'file' || part.type === 'audio' ? [part.fileId] : []) }) }),
  grantAttachment: (id: string, fileId: string) => request<void>(`/api/sessions/${id}/attachments`, { method: 'POST', body: JSON.stringify({ fileId }) }),
  retryQueuedInput: (id: string, commandId: string) => request<void>(`/api/sessions/${id}/queue/${encodeURIComponent(commandId)}/retry`, { method: 'POST' }),
  providers: () => request<ProviderDto[]>('/api/providers'),
  slashCommands: (sessionId: string) =>
    request<SlashCommandCatalog>(`/api/sessions/${sessionId}/slash-commands`),
  previewSlashCommands: (agent: string, workspaceId?: string) => request<SlashCommandCatalog>(`/api/agents/${encodeURIComponent(agent)}/slash-commands${workspaceId === undefined ? '' : `?workspaceId=${encodeURIComponent(workspaceId)}`}`),
  slashControl: (sessionId: string, input: SlashControlRequest) => request<NativeActionResponse>(`/api/sessions/${sessionId}/slash-commands`, { method: 'POST', body: JSON.stringify(input) }),
  slashControlResult: (sessionId: string, commandId: string) => request<NativeActionResponse>(`/api/sessions/${sessionId}/slash-commands/${encodeURIComponent(commandId)}`),
  sendSubagent: (sessionId: string, childSessionId: string, text: string, options: Omit<DshSubagentInputRequest, 'text'> = { commandId: randomUuid(), delivery: 'queue', clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }) =>
    request<NativeActionResponse | { accepted: true }>(`/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(childSessionId)}/prompt`, { method: 'POST', body: JSON.stringify({ ...options, text }) }),
  subagentInputReceipt: (sessionId: string, childSessionId: string, commandId: string) =>
    request<NativeActionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(childSessionId)}/prompts/${encodeURIComponent(commandId)}`),
  interruptSubagent: (sessionId: string, childSessionId: string, commandId = randomUuid()) =>
    request<NativeActionResponse | { accepted: true }>(`/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(childSessionId)}/interrupt`, { method: 'POST', body: JSON.stringify({ commandId }) }),
  subagents: (sessionId: string) => request<DshSubagentCatalog>(`/api/sessions/${encodeURIComponent(sessionId)}/subagents`),
  subagentHistory: (sessionId: string, childSessionId: string, options: DshSubagentHistoryOptions) => {
    const query = new URLSearchParams({ limit: String(options.limit),
      ...(options.throughSeq === undefined ? {} : { throughSeq: String(options.throughSeq) }),
      ...(options.beforeSeq === undefined ? {} : { beforeSeq: String(options.beforeSeq) }),
      ...(options.includeActive === undefined ? {} : { includeActive: String(options.includeActive) }) });
    return request<DshSubagentHistory>(`/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(childSessionId)}/history?${query}`);
  },
  models: async (agent: string, providerId: string | null): Promise<string[]> => {
    const query = `agent=${encodeURIComponent(agent)}${providerId === null ? '' : `&providerId=${encodeURIComponent(providerId)}`}`;
    const result = await request<{ models: string[] }>(`/api/models?${query}`);
    return result.models;
  },
  modelOptions: async (agent: string, providerId: string | null): Promise<ModelOption[]> => {
    const query = `agent=${encodeURIComponent(agent)}${providerId === null ? '' : `&providerId=${encodeURIComponent(providerId)}`}`;
    const result = await request<{ options?: ModelOption[] }>(`/api/models?${query}`);
    return result.options ?? [];
  },
  createProvider: (input: {
    name: string;
    baseUrl: string;
    protocols: string[];
    models: string[];
    modelDetails?: ProviderDto['modelDetails'];
    apiKey?: string;
    codexCatalogPath?: string;
  }) => request<ProviderDto>('/api/providers', { method: 'POST', body: JSON.stringify(input) }),
  updateProvider: (id: string, patch: Record<string, unknown>) =>
    request<ProviderDto>(`/api/providers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  providerLocalChange: (id: string, action: 'update' | 'ignore') => request<ProviderDto>(`/api/providers/${id}/local-change`, { method: 'POST', body: JSON.stringify({ action }) }),
  providerScan: () => request<{ imported: number; skipped: number }>('/api/providers/scan', { method: 'POST', body: '{}' }),
  providerRestore: () => request<{ imported: number; skipped: number }>('/api/providers/restore-ignored', { method: 'POST', body: '{}' }),
  deleteProvider: (id: string) => request<void>(`/api/providers/${id}`, { method: 'DELETE' }),
  dshStatus: () => request<{ mode: string; url: string | null; connected: boolean; version?: string }>('/api/dsh'),
  dshConnect: (link: string) => request<{ ok: boolean; url: string }>('/api/dsh/connect', { method: 'POST', body: JSON.stringify({ link }) }),
  dshDisconnect: () => request<{ ok: boolean }>('/api/dsh', { method: 'DELETE' }),
  dshProvider: (providerKey?: string) => request<DshSettingsView>(`/api/dsh/provider${providerKey === undefined ? '' : `?${new URLSearchParams({ providerKey })}`}`),
  previewCreateDshProvider: (input: DshProviderCreate) => request<DshSettingsPreview>('/api/dsh/provider/create-preview', { method: 'POST', body: JSON.stringify(input) }),
  createDshProvider: (input: DshProviderCreate) => request<DshSettingsView>('/api/dsh/provider', { method: 'POST', body: JSON.stringify(input) }),
  updateDshCredential: (input: DshCredentialUpdate) => request<{ apiKeyEnv: string; configured: boolean }>('/api/dsh/provider/credential', { method: 'PATCH', body: JSON.stringify(input) }),
  previewDshProvider: (input: DshProviderUpdate) => request<DshSettingsPreview>('/api/dsh/provider/preview', { method: 'POST', body: JSON.stringify(input) }),
  updateDshProvider: (input: DshProviderUpdate) => request<DshSettingsView>('/api/dsh/provider', { method: 'PATCH', body: JSON.stringify(input) }),
  previewDshDefault: (input: DshDefaultModelUpdate) => request<DshSettingsPreview>('/api/dsh/default-model/preview', { method: 'POST', body: JSON.stringify(input) }),
  updateDshDefault: (input: DshDefaultModelUpdate) => request<DshSettingsView>('/api/dsh/default-model', { method: 'PATCH', body: JSON.stringify(input) }),
  command: (command: Command) =>
    request<{ ok: boolean; value?: unknown; error?: string; code?: string }>('/api/commands', {
      method: 'POST',
      body: JSON.stringify({ command }),
    }),
};
