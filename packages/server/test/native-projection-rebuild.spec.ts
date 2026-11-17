import { fork, execFile } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import type { AdapterEvent, NativeEnvelopeDetail } from '@webdcc/protocol';
import { openDb, type Db } from '../src/db.js';
import { Store } from '../src/store.js';
import { readNativeProjection } from '../src/native-projection-reader.js';
import { rebuildNativeProjection } from '../src/native-projection-rebuild.js';

const execute = promisify(execFile);
type Completion = Extract<AdapterEvent, { type: 'item.complete' }>;
function setup(db: Db) {
  const store = new Store(db); const workspace = store.createWorkspace('rebuild', '/tmp');
  const session = store.createSession({ workspaceId: workspace.id, agent: 'claude-code' });
  const identity = store.nativeOwners.acquire('owner', session.id, 'claude-code', 'native');
  const context = { sessionId: session.id, agent: 'claude-code', nativeId: 'native', identity };
  const event: Completion = { type: 'item.complete', itemKey: 'item', kind: 'assistant.message', data: { text: 'original', nativePhase: 'commentary' },
    nativeSeq: 1, nativeTurnId: 'turn', runtime: identity, native: { type: 'assistant', session_id: 'native', agent_id: 'actor', parent_tool_use_id: 'parent', opaque: { z: 2, a: 1 } } };
  return { store, session, context, event };
}
function dump(db: Db): unknown {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]));
}
async function evidence(name: string, value: unknown): Promise<void> {
  const directory = process.env['WDCC_PROJECTION_REBUILD_EVIDENCE_DIR'];
  if (directory !== undefined) await writeFile(join(directory, `${name}.json`), JSON.stringify(value, null, 2) + '\n');
}

it('reconstructs captured raw after a real semantic transaction failure without touching original tables or pending claims', async () => {
  const db = openDb(':memory:');
  try {
    const { store, context, event } = setup(db); const raw = store.nativeEvents.mapping(context, event, 'accepted');
    db.exec("CREATE TEMP TRIGGER refuse_semantic BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'controlled semantic failure'); END");
    expect(() => store.appendEvent({ sessionId: context.sessionId, turnId: 'public-turn', itemKey: event.itemKey, kind: event.kind, data: event.data, nativeEnvelopeId: raw.id })).toThrow('controlled semantic failure');
    const before = dump(db); const result = rebuildNativeProjection(store.nativeEvents); const after = dump(db);
    await evidence('transaction', { raw, event, result, before, after });
    expect(result.complete).toBe(true); expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ kind: event.kind, itemKey: event.itemKey, data: event.data, native: event.native,
      origins: [{ id: raw.id, nativeId: 'native', nativeTurnId: 'turn', actorId: 'actor', parentToolUseId: 'parent' }] });
    expect(after).toEqual(before); expect(store.allEvents(context.sessionId)).toHaveLength(0);
  } finally { db.close(); }
});

it('ten captured repeats retain every origin and rebuild once across a new owner generation and JSON key order', async () => {
  const db = openDb(':memory:');
  try {
    const { store, context, event } = setup(db); const rawIds = [];
    for (let count = 0; count < 5; count++) rawIds.push(store.nativeEvents.mapping(context, event, 'accepted').id);
    store.nativeOwners.release(context.sessionId, context.identity, true);
    const identity = store.nativeOwners.acquire('new-owner', context.sessionId, 'claude-code', 'native');
    const repeated: Completion = { ...event, runtime: identity, data: { nativePhase: 'commentary', text: 'original' } };
    for (let count = 0; count < 5; count++) rawIds.push(store.nativeEvents.mapping({ ...context, identity }, repeated, 'accepted').id);
    const report = rebuildNativeProjection(store.nativeEvents); await evidence('ten-repeats', { rawIds, report });
    expect(report.items).toHaveLength(1); expect(report.items[0]?.origins.map(row => row.id)).toEqual(rawIds);
    expect(report.records.filter(row => row.status === 'duplicate')).toHaveLength(9); expect(report.complete).toBe(true);
    expect(report.items[0]?.origins.map(row => row.generation)).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
  } finally { db.close(); }
});

