import { join } from 'node:path';
import { FakeAdapter } from '@webdcc/fake-adapter';
import type { AdapterEvent } from '@webdcc/protocol';
import { openDb } from '../../src/db.js';
import { Store } from '../../src/store.js';
import { SessionManager } from '../../src/manager.js';
const directory = process.argv[2]!; const db = openDb(join(directory, 'source.sqlite')); const store = new Store(db); const manager = new SessionManager(store, { idleDisposeMin: 0 }); const adapter = new FakeAdapter({ id: 'claude-code' });
let callback!: (id: string, event: AdapterEvent) => void; adapter.onEvent = cb => { callback = cb; }; adapter.send = async () => undefined; adapter.dispose = async () => undefined; manager.registerAdapter(adapter);
const workspace = store.createWorkspace('publication crash', directory); const session = await manager.createSession({ workspaceId: workspace.id, agent: 'claude-code' });
const commandId = 'original-crash-command'; store.journal.claim({ op: 'send', clientCommandId: commandId, sessionId: session.id, text: 'original input' }); store.journal.acquire(commandId);
const sent = await manager.send(session.id, { text: 'original input' }, commandId);
db.exec("CREATE TRIGGER reject_publication BEFORE INSERT ON events WHEN NEW.kind = 'assistant.message' BEGIN SELECT RAISE(ABORT, 'publication failed'); END");
let escaped: string | null = null; try { callback(session.id, { type: 'item.complete', itemKey: 'original answer', kind: 'assistant.message', data: { text: 'original completed answer' }, native: { message_id: 'original message', agent_id: 'original actor', parent_tool_use_id: 'original parent' } }); } catch (error) { escaped = String(error); }
db.exec('DROP TRIGGER reject_publication'); process.send?.({ sessionId: session.id, turnId: sent.turnId, escaped, rawId: store.nativeEvents.list(session.id, 0, 500).at(-1)!.id }); setInterval(() => undefined, 1000);
