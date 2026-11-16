/** A native timed question keeps its call and item identities across UI phases. */
export interface DshQuestionIdentity {
  nativeId: string;
  callId: string;
  itemId: string;
  /** Actual forwarded Client identity; changes when the native mux reconnects. */
  clientId?: string;
  timed: boolean;
  phase: 'open' | 'continued';
}

/** Server-only native stream lifetime, bound to one authenticated browser socket. */
export interface DshQuestionWaitOpening {
  callId: string;
  remainingMs: number;
  closed: Promise<void>;
}

export type DshQuestionWaitRequest = { op: 'dsh-question-wait'; requestId: string; sessionId: string; questionId: string } & (
  { action: 'claim' } | { action: 'timeout' | 'release'; claimId: string }
);
export interface DshQuestionWaitMessage {
  op: 'dsh-question-wait';
  requestId: string;
  sessionId: string;
  questionId: string;
  result: { kind: 'claim'; claimId: string; callId: string; remainingMs: number }
    | { kind: 'ended'; claimId: string }
    | { kind: 'submitted'; claimId: string }
    | { kind: 'error'; error: string };
}
