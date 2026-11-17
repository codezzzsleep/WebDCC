import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AdapterEvent, AgentId } from '@webdcc/protocol';
import { openDb, type Db } from '../src/db.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/manager.js';
import { readNativeTurnOutcomes } from '../src/native-turn-outcome-reader.js';
import { rebuildNativeTurnOutcomes, type NativeTurnOutcomeSource } from '../src/native-turn-outcomes.js';

function setup(db: Db, agent: AgentId = 'codex') {
  const store = new Store(db); const workspace = store.createWorkspace('turn outcomes', tmpdir());
  const session = store.createSession({ workspaceId: workspace.id, agent }); store.updateSession(session.id, { nativeId: 'native' });
  const identity = store.nativeOwners.acquire('owner', session.id, agent, 'native'); store.nativeOwners.activate(session.id, identity, 'native');
  store.nativeHistory.bind(session.id, 'turn', 'public-turn');
  const terminal = (status: 'completed' | 'failed' | 'interrupted' = 'completed', patch: object = {}): AdapterEvent => ({
    type: 'turn.end', nativeTurnId: 'turn', status, runtime: identity, native: { original: true, actor: 'root' }, ...patch,
  });
  const mapping = (event: AdapterEvent, disposition = 'accepted') => store.nativeEvents.mapping({ sessionId: session.id, nativeId: 'native', agent, identity }, event, disposition);
  const source: NativeTurnOutcomeSource = { schemaHash: store.nativeEvents.schemaHash,
    list: (id, after, limit) => store.nativeEvents.list(id, after, limit), get: id => store.nativeEvents.get(id),
    restricted: id => store.nativeEvents.restricted(id), diagnosticValue: value => store.nativeEvents.diagnosticValue(value),
    publicTurn: (id, native, turn) => store.getSession(id)?.nativeId === native ? store.nativeHistory.turn(id, turn) : undefined,
  };
  return { store, session, identity, terminal, mapping, source };
}
async function evidence(name: string, value: unknown) {
  const dir = process.env['WDCC_TURN_OUTCOME_EVIDENCE_DIR']; if (dir !== undefined) await writeFile(join(dir, `${name}.json`), JSON.stringify(value, null, 2));
}
const fileHash = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');

it.each(['codex', 'claude-code', 'dsh'] as const)('%s rebuilds explicit completed/failed/interrupted native outcomes with original identities', async agent => {
  const db = openDb(':memory:');
  try {
    const ctx = setup(db, agent);
    for (const status of ['completed', 'failed', 'interrupted'] as const) {
      ctx.store.nativeHistory.bind(ctx.session.id, status, `public-${status}`);
      ctx.mapping(ctx.terminal(status, { nativeTurnId: status, usage: { inputTokens: 7, outputTokens: 2, modelUsage: { opaque: [2, 1] } } }));
    }
    const report = rebuildNativeTurnOutcomes(ctx.source); await evidence(agent, report);
    expect(report.complete).toBe(true); expect(report.outcomes.map(outcome => outcome.status)).toEqual(['completed', 'failed', 'interrupted']);
    for (const outcome of report.outcomes) {
      expect(outcome.publicTurnId).toBe(`public-${outcome.status}`); expect(outcome.nativeTurnId).toBe(outcome.status);
      expect(outcome.usage).toMatchObject({ inputTokens: 7, modelUsage: { opaque: [2, 1] } });
      expect(outcome.origins[0]?.payload).toMatchObject({ runtime: ctx.identity, native: { original: true } });
      expect(outcome).not.toHaveProperty('durationMs'); expect(outcome).not.toHaveProperty('answerItemKeys');
    }
  } finally { db.close(); }
});

