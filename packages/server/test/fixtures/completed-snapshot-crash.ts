import { join } from 'node:path';
import { FakeAdapter } from '@webdcc/fake-adapter';
import type { AdapterEvent, AgentId } from '@webdcc/protocol';
import { openDb } from '../../src/db.js';
import { Store } from '../../src/store.js';
import { SessionManager } from '../../src/manager.js';
const directory = process.argv[2]!; const agent = process.argv[3] as AgentId; const db = openDb(join(directory, 'source.sqlite')); const store = new Store(db);
const manager = new SessionManager(store, { idleDisposeMin: 0 }); const adapter = new FakeAdapter({ id: agent }); let emit!: (id: string, event: AdapterEvent) => void;
adapter.onEvent = callback => { emit = callback; }; adapter.send = async () => undefined; adapter.dispose = async () => undefined; manager.registerAdapter(adapter);
const workspace = store.createWorkspace('completed output crash', directory); const sessions = [];
for (const [kind, data] of [
  ['assistant.message', { text: 'original completed answer', nativePhase: 'final_answer' }],
  ['command', { command: 'original native command', status: 'completed', outputTail: 'original command output', exitCode: 0 }],
  ['tool.call', { name: 'OriginalRead', input: { path: 'original-path', opaque: { original: true } }, status: 'completed', output: 'original tool output' }],
] as const) {
  const session = await manager.createSession({ workspaceId: workspace.id, agent }); const commandId = `original-${session.id}`;
  store.journal.claim({ op: 'send', clientCommandId: commandId, sessionId: session.id, text: 'original input' }); store.journal.acquire(commandId);
  const sent = await manager.send(session.id, { text: 'original input' }, commandId);
  emit(session.id, { type: 'item.start', itemKey: 'retained-hot', kind: 'command', data: { command: 'original unfinished command', status: 'running', outputTail: 'original unfinished output' } });
  const queued = await manager.send(session.id, { text: 'keep queued' });
  db.exec("CREATE TRIGGER reject_completion BEFORE INSERT ON events WHEN NEW.item_key = 'target-completion' BEGIN SELECT RAISE(ABORT, 'completion publication failed'); END");
  const native = { message_id: `original-${kind}`, agent_id: 'original-actor', parent_tool_use_id: 'original-parent', request_id: `original-request-${kind}`, opaque: { original: true } };
  emit(session.id, { type: 'item.complete', itemKey: 'target-completion', kind, data, native }); db.exec('DROP TRIGGER reject_completion');
  const rawId = store.nativeEvents.list(session.id, 0, 500).at(-1)!.id;
  sessions.push({ sessionId: session.id, turnId: sent.turnId, queuedTurnId: queued.turnId, commandId, kind, data, native, rawId, identity: manager.getRuntime(session.id)!.identity });
}
process.send?.({ agent, sessions }); setInterval(() => undefined, 1000);
