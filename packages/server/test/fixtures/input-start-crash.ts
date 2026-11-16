import { join } from 'node:path';
import { FakeAdapter } from '../../../testing/fake-adapter/src/index.js';
import { openDb } from '../../src/db.js';
import { Store } from '../../src/store.js';
import { SessionManager } from '../../src/manager.js';
import { FileStore } from '../../src/files.js';
import { CommandDispatcher } from '../../src/dispatcher.js';

const directory = process.argv[2];
if (directory === undefined) throw new Error('Missing isolated directory');
const db = openDb(join(directory, 'state.db')); const store = new Store(db);
const manager = new SessionManager(store, { idleDisposeMin: 0 });
const adapter = new FakeAdapter({ id: 'codex' }); manager.registerAdapter(adapter);
const workspace = store.createWorkspace('dispatch crash', directory);
const session = await manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
const command = { op: 'send' as const, clientCommandId: 'dispatch-crash', sessionId: session.id, text: ' original before acceptance\r\n' };
adapter.send = async (_sessionId, input) => {
  if (store.journal.get(command.clientCommandId)?.state !== 'dispatching' || store.allEvents(session.id).length !== 2) throw new Error('Missing committed admission');
  const waiting = setInterval(() => undefined, 1000);
  process.send?.({ command, identity: manager.getRuntime(session.id)!.identity, nativeRequestId: input.nativeRequestId });
  try { await new Promise<void>(() => undefined); } finally { clearInterval(waiting); }
};
const files = new FileStore(directory, store); await files.init();
const dispatcher = new CommandDispatcher(store, manager, files);
await dispatcher.dispatch(command);
throw new Error('Dispatch fixture unexpectedly received a native response');
