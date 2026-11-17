import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FakeAdapter } from '@webdcc/fake-adapter';
import type { AdapterEvent, AgentId } from '@webdcc/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/manager.js';
import { recoverCompletedSnapshot, type CompletedSnapshotOptions } from '../src/native-completed-snapshot.js';

async function fixture(agent: AgentId) {
  const db = openDb(':memory:'); const store = new Store(db); const manager = new SessionManager(store, { idleDisposeMin: 0 }); const adapter = new FakeAdapter({ id: agent });
  let callback!: (id: string, event: AdapterEvent) => void; let sends = 0; adapter.onEvent = cb => { callback = cb; }; adapter.send = async () => { sends++; }; adapter.dispose = async () => undefined; manager.registerAdapter(adapter);
  const workspace = store.createWorkspace('completed snapshot', tmpdir()); const session = await manager.createSession({ workspaceId: workspace.id, agent });
  const commandId = 'original-input'; store.journal.claim({ op: 'send', clientCommandId: commandId, sessionId: session.id, text: 'original input' }); store.journal.acquire(commandId);
  const sent = await manager.send(session.id, { text: 'original input' }, commandId); const identity = manager.getRuntime(session.id)!.identity;
  return { db, store, manager, session, sent, identity, sends: () => sends, emit: (event: AdapterEvent) => callback(session.id, { ...event, runtime: event.runtime ?? identity }),
    read: (options: CompletedSnapshotOptions = {}) => recoverCompletedSnapshot(store.nativeEvents, store.projectionContexts, store.getSession(session.id)!, store.allEvents(session.id), { identity, ...options }),
    close: async () => { db.exec('DROP TRIGGER IF EXISTS reject_completion'); await manager.disposeAll(); db.close(); } };
}
const complete: Extract<AdapterEvent, { type: 'item.complete' }> = { type: 'item.complete', itemKey: 'original-answer', kind: 'assistant.message', data: { text: 'original completed answer', nativePhase: 'final_answer' },
  native: { message_id: 'original-message', agent_id: 'original-actor', parent_tool_use_id: 'original-parent', request_id: 'original-request', opaque: { unchanged: true } } };
async function evidence(name: string, report: unknown) { const directory = process.env['WDCC_COMPLETED_SNAPSHOT_EVIDENCE_DIR']; if (directory !== undefined) await writeFile(join(directory, `${name}.json`), JSON.stringify(report, null, 2)); }
type Fixture = Awaited<ReturnType<typeof fixture>>;
function record(ctx: Fixture, event: Extract<AdapterEvent, { type: 'item.complete' }> = complete, patch: { turnId?: string | null; late?: boolean; turnEnded?: boolean } = {}) {
  const mapping = ctx.store.nativeEvents.mapping({ sessionId: ctx.session.id, agent: ctx.session.agent, nativeId: ctx.session.nativeId, identity: ctx.identity }, { ...event, runtime: ctx.identity }, 'accepted');
  if (!mapping.duplicate) ctx.store.projectionContexts.record(mapping.id, { sessionId: ctx.session.id, identity: ctx.identity, turnId: patch.turnId === undefined ? ctx.sent.turnId : patch.turnId,
    late: patch.late ?? false, turnEnded: patch.turnEnded ?? false, hot: { present: false, closed: false } });
  return mapping.id;
}

it.each(['codex', 'claude-code', 'dsh'] as const)('%s actual SQL publication failure retains completed output in the snapshot under its original public/native identity', async agent => {
  const ctx = await fixture(agent);
  try {
    ctx.db.exec("CREATE TRIGGER reject_completion BEFORE INSERT ON events WHEN NEW.kind = 'assistant.message' BEGIN SELECT RAISE(ABORT, 'completion failed'); END");
    ctx.emit(complete); const before = ctx.db.serialize(); const snapshot = ctx.manager.hotSnapshot(ctx.session.id);
    await evidence(`${agent}-completion`, { snapshot, events: ctx.store.allEvents(ctx.session.id), raw: ctx.store.nativeEvents.list(ctx.session.id, 0, 500).map(row => ctx.store.nativeEvents.get(row.id)), queue: ctx.store.journal.queue(ctx.session.id), identity: ctx.identity });
    expect(snapshot).toMatchObject({ completed: [expect.objectContaining({ sessionId: ctx.session.id, turnId: ctx.sent.turnId, itemKey: complete.itemKey, kind: complete.kind, data: complete.data, native: complete.native })] });
    expect(ctx.db.serialize()).toEqual(before); expect(ctx.sends()).toBe(1); expect(ctx.store.journal.queue(ctx.session.id)[0]?.state).toBe('uncertain');
    expect(ctx.store.allEvents(ctx.session.id).some(event => event.kind === 'assistant.message' || event.kind === 'turn.completed')).toBe(false);
  } finally { await ctx.close(); }
});

