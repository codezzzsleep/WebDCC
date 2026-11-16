import { join } from 'node:path';
import { openDb } from '../../src/db.js';
import { Store } from '../../src/store.js';

const directory = process.argv[2]!;
const db = openDb(join(directory, 'opening.sqlite')); const store = new Store(db);
const workspace = store.createWorkspace('opening crash', directory);
const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
const other = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
const old = store.nativeOwners.acquire('old', session.id, 'codex', 'old-native');
store.nativeOwners.activate(session.id, old, 'old-native'); store.nativeOwners.release(session.id, old, true);
const current = store.nativeOwners.acquire('opening', session.id, 'codex', 'new-native');
process.send?.({ sessionId: session.id, otherId: other.id, generation: current.generation });
setInterval(() => undefined, 1000);
