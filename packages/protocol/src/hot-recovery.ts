import type { NativeEnvelopeSummary } from './native-events.js';
import type { RuntimeIdentity } from './runtime.js';

/** Web observation only. The original item data and native status are unchanged. */
export interface HotObservation {
  state: 'lost';
  identity: RuntimeIdentity;
  origins: NativeEnvelopeSummary[];
}

export interface HotRecovery {
  formatVersion: 1;
  coverage: 'complete' | 'partial';
  throughEnvelopeId: number;
  hasMore: boolean;
  issues: { envelopeId: number | null; reason: string }[];
  omittedIssues: number;
}