it('actual SQLite terminal projection abort does not prevent readonly reconstruction or alter accepted input/owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-turn-reader-')); const path = join(directory, 'source.sqlite'); const db = openDb(path);
  try {
    const ctx = setup(db); ctx.store.journal.claim({ op: 'send', sessionId: ctx.session.id, clientCommandId: 'INPUT', text: 'kept input' });
    ctx.store.journal.enqueue('INPUT', ctx.session.id, 'public-turn', { text: 'kept input' });
    ctx.store.inputAdmissions.begin(ctx.session.id, 'public-turn', { text: 'kept input' }, ctx.identity, 'INPUT'); ctx.store.journal.acceptInput('public-turn');
    const item = ctx.mapping({ type: 'item.complete', kind: 'assistant.message', itemKey: 'answer', data: { text: 'observed answer' }, nativeTurnId: 'turn', runtime: ctx.identity });
    ctx.store.appendEvent({ sessionId: ctx.session.id, turnId: 'public-turn', itemKey: 'answer', kind: 'assistant.message', data: { text: 'observed answer' }, nativeEnvelopeId: item.id });
    const raw = ctx.mapping(ctx.terminal());
    db.exec("CREATE TRIGGER reject_end BEFORE INSERT ON events WHEN NEW.kind = 'turn.completed' BEGIN SELECT RAISE(ABORT, 'terminal rejected'); END");
    expect(() => ctx.store.appendEvent({ sessionId: ctx.session.id, turnId: 'public-turn', itemKey: 'end', kind: 'turn.completed', data: { status: 'completed', durationMs: 1 }, nativeEnvelopeId: raw.id })).toThrow('terminal rejected');
    const rows = { events: ctx.store.allEvents(ctx.session.id), owner: ctx.store.nativeOwners.get(ctx.session.id), command: ctx.store.journal.get('INPUT'), queue: ctx.store.journal.queue(ctx.session.id) };
    db.close(); const beforeHash = await fileHash(path); const report = readNativeTurnOutcomes(path);
    expect(await fileHash(path)).toBe(beforeHash); const reopened = openDb(path); const store = new Store(reopened);
    try {
      await evidence('projection-abort', { raw, rows, beforeHash, report });
      expect(report.outcomes[0]).toMatchObject({ publicTurnId: 'public-turn', nativeTurnId: 'turn', status: 'completed' });
      expect(store.allEvents(ctx.session.id)).toEqual(rows.events); expect(store.nativeOwners.get(ctx.session.id)).toEqual(rows.owner);
      expect(store.journal.get('INPUT')).toEqual(rows.command); expect(store.journal.queue(ctx.session.id)).toEqual(rows.queue);
      expect(rows.command?.state).toBe('native-accepted');
    } finally { reopened.close(); }
  } finally { if (db.open) db.close(); await rm(directory, { recursive: true, force: true }); }
});

it('readonly binding requires a committed native-public witness and does not infer it from the current native session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-turn-proof-')); const path = join(directory, 'source.sqlite'); const db = openDb(path);
  try {
    const ctx = setup(db); ctx.mapping(ctx.terminal()); db.close(); const before = await fileHash(path); const report = readNativeTurnOutcomes(path);
    await evidence('missing-witness', report); expect(report.outcomes).toEqual([]);
    expect(report.records[0]?.reason).toBe('public-turn-binding-not-verified'); expect(await fileHash(path)).toBe(before);
  } finally { if (db.open) db.close(); await rm(directory, { recursive: true, force: true }); }
});

it('10 raw terminal observations deduplicate JSON values and retain every original envelope', async () => {
  const db = openDb(':memory:');
  try {
    const ctx = setup(db);
    for (let i = 0; i < 10; i++) ctx.mapping(ctx.terminal('completed', { nativeSeq: i, usage: i % 2 ? { inputTokens: 7, outputTokens: 2 } : { outputTokens: 2, inputTokens: 7 } }));
    const report = rebuildNativeTurnOutcomes(ctx.source); await evidence('duplicate', report);
    expect(report.outcomes).toHaveLength(1); expect(report.outcomes[0]?.origins).toHaveLength(10);
    expect(new Set(report.outcomes[0]?.origins.map(origin => origin.id)).size).toBe(10); expect(report.records.filter(record => record.status === 'duplicate')).toHaveLength(9);
    expect(rebuildNativeTurnOutcomes(ctx.source)).toEqual(report);
  } finally { db.close(); }
});

it('contradictory native outcomes retain both results and block completion instead of choosing the latest', async () => {
  const db = openDb(':memory:');
  try {
    const ctx = setup(db); ctx.mapping(ctx.terminal('completed')); ctx.mapping(ctx.terminal('failed')); ctx.mapping(ctx.terminal('completed'));
    const report = rebuildNativeTurnOutcomes(ctx.source); await evidence('conflict', report);
    expect(report.complete).toBe(false); expect(report.outcomes.map(outcome => outcome.status)).toEqual(['completed', 'failed']);
    expect(report.conflicts).toHaveLength(1); expect(report.records.every(record => record.status === 'conflict')).toBe(true);
  } finally { db.close(); }
});

