/** DSH direct-child reads retain the native address and sequence space. */
export type DshSubagentMode = 'continuable' | 'one-shot' | 'external' | 'unknown';
export interface DshSubagentIdentity {
  childId: string;
  parentSessionId: string;
  mode: DshSubagentMode;
  createdAt: number;
  name?: string;
  label?: string;
}

export interface DshSubagentState {
  cursor: number;
  active: boolean;
  running: boolean;
  pendingInput: ('approval' | 'question' | 'other')[];
  queue: { id: string; placement: 'queued' | 'steering' | 'context'; rpcId?: string; content: unknown[] }[] | null;
}

export interface DshSubagentRecord {
  type: 'event';
  event: { type: string; seq: number; time: number; data: unknown; [key: string]: unknown };
}

export interface DshSubagentSummary extends DshSubagentIdentity {
  /** Native subagent projection's own descriptor, after any inherited prefix. */
  ownDescriptorSeq?: number;
  status: 'running' | 'waiting' | 'pending' | 'idle' | 'completed' | 'failed' | 'stopped' | 'unknown';
  state?: DshSubagentState;
  lastTurn?: { turn?: number; seq: number; reason: unknown };
  /** Exact last non-empty assistant text in the observed window; may be partial. */
  result?: { seq: number; text: string };
  error?: string;
}

export interface DshSubagentCatalog {
  nativeId: string;
  asOfSeq: number;
  items: DshSubagentSummary[];
}

/** Server-selected persistent native ID; the browser cannot override it. */
export interface DshSubagentReadTarget { nativeId: string }

/** A server-side ownership check immediately before a child side effect. */
export interface DshSubagentControlTarget extends DshSubagentReadTarget { guard?: () => void }

export interface DshSubagentInterruptReceipt {
  id: string;
  address: { kind: 'subagent'; parentSessionId: string; childSessionId: string; mode: 'continuable' };
  accepted: true;
  /** The native cancel ACK does not confirm that the child has stopped. */
  confirmed: false;
}

export interface DshSubagentHistoryOptions {
  limit: number;
  throughSeq?: number;
  beforeSeq?: number;
}

export interface DshSubagentHistory {
  ownDescriptorSeq?: number;
  address: { kind: 'subagent'; parentSessionId: string; childSessionId: string; mode: Exclude<DshSubagentMode, 'external'> };
  cursor: number;
  records: DshSubagentRecord[];
  hasMore: boolean;
  nextCursor?: number;
}
