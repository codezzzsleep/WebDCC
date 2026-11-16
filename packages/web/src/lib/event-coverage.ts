import type { StoredEvent } from '@webdcc/protocol';

type Range = { from: number; to: number };

/** Tracks committed event ranges separately from the live projection. */
export class CachedEventCoverage {
  private readonly ends = new Map<string, number>();
  private readonly pending = new Map<string, Range[]>();

  cursor(sessionId: string): number { return this.ends.get(sessionId) ?? 0; }

  record(events: readonly StoredEvent[]): void {
    const added = new Map<string, Range[]>();
    for (const event of events) {
      if (!Number.isSafeInteger(event.seq) || event.seq < 1 || event.seq <= this.cursor(event.sessionId)) continue;
      const ranges = added.get(event.sessionId) ?? [];
      ranges.push({ from: event.seq, to: event.seq }); added.set(event.sessionId, ranges);
    }
    for (const [sessionId, ranges] of added) {
      const sorted = [...this.pending.get(sessionId) ?? [], ...ranges].sort((a, b) => a.from - b.from);
      const merged: Range[] = [];
      for (const range of sorted) {
        const last = merged.at(-1);
        if (last !== undefined && range.from <= last.to + 1) last.to = Math.max(last.to, range.to);
        else merged.push({ ...range });
      }
      this.pending.set(sessionId, merged); this.advance(sessionId);
    }
  }

  /** A bounded history window may establish a new starting point only when
   * its entire range was committed. Older history remains a separate gap. */
  useWindow(sessionId: string, from: number, to: number): boolean {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) return false;
    const end = this.cursor(sessionId);
    if (to <= end) return true;
    const ranges = this.pending.get(sessionId) ?? [];
    if (!ranges.some(range => range.from <= Math.max(from, end + 1) && range.to >= to)) return false;
    this.ends.set(sessionId, to); this.advance(sessionId); return true;
  }

  private advance(sessionId: string): void {
    let end = this.cursor(sessionId);
    const ranges = this.pending.get(sessionId) ?? [];
    for (const range of ranges) {
      if (range.from > end + 1) break;
      end = Math.max(end, range.to);
    }
    this.ends.set(sessionId, end);
    const remaining = ranges.filter(range => range.to > end);
    if (remaining.length === 0) this.pending.delete(sessionId);
    else this.pending.set(sessionId, remaining);
  }
}
