import { join } from 'node:path';
import { FakeAdapter } from '@webdcc/fake-adapter';
import type { AdapterEvent } from '@webdcc/protocol';
import { openDb } from '../../src/db.js';
import { Store } from '../../src/store.js';
import { SessionManager } from '../../src/manager.js';

const directory = process.argv[2]!; const db = openDb(join(directory, 'state.db')); const store = new Store(db);
const manager = new SessionManager(store, { idleDisposeMin: 0 }); const adapter = new FakeAdapter({ id: 'codex' });
let emit!: (id: string, event: AdapterEvent) => void; adapter.onEvent = callback => { emit = callback; };
adapter.send = async id => { emit(id, { type: 'turn.start', nativeTurnId: 'native-uncertain' }); throw new Error('response lost before process crash'); };
manager.registerAdapter(adapter);
const workspace = store.createWorkspace('uncertain crash', directory); const session = await manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
store.journal.claim({ op: 'send', clientCommandId: 'crash-command', sessionId: session.id, text: 'kept original' });
try { await manager.send(session.id, { text: 'kept original' }, 'crash-command'); } catch { /* Expected unknown outcome; evidence is persisted before SIGKILL. */ }
const row = store.journal.queue(session.id)[0]!;
process.send?.({ sessionId: session.id, turnId: row.turnId, nativeRequestId: store.journal.nativeRequestId(row.turnId), owner: store.nativeOwners.get(session.id) });
setInterval(() => undefined, 1000);
