import type { AdapterEvent } from '@webdcc/protocol';

interface PlanDraft { itemKey: string; nativeTurnId?: string; text: string }
type PlanStart = Extract<AdapterEvent, { type: 'item.start' }>;
type PlanDelta = Extract<AdapterEvent, { type: 'item.delta' }>;
type PlanComplete = Extract<AdapterEvent, { type: 'item.complete' }>;

/** Native plan deltas are provisional; only the completed item supplies the
 * final document. Keep stream identity separate from structured plan steps. */
export class CodexPlanStreams {
  private readonly drafts = new Map<string, PlanDraft>();
  private readonly completed = new Set<string>();
  private readonly endedTurns = new Set<string>();

  private key(itemKey: string, nativeTurnId?: string): string {
    return JSON.stringify([nativeTurnId ?? null, itemKey]);
  }

  private remember(set: Set<string>, key: string): void {
    set.add(key);
    if (set.size > 1024) set.delete(set.values().next().value!);
  }

  start(itemKey: string, nativeTurnId: string | undefined, text: string): PlanStart[] {
    const key = this.key(itemKey, nativeTurnId);
    if (this.completed.has(key) || nativeTurnId !== undefined && this.endedTurns.has(nativeTurnId) || this.drafts.has(key)) return [];
    this.drafts.set(key, { itemKey, nativeTurnId, text });
    return [{ type: 'item.start', itemKey, nativeTurnId, kind: 'plan', data: { items: [], text, incomplete: true } }];
  }

  delta(itemKey: string, nativeTurnId: string, delta: string): (PlanStart | PlanDelta)[] {
    const key = this.key(itemKey, nativeTurnId);
    if (this.completed.has(key) || this.endedTurns.has(nativeTurnId)) return [];
    const events = this.start(itemKey, nativeTurnId, '');
    this.drafts.get(key)!.text += delta;
    return [...events, { type: 'item.delta', itemKey, nativeTurnId, field: 'text', append: delta }];
  }

  complete(itemKey: string, nativeTurnId: string | undefined, text: string): PlanComplete[] {
    const key = this.key(itemKey, nativeTurnId);
    if (this.completed.has(key)) return [];
    this.drafts.delete(key);
    this.remember(this.completed, key);
    return [{ type: 'item.complete', itemKey, nativeTurnId, kind: 'plan', data: { items: [], text, incomplete: false } }];
  }

  endTurn(nativeTurnId: string): PlanComplete[] {
    this.remember(this.endedTurns, nativeTurnId);
    const events: PlanComplete[] = [];
    for (const [key, draft] of this.drafts) {
      if (draft.nativeTurnId !== nativeTurnId) continue;
      this.drafts.delete(key);
      // This is a retained draft, not a native completed plan. A late genuine
      // item/completed can still replace it with the authoritative document.
      events.push({ type: 'item.complete', itemKey: draft.itemKey, nativeTurnId, kind: 'plan',
        data: { items: [], text: draft.text, incomplete: true } });
    }
    return events;
  }
}
