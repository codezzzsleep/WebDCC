import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { DraftConflictError, type InputDraft, type InputDraftStore } from './draft-controller.js';
import type { UploadTask, UploadTaskStore } from './upload-controller.js';
import type { InputContent } from '@webdcc/protocol';

export interface RemoteDraftBaseline { sessionId: string; revision: number; text: string; contentParts?: InputContent }

interface PreparationSchema extends DBSchema {
  drafts: { key: string; value: InputDraft };
  uploads: { key: string; value: UploadTask; indexes: { bySession: string } };
  remoteDrafts: { key: string; value: RemoteDraftBaseline };
}
/** Separate database: accepted Blob bytes and draft revisions survive refresh
 * without changing the established timeline/outbox cache's schema. */
export class InputPreparationStore<Part = unknown> implements InputDraftStore<Part>, UploadTaskStore {
  private database?: Promise<IDBPDatabase<PreparationSchema>>;
  constructor(private readonly name = 'webdcc-input-preparation-v1') {}
  private db(): Promise<IDBPDatabase<PreparationSchema>> {
    return this.database ??= openDB<PreparationSchema>(this.name, 2, { upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        database.createObjectStore('drafts', { keyPath: 'sessionId' });
        database.createObjectStore('uploads', { keyPath: 'id' }).createIndex('bySession', 'sessionId');
      }
      database.createObjectStore('remoteDrafts', { keyPath: 'sessionId' });
    } });
  }
  async getDraft(sessionId: string): Promise<InputDraft<Part> | undefined> { return (await (await this.db()).get('drafts', sessionId)) as InputDraft<Part> | undefined; }
  async putDraft(draft: InputDraft<Part>, expectedRevision: number): Promise<void> {
    const tx = (await this.db()).transaction('drafts', 'readwrite');
    const current = await tx.store.get(draft.sessionId);
    if ((current?.revision ?? 0) !== expectedRevision) { tx.abort(); await tx.done.catch(() => undefined); throw new DraftConflictError(); }
    await tx.store.put(draft); await tx.done;
  }
  async getUpload(id: string): Promise<UploadTask | undefined> { return (await this.db()).get('uploads', id); }
  async listUploads(sessionId: string): Promise<UploadTask[]> { return (await this.db()).getAllFromIndex('uploads', 'bySession', sessionId); }
  async putUpload(task: UploadTask): Promise<void> { await (await this.db()).put('uploads', task); }
  async getRemoteDraft(sessionId: string): Promise<RemoteDraftBaseline | undefined> { return (await this.db()).get('remoteDrafts', sessionId); }
  async putRemoteDraft(baseline: RemoteDraftBaseline): Promise<void> { await (await this.db()).put('remoteDrafts', baseline); }
  async close(): Promise<void> { (await this.database)?.close(); this.database = undefined; }
}
