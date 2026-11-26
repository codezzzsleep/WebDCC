import type { EventData, StoredEvent, TraceFrame } from './index.js';

export class UserEchoMismatchError extends Error {
  constructor() { super('原生消息身份相同但正文不同'); }
}

/** Verify the original admitted text when the stored event is a redacted projection. */
export function findUserEcho(events: readonly StoredEvent[], incoming: EventData['user.message'], admittedText?: string): StoredEvent | undefined {
  if (incoming.clientCommandId === undefined) return undefined;
  const local = events.find(event => event.kind === 'user.message' && (event.data as EventData['user.message']).clientCommandId === incoming.clientCommandId);
  const expectedText = admittedText ?? (local?.data as EventData['user.message'] | undefined)?.text;
  if (expectedText !== undefined && expectedText !== incoming.text) throw new UserEchoMismatchError();
  return local;
}

/** Recover the request identity already present in a recorded DSH call. */
export function traceInputIdentity(frame: TraceFrame): string | undefined {
  if (frame.dir !== 'out' || frame.ch !== 'rpc:session/prompt') return undefined;
  const raw = frame.frame as { args?: { request?: { requestId?: unknown } } } | null;
  const id = raw?.args?.request?.requestId;
  return typeof id === 'string' ? id : undefined;
}
