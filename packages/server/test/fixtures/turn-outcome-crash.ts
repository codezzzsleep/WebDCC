import { join } from 'node:path';
import { openDb } from '../../src/db.js';
import { Store } from '../../src/store.js';
const directory = process.argv[2]!; const db = openDb(join(directory, 'source.sqlite')); const store = new Store(db);
const workspace = store.createWorkspace('terminal crash', directory); const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
store.updateSession(session.id, { nativeId: 'native' }); const identity = store.nativeOwners.acquire('owner', session.id, 'codex', 'native');
store.nativeOwners.activate(session.id, identity, 'native'); store.nativeHistory.bind(session.id, 'turn', 'public-turn');
store.journal.claim({ op: 'send', sessionId: session.id, clientCommandId: 'CRASH', text: 'kept input' });
store.journal.enqueue('CRASH', session.id, 'public-turn', { text: 'kept input' });
store.inputAdmissions.begin(session.id, 'public-turn', { text: 'kept input' }, identity, 'CRASH'); store.journal.acceptInput('public-turn');
const item = store.nativeEvents.mapping({ sessionId: session.id, agent: 'codex', nativeId: 'native', identity },
  { type: 'item.complete', kind: 'assistant.message', itemKey: 'answer', data: { text: 'observed answer' }, nativeTurnId: 'turn', runtime: identity }, 'accepted');
store.appendEvent({ sessionId: session.id, turnId: 'public-turn', itemKey: 'answer', kind: 'assistant.message', data: { text: 'observed answer' }, nativeEnvelopeId: item.id });
const event = { type: 'turn.end' as const, nativeTurnId: 'turn', status: 'completed' as const, runtime: identity, native: { observed: 'controlled' } };
store.nativeEvents.mapping({ sessionId: session.id, agent: 'codex', nativeId: 'native', identity }, event, 'accepted');
process.send?.({ sessionId: session.id }); setInterval(() => undefined, 1000);
