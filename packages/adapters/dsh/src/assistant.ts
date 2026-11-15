/** Frozen 0.2.2-rc.1 compact assistant streams. Every original chunk boundary
 * survives expansion; revisions and dense attempt indices fence late frames. */
export interface DshAssistantFrame {
  type: 'start' | 'chunk' | 'end'; attemptId: string; revision: number;
  index?: number; startedAfterSeq?: number; turn?: number; step?: number;
  chunk?: Record<string, unknown>;
  outcome?: { kind: 'committed' | 'abandoned'; seq?: number; eventType?: string };
}
export interface DshAssistantBaseline {
  revision: number;
  activeAttempt?: { attemptId: string; startedAfterSeq: number; turn: number; step: number; nextIndex: number; stream: unknown[] };
}
export function expandDshAssistantStream(records: unknown[]): Record<string, unknown>[] {
  const chunks: Record<string, unknown>[] = [];
  for (const value of records) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid compact assistant record');
    const record = value as Record<string, unknown>;
    if (record['type'] === 'chunk') {
      if (!Number.isSafeInteger(record['time']) || record['chunk'] === null || typeof record['chunk'] !== 'object' || Array.isArray(record['chunk'])) throw new Error('Invalid compact raw chunk');
      chunks.push(record['chunk'] as Record<string, unknown>);
    } else {
      const type = record['type'];
      if (!['text-chunks', 'reasoning-chunks', 'tool-call-chunks'].includes(String(type))) throw new Error('Unknown compact assistant record');
      const parts = record[type === 'tool-call-chunks' ? 'args' : 'texts'];
      const dt = record['dt'];
      if (!Array.isArray(parts) || parts.length === 0 || parts.some(part => typeof part !== 'string') || !Array.isArray(dt) || dt.length !== parts.length - 1 || dt.some(time => !Number.isSafeInteger(time)) || !Number.isSafeInteger(record['time0']) || !Number.isSafeInteger(record['index']) || Number(record['index']) < 0) throw new Error('Invalid compact assistant run');
      if (type === 'tool-call-chunks' && (typeof record['id'] !== 'string' || record['id'] === '' || record['name'] !== undefined && typeof record['name'] !== 'string')) throw new Error('Invalid compact tool identity');
      for (const part of parts) chunks.push(type === 'tool-call-chunks'
        ? { type: 'tool-call-delta', index: record['index'], id: record['id'], ...(record['name'] === undefined ? {} : { name: record['name'] }), argumentsDelta: part }
        : { type: type === 'text-chunks' ? 'text-delta' : 'reasoning-delta', index: record['index'], text: part });
    }
    if (chunks.length > 100_000) throw new Error('Assistant baseline exceeds the recovery limit');
  }
  return chunks;
}

export class DshAssistantBridge {
  attemptId?: string;
  private startedAfterSeq = -1;
  private turn = -1;
  private step = -1;
  private nextIndex = 0;
  private revision = -1;
  baseline(value: unknown): Record<string, unknown>[] {
    this.attemptId = undefined; this.nextIndex = 0; this.revision = -1;
    if (value === undefined) return [];
    if (value === null || typeof value !== 'object') throw new Error('Invalid assistant baseline');
    const baseline = value as DshAssistantBaseline;
    if (!Number.isSafeInteger(baseline.revision) || baseline.revision < 0) throw new Error('Invalid assistant revision');
    this.revision = baseline.revision;
    const active = baseline.activeAttempt;
    if (active === undefined) return [];
    if (typeof active.attemptId !== 'string' || active.attemptId === '' || !Number.isSafeInteger(active.nextIndex) || active.nextIndex < 0 || !Number.isSafeInteger(active.startedAfterSeq) || !Number.isSafeInteger(active.turn) || !Number.isSafeInteger(active.step) || !Array.isArray(active.stream)) throw new Error('Invalid assistant attempt');
    const chunks = expandDshAssistantStream(active.stream);
    if (chunks.length !== active.nextIndex) throw new Error('Assistant baseline does not cover its dense index');
    this.attemptId = active.attemptId; this.nextIndex = active.nextIndex;
    this.startedAfterSeq = active.startedAfterSeq; this.turn = active.turn; this.step = active.step;
    return chunks;
  }
  accept(value: Record<string, unknown>): 'chunk' | 'start' | 'end' | 'ignored' | 'rebaseline' {
    const frame = value as unknown as DshAssistantFrame;
    // Old trace fixtures predate dense frames. They remain compatible only
    // when the entire frame has no native attempt identity.
    if (frame.attemptId === undefined && frame.revision === undefined) return frame.type === 'chunk' ? 'chunk' : 'ignored';
    if (typeof frame.attemptId !== 'string' || !Number.isSafeInteger(frame.revision)) return 'rebaseline';
    if (frame.revision <= this.revision) return 'ignored';
    if (frame.type === 'start') {
      if (this.attemptId !== undefined) return 'rebaseline';
      if (!Number.isSafeInteger(frame.startedAfterSeq) || !Number.isSafeInteger(frame.turn) || !Number.isSafeInteger(frame.step)) return 'rebaseline';
      if (this.revision >= 0 && frame.revision !== this.revision + 1) return 'rebaseline';
      this.attemptId = frame.attemptId; this.nextIndex = 0; this.revision = frame.revision;
      this.startedAfterSeq = frame.startedAfterSeq!; this.turn = frame.turn!; this.step = frame.step!; return 'start';
    }
    if (frame.attemptId !== this.attemptId) return 'ignored';
    if (frame.revision !== this.revision + 1) return 'rebaseline';
    if (frame.index !== this.nextIndex) return 'rebaseline';
    this.revision = frame.revision;
    if (frame.type === 'chunk') { this.nextIndex++; return 'chunk'; }
    if (frame.type === 'end') {
      if (frame.outcome?.kind !== 'abandoned' && (frame.outcome?.kind !== 'committed' || !Number.isSafeInteger(frame.outcome.seq) || !['assistant/message', 'assistant/attempt'].includes(frame.outcome.eventType ?? ''))) return 'rebaseline';
      this.attemptId = undefined; return 'end';
    }
    return 'rebaseline';
  }
  matchesSettlement(seq: number, data: Record<string, unknown>): boolean {
    return this.attemptId !== undefined && seq > this.startedAfterSeq && data['turn'] === this.turn && data['step'] === this.step;
  }
}
