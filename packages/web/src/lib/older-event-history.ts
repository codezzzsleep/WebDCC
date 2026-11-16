import type { StoredEvent } from '@webdcc/protocol';

export interface OlderHistoryState { phase: 'idle' | 'loading' | 'error' | 'end'; error?: string }
interface Hooks {
  before(sessionId: string): number | undefined;
  cached(sessionId: string, before: number, limit: number): Promise<StoredEvent[]>;
  fetch(sessionId: string, before: number, limit: number): Promise<{ events: StoredEvent[]; hasMore: boolean }>;
  persist(events: StoredEvent[]): Promise<void>;
  publish(sessionId: string, events: StoredEvent[]): void;
  changed(): void;
}
const LIMIT = 200;
const belongs = (event: StoredEvent, sessionId: string, before: number): boolean => event.sessionId === sessionId && Number.isSafeInteger(event.seq) && event.seq >= 1 && event.seq < before;
function cachedTail(events: StoredEvent[], sessionId: string, before: number): StoredEvent[] {
  if (events.length === 0 || events.length > LIMIT || events.some(event => !belongs(event, sessionId, before)) || events.at(-1)?.seq !== before - 1) return [];
  let start = events.length - 1;
  while (start > 0 && events[start - 1]!.seq === events[start]!.seq - 1) start--;
  return events.slice(start);
}
function completePage(events: StoredEvent[], sessionId: string, before: number): boolean {
  return events.length > 0 && events.length <= LIMIT && events.every((event, index) => belongs(event, sessionId, before) &&
    event.seq === events[0]!.seq + index) && events.at(-1)?.seq === before - 1;
}

/** Paging state follows committed history, with one operation per session.
 * Sparse old cache cannot certify the missing interval before the viewport. */
export class OlderEventHistory {
  private readonly pending = new Map<string, Promise<boolean>>();
  private readonly states = new Map<string, OlderHistoryState>();
  constructor(private readonly hooks: Hooks) {}
  state(sessionId: string): OlderHistoryState { return this.states.get(sessionId) ?? { phase: 'idle' }; }

  load(sessionId: string): Promise<boolean> {
    const existing = this.pending.get(sessionId);
    if (existing !== undefined) return existing;
    const pending = Promise.resolve().then(() => this.read(sessionId)).finally(() => {
      if (this.pending.get(sessionId) === pending) this.pending.delete(sessionId);
    });
    this.pending.set(sessionId, pending);
    return pending;
  }

  private set(sessionId: string, state: OlderHistoryState): void {
    const previous = this.state(sessionId);
    if (previous.phase === state.phase && previous.error === state.error) return;
    this.states.set(sessionId, state); this.hooks.changed();
  }

  private async read(sessionId: string): Promise<boolean> {
    const before = this.hooks.before(sessionId);
    if (before === undefined) return false;
    if (before <= 1) { this.set(sessionId, { phase: 'end' }); return false; }
    this.set(sessionId, { phase: 'loading' });
    let cached: StoredEvent[];
    try { cached = await this.hooks.cached(sessionId, before, LIMIT); } catch { cached = []; }
    const tail = cachedTail(cached, sessionId, before);
    if (tail.length > 0) {
      this.hooks.publish(sessionId, tail); this.set(sessionId, { phase: 'idle' }); return true;
    }
    let page: { events: StoredEvent[]; hasMore: boolean };
    try { page = await this.hooks.fetch(sessionId, before, LIMIT); }
    catch { this.set(sessionId, { phase: 'error', error: '暂时无法读取更早的记录，请重试。' }); return false; }
    if (!completePage(page.events, sessionId, before)) {
      this.set(sessionId, { phase: 'error', error: '更早的记录仍有缺口，请重试或核对服务器历史。' }); return false;
    }
    try { await this.hooks.persist(page.events); }
    catch { this.set(sessionId, { phase: 'error', error: '更早的记录暂时无法保存，请重试。' }); return false; }
    this.hooks.publish(sessionId, page.events); this.set(sessionId, { phase: 'idle' }); return true;
  }
}
