import type { AgentId } from './adapter.js';
import type { RuntimeIdentity } from './runtime.js';

export interface NativeControlSnapshot {
  sessionId: string;
  agent: AgentId;
  nativeId: string | null;
  runtime: RuntimeIdentity;
  revision: string;
  state: unknown;
  catalog?: unknown;
}
export interface NativeActionRequest {
  commandId: string;
  revision?: string;
  action: { type: string; [key: string]: unknown };
}
export type NativeActionState = 'dispatching' | 'submitted' | 'completed' | 'failed' | 'uncertain';
/** A durable receipt never repeats the native payload or a secret answer. */
export interface NativeActionReceipt {
  commandId: string;
  sessionId: string;
  type: string;
  state: NativeActionState;
  updatedAt: string;
  error?: string;
  reference?: { id: string; generation?: number };
}
export interface NativeActionResponse {
  receipt: NativeActionReceipt;
  /** Ephemeral response for this attempt; a retry returns the durable receipt. */
  result?: unknown;
}
export interface NativeProcessDelta { stream: 'stdout' | 'stderr'; deltaBase64: string; capReached: boolean }
export interface NativeProcessCompletion { exitCode: number; stdout: string; stderr: string }
export interface NativeProcessStart { processId: string; command: string[]; size: { rows: number; cols: number } }
