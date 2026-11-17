import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/manager.js';
import { FakeAdapter } from '@webdcc/fake-adapter';
import type { AdapterEvent, AgentId } from '@webdcc/protocol';
import { recoverNativeHot, type HotRecoveryOptions } from '../src/native-hot-recovery.js';

async function fixture(agent: AgentId = 'codex') {
  const db = openDb(':memory:'); const store = new Store(db); const manager = new SessionManager(store, { idleDisposeMin: 0 }); const adapter = new FakeAdapter({ id: agent });
  let callback!: (sessionId: string, event: AdapterEvent) => void; adapter.onEvent = cb => { callback = cb; }; adapter.send = async () => undefined; manager.registerAdapter(adapter);
  const workspace = store.createWorkspace('hot recovery', tmpdir()); const session = await manager.createSession({ workspaceId: workspace.id, agent });
  const sent = await manager.send(session.id, { text: 'original input' }); const identity = manager.getRuntime(session.id)!.identity;
  return { db, store, manager, session, sent, identity, emit: (event: AdapterEvent) => callback(session.id, { ...event, runtime: event.runtime ?? identity }),
    read: (options: HotRecoveryOptions = {}) => recoverNativeHot(store.nativeEvents, store.projectionContexts, store.getSession(session.id)!, store.allEvents(session.id), { identity, ...options }),
    close: async () => { await manager.disposeAll(); db.close(); } };
}
const start = (patch: object = {}): Extract<AdapterEvent, { type: 'item.start' }> => ({ type: 'item.start', itemKey: 'hot', kind: 'assistant.message', data: { text: '' }, ...patch });
const delta = (patch: object = {}): Extract<AdapterEvent, { type: 'item.delta' }> => ({ type: 'item.delta', itemKey: 'hot', field: 'text', append: 'original partial\n', ...patch });
const latest = (store: Store, sessionId: string) => store.nativeEvents.list(sessionId, 0, 500).at(-1)!;
async function evidence(name: string, report: unknown) {
  const directory = process.env['WDCC_HOT_RECOVERY_EVIDENCE_DIR']; if (directory !== undefined) await writeFile(join(directory, `${name}.json`), JSON.stringify(report, null, 2));
}

it.each(['codex', 'claude-code', 'dsh'] as const)('%s retains original text/output/update and source identities; recovery reads change no storage or native input', async agent => {
  const ctx = await fixture(agent);
  try {
    ctx.emit(start({ native: { agent_id: 'original actor', parent_tool_use_id: 'original parent', request_id: 'original request' } })); ctx.emit(delta());
    ctx.emit(start({ itemKey: 'cmd', kind: 'command', data: { command: 'original command', status: 'running', outputTail: '' } }));
    ctx.emit({ type: 'item.delta', itemKey: 'cmd', field: 'output', append: 'original output' });
    ctx.emit({ type: 'item.update', itemKey: 'cmd', data: { command: 'original command', status: 'running', outputTail: 'replacement output', opaque: { original: true } } });
    ctx.emit(start({ scope: 'session', itemKey: 'global', data: { text: 'session original' } }));
    const before = ctx.db.serialize(); const report = ctx.read(); await evidence(agent, { report, live: ctx.manager.hotItems(ctx.session.id) });
    expect(report.recovery?.coverage).toBe('complete'); expect(report.items).toHaveLength(3);
    expect(report.items[0]).toMatchObject({ turnId: ctx.sent.turnId, data: { text: 'original partial\n' }, observation: { state: 'lost', identity: ctx.identity } });
    expect(report.items[0]?.observation?.origins[0]).toMatchObject({ actorId: 'original actor', parentToolUseId: 'original parent', nativeRequestId: 'original request', nativeTurnId: null, nativeId: ctx.session.nativeId });
    expect(report.items[1]?.data).toMatchObject({ status: 'running', outputTail: 'replacement output', opaque: { original: true } }); expect(report.items[2]?.turnId).toBeNull();
    expect(ctx.db.serialize()).toEqual(before); expect(ctx.manager.hotItems(ctx.session.id).every(item => item.observation === undefined)).toBe(true);
    await ctx.manager.dispose(ctx.session.id); expect(ctx.manager.hotSnapshot(ctx.session.id).items).toEqual(report.items);
  } finally { await ctx.close(); }
});

