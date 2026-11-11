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

function emit(next: Partial<AppData>): void {
  data = { ...data, ...next };
  for (const listener of listeners) listener();
}

export function refreshAppData(): Promise<void> {
  loading = Promise.all([
    api.meta().then((meta) => emit({ meta })).catch(() => undefined),
    api.providers().then((providers) => emit({ providers })).catch(() => undefined),
    api.workspaces().then((workspaces) => emit({ workspaces })).catch(() => undefined),
    api.dshStatus().then((dsh) => emit({ dsh })).catch(() => emit({ dsh: null })),
  ]).then(() => emit({ loaded: true }));
  return loading;
}

export function refreshProviders(): Promise<void> {
  return api.providers().then((providers) => emit({ providers })).catch(() => undefined);
}

export function refreshWorkspaces(): Promise<void> {
  return api.workspaces().then((workspaces) => emit({ workspaces })).catch(() => undefined);
}

export function refreshDsh(): Promise<void> {
  return api.dshStatus().then((dsh) => emit({ dsh })).catch(() => emit({ dsh: null }));
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
