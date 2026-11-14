import type { EventData, EventKind } from './events.js';
import type { NativeHistoryRecord } from './adapter.js';

export interface ManagedProcessIdentity {
  pid: number; bootId: string; startTicks: string; machineId: string; profilePath: string | null;
  nativeVersion?: string;
}
export interface NativeTurnObservation {
  nativeTurnId: string;
  status: 'completed' | 'failed' | 'interrupted' | 'inProgress';
  startedAt: string | null; completedAt: string | null;
  clientCommandIds: string[];
  items: { itemKey: string; kind: EventKind; data: EventData[EventKind]; native: unknown }[];
  itemsComplete: boolean;
}
export interface NativeObservation {
  nativeId: string; agent: string; cwd: string | null; version: string;
  profilePath: string | null;
  capturedAt: string;
  state: 'running' | 'idle' | 'unknown';
  authority: 'observer-local' | 'native-host' | 'history-only';
  releasePolicy: 'managed-process' | 'native-arbitration' | 'unverified';
  turns: NativeTurnObservation[];
  history?: NativeHistoryRecord[];
  queuedCommandIds?: string[];
  pendingInput?: string[];
  notes: string[];
}
export interface ReconciliationView {
  revision: string; sessionId: string; generation: number | null; observedAt: string;
  observation: NativeObservation;
  writer: 'running' | 'exited' | 'unknown' | 'native-arbitrated';
  canApply: boolean; reasons: string[]; applied: boolean;
  outcomes: { turnId: string; nativeTurnId: string; status: 'completed' | 'failed' | 'interrupted' }[];
}
