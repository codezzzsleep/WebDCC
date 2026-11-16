import type { StoredEvent } from '@webdcc/protocol';

/** A recent response certifies only the requested session's bounded suffix.
 * Opaque/unknown event bodies remain untouched; identity and sequence define
 * whether the response can join this session's projection and cache. */
export function completeRecentEventPage(value: unknown, sessionId: string, throughSeq: number, limit = 200): value is { events: Pick<StoredEvent, 'sessionId' | 'seq'>[] } {
  if (!Number.isSafeInteger(throughSeq) || throughSeq < 1 || value === null || typeof value !== 'object') return false;
  const events = (value as { events?: unknown }).events;
  if (!Array.isArray(events) || events.length === 0 || events.length > limit) return false;
  let previous: number | undefined;
  for (const value of events) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const event = value as { sessionId?: unknown; seq?: unknown };
    if (event.sessionId !== sessionId || typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq) || event.seq < 1 ||
      previous !== undefined && event.seq !== previous + 1) return false;
    previous = event.seq;
  }
  return previous === throughSeq;
}
