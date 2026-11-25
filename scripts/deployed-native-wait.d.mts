export interface NativeWaitEvent {
  seq: number;
  kind: string;
  turnId?: string | null;
  data?: unknown;
}
export interface NativeWaitRequest {
  id: string;
  state: string;
  response?: { chunks?: { t?: number }[] };
}
export interface NativeWaitOptions {
  afterSeq?: number;
  idleTimeoutMs?: number;
  maxDurationMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}
export function waitForNativeTurn<T extends NativeWaitEvent>(read: () => Promise<{ events: T[]; requests?: NativeWaitRequest[] }>, options?: NativeWaitOptions): Promise<T[]>;
export function waitForNativeReceipts(read: () => NativeWaitRequest[], options?: Pick<NativeWaitOptions, 'intervalMs' | 'now' | 'sleep'> & { timeoutMs?: number }): Promise<{
  settled: boolean;
  elapsedMs: number;
  pendingRequestIds: string[];
  uncertainRequestIds: string[];
}>;