it.each(['binding', 'native-session', 'generation', 'schema', 'json', 'restricted', 'masked', 'session-scope', 'invalid-status'] as const)('%s missing/conflicting source remains explicit', async kind => {
  const db = openDb(':memory:');
  try {
    const ctx = setup(db); const event = ctx.terminal('completed', kind === 'session-scope' ? { scope: 'session' } : kind === 'masked' ? { native: { marker: 'contains <redacted> text' } } : {});
    const raw = ctx.mapping(event);
    if (kind === 'binding') db.exec('DELETE FROM native_turns');
    if (kind === 'native-session') ctx.store.updateSession(ctx.session.id, { nativeId: 'other-native' });
    if (kind === 'generation') db.prepare('UPDATE native_event_envelopes SET payload = json_set(payload, \'$.runtime.generation\', 99) WHERE id = ?').run(raw.id);
    if (kind === 'schema') db.prepare('UPDATE native_event_envelopes SET schema_hash = ? WHERE id = ?').run('future-schema', raw.id);
    if (kind === 'json') db.prepare('UPDATE native_event_envelopes SET payload = ? WHERE id = ?').run('{invalid', raw.id);
    if (kind === 'restricted') ctx.store.nativeEvents.restrictSession(ctx.session.id);
    if (kind === 'invalid-status') db.prepare('UPDATE native_event_envelopes SET payload = json_set(payload, \'$.status\', \'inProgress\') WHERE id = ?').run(raw.id);
    const report = rebuildNativeTurnOutcomes(ctx.source); await evidence(kind, report);
    expect(report.outcomes).toEqual([]); expect(report.records[0]?.reason).toBeTruthy(); expect(report.complete).toBe(false);
  } finally { db.close(); }
});

it('source metadata conflicts and stale generation dispositions never become outcomes', () => {
  const db = openDb(':memory:');
  try {
    const ctx = setup(db); ctx.mapping(ctx.terminal(), 'stale-generation');
    const accepted = ctx.mapping(ctx.terminal()); const report = rebuildNativeTurnOutcomes({ ...ctx.source, get: id => {
      const detail = ctx.source.get(id); return id === accepted.id && detail !== undefined ? { ...detail, nativeId: 'foreign-native' } : detail;
    } });
    expect(report.outcomes).toEqual([]); expect(report.records.map(record => record.reason)).toEqual(['source-not-accepted', 'source-metadata-conflict']);
  } finally { db.close(); }
});

it('distinct native turns, recorded Hosts, actors and parent calls preserve separate scopes', () => {
  const db = openDb(':memory:');
  try {
    const ctx = setup(db); ctx.store.nativeHistory.bind(ctx.session.id, 'other-turn', 'other-public');
    ctx.mapping(ctx.terminal());
    ctx.mapping(ctx.terminal('completed', { nativeTurnId: 'other-turn' }));
    ctx.mapping(ctx.terminal('completed', { runtime: { ...ctx.identity, hostId: 'other-recorded-host' } }));
    ctx.mapping(ctx.terminal('completed', { native: { actorId: 'other-actor' } }));
    ctx.mapping(ctx.terminal('completed', { native: { parent_tool_use_id: 'other-parent' } }));
    const report = rebuildNativeTurnOutcomes(ctx.source);
    expect(report.outcomes).toHaveLength(5); expect(new Set(report.outcomes.map(outcome => outcome.scopeId)).size).toBe(5); expect(report.conflicts).toEqual([]);
  } finally { db.close(); }
});

it('a malformed JSON status cannot coerce an object or crash the rebuild', () => {
  const db = openDb(':memory:');
  try {
    const ctx = setup(db); const raw = ctx.mapping(ctx.terminal());
    const detail = ctx.source.get(raw.id)!; const report = rebuildNativeTurnOutcomes({ ...ctx.source,
      get: () => ({ ...detail, payload: { ...(detail.payload as object), status: { toString: 'invalid' } } }),
    });
    expect(report.records[0]).toMatchObject({ status: 'unsupported' }); expect(report.outcomes).toEqual([]);
  } finally { db.close(); }
});

