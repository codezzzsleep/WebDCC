/** Optional, server-wide recovery for Codex sessions managed by WebDCC. */
export interface WatchdogSettings {
  enabled: boolean;
  maxAttempts: number;
  maxHandoffs: number;
  baseDelaySeconds: number;
  maxDelaySeconds: number;
}

export interface WatchdogJob {
  sessionId: string;
  rootSessionId: string;
  failedTurnId: string;
  action: 'continue' | 'handoff';
  status: 'scheduled' | 'recovering' | 'recovered' | 'handed-off' | 'cancelled' | 'exhausted';
  attempts: number;
  handoffs: number;
  nextAttemptAt: string | null;
  targetSessionId?: string;
  detail: string;
  updatedAt: string;
}

export interface WatchdogView {
  settings: WatchdogSettings;
  jobs: WatchdogJob[];
}
