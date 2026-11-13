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
  WorkspaceDto,
  WorkspaceFileSaveRequest,
  WatchdogSettings,
  WatchdogView,
  CapabilitySnapshot,
  QueuedInput,
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
  dshProvider: () => request<{
    writable: boolean;
    providerKey: string;
    provider: Record<string, unknown>;
    defaultModel: { provider: string; model: string; reasoningEffort?: string };
    official: boolean;
    reasoningEfforts: string[];
    defaultReasoning?: string;
    contextWindow?: number;
    maxTokens?: number;
    providerRevision: number;
    defaultModelRevision: number;
  }>('/api/dsh/provider'),
  updateDshProvider: (input: { providerKey: string; baseURL: string; model: string; reasoning?: string; reasoningEfforts?: string[]; contextWindow?: number; maxTokens?: number; apiKey?: string }) =>
    request('/api/dsh/provider', { method: 'PATCH', body: JSON.stringify(input) }),
  command: (command: Command) =>
    request<{ ok: boolean; value?: unknown; error?: string; code?: string }>('/api/commands', {
      method: 'POST',
      body: JSON.stringify({ command }),
    }),
};
