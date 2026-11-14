import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';

it('NP-07/47 migrates legacy selection as unverified intent while preserving session URL identity and events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-permission-migration-'));
  const file = join(directory, 'db.sqlite');
  let db = openDb(file);
  try {
    let store = new Store(db);
    const workspace = store.createWorkspace('legacy', directory);
    const session = store.createSession({ workspaceId: workspace.id, agent: 'codex', accessMode: 'workspace' });
    const saved = store.appendEvent({ sessionId: session.id, turnId: 'turn', kind: 'user.message', itemKey: 'user', data: { text: 'original\r\n' } });
    db.close();
    const legacy = new Database(file);
    legacy.exec('ALTER TABLE sessions DROP COLUMN permission_state');
    legacy.pragma('user_version = 3');
    legacy.close();
    db = openDb(file);
    store = new Store(db);
    expect(store.getSession(session.id)).toMatchObject({ id: session.id, accessMode: 'workspace', permissions: { requested: 'workspace', effective: null, phase: 'unknown' } });
    expect(store.allEvents(session.id)).toEqual([saved]);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});
