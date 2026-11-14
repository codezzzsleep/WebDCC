import type { AdapterEvent, QuestionItem } from '@webdcc/protocol';
import { isBlockingQuestion } from '@webdcc/protocol';

export type TurnState = 'starting' | 'running' | 'waiting' | 'completed' | 'interrupted' | 'failed';

interface TurnRecord {
  sessionId: string;
  turnId: string;
  state: TurnState;
  startedAt: number;
  endedAt?: number;
  nativeTurnId?: string;
  open: Set<string>;
}

export interface TurnAssignment {
  turnId: string | null;
  late: boolean;
}

/**
 * Owns the only event-to-turn assignment rule.  Adapters may report a native
 * turn id, but that id is only a binding hint; the public identity is always
 * the id allocated by SessionManager when the user sends a message.
 */
export class TurnTracker {
  private readonly turns = new Map<string, TurnRecord>();
  private readonly nativeToTurn = new Map<string, string>();
  private readonly active = new Map<string, string>();
  private readonly lastEnded = new Map<string, { turnId: string; at: number }>();

  constructor(private readonly lateWindowMs = 10_000) {}

  start(sessionId: string, turnId: string, at = Date.now()): void {
    const record: TurnRecord = { sessionId, turnId, state: 'starting', startedAt: at, open: new Set() };
    this.turns.set(turnId, record);
    this.active.set(sessionId, turnId);
  }

  bindNative(turnId: string, nativeTurnId: string | undefined): void {
    if (nativeTurnId === undefined || nativeTurnId === '') return;
    const record = this.turns.get(turnId);
    if (record === undefined) return;
    if (record.nativeTurnId !== undefined && record.nativeTurnId !== nativeTurnId) return;
    const existing = this.nativeToTurn.get(JSON.stringify([record.sessionId, nativeTurnId]));
    if (existing !== undefined && existing !== turnId) return;
    record.nativeTurnId = nativeTurnId;
    this.nativeToTurn.set(JSON.stringify([record.sessionId, nativeTurnId]), turnId);
  }

  assignment(sessionId: string, event: AdapterEvent, at = Date.now()): TurnAssignment {
    if (event.scope === 'session') return { turnId: null, late: false };
    const nativeTurnId = 'nativeTurnId' in event ? event.nativeTurnId : 'turnId' in event ? event.turnId : undefined;
    if (nativeTurnId !== undefined) {
      const known = this.nativeToTurn.get(JSON.stringify([sessionId, nativeTurnId]));
      if (known !== undefined) return { turnId: known, late: this.isLate(sessionId, known, at) };
      const current = this.active.get(sessionId);
      if (current !== undefined && this.turns.get(current)?.nativeTurnId === undefined) {
        this.bindNative(current, nativeTurnId);
        return { turnId: current, late: false };
      }
      // An explicit but unknown native identity is not evidence that this
      // frame belongs to the current public turn. Keep it in the raw ledger.
      return { turnId: null, late: false };
    }
    const current = this.active.get(sessionId);
    if (current !== undefined) return { turnId: current, late: false };
    const previous = this.lastEnded.get(sessionId);
    if (previous !== undefined && at - previous.at <= this.lateWindowMs && this.isClosing(event)) {
      return { turnId: previous.turnId, late: true };
    }
    return { turnId: null, late: false };
  }

