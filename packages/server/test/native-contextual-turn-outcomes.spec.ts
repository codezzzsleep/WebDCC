import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AdapterEvent, AgentId } from '@webdcc/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { readNativeTurnOutcomes } from '../src/native-turn-outcome-reader.js';

const evidence = async (name: string, data: unknown) => {
  const dir = process.env['WDCC_TURN_CONTEXT_EVIDENCE_DIR']; if (dir !== undefined) await writeFile(join(dir, `${name}.json`), JSON.stringify(data, null, 2));
};
const hash = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
async function fixture(agent: AgentId = 'codex') {
  const dir = await mkdtemp(join(tmpdir(), 'wdcc-turn-context-')); const path = join(dir, 'source.sqlite'); const db = openDb(path); const store = new Store(db);
  const workspace = store.createWorkspace('contextual turn outcomes', tmpdir()); const session = store.createSession({ workspaceId: workspace.id, agent });
  store.updateSession(session.id, { nativeId: 'original-native-session' });
  let identity = store.nativeOwners.acquire('original-executor', session.id, agent, 'original-native-session'); store.nativeOwners.activate(session.id, identity, 'original-native-session');
  store.journal.claim({ op: 'send', sessionId: session.id, clientCommandId: 'original-input', text: 'original text' });
  store.journal.enqueue('original-input', session.id, 'original-public-turn', { text: 'original text' });
  store.appendEvent({ sessionId: session.id, turnId: 'original-public-turn', itemKey: 'input', kind: 'user.message', data: { text: 'original text' } });
  const record = (event: AdapterEvent, turnId: string | null = 'original-public-turn', patch: { late?: boolean; turnEnded?: boolean; context?: boolean } = {}) => {
    const raw = store.nativeEvents.mapping({ sessionId: session.id, agent, nativeId: 'original-native-session', identity }, { ...event, runtime: event.runtime ?? identity }, 'accepted');
    if (patch.context !== false) store.projectionContexts.record(raw.id, { sessionId: session.id, identity, turnId, late: patch.late ?? false, turnEnded: patch.turnEnded ?? false });
    return raw.id;
  };
  const terminal = (status: 'completed' | 'failed' | 'interrupted' = 'completed', identified = false): AdapterEvent => ({ type: 'turn.end', status,
    ...(identified ? { nativeTurnId: 'original-native-turn' } : {}), usage: { inputTokens: 7, outputTokens: 3, modelUsage: { opaque: { actual: true } } }, native: { original: true, requestId: 'original-request', opaque: [2, 1] } });
  const rows = () => ({ events: store.allEvents(session.id), owner: store.nativeOwners.get(session.id), queue: store.journal.queue(session.id), command: store.journal.get('original-input'),
    raw: store.nativeEvents.list(session.id, 0, 500).map(row => store.nativeEvents.get(row.id)), contexts: db.prepare("SELECT * FROM app_settings WHERE key LIKE 'native-projection-context:%' ORDER BY key").all() });
  const read = async () => { const before = db.serialize(); const report = readNativeTurnOutcomes(path); expect(db.serialize()).toEqual(before); return report; };
  return { db, store, session, path, record, terminal, rows, read, get identity() { return identity; }, replaceOwner: () => {
    store.nativeOwners.release(session.id, identity, true); identity = store.nativeOwners.acquire('replacement-executor', session.id, agent, 'original-native-session'); store.nativeOwners.activate(session.id, identity, 'original-native-session'); return identity;
  }, close: async () => { if (db.open) db.close(); await rm(dir, { recursive: true, force: true }); } };
}

