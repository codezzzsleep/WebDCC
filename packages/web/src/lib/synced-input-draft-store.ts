import { isInputContent, type DraftDto, type InputContent } from '@webdcc/protocol';
import { api } from './api.js';
import type { InputDraft, InputDraftStore } from './draft-controller.js';
import type { PreparedPart } from './composer-input-controller.js';
import type { InputPreparationStore, RemoteDraftBaseline } from './input-preparation-store.js';
import type { UploadController } from './upload-controller.js';

export interface DraftSyncState { pending: boolean; error?: string; conflict?: boolean }
const contentOf = (draft: DraftDto): InputContent => draft.contentParts ?? { version: 1, parts: [
  ...(draft.text === '' ? [] : [{ type: 'text' as const, text: draft.text }]),
  ...draft.fileIds.map(fileId => ({ type: 'image' as const, fileId })),
] };
/** The complete local draft is always durable first. Server CAS has an
 * independent persistent revision, so offline edits cannot invent a server
 * revision or silently replace another device's draft. */
export class SyncedInputDraftStore implements InputDraftStore<PreparedPart> {
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly states = new Map<string, DraftSyncState>();
  private readonly listeners = new Set<() => void>();
  constructor(private readonly local: InputPreparationStore<PreparedPart>, private readonly uploads: UploadController,
    private readonly initial?: (sessionId: string) => { text: string; fileIds: string[] }) {}
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
      const remote = await api.draft(sessionId);
      const contentParts = contentOf(remote);
      await this.local.putRemoteDraft({ sessionId, revision: remote.revision, text: remote.text, contentParts });
      const draft: InputDraft<PreparedPart> = { sessionId, revision: 0, text: remote.text, contentParts, updatedAt: Date.parse(remote.updatedAt) || Date.now() };
      await this.local.putDraft(draft, 0); return draft;
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
    const content = { version: 1, parts };
    if (!isInputContent(content, draft.text)) throw new Error('草稿的结构化内容需要核对后才能同步');
    return content;
  }
  sync(sessionId: string): Promise<void> {
    if (sessionId.startsWith('new:')) return Promise.resolve();
    const pending = this.jobs.get(sessionId) ?? Promise.resolve();
    const job = pending.then(async () => {
      const draft = await this.local.getDraft(sessionId); if (draft === undefined) return;
      this.stateChanged(sessionId, { pending: true });
      const content = await this.prepared(draft);
      let baseline = await this.local.getRemoteDraft(sessionId);
      if (baseline === undefined) {
        const remote = await api.draft(sessionId); const remoteContent = contentOf(remote);
        if (remote.text !== '' || remoteContent.parts.length > 0) {
          if (remote.text !== draft.text || JSON.stringify(remoteContent) !== JSON.stringify(content)) throw Object.assign(new Error('云端已有另一份草稿，本机内容已保留，请核对后处理'), { status: 409 });
        }
        baseline = { sessionId, revision: remote.revision, text: remote.text, contentParts: remoteContent };
        await this.local.putRemoteDraft(baseline);
      }
      if (baseline.text !== draft.text || JSON.stringify(baseline.contentParts) !== JSON.stringify(content)) {
        const saved = await api.saveInputDraft(sessionId, draft.text, content, baseline.revision);
        const next: RemoteDraftBaseline = { sessionId, revision: saved.revision, text: saved.text, contentParts: contentOf(saved) };
        await this.local.putRemoteDraft(next);
      }
      this.stateChanged(sessionId, { pending: false });
    }).catch(error => { this.stateChanged(sessionId, { pending: true, error: error instanceof Error ? error.message : '云端草稿同步失败', conflict: (error as { status?: number } | null)?.status === 409 }); });
    this.jobs.set(sessionId, job); return job;
  }
  /** User-selected conflict resolution still uses the fresh server revision
   * as a CAS precondition; a concurrent device edit may reject it again. */
  async useLocal(sessionId: string): Promise<void> {
    await this.jobs.get(sessionId);
    const remote = await api.draft(sessionId);
    await this.local.putRemoteDraft({ sessionId, revision: remote.revision, text: remote.text, contentParts: contentOf(remote) });
    await this.sync(sessionId);
  }
  async readRemote(sessionId: string): Promise<{ text: string; contentParts: InputContent }> {
    await this.jobs.get(sessionId);
    const remote = await api.draft(sessionId); const contentParts = contentOf(remote);
    await this.local.putRemoteDraft({ sessionId, revision: remote.revision, text: remote.text, contentParts });
    return { text: remote.text, contentParts };
  }
}
