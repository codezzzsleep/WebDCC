/** REST 客户端（同源，Cookie 认证） */
import type {
  BrowseResponse,
  ProviderDto,
  Command,
  DraftDto,
  EventsPageResponse,
  FsListResponse,
  FsReadResponse,
  MetaResponse,
  SessionDetailResponse,
  InteractionKind,
  InteractionEventResponse,
  WorkspaceDto,
  WorkspaceFileSaveRequest,
  WatchdogSettings,
  WatchdogView,
  CapabilitySnapshot,
  QueuedInput,
  DshSettingsView,
  DshProviderUpdate,
  DshDefaultModelUpdate,
  DshSettingsPreview,
  NativeEnvelopeSummary,
  NativeEnvelopeDetail,
  NativeOwnerDto,
  StoredEvent,
  ReconciliationView,
  NativeControlSnapshot,
  NativeActionRequest,
  NativeActionResponse,
  NativeActionReceipt,
  InputContent,
  ModelOption,
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
  nativeDshSurface: () => request<{ status: string; writable: boolean }>('/api/dsh/native-surface'),
  openNativeDshSurface: (sessionId: string) => request<{ actionUrl: string; ticket: string; expiresAt: string }>('/api/dsh/native-surface/open', { method: 'POST', body: JSON.stringify({ sessionId }) }),
  nativeControls: (sessionId: string, catalog = false) => request<NativeControlSnapshot>(`/api/sessions/${encodeURIComponent(sessionId)}/native${catalog ? '?catalog=1' : ''}`),
  connectNativeControls: (sessionId: string, commandId: string) => request<NativeActionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/native/connect`, { method: 'POST', body: JSON.stringify({ commandId, action: { type: 'connect' } }) }),
  nativeAction: (sessionId: string, value: NativeActionRequest) => request<NativeActionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/native/actions`, { method: 'POST', body: JSON.stringify(value) }),
  nativeActionReceipt: (sessionId: string, commandId: string) => request<NativeActionReceipt>(`/api/sessions/${encodeURIComponent(sessionId)}/native/actions/${encodeURIComponent(commandId)}`),
  nativeHistory: (sessionId: string) => request<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/native/history?limit=50`),
  nativeEvents: (sessionId?: string, after = 0) => request<{ records: NativeEnvelopeSummary[]; next: number; projectionVersion: number }>(`/api/native-events?after=${after}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`),
  nativeEvent: (id: number) => request<NativeEnvelopeDetail>(`/api/native-events/${id}`),
  eventEvidence: (sessionId: string, seq: number) => request<{ event: StoredEvent; envelope: NativeEnvelopeDetail | null }>(`/api/sessions/${encodeURIComponent(sessionId)}/events/${seq}/evidence`),
  runtime: (sessionId: string) => request<{ owner: NativeOwnerDto | null }>(`/api/sessions/${encodeURIComponent(sessionId)}/runtime`),
  reconciliation: (sessionId: string) => request<{ reconciliation: ReconciliationView | null }>(`/api/sessions/${encodeURIComponent(sessionId)}/reconciliation`),
  reconcile: (sessionId: string) => request<ReconciliationView>(`/api/sessions/${encodeURIComponent(sessionId)}/reconciliation`, { method: 'POST', body: '{}' }),
  applyReconciliation: (sessionId: string, revision: string) => request<ReconciliationView>(`/api/sessions/${encodeURIComponent(sessionId)}/reconciliation/apply`, { method: 'POST', body: JSON.stringify({ revision }) }),
  queue: (sessionId: string) => request<{ inputs: QueuedInput[]; revision: number }>(`/api/sessions/${encodeURIComponent(sessionId)}/queue`),
  cancelQueued: (sessionId: string, commandId: string) => request<void>(`/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(commandId)}`, { method: 'DELETE' }),
  capabilities: (workspaceId?: string) => request<CapabilitySnapshot>(`/api/capabilities${workspaceId === undefined ? '' : `?workspaceId=${encodeURIComponent(workspaceId)}`}`),
  watchdog: () => request<WatchdogView>('/api/watchdog'),
  updateWatchdog: (settings: Partial<WatchdogSettings>) => request<WatchdogView>('/api/watchdog', { method: 'PATCH', body: JSON.stringify(settings) }),
  cancelWatchdog: (id: string) => request<WatchdogView>(`/api/watchdog/sessions/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }),
  meta: () => request<MetaResponse>('/api/meta'),
  systemMetrics: () => request<SystemMetrics>('/api/system/metrics'),
  workspaces: () => request<WorkspaceDto[]>('/api/workspaces'),
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
  feed: (after: number) => request<{ entries: { feedSeq: number; sessionId: string; patch: Record<string, unknown> }[] }>(`/api/feed?after=${after}`),
  session: (id: string) => request<SessionDetailResponse>(`/api/sessions/${id}`),
  interaction: (sessionId: string, kind: InteractionKind, id: string) => request<InteractionEventResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/interactions/${kind}?${new URLSearchParams({ interactionId: id })}`),
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
    request<{ commands: { name: string; description?: string }[] }>(`/api/sessions/${sessionId}/slash-commands`),
  sendSubagent: (sessionId: string, childSessionId: string, text: string) =>
    request<{ accepted: true }>(`/api/sessions/${sessionId}/subagents/${encodeURIComponent(childSessionId)}/prompt`, { method: 'POST', body: JSON.stringify({ text }) }),
  interruptSubagent: (sessionId: string, childSessionId: string) =>
    request<{ accepted: true }>(`/api/sessions/${sessionId}/subagents/${encodeURIComponent(childSessionId)}/interrupt`, { method: 'POST' }),
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
  providerScan: () => request<{ imported: number; skipped: number }>('/api/providers/scan', { method: 'POST', body: '{}' }),
  providerRestore: () => request<{ imported: number; skipped: number }>('/api/providers/restore-ignored', { method: 'POST', body: '{}' }),
  deleteProvider: (id: string) => fetch(`/api/providers/${id}`, { method: 'DELETE', credentials: 'same-origin' }),
  dshStatus: () => request<{ mode: string; url: string | null; connected: boolean; version?: string }>('/api/dsh'),
  dshConnect: (link: string) => request<{ ok: boolean; url: string }>('/api/dsh/connect', { method: 'POST', body: JSON.stringify({ link }) }),
  dshDisconnect: () => request<{ ok: boolean }>('/api/dsh', { method: 'DELETE' }),
  dshProvider: () => request<DshSettingsView>('/api/dsh/provider'),
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
