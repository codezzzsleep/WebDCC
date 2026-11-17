/** Session snapshots and the feed continuation token form one durable unit.
 * Metadata can skip numeric IDs when the server removes a deleted session's
 * feed records. Serial commits protect received state, not artificial +1 IDs. */
export class FeedCheckpoint<T extends { id: string }> {
  private committed = 0;
  private pending = new Map<string, T>();
  private pendingSeq = 0;
  private version = 0;
  private scheduled = false;
  private writing = false;

  constructor(private readonly persist: (sessions: T[], feedSeq: number) => Promise<void>) {}
  cursor(): number { return this.committed; }
  restore(sequence: unknown): void {
    if (Number.isSafeInteger(sequence) && Number(sequence) >= 0) this.committed = Math.max(this.committed, Number(sequence));
  }
  record(session: T, sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence <= this.committed) return;
    this.pending.set(session.id, structuredClone(session));
    this.pendingSeq = Math.max(this.pendingSeq, sequence); this.version++;
    this.schedule();
  }
  private schedule(): void {
    if (this.scheduled || this.writing || this.pending.size === 0) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; void this.flush(); });
  }
  private async flush(): Promise<void> {
    if (this.writing || this.pending.size === 0) return;
    this.writing = true;
    const batch = this.pending; const sequence = this.pendingSeq; const version = this.version;
    this.pending = new Map(); this.pendingSeq = 0;
    try {
      await this.persist([...batch.values()], sequence);
      this.committed = Math.max(this.committed, sequence);
    } catch {
      // Later complete snapshots contain all previously received fields for
      // their own session. Retain every other failed session as well.
      const newer = this.version > version;
      this.pending = new Map([...batch, ...this.pending]);
      this.pendingSeq = Math.max(sequence, this.pendingSeq);
      this.writing = false;
      // A new received patch may retry the failed unit once. A lone failure
      // does not create a polling loop or claim committed coverage.
      if (newer) this.schedule();
      return;
    }
    this.writing = false; this.schedule();
  }
}
