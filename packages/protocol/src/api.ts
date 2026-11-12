/** REST DTO（SPEC 11.1） */
import type { EventData, EventKind, StoredEvent } from './events.js';
import type { ProbeResult } from './adapter.js';

export interface AgentMeta extends ProbeResult {
  adapterKind?: 'real' | 'fake';
  accessModes?: { id: string; label: string }[];
  models?: { id: string; label: string }[];
}

export interface MetaResponse {
  version: string;
  commit: string;
  builtAt: string;
  agents: Record<string, AgentMeta>;
  /** 服务进程是否以 root 运行：root 下 Claude 不能用 bypassPermissions（MODE-claude-01） */
  runningAsRoot?: boolean;
}

export interface WorkspaceDto {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface SessionDto {
  id: string;
  workspaceId: string;
  agent: string;
  nativeId?: string;
  title?: string;
  providerId?: string | null;
  model?: string;
  reasoningEffort?: string;
  accessMode?: string;
  /** 接续会话的上一棒（"在另一个 Agent 中继续"） */
  parentId?: string;
  status: 'idle' | 'running' | 'waiting' | 'error';
  pinned: boolean;
  archived: boolean;
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface SnapshotItemDto {
  itemKey: string;
  kind: EventKind;
  data: EventData[EventKind];
  turnId?: string | null;
}

export interface SessionDetailResponse extends SessionDto {
  snapshot: SnapshotItemDto[];
}

export interface EventsPageResponse {
  events: StoredEvent[];
  hasMore: boolean;
}

export interface FileDto {
  id: string;
  sha256: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
}

export interface UploadInitResponse {
  uploadId: string;
  chunkSize: number;
  received: number[];
}

export interface UploadStatusResponse {
  uploadId: string;
  received: number[];
  size: number;
}

export interface UploadCompleteResponse {
  fileId: string;
  url: string;
}

export interface DraftDto {
  text: string;
  fileIds: string[];
  updatedAt: string;
}

export interface ProviderEndpointMap {
  'openai-responses'?: string;
  'anthropic-messages'?: string;
}

export interface ProviderDto {
  id: string;
  name: string;
  baseUrl: string;
  /** manual / codex-config / claude-settings / dsh / paste */
  source?: string;
  endpoints?: ProviderEndpointMap;
  protocols: string[];
  models: string[];
  codexCatalogPath?: string;
  hasKey: boolean;
  /** Key 后 4 位（永不返回原文） */
  keyHint?: string;
  /** 缺 Key 等原因（例如"缺少 Key（本机配置读取环境变量 X）"） */
  note?: string;
  createdAt: string;
}

export interface BrowseEntry {
  name: string;
  path: string;
  hidden: boolean;
}

export interface BrowseResponse {
  path: string;
  home: string;
  crumbs: { name: string; path: string }[];
  entries: BrowseEntry[];
}

export interface WorkspaceEntryCreateRequest {
  path: string;
  kind: 'file' | 'dir';
  content?: string;
}

export interface FsListResponse {
  path: string;
  entries: { name: string; path: string; type: 'file' | 'dir'; size?: number }[];
}

export interface FsReadResponse {
  path: string;
  content: string;
  truncated: boolean;
}