it('cancelled/completed items and late starts cannot revive, while equal item keys in the next turn remain independent', async () => {
  const ctx = await fixture();
  try {
    ctx.emit({ type: 'turn.start', nativeTurnId: 'first' }); ctx.emit(start({ nativeTurnId: 'first' })); ctx.emit({ type: 'item.cancel', itemKey: 'hot', nativeTurnId: 'first' }); ctx.emit(start({ nativeTurnId: 'first' }));
    ctx.emit(start({ itemKey: 'done', nativeTurnId: 'first' })); ctx.emit({ type: 'item.complete', itemKey: 'done', nativeTurnId: 'first', kind: 'assistant.message', data: { text: 'completed original' } }); ctx.emit(start({ itemKey: 'done', nativeTurnId: 'first' }));
    expect(ctx.read().items).toEqual([]);
    ctx.emit({ type: 'turn.start', nativeTurnId: 'next' }); const nextTurn = ctx.manager.getRuntime(ctx.session.id)!.turnId;
    ctx.emit(start({ nativeTurnId: 'next', data: { text: 'new original' } })); ctx.emit(start({ nativeTurnId: 'first' }));
    const report = ctx.read(); await evidence('closed-next-turn', report); expect(report.recovery?.coverage).toBe('complete');
    expect(report.items).toEqual([expect.objectContaining({ turnId: nextTurn, itemKey: 'hot', data: { text: 'new original' } })]); expect(nextTurn).not.toBe(ctx.sent.turnId);
  } finally { await ctx.close(); }
});

it('an original anonymous turn.end suppresses hot even before an item completion was ever persisted', async () => {
  const ctx = await fixture('claude-code');
  try {
    ctx.emit(start()); ctx.emit(delta()); ctx.emit({ type: 'turn.end', status: 'completed' });
    const report = ctx.read(); await evidence('anonymous-terminal', report); expect(report.items).toEqual([]); expect(report.recovery?.coverage).toBe('complete');
  } finally { await ctx.close(); }
});

it.each(['missing-delta', 'missing-cancel', 'bad-json', 'version', 'digest', 'schema', 'restricted', 'unsupported-question'] as const)('%s stays explicit and cannot display a misleading open prefix', async kind => {
  const ctx = await fixture();
  try {
    ctx.emit(start()); ctx.emit(delta());
    if (kind === 'missing-cancel') ctx.emit({ type: 'item.cancel', itemKey: 'hot' });
    const row = latest(ctx.store, ctx.session.id); const setting = `native-projection-context:${row.id}`;
    if (kind.startsWith('missing-')) ctx.db.prepare('DELETE FROM app_settings WHERE key = ?').run(setting);
    if (kind === 'bad-json') ctx.db.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run('{invalid', setting);
    if (kind === 'version') ctx.db.prepare("UPDATE app_settings SET value = json_set(value, '$.formatVersion', 99) WHERE key = ?").run(setting);
    if (kind === 'digest') ctx.db.prepare("UPDATE app_settings SET value = json_set(value, '$.contextDigest', 'corrupt') WHERE key = ?").run(setting);
    if (kind === 'schema') ctx.db.prepare('UPDATE native_event_envelopes SET schema_hash = ? WHERE id = ?').run('future', row.id);
    if (kind === 'restricted') ctx.store.nativeEvents.restrictSession(ctx.session.id);
    if (kind === 'unsupported-question') ctx.emit(start({ itemKey: 'question', kind: 'question', data: { questionId: 'original question', prompt: 'original prompt' } }));
    const before = ctx.db.serialize(); const report = ctx.read(); await evidence(kind, report);
    expect(report.items).toEqual([]); expect(report.recovery?.coverage).toBe('partial'); expect(report.recovery?.issues.length).toBeGreaterThan(0); expect(ctx.db.serialize()).toEqual(before);
  } finally { await ctx.close(); }
});

it('a real SQLite context insertion failure preserves the native pump and reports an incomplete snapshot', async () => {
  const ctx = await fixture();
  try {
    ctx.db.exec("CREATE TRIGGER reject_hot_context BEFORE INSERT ON app_settings WHEN NEW.key LIKE 'native-projection-context:%' BEGIN SELECT RAISE(ABORT, 'context failed'); END");
    ctx.emit(start()); ctx.emit(delta()); const report = ctx.read(); await evidence('sql-abort', { report, raw: ctx.store.nativeEvents.get(latest(ctx.store, ctx.session.id).id), live: ctx.manager.hotItems(ctx.session.id) });
    expect(report.items).toEqual([]); expect(report.recovery?.issues[0]?.reason).toBe('projection-context-not-recorded'); expect(ctx.manager.hotItems(ctx.session.id)[0]?.data).toMatchObject({ text: 'original partial\n' });
  } finally { ctx.db.exec('DROP TRIGGER IF EXISTS reject_hot_context'); await ctx.close(); }
});

