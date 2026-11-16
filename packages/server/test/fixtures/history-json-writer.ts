import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NativeHistoryRecord } from '@webdcc/protocol';
import { openDb } from '../../src/db.js';
import { Store } from '../../src/store.js';

const directory = process.argv[2]!; const phase = process.argv[3]!;
const input = JSON.parse(readFileSync(join(directory, 'inputs.json'), 'utf8')) as {
  sessionId: string; nativeId: string; original: NativeHistoryRecord; next: NativeHistoryRecord;
};
function reverse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverse);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverse(child)]));
}
const records = phase === 'seed' ? [input.original] : [input.next, { ...input.original, native: reverse(input.original.native) }];
const db = openDb(join(directory, 'history.sqlite')); const store = new Store(db); let rejected: string | null = null;
try { store.nativeHistory.import(input.sessionId, input.nativeId, records); } catch (error) { rejected = String(error); }
console.log(JSON.stringify({ phase, pid: process.pid, records, rejected, raw: db.prepare('SELECT * FROM native_history_records ORDER BY native_seq').all(), events: store.allEvents(input.sessionId) }));
db.close();
