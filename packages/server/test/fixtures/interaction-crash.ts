import { join } from 'node:path';
import { openDb } from '../../src/db.js';
import { Store } from '../../src/store.js';

const store = new Store(openDb(join(process.argv[2]!, 'db.sqlite')));
const workspace = store.createWorkspace('fixture', process.argv[2]!);
const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
store.appendEvent({ sessionId: session.id, turnId: 'turn', itemKey: 'request', kind: 'approval.request', data: { approvalId: 'approval', title: 'Approval', detail: '', options: [{ id: 'accept', label: 'Allow' }] } });
store.journal.claim({ op: 'approve', clientCommandId: 'CRASH-APPROVAL', sessionId: session.id, approvalId: 'approval', optionId: 'accept' });
store.journal.acquire('CRASH-APPROVAL');
store.interactions.claim(session.id, 'approve', 'approval', 'CRASH-APPROVAL');
process.on('message', () => undefined);
process.send?.({ sessionId: session.id });