it.each(['codex', 'claude-code', 'dsh'] as const)('%s fenced runtime snapshot marks retained hot as lost rather than currently running', async agent => {
  const ctx = await fixture(agent);
  try {
    ctx.emit({ type: 'item.start', itemKey: 'unfinished', kind: 'command', data: { command: 'original command', status: 'running', outputTail: 'original partial' } });
    ctx.db.exec("CREATE TRIGGER reject_completion BEFORE INSERT ON events WHEN NEW.kind = 'assistant.message' BEGIN SELECT RAISE(ABORT, 'completion failed'); END");
    ctx.emit(complete); const snapshot = ctx.manager.hotSnapshot(ctx.session.id); await evidence(`${agent}-fenced-hot`, snapshot);
    expect(snapshot.items).toEqual([expect.objectContaining({ itemKey: 'unfinished', turnId: ctx.sent.turnId, data: { command: 'original command', status: 'running', outputTail: 'original partial' }, observation: expect.objectContaining({ state: 'lost' }) })]);
  } finally { await ctx.close(); }
});

it('ten equal raw completions retain all original assignments and rebuild once without table writes', async () => {
  const ctx = await fixture('codex');
  try {
    const ids = Array.from({ length: 10 }, () => record(ctx)); const before = ctx.db.serialize(); const report = ctx.read();
    await evidence('ten-repeat', report); expect(report.completed).toHaveLength(1); expect(report.completed[0]?.origins.map(row => row.id)).toEqual(ids);
    expect(report.completed[0]?.assignments.map(row => row.envelopeId)).toEqual(ids); expect(new Set(report.completed[0]?.assignments.map(row => row.contextDigest)).size).toBe(10);
    expect(report.completedRecovery?.coverage).toBe('complete'); expect(ctx.db.serialize()).toEqual(before);
  } finally { await ctx.close(); }
});

it('anonymous equal item keys and content remain separate in their actual public turns', async () => {
  const ctx = await fixture('claude-code');
  try {
    record(ctx); ctx.emit({ type: 'turn.end', status: 'completed' }); ctx.manager.getRuntime(ctx.session.id)!.finishAction!();
    const next = await ctx.manager.send(ctx.session.id, { text: 'next input' }); record(ctx, complete, { turnId: next.turnId });
    const report = ctx.read(); await evidence('public-turns', report); expect(report.completed.map(item => item.turnId)).toEqual([ctx.sent.turnId, next.turnId]);
    expect(new Set(report.completed.map(item => item.projectionId)).size).toBe(2); expect(report.completed.every(item => item.origins[0]?.nativeTurnId === null)).toBe(true);
  } finally { await ctx.close(); }
});

it('session scope stays null, while native opaque differences and null/presence stay distinct and unresolved', async () => {
  const ctx = await fixture('codex');
  try {
    record(ctx, { ...complete, scope: 'session', itemKey: 'global' }, { turnId: null });
    for (const native of [{ opaque: { original: 1 } }, { opaque: { original: 2 } }, null, false, 0]) record(ctx, { ...complete, native });
    record(ctx, { type: 'item.complete', itemKey: complete.itemKey, kind: complete.kind, data: complete.data });
    const report = ctx.read(); await evidence('opaque-conflicts', report); expect(report.completed).toHaveLength(7); expect(report.completed[0]?.turnId).toBeNull();
    expect(report.completedRecovery?.coverage).toBe('partial'); expect(report.completedRecovery?.conflicts).toHaveLength(1);
    expect(report.completed.slice(1).every(item => item.conflict === true)).toBe(true);
    expect(report.completed.map(item => item.native)).toEqual([complete.native, { opaque: { original: 1 } }, { opaque: { original: 2 } }, null, false, 0, undefined]);
  } finally { await ctx.close(); }
});

it('a committed semantic publication prevents a matching retained result from appearing twice', async () => {
  const ctx = await fixture('codex');
  try {
    const first = record(ctx); const second = record(ctx);
    ctx.store.appendEvent({ sessionId: ctx.session.id, turnId: ctx.sent.turnId, itemKey: complete.itemKey, kind: complete.kind, data: complete.data as never, native: complete.native, nativeEnvelopeId: second });
    const before = ctx.db.serialize(); const report = ctx.read(); await evidence('published', { first, second, report });
    expect(report.completed).toEqual([]); expect(report.completedRecovery?.coverage).toBe('complete'); expect(ctx.db.serialize()).toEqual(before);
  } finally { await ctx.close(); }
});