it('bounded scans with unseen later closure return partial without reviving an older prefix', async () => {
  const ctx = await fixture();
  try {
    ctx.emit(start()); ctx.emit(delta({ append: 'x'.repeat(8000) })); ctx.emit({ type: 'item.cancel', itemKey: 'hot' });
    const records = ctx.read({ maxRecords: 2 }); const bytes = ctx.read({ maxBytes: 4096 }); await evidence('budget', { records, bytes });
    expect(records).toMatchObject({ items: [], recovery: { coverage: 'partial', hasMore: true, issues: expect.arrayContaining([expect.objectContaining({ reason: 'recovery-record-limit' })]) } });
    expect(bytes).toMatchObject({ items: [], recovery: { coverage: 'partial', hasMore: true, issues: expect.arrayContaining([expect.objectContaining({ reason: 'recovery-scan-size-limit' })]) } });
  } finally { await ctx.close(); }
});

it('a second manager and a later owner acquisition cannot label another live executor as lost', async () => {
  const ctx = await fixture(); let reader: SessionManager | undefined;
  try {
    ctx.emit(start()); ctx.emit(delta()); reader = new SessionManager(ctx.store, { idleDisposeMin: 0 });
    const before = ctx.store.nativeOwners.get(ctx.session.id); expect(reader.hotSnapshot(ctx.session.id)).toEqual({ items: [] }); expect(ctx.store.nativeOwners.get(ctx.session.id)).toEqual(before);
    await ctx.manager.dispose(ctx.session.id); await reader.disposeAll(); reader = new SessionManager(ctx.store, { idleDisposeMin: 0 }); expect(reader.hotItems(ctx.session.id)).toHaveLength(1);
    const identity = ctx.store.nativeOwners.acquire('different executor', ctx.session.id, 'codex', ctx.session.nativeId); ctx.store.nativeOwners.activate(ctx.session.id, identity, ctx.session.nativeId!);
    const active = ctx.store.nativeOwners.get(ctx.session.id); expect(reader.hotSnapshot(ctx.session.id)).toEqual({ items: [] }); expect(ctx.store.nativeOwners.get(ctx.session.id)).toEqual(active);
  } finally { await reader?.disposeAll(); await ctx.close(); }
});

it('real SIGKILL restores anonymous partial output in the original Web turn without inventing a native outcome', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-hot-recovery-kill-'));
  const child = fork(join(import.meta.dirname, 'fixtures/projection-context-crash.ts'), [directory], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr?.on('data', value => { stderr += String(value); }); let db: Db | undefined; let manager: SessionManager | undefined;
  try {
    const [value] = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`worker exited ${code}: ${stderr}`); })]);
    const message = value as { sessionId: string; publicTurnId: string; rawId: number }; const exited = once(child, 'exit'); child.kill('SIGKILL'); const exit = await exited;
    db = openDb(join(directory, 'source.sqlite')); const store = new Store(db); manager = new SessionManager(store, { idleDisposeMin: 0 });
    const hot = manager.hotItems(message.sessionId);
    const report = { exit, stderr, message, hot, context: store.projectionContexts.get(message.rawId), queue: store.journal.queue(message.sessionId), raw: store.nativeEvents.get(message.rawId) };
    const evidence = process.env['WDCC_HOT_RECOVERY_EVIDENCE_DIR']; if (evidence !== undefined) await writeFile(join(evidence, 'sigkill.json'), JSON.stringify(report, null, 2));
    expect(exit[1]).toBe('SIGKILL');
    expect(hot).toEqual([expect.objectContaining({ itemKey: 'hot', turnId: message.publicTurnId, kind: 'assistant.message', data: { text: 'original partial\n' }, observation: expect.objectContaining({ state: 'lost' }) })]);
    expect(store.journal.queue(message.sessionId)[0]?.state).toBe('uncertain'); expect(store.allEvents(message.sessionId).some(event => event.kind === 'turn.completed')).toBe(false);
    expect(manager.getRuntime(message.sessionId)).toBeUndefined();
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await manager?.disposeAll(); db?.close(); await rm(directory, { recursive: true, force: true }); }
});
