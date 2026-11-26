/** 应用级只读数据：Agent 探测结果、Provider、工作区、DSH 连接状态。加载一次，供各处共享 */
import { useEffect, useSyncExternalStore } from 'react';
import type { MetaResponse, ProviderDto, WorkspaceDto } from '@webdcc/protocol';
import { api } from './api.js';

export interface DshStatus {
  mode: string;
  url: string | null;
  connected: boolean;
  version?: string;
}

interface AppData {
  meta: MetaResponse | null;
  providers: ProviderDto[];
  workspaces: WorkspaceDto[];
  dsh: DshStatus | null;
  loaded: boolean;
}

let data: AppData = { meta: null, providers: [], workspaces: [], dsh: null, loaded: false };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;
const readers = { meta: api.meta, providers: api.providers, workspaces: api.workspaces, dsh: api.dshStatus };
type Field = keyof typeof readers;
const activeReads = new Map<Field, { retry?: ReturnType<typeof setTimeout> }>();

function emit(next: Partial<AppData>): void {
  data = { ...data, ...next };
  for (const listener of listeners) listener();
}

async function refreshField(field: Field, attempt = 0): Promise<void> {
  const previous = activeReads.get(field)?.retry;
  if (previous !== undefined) clearTimeout(previous);
  const current: { retry?: ReturnType<typeof setTimeout> } = {};
  activeReads.set(field, current);
  try {
    const value = await readers[field]();
    if (activeReads.get(field) === current) emit({ [field]: value });
  } catch (error) {
    if (activeReads.get(field) !== current) return;
    const status = (error as { status?: number } | null)?.status;
    if (status === undefined || status === 408 || status === 429 || status >= 500) {
      const delay = Math.min(1_000 * 2 ** attempt, 30_000);
      current.retry = setTimeout(() => {
        if (activeReads.get(field) === current) void refreshField(field, attempt + 1);
      }, delay);
    }
    if (field === 'dsh') emit({ dsh: null });
  }
}

export function refreshAppData(): Promise<void> {
  loading = Promise.all([
    refreshField('meta'), refreshProviders(), refreshWorkspaces(), refreshDsh(),
  ]).then(() => emit({ loaded: true }));
  return loading;
}

export function refreshProviders(): Promise<void> {
  return refreshField('providers');
}

export function refreshWorkspaces(): Promise<void> {
  return refreshField('workspaces');
}

export function refreshDsh(): Promise<void> {
  return refreshField('dsh');
}

export function useAppData(): AppData {
  const snapshot = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => data,
  );
  useEffect(() => {
    if (loading === null) void refreshAppData();
  }, []);
  return snapshot;
}