it('different native session, turn, actor, parent and content identities remain separate', () => {
  const db = openDb(':memory:');
  try {
    const { store, context, event } = setup(db);
    const native = event.native as Record<string, unknown>;
    for (const variant of [event, { ...event, native: { ...native, session_id: 'other-native' } }, { ...event, nativeTurnId: 'other-turn' },
      { ...event, native: { ...native, agent_id: 'other-actor' } }, { ...event, native: { ...native, parent_tool_use_id: 'other-parent' } },
      { ...event, data: { text: 'changed' } }]) store.nativeEvents.mapping(context, variant as Completion, 'accepted');
    const report = rebuildNativeProjection(store.nativeEvents); expect(report.items).toHaveLength(6);
    expect(new Set(report.items.map(item => item.projectionId)).size).toBe(6);
  } finally { db.close(); }
});

it.each([
  ['reasoning', { text: 'reasoning' }], ['file.read', { path: '/tmp/file', status: 'completed', output: 'read' }],
  ['command', { command: 'pwd', status: 'completed', outputTail: '/tmp', exitCode: 0 }],
  ['tool.call', { name: 'Read', input: { path: '/tmp/file' }, output: 'read', status: 'completed' }],
  ['file.change', { changes: [{ path: '/tmp/file', kind: 'modify', added: 1, removed: 0 }], status: 'failed' }],
] as const)('rebuilds supported %s terminal data without inventing a turn end', (kind, data) => {
  const db = openDb(':memory:');
  try {
    const { store, context, event } = setup(db); store.nativeEvents.mapping(context, { ...event, kind, data } as Completion, 'accepted');
    const report = rebuildNativeProjection(store.nativeEvents); expect(report.items[0]).toMatchObject({ kind, data });
    expect(report.complete).toBe(true); expect(store.allEvents(context.sessionId)).toHaveLength(0);
  } finally { db.close(); }
});

it.each(['future-schema', 'restricted', 'malformed', 'omitted', 'oversize', 'masked', 'incomplete', 'stale-source', 'identity-missing'] as const)('%s remains explicit and cannot certify complete reconstruction', async failure => {
  const db = openDb(':memory:');
  try {
    const { store, context, event } = setup(db);
    const modified = failure === 'omitted' ? { ...event, native: { omitted: 'controlled missing source' } }
      : failure === 'oversize' ? { ...event, data: { text: 'x'.repeat(1024 * 1024) } }
      : failure === 'masked' ? { ...event, data: { text: 'prefix <redacted> suffix' } }
      : failure === 'incomplete' ? { ...event, data: { text: 'partial', incomplete: true } } : event;
    const raw = store.nativeEvents.mapping(failure === 'identity-missing' ? { sessionId: context.sessionId, agent: context.agent } : context,
      failure === 'identity-missing' ? { ...event, native: undefined, runtime: undefined } : modified, failure === 'stale-source' ? 'stale-generation' : 'accepted');
    if (failure === 'future-schema') db.prepare('UPDATE native_event_envelopes SET schema_hash = ? WHERE id = ?').run('future', raw.id);
    if (failure === 'restricted') store.nativeEvents.restrictSession(context.sessionId);
    if (failure === 'malformed') db.prepare('UPDATE native_event_envelopes SET payload = ? WHERE id = ?').run('{invalid', raw.id);
    const before = dump(db); const report = rebuildNativeProjection(store.nativeEvents); await evidence(failure, { report, raw });
    expect(report.items).toHaveLength(0); expect(report.complete).toBe(false); expect(report.records[0]?.reason).toBeDefined(); expect(dump(db)).toEqual(before);
  } finally { db.close(); }
});

it('transport, unknown mappings and an empty range remain outside completed item reconstruction', () => {
  const db = openDb(':memory:');
  try {
    const { store, context } = setup(db); expect(rebuildNativeProjection(store.nativeEvents).complete).toBe(false);
    store.nativeEvents.frame(context, { i: 0, t: 0, dir: 'in', ch: 'rpc', frame: { method: 'unmapped/notification', params: {} } }, true);
    store.nativeEvents.mapping(context, { type: 'turn.end', status: 'completed' }, 'accepted');
    store.nativeEvents.mapping(context, { type: 'item.complete', itemKey: 'unknown', kind: 'unknown', data: { nativeType: 'unmapped', raw: {} }, nativeSeq: 1 }, 'accepted');
    const report = rebuildNativeProjection(store.nativeEvents); expect(report.items).toHaveLength(0); expect(report.complete).toBe(false);
    expect(report.records.map(row => row.status)).toEqual(['raw-only', 'raw-only', 'unsupported']);
  } finally { db.close(); }
});