it.each(['context-missing', 'context-json', 'context-version', 'context-digest', 'raw-body', 'schema', 'restricted', 'unknown-turn'] as const)('%s is explicit and cannot be replaced with a guessed completion', async kind => {
  const ctx = await fixture('codex');
  try {
    const id = record(ctx); const key = `native-projection-context:${id}`;
    if (kind === 'context-missing') ctx.db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
    if (kind === 'context-json') ctx.db.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run('{invalid', key);
    if (kind === 'context-version') ctx.db.prepare("UPDATE app_settings SET value = json_set(value, '$.formatVersion', 99) WHERE key = ?").run(key);
    if (kind === 'context-digest') ctx.db.prepare("UPDATE app_settings SET value = json_set(value, '$.contextDigest', 'invalid') WHERE key = ?").run(key);
    if (kind === 'raw-body') ctx.db.prepare("UPDATE native_event_envelopes SET payload = json_set(payload, '$.data.text', 'changed original') WHERE id = ?").run(id);
    if (kind === 'schema') ctx.db.prepare('UPDATE native_event_envelopes SET schema_hash = ? WHERE id = ?').run('future', id);
    if (kind === 'restricted') ctx.store.nativeEvents.restrictSession(ctx.session.id);
    if (kind === 'unknown-turn') ctx.db.prepare("UPDATE app_settings SET value = json_set(value, '$.turnId', 'guessed') WHERE key = ?").run(key);
    const before = ctx.db.serialize(); const report = ctx.read(); await evidence(kind, report); expect(report.completed).toEqual([]);
    expect(report.completedRecovery?.coverage).toBe('partial'); expect(report.completedRecovery?.issues.length).toBeGreaterThan(0); expect(ctx.db.serialize()).toEqual(before);
  } finally { await ctx.close(); }
});

it('unsupported interactions and child-native routing stay unavailable, without creating actionable prompts', async () => {
  const ctx = await fixture('claude-code');
  try {
    record(ctx, { ...complete, kind: 'question', data: { questionId: 'original question', prompt: 'original prompt' } });
    record(ctx, { ...complete, native: { type: 'assistant', session_id: ctx.session.nativeId, parent_tool_use_id: 'original child parent', message: { id: 'original child message' } } });
    const report = ctx.read(); await evidence('unsupported-routing', report); expect(report.completed).toEqual([]); expect(report.completedRecovery?.coverage).toBe('partial');
    expect(ctx.db.prepare('SELECT id FROM interactions WHERE session_id = ?').all(ctx.session.id)).toEqual([]);
  } finally { await ctx.close(); }
});

it('record and byte limits remain partial and do not silently select an incomplete result prefix', async () => {
  const ctx = await fixture('codex');
  try {
    record(ctx); record(ctx, { ...complete, itemKey: 'large', data: { text: 'x'.repeat(7000) } });
    const records = ctx.read({ maxRecords: 1 }); const bytes = ctx.read({ maxBytes: 4096 }); await evidence('budgets', { records, bytes });
    expect(records).toMatchObject({ completed: [], completedRecovery: { coverage: 'partial', hasMore: true } });
    expect(bytes).toMatchObject({ completed: [], completedRecovery: { coverage: 'partial', hasMore: true } });
  } finally { await ctx.close(); }
});

it('owner acquisition between manager selection and the store read cannot produce lost data for another live writer', async () => {
  const ctx = await fixture('codex');
  try {
    ctx.db.exec("CREATE TRIGGER reject_completion BEFORE INSERT ON events WHEN NEW.kind = 'assistant.message' BEGIN SELECT RAISE(ABORT, 'completion failed'); END"); ctx.emit(complete);
    const read = ctx.store.recoveredHot.bind(ctx.store); ctx.store.recoveredHot = sessionId => {
      ctx.store.nativeOwners.release(ctx.session.id, ctx.identity, true);
      const next = ctx.store.nativeOwners.acquire('next executor', ctx.session.id, 'codex', ctx.session.nativeId); ctx.store.nativeOwners.activate(ctx.session.id, next, ctx.session.nativeId!);
      return read(sessionId);
    };
    const snapshot = ctx.manager.hotSnapshot(ctx.session.id); await evidence('owner-race', { snapshot, owner: ctx.store.nativeOwners.get(ctx.session.id), queue: ctx.store.journal.queue(ctx.session.id) });
    expect(snapshot).toEqual({ items: [] }); expect(ctx.store.nativeOwners.get(ctx.session.id)?.state).toBe('active');
  } finally { await ctx.close(); }
});
