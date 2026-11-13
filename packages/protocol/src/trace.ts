/**
 * Protocol trace recording is deliberately a side channel.  Adapters call the
 * sink after receiving or sending a native frame and never read from it, so a
 * recorder cannot change Agent behaviour.  A sink may be backed by JSONL,
 * memory, or a test assertion.
 */
export type TraceDirection = 'in' | 'out';

export interface TraceFrame<T = unknown> {
  /** Monotonic frame number within one native channel. */
  i: number;
  /** Milliseconds relative to the beginning of the trace. */
  t: number;
  dir: TraceDirection;
  /** rpc, sdk, input, canUseTool, control, or an Agent-specific channel. */
  ch: string;
  frame: T;
}

export interface TraceSink<T = unknown> {
  record?(frame: TraceFrame<T>): void;
  /** Alias used by transport adapters that already expose an onFrame hook. */
  onFrame?(frame: TraceFrame<T>): void;
  push?(frame: TraceFrame<T>): void;
}

/** A no-op sink avoids a branch in every adapter call site. */
export const NOOP_TRACE_SINK: TraceSink = { record: () => undefined };

export function traceFrame<T>(
  sink: TraceSink<T> | undefined,
  input: Omit<TraceFrame<T>, 'i' | 't'> & { i?: number; t?: number },
): void {
  if (sink === undefined) return;
  const frame = { i: input.i ?? 0, t: input.t ?? 0, dir: input.dir, ch: input.ch, frame: input.frame };
  try {
    if (sink.record !== undefined) sink.record(frame);
    else if (sink.onFrame !== undefined) sink.onFrame(frame);
    else sink.push?.(frame);
  } catch { /* An observer must never alter the native transport. */ }
}