it.each(['codex', 'claude-code', 'dsh'] as const)('%s anonymous and identified native terminal recover with actual context after SQLite publication abort and reopen', async agent => {
  const ctx = await fixture(agent);
  try {
    const ids = [];
    for (const identified of [false, true]) {
      if (identified) ctx.store.nativeHistory.bind(ctx.session.id, 'original-native-turn', 'original-public-turn');
      ids.push(ctx.record(ctx.terminal('completed', identified)));
    }
    ctx.db.exec("CREATE TRIGGER reject_end BEFORE INSERT ON events WHEN NEW.kind = 'turn.completed' BEGIN SELECT RAISE(ABORT, 'actual failed terminal publication'); END");
    for (const id of ids) expect(() => ctx.store.appendEvent({ sessionId: ctx.session.id, turnId: 'original-public-turn', itemKey: 'terminal', kind: 'turn.completed', data: { status: 'completed', durationMs: 1 }, nativeEnvelopeId: id })).toThrow('actual failed terminal publication');
    const rows = ctx.rows(); ctx.db.close(); const beforeHash = await hash(ctx.path); const report = readNativeTurnOutcomes(ctx.path);
    await evidence(agent, { rows, beforeHash, report }); expect(await hash(ctx.path)).toBe(beforeHash);
    expect(report.outcomes).toHaveLength(2); expect(report.outcomes.map(outcome => outcome.nativeTurnId)).toEqual([null, 'original-native-turn']);
    expect(report.outcomes.every(outcome => outcome.publicTurnId === 'original-public-turn' && outcome.status === 'completed')).toBe(true);
    expect(report.outcomes[0]).toMatchObject({ identity: ctx.identity, assignments: [{ envelopeId: ids[0], late: false, turnEnded: false }] });
    expect(report.outcomes[0]?.origins[0]?.payload).toMatchObject({ native: { requestId: 'original-request', opaque: [2, 1] } });
    expect(report.outcomes[0]).not.toHaveProperty('durationMs'); expect(report.outcomes[0]).not.toHaveProperty('answerItemKeys');
    const reopened = openDb(ctx.path); try { const store = new Store(reopened); expect(store.allEvents(ctx.session.id)).toEqual(rows.events); expect(store.journal.queue(ctx.session.id)).toEqual(rows.queue); expect(store.nativeOwners.get(ctx.session.id)).toEqual(rows.owner); } finally { reopened.close(); }
  } finally { await ctx.close(); }
});

it('anonymous identical terminal bodies remain separate in actual public turns and owner generations', async () => {
  const ctx = await fixture();
  try {
    ctx.record(ctx.terminal()); ctx.store.appendEvent({ sessionId: ctx.session.id, turnId: 'another-public-turn', itemKey: 'another', kind: 'user.message', data: { text: 'another input' } });
    ctx.record(ctx.terminal(), 'another-public-turn'); const original = ctx.identity; ctx.replaceOwner(); ctx.record(ctx.terminal());
    const report = await ctx.read(); await evidence('distinct-assignments', report); expect(report.outcomes).toHaveLength(3); expect(new Set(report.outcomes.map(outcome => outcome.scopeId)).size).toBe(3);
    expect(report.outcomes[0]).toMatchObject({ identity: original, publicTurnId: 'original-public-turn' }); expect(report.outcomes[2]).toMatchObject({ identity: ctx.identity, publicTurnId: 'original-public-turn' });
  } finally { await ctx.close(); }
});

it('ten anonymous repeats retain each context digest and late/ended assignment without changing the original terminal', async () => {
  const ctx = await fixture('claude-code');
  try {
    const ids = Array.from({ length: 10 }, (_, i) => ctx.record(ctx.terminal('interrupted'), undefined, { late: i > 0, turnEnded: i > 0 }));
    const report = await ctx.read(); await evidence('ten-repeat', report); expect(report.outcomes).toHaveLength(1); expect(report.outcomes[0]?.origins.map(row => row.id)).toEqual(ids);
    expect(report.outcomes[0]?.assignments?.map(row => row.envelopeId)).toEqual(ids); expect(new Set(report.outcomes[0]?.assignments?.map(row => row.contextDigest)).size).toBe(10);
    expect(report.outcomes[0]?.assignments?.at(-1)).toMatchObject({ late: true, turnEnded: true }); expect(report.outcomes[0]?.status).toBe('interrupted');
  } finally { await ctx.close(); }
});

