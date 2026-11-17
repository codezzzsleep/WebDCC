import type { EventData } from './events.js';
import type { NativeEnvelopeSummary } from './native-events.js';
import type { RuntimeIdentity } from './runtime.js';
import type { HotRecovery } from './hot-recovery.js';

export type RecoveredCompletionKind = 'assistant.message' | 'reasoning' | 'command' | 'tool.call' | 'file.read' | 'file.change';

/** Original mapped output with its actual assignment. This is not a semantic
 * event, a native execution receipt or a newly allocated event sequence. */
export interface RecoveredCompletion {
  projectionId: string;
  scopeId: string;
  sessionId: string;
  turnId: string | null;
  itemKey: string;
  kind: RecoveredCompletionKind;
  data: EventData[RecoveredCompletionKind];
  native?: unknown;
  identity: RuntimeIdentity;
  late: boolean;
  turnEnded: boolean;
  origins: NativeEnvelopeSummary[];
  assignments: { envelopeId: number; contextDigest: string; late: boolean; turnEnded: boolean }[];
  conflict?: true;
}

export interface CompletedRecovery extends HotRecovery {
  scope: 'immutable-completed-items';
  conflicts: { scopeId: string; projectionIds: string[] }[];
}
