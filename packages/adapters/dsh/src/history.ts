import { validateDshResult, type DshHistoryRecord, type DshPage, type DshPageRequest } from './contracts.js';

export interface DshOpening extends DshPage {
  type: 'snapshot';
  header: { id: string };
  projections?: { asOfSeq: number; values: Record<string, unknown> };
  assistantStream?: unknown;
}

function validateRecords(records: DshHistoryRecord[], cut: number): void {
  let previous = -1;
  for (const record of records) {
    if (record.type !== 'event' || !Number.isSafeInteger(record.event.seq) || record.event.seq < 0 || record.event.seq <= previous || record.event.seq > cut) throw new Error('DSH 历史序号或顺序无效');
    previous = record.event.seq;
  }
}

/** Reconnect openings can be shorter than the outage. Pin the opening cut,
 * fetch older pages before publishing newer events, and retain the old cursor
 * on failure. No prompt or external side effect is replayed here. */
export class DshHistoryBridge {
  lastSeq = -1;
  private generation = 0;
  private syncing = false;
  private blocked = false;
  private buffered: DshHistoryRecord[] = [];
  get isReady(): boolean { return !this.syncing && !this.blocked && this.lastSeq >= -1; }

  constructor(
    private readonly nativeId: string,
    private readonly page: (request: DshPageRequest) => Promise<DshPage>,
    private readonly publish: (record: DshHistoryRecord, historical: boolean) => void,
    private readonly ready: (opening: DshOpening) => void,
    private readonly fail: (error: Error) => void,
  ) {}

  invalidate(): void { this.generation++; this.syncing = false; this.blocked = true; this.buffered = []; }

  event(record: DshHistoryRecord): void {
    if (record.event.seq <= this.lastSeq) return;
    if (this.syncing || this.blocked) { this.buffered.push(record); return; }
    try { this.commit([record], false); } catch (error) { this.blocked = true; this.buffered.push(record); throw error; }
  }

  opening(opening: DshOpening): void {
    const generation = ++this.generation;
    this.buffered = [];
    this.syncing = true;
    this.blocked = false;
    try {
      if (opening.header?.id !== this.nativeId || !Number.isSafeInteger(opening.cursor) || opening.cursor < -1 || opening.cursor < this.lastSeq) throw new Error('DSH Host 会话身份或历史水位发生变化');
      validateDshResult('session/page', opening);
      validateRecords(opening.records, opening.cursor);
      const first = opening.records[0]?.event.seq ?? opening.cursor + 1;
      if (!opening.hasMore || first <= this.lastSeq + 1) {
        this.finish(opening, opening.records, generation);
      } else void this.recover(opening, generation).catch(error => {
        if (generation !== this.generation) return;
        this.syncing = false;
        this.blocked = true;
        this.fail(error instanceof Error ? error : new Error(String(error)));
      });
    } catch (error) {
      this.syncing = false;
      this.blocked = true;
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async recover(opening: DshOpening, generation: number): Promise<void> {
    const pages = [opening.records];
    let beforeSeq = opening.records[0]?.event.seq ?? opening.cursor + 1;
    let count = opening.records.length;
    for (let pageCount = 0; beforeSeq > this.lastSeq + 1; pageCount++) {
      if (pageCount >= 1000 || count > 100_000) throw new Error('DSH 历史恢复超过单次限制，需要重新分页同步');
      const page = await this.page({ address: { kind: 'session', sessionId: this.nativeId }, throughSeq: opening.cursor, beforeSeq, maxMessages: 200 });
      if (generation !== this.generation) return;
      validateDshResult('session/page', page);
      validateRecords(page.records, opening.cursor);
      const first = page.records[0]?.event.seq;
      const last = page.records.at(-1)?.event.seq;
      if (first === undefined || last === undefined || first >= beforeSeq || last >= beforeSeq) throw new Error('DSH 历史分页没有推进');
      pages.push(page.records);
      count += page.records.length;
      beforeSeq = first;
      if (!page.hasMore) break;
    }
    this.finish(opening, pages.reverse().flat(), generation);
  }

  private finish(opening: DshOpening, records: DshHistoryRecord[], generation: number): void {
    if (generation !== this.generation) return;
    const previous = this.lastSeq;
    try {
      this.commit(records, true);
      if (this.lastSeq !== opening.cursor) throw new Error('DSH 开场快照未覆盖声明的历史水位');
      this.ready(opening);
    } catch (error) { this.lastSeq = previous; throw error; }
    this.syncing = false;
    const buffered = this.buffered;
    this.buffered = [];
    this.commit(buffered, false);
  }

  private commit(records: DshHistoryRecord[], historical: boolean): void {
    const fresh = records.filter(record => record.event.seq > this.lastSeq);
    // Validate the complete range before advancing any projection or cursor.
    let expected = this.lastSeq + 1;
    for (const record of fresh) {
      if (record.event.seq !== expected++) throw new Error('DSH 历史存在未补齐的缺口');
    }
    for (const record of fresh) { this.publish(record, historical); this.lastSeq = record.event.seq; }
  }
}
