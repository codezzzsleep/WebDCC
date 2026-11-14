import type { AgentId, ProbeResult } from './adapter.js';

export type NativeAvailability = 'available' | 'environment-blocked' | 'not-applicable' | 'unknown';
export type ApiExposure = 'public' | 'experimental' | 'unsupported-in-api' | 'unverified';
export interface NativeMethodInventoryEntry {
  agent: AgentId;
  method: string;
  role: 'action' | 'observation' | 'internal';
  capabilityId: string;
  reason?: string;
}
export interface Capability {
  id: string;
  agent: AgentId;
  title: string;
  methods: string[];
  nativeAvailability: NativeAvailability;
  apiExposure: ApiExposure;
  structuredImplemented: boolean;
  structuredVerified: boolean;
  fallbackVerified: boolean;
  reason: string;
  evidence: string[];
}
export interface CapabilityRuntime {
  agent: AgentId;
  hostId: string;
  os: string;
  profile: string;
  probe: ProbeResult;
  adapterKind: 'real' | 'fake';
  compatibility: 'compatible' | 'incompatible' | 'unknown' | 'test-only';
  schemaHash: string;
  configurationFingerprint: string;
  pluginStatus: 'unverified' | 'verified';
}
export interface CapabilitySnapshot {
  formatVersion: 1;
  revision: string;
  observedAt: string;
  workspaceId: string | null;
  runtimes: CapabilityRuntime[];
  capabilities: Capability[];
  inventory: NativeMethodInventoryEntry[];
}
