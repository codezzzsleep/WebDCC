import { expect, it } from 'vitest';
import type { AdapterEvent } from '@webdcc/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { createTestApp } from './helpers.js';

function fixture() {
  const db = openDb(':memory:'); const store = new Store(db); const workspace = store.createWorkspace('terminal results', '/tmp');
  const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' }); store.updateSession(session.id, { nativeId: 'original-native' });
  const identity = store.nativeOwners.acquire('original-executor', session.id, 'codex', 'original-native'); store.nativeOwners.activate(session.id, identity, 'original-native');
  store.appendEvent({ sessionId: session.id, turnId: 'original-public', itemKey: 'input', kind: 'user.message', data: { text: 'original input' } });
  store.journal.claim({ op: 'send', sessionId: session.id, clientCommandId: 'original-command', text: 'original input' }); store.journal.enqueue('original-command', session.id, 'original-public', { text: 'original input' });
  const record = (status: 'completed' | 'failed' | 'interrupted' = 'completed', patch: object = {}, publicTurn = 'original-public') => {
    const event = { type: 'turn.end', status, runtime: identity, native: { original: true, opaque: 1 }, ...patch } as AdapterEvent;
    const raw = store.nativeEvents.mapping({ sessionId: session.id, nativeId: 'original-native', identity, agent: 'codex' }, event, 'accepted');
    store.projectionContexts.record(raw.id, { sessionId: session.id, identity, turnId: publicTurn, late: false, turnEnded: false }); return raw.id;
  };
  return { db, store, session, identity, record, read: () => store.nativeTerminalResults(session.id) };
}

it('10 equal observations preserve every source and deduplicate only represented output bytes in the same actual scope', () => {
  const ctx = fixture();
  try {
    const ids = Array.from({ length: 10 }, (_, nativeSeq) => ctx.record('completed', { nativeSeq })); const before = ctx.db.serialize();
    expect(ctx.read().outcomes[0]?.origins.map(row => row.id)).toEqual(ids); expect(ctx.db.serialize()).toEqual(before);
    ctx.store.appendEvent({ sessionId: ctx.session.id, turnId: 'original-public', itemKey: 'native-end', kind: 'turn.completed', data: { status: 'completed', durationMs: 1 }, nativeEnvelopeId: ids[5] });
    expect(ctx.read().outcomes).toEqual([]); const different = ctx.record('completed', { native: { original: true, opaque: 2 } });
    expect(ctx.read().outcomes[0]?.origins.map(row => row.id)).toEqual([different]); expect(ctx.read().outcomes[0]?.assignments?.map(row => row.envelopeId)).toEqual([different]);
  } finally { ctx.db.close(); }
});

it('contradictory statuses and a different semantic result remain explicit without altering Web completion or receipts', () => {
  const ctx = fixture();
  try {
    const original = ctx.record(); ctx.record('failed'); ctx.store.appendEvent({ sessionId: ctx.session.id, turnId: 'original-public', itemKey: 'different-terminal', kind: 'turn.completed', data: { status: 'interrupted', durationMs: 1 }, nativeEnvelopeId: original });
    const before = ctx.db.serialize(); const report = ctx.read(); expect(report.outcomes.map(row => row.status)).toEqual(['completed', 'failed']); expect(report.recovery.coverage).toBe('partial');
    expect(report.recovery.conflicts).toHaveLength(1); expect(report.recovery.issues.some(row => row.reason === 'native-semantic-terminal-conflict')).toBe(true); expect(ctx.db.serialize()).toEqual(before);
    expect(ctx.store.journal.queue(ctx.session.id)[0]?.state).toBe('queued');
  } finally { ctx.db.close(); }
});

it('missing context and read limits remain partial rather than choosing an arbitrary result prefix', () => {
  const ctx = fixture();
  try {
    const id = ctx.record(); ctx.db.prepare('DELETE FROM app_settings WHERE key = ?').run(`native-projection-context:${id}`);
    expect(ctx.read()).toMatchObject({ outcomes: [], recovery: { coverage: 'partial' } }); ctx.record(); ctx.record('failed');
    expect(ctx.store.nativeTerminalResults(ctx.session.id, { maxRecords: 1 })).toMatchObject({ outcomes: [], recovery: { coverage: 'partial', hasMore: true } });
    ctx.record('completed', { native: { large: 'x'.repeat(7000) } }); expect(ctx.store.nativeTerminalResults(ctx.session.id, { maxBytes: 4096 })).toMatchObject({ outcomes: [], recovery: { coverage: 'partial', hasMore: true } });
  } finally { ctx.db.close(); }
});

it('conversation reset excludes earlier original turns and does not relocate their native outcomes', () => {
  const ctx = fixture();
  try {
    ctx.record(); const boundary = ctx.store.appendEvent({ sessionId: ctx.session.id, turnId: null, itemKey: 'reset-boundary', kind: 'notice', data: { level: 'info', text: 'reset' } });
    ctx.store.saveConversation(ctx.session.id, { id: 'new-original-conversation', uuid: 'original-reset-uuid', resetSeq: boundary.seq });
    ctx.store.appendEvent({ sessionId: ctx.session.id, turnId: 'new-public', itemKey: 'new-input', kind: 'user.message', data: { text: 'new input' } }); ctx.record('failed', {}, 'new-public');
    const report = ctx.read(); expect(report.outcomes.map(row => row.publicTurnId)).toEqual(['new-public']); expect(report.outcomes[0]?.status).toBe('failed');
  } finally { ctx.db.close(); }
});

it('the Store recovery method operates while SQLite is query-only without inserting a Host or touching the active owner', () => {
  const ctx = fixture();
  try { ctx.record(); const before = ctx.db.serialize(); ctx.db.pragma('query_only = 1'); expect(ctx.read().outcomes).toHaveLength(1); expect(ctx.db.serialize()).toEqual(before); }
  finally { ctx.db.close(); }
});

it('checks read budgets before decoding unrelated semantic history', () => {
  const ctx = fixture();
  try {
    ctx.db.prepare('UPDATE events SET data = ?, native = ? WHERE session_id = ?').run('{invalid-unused-body', '{invalid-unused-native', ctx.session.id);
    expect(() => ctx.store.nativeTerminalResults(ctx.session.id, { maxRecords: 0 })).toThrow('Invalid native terminal read budget');
    expect(() => ctx.store.nativeTerminalResults(ctx.session.id, { maxBytes: 0 })).toThrow('Invalid native terminal read budget');
    ctx.record();
    expect(ctx.read().outcomes[0]?.publicTurnId).toBe('original-public');
  } finally { ctx.db.close(); }
});

it('the independent HTTP result route keeps existing auth/session boundaries and never activates an Adapter', async () => {
  const ctx = await createTestApp();
  try {
    const workspace = ctx.store.createWorkspace('HTTP native terminals', ctx.dataDir); const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' }); const url = `/api/sessions/${session.id}/native-terminal-results`;
    expect((await ctx.app.inject({ url })).statusCode).toBe(401); expect((await ctx.app.inject({ url: '/api/sessions/missing/native-terminal-results', headers: { cookie: ctx.cookie } })).statusCode).toBe(404);
    const before = ctx.store.allEvents(session.id); const response = await ctx.app.inject({ url, headers: { cookie: ctx.cookie } }); expect(response.statusCode).toBe(200); expect(response.json().outcomes).toEqual([]);
    expect(ctx.store.allEvents(session.id)).toEqual(before); expect(ctx.manager.getRuntime(session.id)).toBeUndefined(); expect(ctx.store.nativeOwners.get(session.id)).toBeUndefined();
  } finally { await ctx.close(); }
});