it('contradictory anonymous native outcomes retain both statuses and never choose the latest', async () => {
  const ctx = await fixture('dsh');
  try { ctx.record(ctx.terminal()); ctx.record(ctx.terminal('failed')); const report = await ctx.read(); await evidence('conflicting-outcomes', report);
    expect(report.outcomes.map(row => row.status)).toEqual(['completed', 'failed']); expect(report.conflicts).toHaveLength(1); expect(report.complete).toBe(false);
  } finally { await ctx.close(); }
});

it.each(['missing', 'invalid-json', 'version', 'digest', 'schema', 'runtime-host', 'session-scope'] as const)('%s original assignment cannot be guessed or hidden by a legacy witness', async kind => {
  const ctx = await fixture();
  try {
    ctx.store.nativeHistory.bind(ctx.session.id, 'original-native-turn', 'original-public-turn');
    const event = kind === 'runtime-host' ? { ...ctx.terminal('completed', true), runtime: { ...ctx.identity, hostId: 'foreign-host' } } : { ...ctx.terminal('completed', true), ...(kind === 'session-scope' ? { scope: 'session' as const } : {}) };
    const id = ctx.record(event); const key = `native-projection-context:${id}`;
    ctx.store.appendEvent({ sessionId: ctx.session.id, turnId: 'original-public-turn', itemKey: 'legacy witness', kind: 'assistant.message', data: { text: 'committed witness' }, nativeEnvelopeId: id });
    if (kind === 'missing') { ctx.db.prepare('DELETE FROM app_settings WHERE key = ?').run(key); const anonymous = ctx.record(ctx.terminal(), undefined, { context: false }); void anonymous; }
    if (kind === 'invalid-json') ctx.db.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run('{broken', key);
    if (kind === 'version') ctx.db.prepare("UPDATE app_settings SET value = json_set(value, '$.formatVersion', 99) WHERE key = ?").run(key);
    if (kind === 'digest') ctx.db.prepare("UPDATE app_settings SET value = json_set(value, '$.contextDigest', 'invalid') WHERE key = ?").run(key);
    if (kind === 'schema') ctx.db.prepare('UPDATE native_event_envelopes SET schema_hash = ? WHERE id = ?').run('unknown schema', id);
    const report = await ctx.read(); await evidence(`invalid-${kind}`, report);
    if (kind === 'missing') { expect(report.outcomes).toHaveLength(1); expect(report.outcomes[0]).not.toHaveProperty('identity'); expect(report.records.at(-1)?.status).toBe('unverified'); }
    else { expect(report.outcomes).toEqual([]); expect(report.records[0]?.reason).toBeTruthy(); }
    expect(report.complete).toBe(false);
  } finally { await ctx.close(); }
});

it('a conflicting committed native-public witness cannot override the recorded assignment', async () => {
  const ctx = await fixture();
  try {
    ctx.store.nativeHistory.bind(ctx.session.id, 'original-native-turn', 'other-public-turn'); const id = ctx.record(ctx.terminal('completed', true));
    ctx.store.appendEvent({ sessionId: ctx.session.id, turnId: 'other-public-turn', itemKey: 'other-witness', kind: 'assistant.message', data: { text: 'different committed turn' }, nativeEnvelopeId: id });
    const report = await ctx.read(); await evidence('legacy-context-conflict', report); expect(report.outcomes).toEqual([]); expect(report.records[0]?.reason).toBe('native-public-turn-context-conflict');
  } finally { await ctx.close(); }
});

it('session/null assignment and restricted source remain explicit instead of creating an actionable turn', async () => {
  const ctx = await fixture();
  try { ctx.record(ctx.terminal(), null); const report = await ctx.read(); expect(report.outcomes).toEqual([]); expect(report.records[0]?.reason).toBe('native-terminal-public-turn-not-recorded');
    ctx.store.nativeEvents.restrictSession(ctx.session.id); const restricted = await ctx.read(); expect(restricted.outcomes).toEqual([]); expect(restricted.records[0]?.status).toBe('unavailable');
  } finally { await ctx.close(); }
});

