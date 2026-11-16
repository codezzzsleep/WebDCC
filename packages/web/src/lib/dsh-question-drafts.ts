import type { DshQuestionIdentity } from '@webdcc/protocol';

export interface DshQuestionDraft { selected: string[]; custom: string }
interface Progress { wait?: 'editing' | 'waiting'; drafts: Record<string, DshQuestionDraft> }

/** Native call/item identities keep one draft across waterfall re-delivery and late answers. */
export class DshQuestionDrafts {
  private readonly memory = new Map<string, Progress>();
  private key(sessionId: string, identity: DshQuestionIdentity): string {
    return `wdcc.dsh-question.v1:${JSON.stringify([sessionId, identity.nativeId, identity.callId])}`;
  }
  private progress(sessionId: string, identity: DshQuestionIdentity): Progress {
    const key = this.key(sessionId, identity);
    const cached = this.memory.get(key);
    if (cached !== undefined) return cached;
    let progress: Progress = { drafts: {} };
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? 'null') as Progress | null;
      if (value !== null && typeof value === 'object' && value.drafts !== null && typeof value.drafts === 'object'
        && !Array.isArray(value.drafts) && (value.wait === undefined || value.wait === 'editing' || value.wait === 'waiting')) {
        progress = { ...value, drafts: Object.fromEntries(Object.entries(value.drafts).filter(([, draft]) => draft !== null && typeof draft === 'object'
          && Array.isArray(draft.selected) && draft.selected.every(item => typeof item === 'string') && typeof draft.custom === 'string')) };
      }
    } catch { /* A storage restriction leaves the current page's draft available. */ }
    this.memory.set(key, progress);
    return progress;
  }
  read(sessionId: string, identity: DshQuestionIdentity): DshQuestionDraft {
    const draft = this.progress(sessionId, identity).drafts[identity.itemId];
    return draft === undefined ? { selected: [], custom: '' } : { selected: [...draft.selected], custom: draft.custom };
  }
  wait(sessionId: string, identity: DshQuestionIdentity): Progress['wait'] { return this.progress(sessionId, identity).wait; }
  save(sessionId: string, identity: DshQuestionIdentity, wait: NonNullable<Progress['wait']>, draft?: DshQuestionDraft): void {
    const key = this.key(sessionId, identity); const progress = this.progress(sessionId, identity);
    if (wait === 'waiting' || progress.wait !== 'waiting') progress.wait = wait;
    if (draft !== undefined) progress.drafts[identity.itemId] = { selected: [...draft.selected], custom: draft.custom };
    try { localStorage.setItem(key, JSON.stringify(progress)); } catch { /* Keep the in-memory draft. */ }
  }
  clear(sessionId: string, identity: DshQuestionIdentity): void {
    const key = this.key(sessionId, identity); this.memory.delete(key);
    try { localStorage.removeItem(key); } catch { /* Storage is unavailable. */ }
  }
}
