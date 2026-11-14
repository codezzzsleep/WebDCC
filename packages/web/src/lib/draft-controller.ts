/** Revisioned drafts are isolated by Session. A late read cannot overwrite
 * another Session or edits accepted after that read began. */
export interface DraftContent<Part = unknown> { version: 1; parts: Part[] }
export interface InputDraft<Part = unknown> {
  sessionId: string; revision: number; text: string; contentParts: DraftContent<Part>; updatedAt: number;
}
export interface InputDraftStore<Part = unknown> {
  getDraft(sessionId: string): Promise<InputDraft<Part> | undefined>;
  putDraft(draft: InputDraft<Part>, expectedRevision: number): Promise<void>;
}
export class DraftConflictError extends Error { constructor() { super('草稿已在其他页面变化，请重新核对'); } }
export class DraftController<Part = unknown> {
  private current?: InputDraft<Part>;
  private generation = 0;
  private editSequence = 0;
  private restoring = false;
  private readonly durableRevisions = new Map<string, number>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly saved = new Map<string, InputDraft<Part>>();
  private readonly listeners = new Set<() => void>();
  private failures = new Map<string, Error>();
  constructor(private readonly backend: InputDraftStore<Part>) {}
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(): void { for (const listener of this.listeners) { try { listener(); } catch { /* view only */ } } }
  snapshot(): InputDraft<Part> | undefined { return this.current === undefined ? undefined : structuredClone(this.current); }
  token(): { sessionId: string; generation: number; revision: number } | undefined {
    return this.current === undefined ? undefined : { sessionId: this.current.sessionId, generation: this.generation, revision: this.current.revision };
  }
  accepts(token: { sessionId: string; generation: number }): boolean { return token.sessionId === this.current?.sessionId && token.generation === this.generation; }
  error(sessionId = this.current?.sessionId): Error | undefined { return sessionId === undefined ? undefined : this.failures.get(sessionId); }
  loading(): boolean { return this.restoring; }
  async open(sessionId: string, initial?: { text: string; contentParts?: DraftContent<Part> }): Promise<InputDraft<Part>> {
    const generation = ++this.generation; const edits = this.editSequence;
    const empty: InputDraft<Part> = { sessionId, revision: 0, text: initial?.text ?? '', contentParts: initial?.contentParts ?? { version: 1, parts: [] }, updatedAt: Date.now() };
    this.current = structuredClone(this.saved.get(sessionId) ?? empty); this.restoring = true; this.notify();
    try {
      await this.writes.get(sessionId)?.catch(() => undefined);
      const stored = await this.backend.getDraft(sessionId);
      const failedLocal = this.failures.has(sessionId) && this.saved.has(sessionId);
      if (!failedLocal) {
        this.durableRevisions.set(sessionId, stored?.revision ?? 0);
        if (stored !== undefined) this.saved.set(sessionId, structuredClone(stored));
      }
      if (!failedLocal && this.generation === generation && this.current.sessionId === sessionId && this.editSequence === edits && stored !== undefined) this.current = structuredClone(stored);
      return structuredClone(this.saved.get(sessionId) ?? stored ?? empty);
    } catch (error) {
      this.failures.set(sessionId, error instanceof Error ? error : new Error('草稿恢复失败')); throw error;
    } finally { if (this.generation === generation) { this.restoring = false; this.notify(); } }
  }
  update(text: string, contentParts: DraftContent<Part> = this.current?.contentParts ?? { version: 1, parts: [] }): InputDraft<Part> {
    if (this.current === undefined) throw new Error('草稿尚未选择会话');
    if (this.restoring) throw new Error('草稿正在恢复，请稍候');
    if (contentParts.version !== 1 || !Array.isArray(contentParts.parts)) throw new Error('草稿内容版本无效');
    const previous = this.current;
    const next = { ...previous, revision: previous.revision + 1, text, contentParts: structuredClone(contentParts), updatedAt: Date.now() };
    this.current = next; this.saved.set(next.sessionId, structuredClone(next)); this.editSequence++;
    const pending = this.writes.get(next.sessionId) ?? Promise.resolve();
    const write = pending.then(async () => { await this.backend.putDraft(structuredClone(next), previous.revision); this.durableRevisions.set(next.sessionId, next.revision); });
    this.writes.set(next.sessionId, write);
    void write.catch(error => { this.failures.set(next.sessionId, error instanceof Error ? error : new Error('草稿未保存')); this.notify(); });
    this.notify(); return structuredClone(next);
  }
  async flush(sessionId = this.current?.sessionId): Promise<void> {
    if (sessionId === undefined) throw new Error('草稿尚未选择会话');
    await this.writes.get(sessionId);
    const error = this.failures.get(sessionId); if (error !== undefined) throw error;
  }
  clearIfUnchanged(token: { sessionId: string; generation: number; revision: number }): boolean {
    if (!this.accepts(token) || this.current?.revision !== token.revision) return false;
    this.update('', { version: 1, parts: [] }); return true;
  }
  /** Retry a failed durable save only at the current revision. Native sends
   * are never retried here, and a CAS conflict stays visible until reopened. */
  retrySave(): Promise<void> {
    const draft = this.snapshot(); if (draft === undefined) return Promise.reject(new Error('草稿尚未选择会话'));
    // Enter the same write queue synchronously. Edits accepted while the
    // retry reads IndexedDB must follow this exact revision rather than being
    // chained to the failed write or discarded when the retry finishes.
    const pending = this.writes.get(draft.sessionId) ?? Promise.resolve();
    const write = pending.catch(() => undefined).then(async () => {
      const stored = await this.backend.getDraft(draft.sessionId);
      const expected = stored?.revision ?? 0;
      if (stored?.revision === draft.revision && stored.text === draft.text && JSON.stringify(stored.contentParts) === JSON.stringify(draft.contentParts)) {
        this.durableRevisions.set(draft.sessionId, draft.revision);
      } else {
        if (expected !== (this.durableRevisions.get(draft.sessionId) ?? 0) || expected >= draft.revision) throw new DraftConflictError();
        await this.backend.putDraft(structuredClone(draft), expected);
        this.durableRevisions.set(draft.sessionId, draft.revision);
      }
      this.failures.delete(draft.sessionId); this.notify();
    });
    this.writes.set(draft.sessionId, write);
    void write.catch(error => { this.failures.set(draft.sessionId, error instanceof Error ? error : new Error('草稿未保存')); this.notify(); });
    return write;
  }
  /** An explicit conflict choice still uses a fresh CAS. Switching Session
   * while it finishes cannot load this draft into the new Session. */
  resolveConflict(choice: 'local' | 'stored'): Promise<void> {
    const draft = this.snapshot(); const token = this.token();
    if (draft === undefined || token === undefined || this.restoring) return Promise.reject(new Error('草稿正在恢复'));
    this.restoring = true; this.notify();
    const pending = this.writes.get(draft.sessionId) ?? Promise.resolve();
    const write = pending.catch(() => undefined).then(async () => {
      const stored = await this.backend.getDraft(draft.sessionId);
      const expected = stored?.revision ?? 0;
      const selected: InputDraft<Part> = choice === 'local' ? { ...draft, revision: Math.max(draft.revision, expected) + 1, updatedAt: Date.now() }
        : stored ?? { sessionId: draft.sessionId, revision: 0, text: '', contentParts: { version: 1, parts: [] }, updatedAt: Date.now() };
      if (choice === 'local') await this.backend.putDraft(structuredClone(selected), expected);
      this.saved.set(draft.sessionId, structuredClone(selected)); this.durableRevisions.set(draft.sessionId, selected.revision);
      if (this.accepts(token)) { this.current = structuredClone(selected); this.editSequence++; }
      this.failures.delete(draft.sessionId);
    }).catch(error => { this.failures.set(draft.sessionId, error instanceof Error ? error : new Error('草稿冲突未解决')); throw error; })
      .finally(() => { if (this.accepts(token)) this.restoring = false; this.notify(); });
    this.writes.set(draft.sessionId, write); void write.catch(() => undefined); return write;
  }
  replaceFromRemote(persist: (sessionId: string, revision: number) => Promise<InputDraft<Part>>): Promise<void> {
    const token = this.token();
    if (token === undefined || this.restoring) return Promise.reject(new Error('草稿正在恢复'));
    this.restoring = true; this.notify();
    const pending = this.writes.get(token.sessionId) ?? Promise.resolve();
    const write = pending.catch(() => undefined).then(async () => {
      if (!this.accepts(token)) throw new Error('会话已切换，请重新选择草稿');
      const selected = await persist(token.sessionId, token.revision);
      this.saved.set(token.sessionId, structuredClone(selected)); this.durableRevisions.set(token.sessionId, selected.revision);
      if (this.accepts(token)) { this.current = structuredClone(selected); this.editSequence++; }
      this.failures.delete(token.sessionId);
    }).finally(() => { if (this.accepts(token)) this.restoring = false; this.notify(); });
    // A rejected cloud choice has not replaced the local bytes. Keep the
    // prior durability chain usable instead of poisoning later local saves.
    this.writes.set(token.sessionId, write.then(() => undefined, () => pending));
    void write.catch(() => undefined); return write;
  }
}