it.each(['codex', 'claude-code', 'dsh'] as const)('%s actual callback/timer SQL failure and Node SIGKILL preserve anonymous native statuses without retry or receipt changes', async agent => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-contextual-turn-kill-'));
  const child = fork(join(import.meta.dirname, 'fixtures/contextual-turn-crash.ts'), [directory, agent], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr?.on('data', chunk => { stderr += String(chunk); });
  try {
    const [value] = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`child exited ${code}: ${stderr}`); })]);
    const message = value as { sends: number; cases: { sessionId: string; turnId: string; status: string; commandId: string }[] }; const exited = once(child, 'exit'); child.kill('SIGKILL'); const exit = await exited;
    const path = join(directory, 'source.sqlite'); const beforeHash = await hash(path); const before = JSON.parse(await readFile(join(directory, 'before.json'), 'utf8')) as unknown;
    const report = readNativeTurnOutcomes(path); expect(await hash(path)).toBe(beforeHash); expect(exit[1]).toBe('SIGKILL'); expect(message.sends).toBe(3);
    expect(report.outcomes.map(row => row.status)).toEqual(['completed', 'failed', 'interrupted']); expect(report.outcomes.every(row => row.nativeTurnId === null)).toBe(true);
    const db = openDb(path); const store = new Store(db);
    try {
      for (const original of message.cases) {
        expect(report.outcomes.find(row => row.sessionId === original.sessionId)?.publicTurnId).toBe(original.turnId);
        expect(store.journal.get(original.commandId)?.state).toBe('uncertain'); expect(store.nativeOwners.get(original.sessionId)?.state).toBe('uncertain');
        expect(store.allEvents(original.sessionId).some(row => row.kind === 'turn.completed')).toBe(false);
      }
      const output = process.env['WDCC_TURN_CONTEXT_EVIDENCE_DIR']; if (output !== undefined) await db.backup(join(output, `${agent}-sigkill-source.sqlite`));
    } finally { db.close(); }
    await evidence(`${agent}-sigkill`, { message, exit, stderr, beforeHash, before, report });
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); }
});

it('contextual output budget includes every assignment and preserves the unread cursor explicitly', async () => {
  const ctx = await fixture();
  try {
    for (let i = 0; i < 30; i++) ctx.record(ctx.terminal()); const before = ctx.db.serialize();
    const report = readNativeTurnOutcomes(ctx.path, { maxBytes: 4096 }); await evidence('contextual-budget', report);
    expect(Buffer.byteLength(JSON.stringify(report)) + 1).toBeLessThanOrEqual(4096); expect(report.complete).toBe(false); expect(report.hasMore).toBe(true);
    expect(report.outcomes.every(row => row.origins.length === row.assignments?.length)).toBe(true); expect(report.records.at(-1)?.id).toBe(report.next);
    expect(readNativeTurnOutcomes(ctx.path, { after: report.next }).records[0]?.id).toBeGreaterThan(report.next); expect(ctx.db.serialize()).toEqual(before);
  } finally { await ctx.close(); }
});

it('an actual ignored unknown native-turn assignment remains unverified', async () => {
  const ctx = await fixture();
  try {
    const raw = ctx.store.nativeEvents.mapping({ sessionId: ctx.session.id, nativeId: 'original-native-session', agent: 'codex', identity: ctx.identity }, { ...ctx.terminal('completed', true), runtime: ctx.identity }, 'accepted');
    ctx.store.projectionContexts.record(raw.id, { sessionId: ctx.session.id, identity: ctx.identity, turnId: null, late: false, turnEnded: false, ignoredReason: 'unknown-native-turn' });
    const report = await ctx.read(); expect(report.outcomes).toEqual([]); expect(report.records[0]?.reason).toBe('unknown-native-turn');
  } finally { await ctx.close(); }
});
