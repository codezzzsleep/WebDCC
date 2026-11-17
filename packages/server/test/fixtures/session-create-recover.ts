import { openDb } from '../../src/db.js';
import { Store } from '../../src/store.js';
const db = openDb(process.argv[2]!); const store = new Store(db); const id = process.argv[3]!;
process.once('message', () => {
  store.journal.recover([]); process.send?.({ state: store.journal.get(id)?.state }); db.close(); process.disconnect?.();
});
process.send?.({ ready: true });