it('missing source details and mismatched metadata stay unverified controlled evidence', () => {
  const db = openDb(':memory:');
  try {
    const { store, context, event } = setup(db); store.nativeEvents.mapping(context, event, 'accepted');
    const source = store.nativeEvents;
    const reader = { schemaHash: source.schemaHash, list: source.list.bind(source), restricted: source.restricted.bind(source), diagnosticValue: source.diagnosticValue.bind(source),
      get: (_id: number): NativeEnvelopeDetail | undefined => undefined };
    expect(rebuildNativeProjection(reader).records[0]?.status).toBe('unavailable');
    reader.get = id => ({ ...source.get(id)!, nativeId: 'foreign' });
    expect(rebuildNativeProjection(reader).records[0]?.reason).toBe('source-metadata-conflict');
  } finally { db.close(); }
});

it.each(['missing-host', 'invalid-runtime', 'wrong-owner', 'wrong-generation'] as const)('%s cannot certify the captured runtime identity', failure => {
  const db = openDb(':memory:');
  try {
    const { store, context, event } = setup(db); const raw = store.nativeEvents.mapping(context, event, 'accepted');
    const runtime = failure === 'invalid-runtime' ? 'invalid'
      : failure === 'missing-host' ? { ownerId: context.identity.ownerId, generation: context.identity.generation }
        : { ...context.identity, ...(failure === 'wrong-owner' ? { ownerId: 'foreign' } : { generation: 9 }) };
    db.prepare('UPDATE native_event_envelopes SET payload = ? WHERE id = ?').run(JSON.stringify({ ...event, runtime }), raw.id);
    const report = rebuildNativeProjection(store.nativeEvents);
    expect(report.items).toHaveLength(0); expect(report.complete).toBe(false);
    expect(report.records[0]?.reason).toBe('mapping-source-identity-conflict');
  } finally { db.close(); }
});

it('bounds output bytes and paging while projection IDs remain stable across windows', async () => {
  const db = openDb(':memory:');
  try {
    const { store, context, event } = setup(db);
    for (let index = 0; index < 5; index++) store.nativeEvents.mapping(context, { ...event, itemKey: `item-${index}`, nativeSeq: index, data: { text: `${index}` + 'x'.repeat(2000) } }, 'accepted');
    const report = rebuildNativeProjection(store.nativeEvents, { maxBytes: 4096 }); const all = rebuildNativeProjection(store.nativeEvents);
    expect(Buffer.byteLength(JSON.stringify(report)) + 1).toBeLessThanOrEqual(4096); expect(report.complete).toBe(false); expect(report.hasMore).toBe(true);
    const page = rebuildNativeProjection(store.nativeEvents, { limit: 1 }); expect(page.hasMore).toBe(true); expect(page.items[0]?.projectionId).toBe(all.items[0]?.projectionId);
    const next = rebuildNativeProjection(store.nativeEvents, { after: page.next, limit: 1 }); expect(next.items[0]?.projectionId).toBe(all.items[1]?.projectionId);
    await evidence('budget-window', { report, page, next, all });
    expect(() => rebuildNativeProjection(store.nativeEvents, { limit: 501 })).toThrow(); expect(() => rebuildNativeProjection(store.nativeEvents, { after: -1 })).toThrow();
  } finally { db.close(); }
});

it('SIGKILL after raw commit rebuilds through a readonly database without native replay or owner recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-rebuild-crash-'));
  const child = fork(join(import.meta.dirname, 'fixtures/projection-rebuild-crash.ts'), [directory], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr!.setEncoding('utf8'); child.stderr!.on('data', chunk => { stderr += String(chunk); });
  try {
    const ready = await new Promise<{ sessionId: string; event: Completion }>((resolve, reject) => {
      child.once('message', value => resolve(value as { sessionId: string; event: Completion }));
      child.once('error', reject); child.once('exit', (code, signal) => reject(new Error(`raw capture exited before ready ${code}/${signal}: ${stderr}`)));
    });
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const report = readNativeProjection(join(directory, 'db.sqlite'), { sessionId: ready.sessionId });
    await evidence('sigkill', { ready, report, stderr, signal: child.signalCode });
    expect(report.items[0]).toMatchObject({ data: ready.event.data, native: ready.event.native }); expect(report.complete).toBe(true);
    const db = openDb(join(directory, 'db.sqlite'));
    try { expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 }); expect(new Store(db).nativeOwners.get(ready.sessionId)?.state).toBe('opening'); }
    finally { db.close(); }
  } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } await rm(directory, { recursive: true, force: true }); }
});

