/** Optional, server-wide recovery for Codex sessions managed by WebDCC. */
export interface WatchdogSettings {
  enabled: boolean;
  /** null = unlimited; otherwise the user's limit for continuation attempts. */
  maxAttempts: number | null;
  /** null = unlimited; 0 disables handoff; otherwise the user's handoff limit. */
  maxHandoffs: number | null;
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
  retries: number;
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
