export interface AccessModeOption {
  id: string;
  label: string;
  allowed?: boolean;
  implemented?: boolean;
  reason?: string;
  source?: string;
  scope?: 'thread' | 'turn' | 'query' | 'session';
}

export interface NativePermissionObservation {
  /** null means that the native operation succeeded without a policy readback. */
  effective: string | null;
  source: string;
  scope: 'thread' | 'turn' | 'query' | 'session';
  policy?: unknown;
  nativeSeq?: number;
}

export interface PermissionState {
  requested: string | null;
  effective: string | null;
  phase: 'inherit' | 'pending' | 'observed' | 'failed' | 'unknown';
  revision: number;
  source?: string;
  scope?: NativePermissionObservation['scope'];
  policy?: unknown;
  nativeSeq?: number;
  error?: string;
}

export const INHERIT_ACCESS_MODE: AccessModeOption = { id: 'inherit', label: '沿用原生权限', allowed: true, implemented: true, source: 'native', reason: '不向新建或恢复的原生会话传权限覆盖' };

export function nativeAccessMode(mode?: string | null): string | undefined { return mode == null || mode === '' || mode === 'inherit' ? undefined : mode; }
export function initialPermissions(mode?: string | null): PermissionState {
  const requested = nativeAccessMode(mode) ?? null;
  return { requested, effective: null, phase: requested === null ? 'inherit' : 'pending', revision: 1 };
}

export function observePermissions(previous: PermissionState, observation: NativePermissionObservation): PermissionState {
  if (observation.nativeSeq !== undefined && previous.nativeSeq !== undefined && observation.nativeSeq < previous.nativeSeq) return previous;
  const requested = previous.requested;
  if (observation.effective === null) return { requested, effective: null, phase: requested === null ? 'unknown' : 'pending', revision: previous.revision + 1, source: observation.source, scope: observation.scope };
  const matches = requested === null || requested.replace(/^:/, '') === observation.effective.replace(/^:/, '');
  return { requested, effective: observation.effective, phase: matches ? 'observed' : previous.phase === 'failed' ? 'failed' : 'pending', revision: previous.revision + 1, source: observation.source, scope: observation.scope, policy: observation.policy, nativeSeq: observation.nativeSeq, ...(!matches && previous.phase === 'failed' ? { error: previous.error } : {}) };
}
