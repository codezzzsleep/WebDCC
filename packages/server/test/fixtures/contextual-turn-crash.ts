import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeAdapter } from '@webdcc/fake-adapter';
import type { AdapterEvent, AgentId } from '@webdcc/protocol';
import { openDb } from '../../src/db.js';
import { Store } from '../../src/store.js';
import { SessionManager } from '../../src/manager.js';
const directory = process.argv[2]!; const agent = process.argv[3] as AgentId;
const db = openDb(join(directory, 'source.sqlite')); const store = new Store(db); const manager = new SessionManager(store, { idleDisposeMin: 0 });
const adapter = new FakeAdapter({ id: agent }); let callback!: (id: string, event: AdapterEvent) => void; let sends = 0;
adapter.onEvent = cb => { callback = cb; }; adapter.send = async () => { sends++; }; adapter.dispose = async () => undefined; manager.registerAdapter(adapter);
const workspace = store.createWorkspace('actual context SIGKILL', directory);
db.exec("CREATE TRIGGER reject_native_end BEFORE INSERT ON events WHEN NEW.kind = 'turn.completed' BEGIN SELECT RAISE(ABORT, 'actual terminal INSERT failed'); END");
const cases = [];
for (const status of ['completed', 'failed', 'interrupted'] as const) {
  const session = await manager.createSession({ workspaceId: workspace.id, agent }); const commandId = `original-${status}`;
  store.journal.claim({ op: 'send', sessionId: session.id, clientCommandId: commandId, text: `original-${status}` }); store.journal.acquire(commandId);
  const sent = await manager.send(session.id, { text: `original-${status}` }, commandId); const identity = manager.getRuntime(session.id)!.identity;
  callback(session.id, { type: 'turn.end', runtime: identity, status, usage: { inputTokens: 7, outputTokens: 3 }, native: { original: true, requestId: `original-${status}` } });
  cases.push({ sessionId: session.id, turnId: sent.turnId, identity, status, commandId });
}
// Exercise the actual completed-turn timer rather than invoking its action.
await new Promise(resolve => setTimeout(resolve, 1700));
const before = cases.map(value => ({ ...value, owner: store.nativeOwners.get(value.sessionId), command: store.journal.get(value.commandId), queue: store.journal.queue(value.sessionId), events: store.allEvents(value.sessionId),
  raw: store.nativeEvents.list(value.sessionId, 0, 500).map(row => store.nativeEvents.get(row.id)) }));
await writeFile(join(directory, 'before.json'), JSON.stringify({ agent, sends, before }, null, 2));
process.send?.({ agent, sends, cases }); setInterval(() => undefined, 60_000);
