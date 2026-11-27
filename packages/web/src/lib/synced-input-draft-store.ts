import { isInputContent, type DraftDto, type InputContent } from '@webdcc/protocol';
import { api } from './api.js';
import type { InputDraft, InputDraftStore } from './draft-controller.js';
import type { PreparedPart } from './composer-input-controller.js';
import type { InputPreparationStore, RemoteDraftBaseline } from './input-preparation-store.js';
import type { UploadController } from './upload-controller.js';

export interface DraftSyncState { pending: boolean; error?: string; conflict?: boolean; syncedRevision?: number }
const databaseQueues = new Map<string, Map<string, Promise<void>>>();
const objectQueues = new WeakMap<object, Map<string, Promise<void>>>();
const contentOf = (draft: DraftDto): InputContent => draft.contentParts ?? { version: 1, parts: [
  ...(draft.text === '' ? [] : [{ type: 'text' as const, text: draft.text }]),
  ...draft.fileIds.map(fileId => ({ type: 'image' as const, fileId })),
] };
const sameContent = (left: { text: string; contentParts?: InputContent }, right: { text: string; contentParts?: InputContent }): boolean =>
  left.text === right.text && JSON.stringify(left.contentParts) === JSON.stringify(right.contentParts);
const baselineOf = (sessionId: string, draft: DraftDto): RemoteDraftBaseline => ({ sessionId, revision: draft.revision, text: draft.text, contentParts: contentOf(draft) });
/** The complete local draft is always durable first. Server CAS has an
 * independent persistent revision, so offline edits cannot invent a server
 * revision or silently replace another device's draft. */
export class SyncedInputDraftStore implements InputDraftStore<PreparedPart> {
  private readonly jobs: Map<string, Promise<void>>;
  private readonly pending = new Map<string, number>();
  private readonly states = new Map<string, DraftSyncState>();
  private readonly listeners = new Set<() => void>();
  private readonly lockScope?: string;
  constructor(private readonly local: InputPreparationStore<PreparedPart>, private readonly uploads: UploadController,
    private readonly initial?: (sessionId: string) => { text: string; fileIds: string[] }) {
    const scope = typeof local.syncScope === 'function' ? local.syncScope() : undefined;
    this.lockScope = scope;
    const queues = scope === undefined ? objectQueues.get(local) : databaseQueues.get(scope);
    this.jobs = queues ?? new Map();
    if (scope === undefined) objectQueues.set(local, this.jobs); else databaseQueues.set(scope, this.jobs);
  }
  private enqueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const pending = this.jobs.get(sessionId) ?? Promise.resolve();
    this.pending.set(sessionId, (this.pending.get(sessionId) ?? 0) + 1);
    this.stateChanged(sessionId, { ...this.states.get(sessionId), pending: true });
    const result = pending.then(async () => {
      this.stateChanged(sessionId, { pending: true, syncedRevision: this.states.get(sessionId)?.syncedRevision });
      // JavaScript queues are page-local. Web Locks serialize shared
      // IndexedDB baselines across tabs without locking out other devices.
      return this.lockScope !== undefined && typeof navigator !== 'undefined' && navigator.locks !== undefined
        ? navigator.locks.request(`webdcc:draft:${JSON.stringify([this.lockScope, sessionId])}`, operation)
        : operation();
    }).catch(error => {
      this.stateChanged(sessionId, { pending: true, syncedRevision: this.states.get(sessionId)?.syncedRevision,
        error: error instanceof Error ? error.message : '云端草稿同步失败', conflict: (error as { status?: number } | null)?.status === 409 });
      throw error;
    }).finally(() => {
      const count = Math.max(0, (this.pending.get(sessionId) ?? 1) - 1); this.pending.set(sessionId, count);
      const state = this.states.get(sessionId);
      this.stateChanged(sessionId, { ...state, pending: count > 0 || state?.error !== undefined });
    });
    this.jobs.set(sessionId, result.then(() => undefined, () => undefined));
    return result;
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  state(sessionId: string): DraftSyncState | undefined { return this.states.get(sessionId); }
  private stateChanged(sessionId: string, state: DraftSyncState): void {
    this.states.set(sessionId, state); for (const listener of this.listeners) { try { listener(); } catch { /* view only */ } }
  }
  async getDraft(sessionId: string): Promise<InputDraft<PreparedPart> | undefined> {
    const local = await this.local.getDraft(sessionId);
    if (local !== undefined || sessionId.startsWith('new:')) {
      if (local !== undefined) void this.sync(sessionId);
      return local;
    }
    const initial = this.initial?.(sessionId);
    if (initial !== undefined && (initial.text !== '' || initial.fileIds.length > 0)) {
      const draft: InputDraft<PreparedPart> = { sessionId, revision: 0, text: initial.text, contentParts: {
        version: 1, parts: initial.fileIds.map(fileId => ({ type: 'image', fileId })),
      }, updatedAt: Date.now() };
      await this.local.putDraft(draft, 0); return draft;
    }
    try {
      return await this.enqueue(sessionId, async () => {
        const existing = await this.local.getDraft(sessionId); if (existing !== undefined) return existing;
        const expectedBaseline = await this.local.getRemoteDraft(sessionId);
        const remote = await api.draft(sessionId); const contentParts = contentOf(remote);
        const selected = await this.local.adoptRemoteDraft({ sessionId, revision: remote.revision, text: remote.text, contentParts }, undefined, expectedBaseline);
        this.stateChanged(sessionId, { pending: true, syncedRevision: selected.revision });
        return selected;
      });
    } catch (error) {
      this.stateChanged(sessionId, { pending: true, error: error instanceof Error ? `云端草稿未读取：${error.message}` : '云端草稿未读取' });
      return undefined;
    }
  }

