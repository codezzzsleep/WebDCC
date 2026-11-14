import type { AgentId } from './adapter.js';

/** Fencing applies to WebDCC-managed connections and processes. External
 * native clients still require native arbitration or a verified release. */
export interface RuntimeIdentity {
  ownerId: string;
  generation: number;
  hostId: string;
}

export interface NativeOwnerDto extends RuntimeIdentity {
  sessionId: string;
  agent: AgentId;
  nativeId: string | null;
  state: 'opening' | 'active' | 'closing' | 'released' | 'uncertain';
  activeNativeTurnId: string | null;
  lastObservedSeq: number | null;
  leaseUntil: number;
  observedAt: string;
  scope: 'webdcc-managed';
}
