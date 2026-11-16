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

export interface DshSubagentHistoryOptions {
  limit: number;
  throughSeq?: number;
  beforeSeq?: number;
}

export interface DshSubagentHistory {
  address: { kind: 'subagent'; parentSessionId: string; childSessionId: string; mode: Exclude<DshSubagentMode, 'external'> };
  cursor: number;
  records: DshSubagentRecord[];
  hasMore: boolean;
  nextCursor?: number;
}
