/** IndexedDB 缓存（SPEC 7.5） */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { SessionDto, StoredEvent } from '@webdcc/protocol';

export interface CachedSession {
  id: string;
  workspaceId: string;
  agent: string;
  title?: string;
  status: string;
  updatedAt: string;
  pinned?: boolean;
  archived?: boolean;
  providerId?: string | null;
  model?: string;
  reasoningEffort?: string;
  accessMode?: string;
  parentId?: string;
  handoffKind?: SessionDto['handoffKind'];
}

export interface CachedDraft {
  sessionId: string;
  text: string;
  fileIds: string[];
}

export interface CachedCommand {
  clientCommandId: string;
  command: unknown;
  status: 'pending' | 'sent' | 'failed' | 'uncertain';
  createdAt: number;
}

interface WebdccSchema extends DBSchema {
  events: { key: [string, number]; value: StoredEvent; indexes: { bySession: string } };
  sessions: { key: string; value: CachedSession };
  meta: { key: string; value: unknown };
  drafts: { key: string; value: CachedDraft };
  outbox: { key: string; value: CachedCommand };
}

let dbPromise: Promise<IDBPDatabase<WebdccSchema>> | null = null;

function db(): Promise<IDBPDatabase<WebdccSchema>> {
  dbPromise ??= openDB<WebdccSchema>('webdcc', 1, {
    upgrade(database) {
      const events = database.createObjectStore('events', { keyPath: ['sessionId', 'seq'] });
      events.createIndex('bySession', 'sessionId');
      database.createObjectStore('sessions', { keyPath: 'id' });
      database.createObjectStore('meta');
      database.createObjectStore('drafts', { keyPath: 'sessionId' });
      database.createObjectStore('outbox', { keyPath: 'clientCommandId' });
    },
  });
  return dbPromise;
}

export const cache = {
  async putEvents(events: StoredEvent[]): Promise<void> {
    if (events.length === 0) return;
    const database = await db();
    const tx = database.transaction('events', 'readwrite');
    for (const event of events) void tx.store.put(event);
    await tx.done;
  },

  async getEvents(sessionId: string, limit = 500): Promise<StoredEvent[]> {
    const database = await db();
    const events: StoredEvent[] = [];
    let cursor = await database.transaction('events').store.index('bySession').openCursor(sessionId, 'prev');
    while (cursor !== null && events.length < limit) { events.push(cursor.value); cursor = await cursor.continue(); }
    return events.sort((a, b) => a.seq - b.seq);
  },

  async getEventsAfter(sessionId: string, afterSeq: number): Promise<StoredEvent[]> {
    const database = await db();
    const range = IDBKeyRange.bound([sessionId, afterSeq + 1], [sessionId, Number.MAX_SAFE_INTEGER]);
    return database.getAll('events', range);
  },

  async countEvents(sessionId: string): Promise<number> {
    const database = await db();
    return database.count('events', IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]));
  },

  async maxSeq(sessionId: string): Promise<number> {
    const database = await db();
    const cursor = await database.transaction('events').store.index('bySession').openCursor(sessionId, 'prev');
    return cursor?.value.seq ?? 0;
  },

  async putSession(session: CachedSession): Promise<void> {
    const database = await db();
    await database.put('sessions', session);
  },

  async getSessions(): Promise<CachedSession[]> {
    const database = await db();
    return database.getAll('sessions');
  },

  async setMeta(key: string, value: unknown): Promise<void> {
    const database = await db();
    await database.put('meta', value, key);
  },

  async getMeta<T>(key: string): Promise<T | undefined> {
    const database = await db();
    return (await database.get('meta', key)) as T | undefined;
  },

  async putDraft(draft: CachedDraft): Promise<void> {
    const database = await db();
    await database.put('drafts', draft);
  },

  async getDraft(sessionId: string): Promise<CachedDraft | undefined> {
    const database = await db();
    return database.get('drafts', sessionId);
  },

  async putOutbox(entry: CachedCommand): Promise<void> {
    const database = await db();
    await database.put('outbox', entry);
  },

  async deleteOutbox(clientCommandId: string): Promise<void> {
    const database = await db();
    await database.delete('outbox', clientCommandId);
  },

  async getOutbox(): Promise<CachedCommand[]> {
    const database = await db();
    const entries = await database.getAll('outbox');
    return entries.sort((a, b) => a.createdAt - b.createdAt);
  },
};
