import { expect, it, vi } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { storedRecoveryEvents } from '../src/native-recovery-events.js';
import { recoverNativeHot } from '../src/native-hot-recovery.js';
import { recoverCompletedSnapshot } from '../src/native-completed-snapshot.js';

it('large unrelated semantic bodies never enter JSON parsing or allEvents during a read-only snapshot', () => {
  const db = openDb(':memory:');
  try {
    const store = new Store(db); const ws = store.createWorkspace('fixture', '/tmp'); const session = store.createSession({ workspaceId: ws.id, agent: 'codex' });
    const insert = db.prepare('INSERT INTO events(session_id,seq,turn_id,item_key,kind,data,at) VALUES(?,?,?,?,?,?,?)');
    const body = JSON.stringify({ text: 'HISTORY_BODY_MARKER:' + 'x'.repeat(8192) });
    db.transaction(() => { for (let i = 1; i <= 2000; i++) insert.run(session.id, i, 'old', `message-${i}`, 'assistant.message', body, new Date(0).toISOString()); })();
    let historicalParses = 0; const parse = JSON.parse;
    const parser = vi.spyOn(JSON, 'parse').mockImplementation((text, ...rest) => { if (text.includes('HISTORY_BODY_MARKER:')) historicalParses++; return parse(text, ...rest); });
    const all = vi.spyOn(store, 'allEvents').mockImplementation(() => { throw new Error('unbounded history'); });
    db.pragma('query_only = 1');
    try { expect(store.recoveredHot(session.id)).toEqual({ items: [], completed: [] }); expect(historicalParses).toBe(0); expect(all).not.toHaveBeenCalled(); }
    finally { parser.mockRestore(); all.mockRestore(); }
  } finally { db.close(); }
});

it('invalid recovery budgets reject before querying semantic witnesses', () => {
  const db = openDb(':memory:');
  try {
    const store = new Store(db); const ws = store.createWorkspace('fixture', '/tmp'); const session = store.createSession({ workspaceId: ws.id, agent: 'codex' }); const source = storedRecoveryEvents(db, session.id);
    const boundary = vi.spyOn(source, 'boundaryEnvelope').mockImplementation(() => { throw new Error('queried before budget'); });
    for (const options of [{ maxRecords: 0 }, { maxRecords: 5001 }, { maxBytes: 3 }, { maxBytes: Number.NaN }]) {
      expect(() => recoverNativeHot(store.nativeEvents, store.projectionContexts, session, source, options)).toThrow('Invalid hot recovery budget');
      expect(() => recoverCompletedSnapshot(store.nativeEvents, store.projectionContexts, session, source, options)).toThrow('Invalid completed snapshot budget');
    }
    expect(boundary).not.toHaveBeenCalled();
  } finally { db.close(); }
});