it('completed items retain data in origins and require the terminal contract', () => {
  const db = openDb(':memory:');
  try {
    const ctx = setup(db); ctx.mapping({ type: 'item.complete', kind: 'turn.completed', itemKey: 'end', nativeTurnId: 'turn', runtime: ctx.identity,
      data: { status: 'interrupted', durationMs: 42, answerItemKeys: ['original'], reason: 'native reason' } });
    const report = rebuildNativeTurnOutcomes(ctx.source); expect(report.outcomes[0]?.status).toBe('interrupted');
    expect(report.outcomes[0]?.origins[0]?.payload).toMatchObject({ data: { durationMs: 42, answerItemKeys: ['original'], reason: 'native reason' } });
  } finally { db.close(); }
});

it('raw-only records, pagination and output budget cannot claim a complete native history', async () => {
  const db = openDb(':memory:');
  try {
    const ctx = setup(db); ctx.mapping({ type: 'turn.start', nativeTurnId: 'turn' });
    ctx.mapping(ctx.terminal('completed', { native: { large: 'x'.repeat(8000) } }));
    expect(rebuildNativeTurnOutcomes(ctx.source, { limit: 1 })).toMatchObject({ hasMore: true, complete: false });
    const report = rebuildNativeTurnOutcomes(ctx.source, { maxBytes: 4096 }); await evidence('budget', report);
    expect(Buffer.byteLength(JSON.stringify(report)) + 1).toBeLessThanOrEqual(4096); expect(report.complete).toBe(false);
    expect(report.records.some(record => record.reason === 'rebuild-output-size-limit')).toBe(true);
    expect(rebuildNativeTurnOutcomes(ctx.source, { after: report.next }).records).toEqual([]);
    expect(() => rebuildNativeTurnOutcomes(ctx.source, { limit: 0 })).toThrow();
  } finally { db.close(); }
});

it('the byte cap includes conflict annotations and cannot drop an unprocessed cursor', () => {
  const db = openDb(':memory:');
  try {
    const ctx = setup(db); for (let i = 0; i < 30; i++) ctx.mapping(ctx.terminal(i % 2 ? 'failed' : 'completed'));
    const report = rebuildNativeTurnOutcomes(ctx.source, { maxBytes: 4096 });
    expect(Buffer.byteLength(JSON.stringify(report)) + 1).toBeLessThanOrEqual(4096); expect(report.complete).toBe(false);
    expect(report.hasMore).toBe(true); expect(report.records.at(-1)?.id).toBe(report.next);
    expect(rebuildNativeTurnOutcomes(ctx.source, { after: report.next }).records[0]?.id).toBeGreaterThan(report.next);
  } finally { db.close(); }
});

it('readonly reader refuses a future schema without migrating or changing source bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-turn-future-')); const path = join(directory, 'future.sqlite'); const db = openDb(path);
  try { db.pragma('user_version = 999'); db.close(); const before = await fileHash(path);
    expect(() => readNativeTurnOutcomes(path)).toThrow('requires schema'); expect(await fileHash(path)).toBe(before);
  } finally { if (db.open) db.close(); await rm(directory, { recursive: true, force: true }); }
});

it('real Node SIGKILL leaves raw terminal recoverable while command and owner stay uncertain', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-turn-outcome-kill-'));
  const child = fork(join(import.meta.dirname, 'fixtures/turn-outcome-crash.ts'), [directory], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr?.on('data', chunk => { stderr += String(chunk); }); let db: Db | undefined;
  try {
    const [message] = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`child exited ${code}: ${stderr}`); })]);
    const { sessionId } = message as { sessionId: string }; const exited = once(child, 'exit'); child.kill('SIGKILL'); const exit = await exited;
    const path = join(directory, 'source.sqlite'); db = openDb(path); const store = new Store(db); const manager = new SessionManager(store, { idleDisposeMin: 0 });
    await manager.disposeAll(); const before = { owner: store.nativeOwners.get(sessionId), command: store.journal.get('CRASH'), events: store.allEvents(sessionId) }; db.close();
    const beforeHash = await fileHash(path); const report = readNativeTurnOutcomes(path); await evidence('sigkill', { exit, stderr, before, beforeHash, report });
    expect(exit[1]).toBe('SIGKILL'); expect(report.outcomes[0]).toMatchObject({ publicTurnId: 'public-turn', status: 'completed', nativeTurnId: 'turn' });
    expect(before.owner?.state).toBe('uncertain'); expect(before.command?.state).toBe('uncertain'); expect(before.events.some(event => event.kind === 'turn.completed')).toBe(false);
    expect(await fileHash(path)).toBe(beforeHash);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); if (db?.open) db.close(); await rm(directory, { recursive: true, force: true }); }
});
