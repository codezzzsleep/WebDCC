/** REST DTO（SPEC 11.1） */
import type { EventData, EventKind, StoredEvent } from './events.js';
import type { ProbeResult } from './adapter.js';

export interface MetaResponse {
  version: string;
  agents: Record<string, ProbeResult>;
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
  accessMode?: string;
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
  turnId?: string;
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

export interface ProviderDto {
  id: string;
  name: string;
  baseUrl: string;
  protocols: string[];
  models: string[];
  codexCatalogPath?: string;
  hasKey: boolean;
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

export interface FsListResponse {
  path: string;
  entries: { name: string; path: string; type: 'file' | 'dir'; size?: number }[];
}

export interface FsReadResponse {
  path: string;
  content: string;
  truncated: boolean;
}