  async putDraft(draft: InputDraft<PreparedPart>, expectedRevision: number): Promise<void> {
    await this.local.putDraft(draft, expectedRevision);
    void this.sync(draft.sessionId);
  }
  private async prepared(draft: InputDraft<PreparedPart>): Promise<InputContent> {
    const parts: PreparedPart[] = [];
    for (const part of draft.contentParts.parts) {
      const { uploadTaskId, ...selected } = part;
      if (uploadTaskId === undefined) { parts.push(selected); continue; }
      const task = this.uploads.get(uploadTaskId) ?? await this.local.getUpload(uploadTaskId);
      if (task?.sessionId !== draft.sessionId || task.state !== 'completed' || task.fileId === undefined) throw new Error('本机附件上传完成后将同步完整草稿');
      parts.push({ ...selected, fileId: task.fileId });
    }
    const textParts = parts.filter(part => part.type === 'text');
    if (textParts.length === 1 && textParts[0]!.elements?.length && textParts[0]!.text !== draft.text) throw new Error('原生文字元素与编辑后的正文不一致，请重新准备');
    if (textParts.length === 0 && draft.text !== '') parts.unshift({ type: 'text', text: draft.text });
    if (textParts.length === 1) parts[parts.indexOf(textParts[0]!)] = { ...textParts[0]!, text: draft.text };
    const content = { ...draft.contentParts, version: 1, parts };
    if (!isInputContent(content, draft.text)) throw new Error('草稿的结构化内容需要核对后才能同步');
    return content;
  }
  private async acceptBaseline(next: RemoteDraftBaseline, expected: RemoteDraftBaseline): Promise<void> {
    try { await this.local.compareRemoteDraft(next, expected); }
    catch (error) {
      const current = await this.local.getRemoteDraft(next.sessionId);
      // On HTTP origins without Web Locks another tab can have already
      // reconciled this exact save, or accepted a later server revision.
      if (current !== undefined && (current.revision > next.revision || current.revision === next.revision && sameContent(current, next))) return;
      throw error;
    }
  }
  private async recoverWrite(baseline: RemoteDraftBaseline): Promise<RemoteDraftBaseline> {
    const remote = baselineOf(baseline.sessionId, await api.draft(baseline.sessionId));
    if (remote.revision > baseline.revision && (sameContent(remote, baseline.pendingWrite!) || sameContent(remote, baseline))) {
      // Exact submitted content needs no rewrite. Unchanged baseline content
      // at a newer revision can safely be used for a fresh CAS; it does not
      // authorize overwriting different content from another device.
      await this.acceptBaseline(remote, baseline); return remote;
    }
    if (remote.revision === baseline.revision && sameContent(remote, baseline)) {
      await this.acceptBaseline(remote, baseline); return remote;
    }
    throw Object.assign(new Error('云端草稿与待确认的保存不同，本机内容已保留，请核对后处理'), { status: 409 });
  }
  private async syncNow(sessionId: string, canRebase = true): Promise<void> {
    const draft = await this.local.getDraft(sessionId); if (draft === undefined) return;
    const content = await this.prepared(draft);
    let baseline = await this.local.getRemoteDraft(sessionId);
    if (baseline?.pendingWrite !== undefined) baseline = await this.recoverWrite(baseline);
    if (baseline === undefined) {
      const remote = await api.draft(sessionId); const remoteContent = contentOf(remote);
      if (remote.text !== '' || remoteContent.parts.length > 0 || remoteContent.collaborationMode !== undefined) {
        if (remote.text !== draft.text || JSON.stringify(remoteContent) !== JSON.stringify(content)) throw Object.assign(new Error('云端已有另一份草稿，本机内容已保留，请核对后处理'), { status: 409 });
      }
      baseline = { sessionId, revision: remote.revision, text: remote.text, contentParts: remoteContent };
      await this.local.compareRemoteDraft(baseline, undefined);
    }
    if (baseline.text !== draft.text || JSON.stringify(baseline.contentParts) !== JSON.stringify(content)) {
      const pending = { ...baseline, pendingWrite: { text: draft.text, contentParts: content } };
      await this.local.compareRemoteDraft(pending, baseline);
      let next: RemoteDraftBaseline;
      try {
        const saved = await api.saveInputDraft(sessionId, draft.text, content, baseline.revision);
        next = baselineOf(sessionId, saved);
        if (next.revision !== baseline.revision + 1 || !sameContent(next, pending.pendingWrite)) throw new Error('保存草稿返回的版本或内容不一致');
      } catch (error) {
        // A response can be lost after commit. Reconcile matching content;
        // older installations may also have an obsolete baseline revision.
        next = await this.recoverWrite(pending).catch(() => { throw error; });
        if (!sameContent(next, pending.pendingWrite)) {
          if (next.revision > baseline.revision && canRebase) return this.syncNow(sessionId, false);
          throw error;
        }
      }
      await this.acceptBaseline(next, pending);
    }
    this.stateChanged(sessionId, { pending: true, syncedRevision: draft.revision });
  }
  sync(sessionId: string): Promise<void> {
    if (sessionId.startsWith('new:')) return Promise.resolve();
    return this.enqueue(sessionId, () => this.syncNow(sessionId)).catch(() => undefined);
  }
  /** Conflict choices join the same queue as GET/PUT synchronization. An old
   * GET cannot overwrite a later PUT response or its baseline revision. */
  useLocal(sessionId: string): Promise<void> {
    return this.enqueue(sessionId, async () => {
      const expected = await this.local.getRemoteDraft(sessionId);
      const remote = await api.draft(sessionId);
      await this.local.compareRemoteDraft({ sessionId, revision: remote.revision, text: remote.text, contentParts: contentOf(remote) }, expected);
      await this.syncNow(sessionId);
    });
  }
  useRemote(sessionId: string, localRevision: number): Promise<InputDraft<PreparedPart>> {
    return this.enqueue(sessionId, async () => {
      const expected = await this.local.getRemoteDraft(sessionId);
      const remote = await api.draft(sessionId); const contentParts = contentOf(remote);
      const selected = await this.local.adoptRemoteDraft({ sessionId, revision: remote.revision, text: remote.text, contentParts }, localRevision, expected);
      this.stateChanged(sessionId, { pending: true, syncedRevision: selected.revision });
      return selected;
    });
  }
  /** Inspection has no authority to change either the local draft or the
   * baseline used by later CAS writes. */
  async readRemote(sessionId: string): Promise<{ text: string; contentParts: InputContent }> {
    const remote = await api.draft(sessionId); return { text: remote.text, contentParts: contentOf(remote) };
  }
}