  observe(sessionId: string, event: AdapterEvent, at = Date.now()): TurnAssignment {
    const assigned = this.assignment(sessionId, event, at);
    const blocks = (event.type === 'item.start' || event.type === 'item.complete') && (event.kind === 'approval.request' || event.kind === 'question' && isBlockingQuestion(event.data as QuestionItem));
    if (assigned.turnId === null) {
      const active = this.active.get(sessionId); const current = active === undefined ? undefined : this.turns.get(active);
      if (event.scope === 'session' && blocks && current !== undefined && current.endedAt === undefined) current.state = 'waiting';
      if (event.scope === 'session' && event.type === 'status' && event.source === 'native-thread' && current !== undefined && current.endedAt === undefined) {
        if (event.status === 'waiting') current.state = 'waiting';
        if (event.status === 'running') current.state = 'running';
      }
      return assigned;
    }
    const record = this.turns.get(assigned.turnId);
    if (record === undefined) return assigned;
    if (record.endedAt !== undefined) return assigned;
    if (event.type === 'turn.start') record.state = 'running';
    if (event.type === 'status') {
      if (event.status === 'running') record.state = 'running';
      if (event.status === 'waiting') record.state = 'waiting';
    }
    if (event.type === 'item.start') {
      record.open.add(event.itemKey);
      if (blocks) record.state = 'waiting';
      else if (record.state !== 'waiting') record.state = 'running';
    }
    if (event.type === 'item.complete' && blocks) record.state = 'waiting';
    if (event.type === 'item.complete' || event.type === 'item.cancel') record.open.delete(event.itemKey);
    // SessionManager owns terminal persistence and applies a short settle
    // window for late item/diff frames. Keep the tracker active until it calls
    // end(), otherwise those frames would be tagged late immediately.
    return assigned;
  }

  end(sessionId: string, turnId: string | undefined = this.active.get(sessionId), status: 'completed' | 'interrupted' | 'failed' = 'completed', at = Date.now()): string[] {
    if (turnId === undefined) return [];
    const record = this.turns.get(turnId);
    if (record === undefined || record.state === 'completed' || record.state === 'interrupted' || record.state === 'failed') return [];
    const open = [...record.open];
    record.open.clear();
    record.state = status;
    record.endedAt = at;
    this.lastEnded.set(sessionId, { turnId, at });
    if (this.active.get(sessionId) === turnId) this.active.delete(sessionId);
    return open;
  }

  forceClose(sessionId: string, status: 'interrupted' | 'failed', at = Date.now()): { turnId: string; itemKeys: string[] } | undefined {
    const turnId = this.active.get(sessionId);
    if (turnId === undefined) return undefined;
    return { turnId, itemKeys: this.end(sessionId, turnId, status, at) };
  }

  state(turnId: string): TurnState | undefined {
    return this.turns.get(turnId)?.state;
  }

  activeTurn(sessionId: string): string | undefined {
    return this.active.get(sessionId);
  }

  nativeTurn(turnId: string): string | undefined { return this.turns.get(turnId)?.nativeTurnId; }

  publicTurn(sessionId: string, nativeTurnId: string): string | undefined {
    return this.nativeToTurn.get(JSON.stringify([sessionId, nativeTurnId]));
  }

  startedAt(turnId: string): number | undefined { return this.turns.get(turnId)?.startedAt; }

  ended(turnId: string): boolean { return this.turns.get(turnId)?.endedAt !== undefined; }

  resume(sessionId: string): void {
    const turnId = this.active.get(sessionId);
    const record = turnId === undefined ? undefined : this.turns.get(turnId);
    if (record !== undefined && record.state === 'waiting') record.state = 'running';
  }

  wait(sessionId: string): void {
    const turnId = this.active.get(sessionId); const record = turnId === undefined ? undefined : this.turns.get(turnId);
    if (record !== undefined && record.endedAt === undefined) record.state = 'waiting';
  }

  openItems(turnId: string): string[] {
    return [...(this.turns.get(turnId)?.open ?? [])];
  }

  private isLate(sessionId: string, turnId: string, at: number): boolean {
    if (this.turns.get(turnId)?.endedAt !== undefined) return true;
    const ended = this.lastEnded.get(sessionId);
    return ended?.turnId === turnId && at - ended.at <= this.lateWindowMs;
  }

  private isClosing(event: AdapterEvent): boolean {
    return event.type === 'item.complete' || event.type === 'item.cancel' || event.type === 'turn.end';
  }
}
