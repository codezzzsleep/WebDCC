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
} from '@webdcc/protocol';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init?.headers ?? {}) },
  });
  if (response.status === 401) throw Object.assign(new Error('unauthorized'), { status: 401 });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${text.slice(0, 200)}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  meta: () => request<MetaResponse>('/api/meta'),
  workspaces: () => request<WorkspaceDto[]>('/api/workspaces'),
  createWorkspace: (input: { name: string; path: string }) =>
    request<WorkspaceDto>('/api/workspaces', { method: 'POST', body: JSON.stringify(input) }),
  browse: (path?: string) =>
    request<BrowseResponse>(`/api/fs/browse${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`),
  fs: (workspaceId: string, path: string) =>
    request<FsListResponse | FsReadResponse>(`/api/workspaces/${workspaceId}/fs?path=${encodeURIComponent(path)}`),
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
  createProvider: (input: {
    name: string;
    baseUrl: string;
    protocols: string[];
    models: string[];
    apiKey?: string;
    codexCatalogPath?: string;
  }) => request<ProviderDto>('/api/providers', { method: 'POST', body: JSON.stringify(input) }),
  providerScan: () => request<{ imported: number; skipped: number }>('/api/providers/scan', { method: 'POST', body: '{}' }),
  providerRestore: () => request<{ imported: number; skipped: number }>('/api/providers/restore-ignored', { method: 'POST', body: '{}' }),
  deleteProvider: (id: string) => fetch(`/api/providers/${id}`, { method: 'DELETE', credentials: 'same-origin' }),
  dshStatus: () => request<{ mode: string; url: string | null; connected: boolean; version?: string }>('/api/dsh'),
  dshConnect: (link: string) => request<{ ok: boolean; url: string }>('/api/dsh/connect', { method: 'POST', body: JSON.stringify({ link }) }),
  dshDisconnect: () => request<{ ok: boolean }>('/api/dsh', { method: 'DELETE' }),
  command: (command: Command) =>
    request<{ ok: boolean; value?: unknown; error?: string; code?: string }>('/api/commands', {
      method: 'POST',
      body: JSON.stringify({ command }),
    }),
};
