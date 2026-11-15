import type { EventData, StoredEvent, TraceFrame } from './index.js';

/** Match only a persisted command identity; equal text alone is not an echo. */
export function findUserEcho(events: readonly StoredEvent[], incoming: EventData['user.message']): StoredEvent | undefined {
  if (incoming.clientCommandId === undefined) return undefined;
  const local = events.find(event => event.kind === 'user.message' && (event.data as EventData['user.message']).clientCommandId === incoming.clientCommandId);
  if (local !== undefined && (local.data as EventData['user.message']).text !== incoming.text) throw new Error('原生消息身份相同但正文不同');
  return local;
}

/** Recover the request identity already present in a recorded DSH call. */
export function traceInputIdentity(frame: TraceFrame): string | undefined {
  if (frame.dir !== 'out' || frame.ch !== 'rpc:session/prompt') return undefined;
  const raw = frame.frame as { args?: { request?: { requestId?: unknown } } } | null;
  const id = raw?.args?.request?.requestId;
  return typeof id === 'string' ? id : undefined;
}
