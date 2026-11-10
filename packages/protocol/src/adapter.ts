/** AgentAdapter 统一接口（SPEC 5.1） */
import type { EventKind } from './events.js';

export type AgentId = 'dsh' | 'codex' | 'claude-code';

export interface ProbeResult {
  installed: boolean;
  version?: string;
  pinnedVersion: string;
  auth: 'ok' | 'missing' | 'unknown';
  notes?: string[];
}

export interface ModelOption {
  id: string;
  label: string;
}

export interface CreateOpts {
  sessionId: string;
  cwd: string;
  providerId: string | null;
  model?: string;
  accessMode?: string;
}

export interface UserInput {
  text: string;
  images?: { fileId: string; path: string; mime: string }[];
}

export interface ApprovalDecision {
  approvalId: string;
  optionId: string;
}

export interface LaunchSpec {
  command?: string;
  args?: string[];
  env: Record<string, string>;
  sdkOptions?: Record<string, unknown>;
  startParams?: Record<string, unknown>;
}

export type AdapterEvent =
  | { type: 'item.start'; itemKey: string; kind: EventKind; data: unknown; turnId?: string; native?: unknown }
  | { type: 'item.delta'; itemKey: string; field: 'text' | 'output'; append: string }
  | { type: 'item.update'; itemKey: string; data: unknown }
  | { type: 'item.complete'; itemKey: string; kind: EventKind; data: unknown; turnId?: string; native?: unknown; nativeSeq?: number }
  | { type: 'status'; status: 'running' | 'waiting' | 'idle' | 'error' };

export interface AgentAdapter {
  id: AgentId;
  probe(): Promise<ProbeResult>;
  listModels(providerId: string | null): Promise<ModelOption[]>;
  accessModes(): { id: string; label: string }[];
  buildLaunchSpec(opts: CreateOpts): LaunchSpec;
  create(opts: CreateOpts): Promise<{ nativeId: string }>;
  resume(opts: CreateOpts & { nativeId: string }): Promise<void>;
  send(sessionId: string, input: UserInput): Promise<void>;
  steer?(sessionId: string, input: UserInput): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  respond(sessionId: string, d: ApprovalDecision): Promise<void>;
  answer?(sessionId: string, questionId: string, answer: unknown): Promise<void>;
  setModel?(sessionId: string, model: string): Promise<void>;
  dispose(sessionId: string): Promise<void>;
  onEvent(cb: (sessionId: string, e: AdapterEvent) => void): void;
}
