import { join } from 'node:path';
import { FakeAdapter } from '@webdcc/fake-adapter';
import type { AdapterEvent, AgentId } from '@webdcc/protocol';
import { openDb } from '../../src/db.js';
import { Store } from '../../src/store.js';
import { SessionManager } from '../../src/manager.js';

// Controlled Adapter events exercise source capture and recovery. No official
// Agent process, provider, prompt, tool or permission is changed or invoked.
const directory = process.argv[2]!; const agent = process.argv[3] as AgentId;
const db = openDb(join(directory, 'source.sqlite')); const store = new Store(db);
const manager = new SessionManager(store, { idleDisposeMin: 0 });
const adapter = new FakeAdapter({ id: agent }); let emit!: (id: string, event: AdapterEvent) => void;
adapter.onEvent = callback => { emit = callback; }; adapter.send = async () => undefined;
adapter.dispose = async () => undefined; manager.registerAdapter(adapter);
const workspace = store.createWorkspace('Markdown recovery', directory); const sessions = [];
const examples: { name: string; text: string; masked?: boolean; legacy?: boolean }[] = [
  { name: 'emphasis', text: '***重点***' },
  { name: 'divider', text: 'before\n\n***\n\nafter' },
  { name: 'masked', text: 'abc', masked: true },
  { name: 'legacy', text: '***', legacy: true },
];
for (const example of examples) {
  const session = await manager.createSession({ workspaceId: workspace.id, agent });
  const commandId = `markdown-${session.id}`;
  store.journal.claim({ op: 'send', clientCommandId: commandId, sessionId: session.id, text: 'original input' });
  store.journal.acquire(commandId);
  const sent = await manager.send(session.id, { text: 'original input' }, commandId);
  if (example.masked) store.nativeEvents.addSecret(example.text);
  db.exec("CREATE TRIGGER reject_markdown BEFORE INSERT ON events WHEN NEW.item_key = 'markdown-output' BEGIN SELECT RAISE(ABORT, 'Markdown publication failed'); END");
  const data = { text: example.text, nativePhase: 'final_answer' };
  emit(session.id, { type: 'item.complete', itemKey: 'markdown-output', kind: 'assistant.message', data,
    native: { message_id: example.name, opaque: { original: true } } });
  db.exec('DROP TRIGGER reject_markdown');
  const rawId = store.nativeEvents.list(session.id, 0, 500).at(-1)!.id;
  if (example.legacy) db.prepare('UPDATE native_event_envelopes SET payload_redacted = NULL WHERE id = ?').run(rawId);
  sessions.push({ name: example.name, sessionId: session.id, turnId: sent.turnId, commandId, rawId,
    available: !example.masked && !example.legacy, data, raw: store.nativeEvents.get(rawId) });
}
process.send?.({ agent, sessions }); setInterval(() => undefined, 1000);
