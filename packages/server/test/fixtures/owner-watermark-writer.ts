import { openDb } from '../../src/db.js';
import { NativeOwnerStore } from '../../src/native-owners.js';
import type { RuntimeIdentity } from '@webdcc/protocol';

const db = openDb(process.argv[2]!); const store = new NativeOwnerStore(db);
const sessionId = process.argv[3]!; const identity = JSON.parse(process.argv[4]!) as RuntimeIdentity;
const seqs = JSON.parse(process.argv[5]!) as number[];
process.once('message', () => {
  const samples = seqs.map(seq => {
    store.observe(sessionId, identity, 'current-turn', seq);
    return { seq, lastObservedSeq: store.get(sessionId)?.lastObservedSeq ?? null };
  });
  db.close(); process.send!({ phase: 'finished', samples }, () => process.disconnect());
});
process.send!({ phase: 'ready' });
