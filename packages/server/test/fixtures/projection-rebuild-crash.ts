import { join } from 'node:path';
import { openDb } from '../../src/db.js';
import { Store } from '../../src/store.js';

const path = join(process.argv[2]!, 'db.sqlite'); const db = openDb(path); const store = new Store(db);
const workspace = store.createWorkspace('raw crash', process.argv[2]!); const session = store.createSession({ workspaceId: workspace.id, agent: 'claude-code' });
const identity = store.nativeOwners.acquire('capture-owner', session.id, 'claude-code', 'captured-native');
const event = { type: 'item.complete' as const, itemKey: 'native-item', kind: 'assistant.message' as const, data: { text: 'captured before projection' },
  nativeSeq: 17, nativeTurnId: 'native-turn', runtime: identity, native: { type: 'assistant', session_id: 'captured-native', agent_id: 'actor', parent_tool_use_id: 'parent' } };
const raw = store.nativeEvents.mapping({ sessionId: session.id, agent: 'claude-code', identity, nativeId: 'captured-native' }, event, 'accepted');
process.send?.({ sessionId: session.id, event, raw, identity });
setInterval(() => undefined, 1000);
