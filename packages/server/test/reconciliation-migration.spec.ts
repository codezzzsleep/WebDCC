import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, openDb } from '../src/db.js';
import { Store } from '../src/store.js';

it('NP-47 v7 ownership and old URL, events, queue and result survive the repeatable v8 recovery migration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-recovery-migrate-')); const file = join(directory, 'old.sqlite');
  let db = openDb(file);
  try {
    let store = new Store(db); const workspace = store.createWorkspace('old', '/tmp'); const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    store.updateSession(session.id, { nativeId: 'old-native' });
    const identity = store.nativeOwners.acquire('old-owner', session.id, 'codex', 'old-native');
    store.nativeOwners.activate(session.id, identity, 'old-native'); store.nativeOwners.observe(session.id, identity, 'old-turn', 28);
    store.appendEvent({ sessionId: session.id, turnId: 'turn', itemKey: 'old', kind: 'user.message', data: { text: 'preserve old event' } });
    store.journal.claim({ clientCommandId: 'queued', op: 'send', sessionId: session.id, text: 'preserve queue' });
    store.journal.enqueue('queued', session.id, 'queue-turn', { text: 'preserve queue' }); store.journal.state('queued', 'queued', { queued: true, turnId: 'queue-turn' });
    db.exec('DROP TABLE native_reconciliations; ALTER TABLE native_owners DROP COLUMN managed_process;');
    db.pragma('user_version = 7'); db.close();
    db = openDb(file); store = new Store(db);
    expect(store.getSession(session.id)).toMatchObject({ id: session.id, nativeId: 'old-native' });
    expect(store.allEvents(session.id)[0]?.data).toEqual({ text: 'preserve old event' });
    expect(store.nativeOwners.get(session.id)).toMatchObject({ ownerId: 'old-owner', activeNativeTurnId: 'old-turn', lastObservedSeq: 28 });
    expect(store.nativeOwners.managedProcess(session.id)).toBeNull();
    expect(store.journal.get('queued')).toMatchObject({ state: 'queued', result: { queued: true, turnId: 'queue-turn' } });
    expect(store.journal.queue(session.id)[0]?.input.text).toBe('preserve queue');
    expect(store.reconciliations.get(session.id)).toBeNull(); db.close();
    db = openDb(file); expect(CURRENT_SCHEMA_VERSION).toBe(8);
    expect(new Store(db).allEvents(session.id)).toHaveLength(1);
  } finally { if (db.open) db.close(); await rm(directory, { recursive: true, force: true }); }
});
