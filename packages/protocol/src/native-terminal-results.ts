import type { NativeEnvelopeDetail } from './native-events.js';
import type { RuntimeIdentity } from './runtime.js';
import type { HotRecovery } from './hot-recovery.js';

/** Original native report, independent from the Web turn and input receipt. */
export interface NativeTerminalResult {
  scopeId: string; outcomeId: string; sessionId: string; publicTurnId: string;
  nativeId: string; nativeTurnId: string | null; status: 'completed' | 'failed' | 'interrupted'; usage?: unknown;
  origins: NativeEnvelopeDetail[]; identity?: RuntimeIdentity;
  assignments?: { envelopeId: number; contextDigest: string; late: boolean; turnEnded: boolean }[];
}
export interface NativeTerminalResultsResponse {
  outcomes: NativeTerminalResult[];
  recovery: HotRecovery & { scope: 'native-terminal-results'; conflicts: { scopeId: string; outcomeIds: string[] }[] };
}
