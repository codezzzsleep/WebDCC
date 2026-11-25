import type { AgentId } from './adapter.js';
import type { RuntimeIdentity } from './runtime.js';
import type { DshSubagentInputReference } from './dsh-subagents.js';
import type { ClaudeQueryConfiguration } from './claude-configuration.js';

/** Adapter-owned descriptor of an actual native fork; never supplied by the browser. */
export interface NativeForkSession {
  sourceNativeId: string;
  nativeId: string;
  cwd: string;
  /** null keeps the fork's native selection when a public model route is unknown. */
  model?: string | null;
  reasoningEffort?: string | null;
  accessMode?: string;
  title?: string;
  /** Acceptance belongs to the source query; the fork must initialize separately. */
  claudeConfiguration?: ClaudeQueryConfiguration;
}
export interface NativeForkContinuation {
  sessionId: string;
  nativeId: string;
  sourceNativeId: string;
  agent: AgentId;
}

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
  reference?: { id: string; generation?: number; runId?: string | null; dshChild?: DshSubagentInputReference };
  /** The SDK call returned; this does not establish a task's terminal outcome. */
  callReturnedAt?: string;
  /** Persisted with the fork association, recoverable without repeating the native action. */
  continuation?: NativeForkContinuation;
}
export interface NativeActionResponse {
  receipt: NativeActionReceipt;
  /** Ephemeral response for this attempt; a retry returns the durable receipt. */
  result?: unknown;
}
export interface NativeProcessDelta { stream: 'stdout' | 'stderr'; deltaBase64: string; capReached: boolean }
export interface NativeProcessCompletion { exitCode: number; stdout: string; stderr: string }
export interface NativeProcessStart { processId: string; command: string[]; size: { rows: number; cols: number } }
