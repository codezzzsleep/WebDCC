import { useEffect, useState } from 'react';
import type { NativeControlSnapshot } from '@webdcc/protocol';
import { useStoreVersion } from './hooks.js';
import { store } from './store.js';
import { api } from './api.js';

export const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const pending = new Map<string, Promise<NativeControlSnapshot>>();
export function readClaudeTaskControls(sessionId: string): Promise<NativeControlSnapshot> {
  const existing = pending.get(sessionId);
  if (existing !== undefined) return existing;
  const read = api.nativeControls(sessionId, true).finally(() => { if (pending.get(sessionId) === read) pending.delete(sessionId); });
  pending.set(sessionId, read);
  return read;
}
export function useClaudeTaskControls(sessionId: string | null, enabled = true): NativeControlSnapshot | undefined {
  useStoreVersion();
  const [value, setValue] = useState<{ sessionId: string; init: number; snapshot: NativeControlSnapshot }>();
  const init = sessionId === null ? 0 : store.getEvents(sessionId).findLast(event => object(event.data)['claudeTaskRuntime'] !== undefined
    || object(event.native)['type'] === 'system' && ['init', 'task_started', 'background_tasks_changed'].includes(String(object(event.native)['subtype'])))?.seq ?? 0;
  useEffect(() => {
    let live = true;
    if (!enabled || sessionId === null) return;
    void readClaudeTaskControls(sessionId).then(snapshot => { if (live) setValue({ sessionId, init, snapshot }); }).catch(() => { if (live) setValue(undefined); });
    return () => { live = false; };
  }, [sessionId, enabled, init]);
  return value?.sessionId === sessionId && value.init === init && enabled ? value.snapshot : undefined;
}
export function claudeTaskStopSupported(snapshot: NativeControlSnapshot | undefined): boolean {
  return snapshot?.agent === 'claude-code' && object(object(snapshot.state)['controls'])['perTaskStopAffordance'] === true
    && Array.isArray(object(snapshot.catalog)['actions']) && (object(snapshot.catalog)['actions'] as unknown[]).some(value => object(value)['type'] === 'stop-task' && object(value)['supported'] === true);
}
