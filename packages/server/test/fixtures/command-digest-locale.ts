import { dirname, join } from 'node:path';
import { openDb } from '../../src/db.js';
import { Store } from '../../src/store.js';
import { payloadHash } from '../../src/command-journal.js';
import { FileStore } from '../../src/files.js';
import { SessionManager } from '../../src/manager.js';
import { CommandDispatcher } from '../../src/dispatcher.js';
import type { Command, EventData } from '@webdcc/protocol';

const file = process.argv[2]!; const mode = process.argv[3]!;
const db = openDb(file); const store = new Store(db);
let manager: SessionManager | undefined;
try {
  const previous = store.journal.get('locale-command');
  let sessionId = previous?.sessionId ?? 'locale-session';
  if (mode === 'secret') {
    if (store.getSession(sessionId) === undefined) {
      const workspace = store.createWorkspace('secret fixture', dirname(file));
      sessionId = store.createSession({ workspaceId: workspace.id, agent: 'claude-code' }).id;
    }
    store.interactions.observe({ sessionId, kind: 'question', data: { questionId: 'locale-question', prompt: 'controlled', status: 'pending', isSecret: true } as EventData['question'] });
  }
  const command: Command = { op: 'answer', sessionId, questionId: 'locale-question', clientCommandId: 'locale-command',
    answer: { 'ä': process.argv[4] === 'different' ? 'different' : 'first', z: 'second' } };
  if (mode.startsWith('seed-')) {
    const digest = mode === 'seed-future' ? 'future-format:unknown' : payloadHash(command);
    const payload = mode === 'seed-redacted' ? { ...command, answer: { omitted: 'sensitive-answer' } } : command;
    db.prepare('INSERT INTO command_journal (command_id,payload_hash,payload,op,session_id,state,result,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(command.clientCommandId, digest, JSON.stringify(payload), command.op, sessionId, 'completed', JSON.stringify({ ok: true, value: { original: 'legacy receipt' } }), new Date(0).toISOString());
    process.stdout.write(JSON.stringify({ locale: Intl.Collator().resolvedOptions().locale, record: store.journal.get(command.clientCommandId) }) + '\n');
  } else if (mode === 'dispatch') {
    let executions = 0;
    manager = new SessionManager(store, { idleDisposeMin: 0 });
    manager.answer = async () => { executions++; };
    const files = new FileStore(join(dirname(file), 'files'), store); await files.init();
    const dispatcher = new CommandDispatcher(store, manager, files);
    const result = await dispatcher.dispatch(command);
    process.stdout.write(JSON.stringify({ locale: Intl.Collator().resolvedOptions().locale, result, executions, record: store.journal.get(command.clientCommandId) }) + '\n');
  } else {
    const claimed = store.journal.claim(command);
    process.stdout.write(JSON.stringify({ locale: Intl.Collator().resolvedOptions().locale, ...claimed }) + '\n');
  }
} finally { await manager?.disposeAll(); db.close(); }