it.each(['', '-wal', '-shm', '-journal'])('the real CLI refuses directory aliases of its source database%s without changing original bytes', async suffix => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-rebuild-alias-')); const real = join(directory, 'real'); const alias = join(directory, 'alias');
  await mkdir(real); await symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const path = join(real, 'db.sqlite'); const db = openDb(path); setup(db); db.close();
  const target = path + suffix;
  if (suffix !== '') await writeFile(target, 'owned journal bytes must stay unchanged');
  const databaseBefore = await readFile(path); const targetBefore = await readFile(target);
  const cli = join(import.meta.dirname, '../../../scripts/rebuild-native-projection.ts');
  try {
    for (const [source, output] of [[path, join(alias, `db.sqlite${suffix}`)], [join(alias, 'db.sqlite'), target]]) {
      await expect(execute(process.execPath, ['--import', 'tsx', cli, '--database', source, '--output', output]))
        .rejects.toThrow('Projection artifact cannot replace its source database or journal');
      expect(await readFile(path)).toEqual(databaseBefore); expect(await readFile(target)).toEqual(targetBefore);
    }
    await evidence(`cli-directory-alias${suffix || '-database'}`, { databaseHash: createHash('sha256').update(databaseBefore).digest('hex'),
      targetHash: createHash('sha256').update(targetBefore).digest('hex'), suffix, sourceAndOutputDirectoryAliasesRejected: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('the real CLI resolves a linked source database before protecting the original database and journals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-rebuild-source-link-')); const path = join(directory, 'db.sqlite');
  const db = openDb(path); const { store, context, event } = setup(db);
  store.nativeEvents.mapping(context, event, 'accepted'); db.close(); const source = join(directory, 'source-link.sqlite');
  await symlink(path, source, 'file'); const before = await readFile(path);
  const cli = join(import.meta.dirname, '../../../scripts/rebuild-native-projection.ts');
  try {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const target = path + suffix; if (suffix !== '') await writeFile(target, 'owned linked-source journal bytes');
      const targetBefore = await readFile(target);
      await expect(execute(process.execPath, ['--import', 'tsx', cli, '--database', source, '--output', target]))
        .rejects.toThrow('Projection artifact cannot replace its source database or journal');
      expect(await readFile(path)).toEqual(before); expect(await readFile(target)).toEqual(targetBefore);
    }
    for (const suffix of ['-wal', '-shm', '-journal']) await rm(path + suffix);
    const output = join(directory, 'independent.json');
    await execute(process.execPath, ['--import', 'tsx', cli, '--database', source, '--output', output]);
    expect(JSON.parse(await readFile(output, 'utf8')).items).toHaveLength(1); expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(await readFile(path)).toEqual(before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('the real CLI produces byte-stable private artifacts and refuses future schema or database/journal output targets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-rebuild-cli-')); const path = join(directory, 'db.sqlite'); const db = openDb(path);
  const { store, context, event } = setup(db); store.nativeEvents.mapping(context, event, 'accepted'); db.close();
  const before = createHash('sha256').update(await readFile(path)).digest('hex'); const first = join(directory, 'first.json'); const second = join(directory, 'second.json');
  const cli = join(import.meta.dirname, '../../../scripts/rebuild-native-projection.ts');
  try {
    const one = await execute(process.execPath, ['--import', 'tsx', cli, '--database', path, '--output', first]);
    const two = await execute(process.execPath, ['--import', 'tsx', cli, '--database', path, '--output', second]);
    expect(await readFile(first, 'utf8')).toBe(await readFile(second, 'utf8')); expect((await stat(first)).mode & 0o777).toBe(0o600);
    expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(before);
    for (const target of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) await expect(execute(process.execPath, ['--import', 'tsx', cli, '--database', path, '--output', target])).rejects.toThrow();
    await evidence('cli', { first: JSON.parse(one.stdout), second: JSON.parse(two.stdout), report: JSON.parse(await readFile(first, 'utf8')), databaseHash: before });
    const future = openDb(path); future.pragma('user_version = 16'); future.close(); const futureHash = createHash('sha256').update(await readFile(path)).digest('hex');
    expect(() => readNativeProjection(path)).toThrow('requires database schema 15'); expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(futureHash);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
