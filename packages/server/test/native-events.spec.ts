import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FakeAdapter } from '@webdcc/fake-adapter';
import type { AdapterEvent, AgentAdapter, CreateOpts, NativeFrameSink } from '@webdcc/protocol';
import { JsonRpcStdio } from '../../adapters/codex/src/rpc.js';
import { openDb, CURRENT_SCHEMA_VERSION } from '../src/db.js';
import { Store } from '../src/store.js';
import { createTestApp, seedWorkspaceAndSession } from './helpers.js';

it('NP-05 host-wide RPC records keep verified Host and transport identity without impersonating a Web session', async () => {
  const ctx = await createTestApp();
  let sink: NativeFrameSink | undefined;
  const adapter: AgentAdapter = new FakeAdapter({ id: 'dsh' }); adapter.bindGlobalNativeEvents = value => { sink = value; };
  ctx.manager.registerAdapter(adapter);
  try {
    const receipt = sink!.record({ i: 1, t: 0, dir: 'in', ch: 'rpc:settings/describe', frame: {
      frame: { type: 'server-response', rpcId: 'transport-request', result: { ok: true, value: { namespaces: [] } } },
      dshTransport: { endpoint: 'settings/describe', rpcId: 'transport-request', coverage: 'complete', httpStatus: 200,
        hostEpoch: 1, muxGeneration: 1, verifiedHostFingerprint: 'a'.repeat(64) },
    } });
    const record = ctx.store.nativeEvents.get(receipt.envelopeId)!;
    expect(record).toMatchObject({ nativeRequestId: 'transport-request', ownerId: null, generation: null });
    expect(record.sessionId).toMatch(/^@native-host:dsh:/); expect(ctx.store.getSession(record.sessionId)).toBeUndefined();
    const failure = sink!.record({ i: 2, t: 0, dir: 'in', ch: 'rpc:settings/describe', frame: {
      frame: { omitted: 'authentication-response' }, dshTransport: { endpoint: 'settings/describe', rpcId: 'auth-failure',
        coverage: 'http-auth-rejected', httpStatus: 401, hostEpoch: 1, muxGeneration: 1 },
    } });
    expect(ctx.store.nativeEvents.get(failure.envelopeId)).toMatchObject({ nativeRequestId: 'auth-failure', payloadCoverage: 'unavailable' });
  } finally { await ctx.close(); }
});

it('NP-05 SDK stdio associates native control request IDs and declares undecodable payload coverage', () => {
  const db = openDb(':memory:'); const store = new Store(db);
  const context = { sessionId: 'sdk', agent: 'claude-code', identity: { ownerId: 'owner', generation: 2, hostId: 'host' } };
  try {
    const request = store.nativeEvents.frame(context, { i: 1, t: 0, dir: 'in', ch: 'claude-stdio:stdout', frame: {
      frame: { type: 'control_request', request_id: 'sdk-request', request: { subtype: 'elicitation', requested_schema: { properties: { password: { writeOnly: true } } } } },
      stdio: { stream: 'stdout', line: 1, byteLength: 128, coverage: 'complete', terminated: true },
    } }, true);
    expect(store.nativeEvents.get(request)).toMatchObject({ nativeRequestId: 'sdk-request', payloadCoverage: 'restricted' });
    expect(store.nativeEvents.get(request)?.payload).toMatchObject({ stdio: { byteLength: 128, coverage: 'complete' } });
    const response = store.nativeEvents.frame(context, { i: 2, t: 0, dir: 'out', ch: 'claude-stdio:stdin', frame: {
      frame: { type: 'control_response', response: { request_id: 'sdk-request', subtype: 'success', response: { content: 'never-store-secret' } } },
      stdio: { stream: 'stdin', line: 2, byteLength: 128, coverage: 'complete', terminated: true },
    } }, true);
    expect(store.nativeEvents.get(response)).toMatchObject({ nativeRequestId: 'sdk-request', payloadCoverage: 'restricted' });
    expect(JSON.stringify(store.nativeEvents.get(response))).not.toContain('never-store-secret');
    const malformed = store.nativeEvents.frame({ ...context, sessionId: 'ordinary-sdk' }, { i: 3, t: 0, dir: 'in', ch: 'claude-stdio:stderr', frame: {
      frame: { omitted: 'undecodable-line' }, stdio: { stream: 'stderr', line: 1, byteLength: 80, coverage: 'invalid-json', terminated: true },
    } }, true);
    expect(store.nativeEvents.get(malformed)?.payloadCoverage).toBe('unavailable');
  } finally { db.close(); }
});

it('NP-05 native request identity retains string/number types and sensitive response policy survives reopening', () => {
  const db = openDb(':memory:');
  try {
    let store = new Store(db);
    const context = { sessionId: 'session', agent: 'codex', identity: { ownerId: 'owner', generation: 1, hostId: 'host' } };
    const ask = store.nativeEvents.frame(context, { i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { id: 0, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'pw', isSecret: true }] } } }, true);
    expect(store.nativeEvents.get(ask)?.payloadCoverage).toBe('restricted');
    store = new Store(db);
    const response = store.nativeEvents.frame(context, { i: 2, t: 0, dir: 'out', ch: 'rpc', frame: { id: 0, result: { answers: { pw: { answers: ['never-persist-this-fixture-value'] } } } } }, true);
    const other = store.nativeEvents.frame(context, { i: 3, t: 0, dir: 'out', ch: 'rpc', frame: { id: '0', result: { ordinary: 'preserved' } } }, true);
    expect(store.nativeEvents.get(response)?.nativeRequestId).toBe(0);
    expect(store.nativeEvents.get(response)?.payloadCoverage).toBe('restricted');
    expect(JSON.stringify(store.nativeEvents.get(response))).not.toContain('never-persist');
    expect(store.nativeEvents.get(other)?.nativeRequestId).toBe('0');
    // Once the session declares secret input, unrelated frame fragments in
    // that session remain restricted too; the typed request ID is still exact.
    expect(store.nativeEvents.get(other)?.payloadCoverage).toBe('restricted');
    const ordinary = store.nativeEvents.frame({ ...context, sessionId: 'ordinary' }, { i: 4, t: 0, dir: 'out', ch: 'rpc', frame: { id: '0', result: { text: 'ordinary visible content' } } }, true);
    expect(store.nativeEvents.get(ordinary)).toMatchObject({ nativeRequestId: '0', payloadCoverage: 'redacted', payload: { result: { text: 'ordinary visible content' } } });
  } finally { db.close(); }
});

it('NP-14 declared secret sessions restrict split raw fragments and retain that policy after reopening', () => {
  const db = openDb(':memory:'); let store = new Store(db);
  const context = { sessionId: 'sensitive', agent: 'codex' };
  try {
    store.nativeEvents.frame(context, { i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { id: 0, method: 'item/tool/requestUserInput', params: { questions: [{ isSecret: true }] } } }, true);
    store.nativeEvents.addSecret('secret-joined-value');
    for (const [index, delta] of ['secret-joined-', 'value'].entries()) {
      const id = store.nativeEvents.frame(context, { i: index + 2, t: 0, dir: 'in', ch: 'rpc', frame: { method: 'item/agentMessage/delta', params: { delta } } }, true);
      expect(store.nativeEvents.get(id)).toMatchObject({ payloadCoverage: 'restricted', payload: { omitted: 'sensitive-session-native-payload' } });
    }
    store = new Store(db);
    const id = store.nativeEvents.frame(context, { i: 4, t: 0, dir: 'in', ch: 'sdk', frame: { type: 'delta', text: 'new arbitrary prefix' } }, true);
    expect(store.nativeEvents.get(id)?.payloadCoverage).toBe('restricted');
    expect(JSON.stringify(store.nativeEvents.list(context.sessionId).map(record => store.nativeEvents.get(record.id)))).not.toContain('secret-joined-');
  } finally { db.close(); }
});

it('NP-05 repeated immutable completion produces one semantic event and all observations remain inspectable', async () => {
  const ctx = await createTestApp(); const adapter = new FakeAdapter({ id: 'codex' });
  let callback!: (id: string, event: AdapterEvent) => void; adapter.onEvent = cb => { callback = cb; };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    for (let i = 0; i < 10; i++) callback(sessionId, { type: 'item.complete', itemKey: 'native-item', kind: 'assistant.message', data: { text: 'complete' }, native: { id: 'native-item', type: 'agentMessage' } });
    const events = ctx.store.allEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.turnId).toBeNull();
    expect(events[0]?.nativeEnvelopeId).toBeGreaterThan(0);
    const records = ctx.store.nativeEvents.list(sessionId);
    expect(records).toHaveLength(10);
    expect(records.filter(record => record.disposition === 'duplicate-projection')).toHaveLength(9);
    const detail = await ctx.app.inject({ url: `/api/native-events/${events[0]!.nativeEnvelopeId}`, headers: { cookie: ctx.cookie } });
    expect(detail.json()).toMatchObject({ source: 'mapping', payload: { kind: 'assistant.message', data: { text: 'complete' } } });
    const page = await ctx.app.inject({ url: `/api/native-events?sessionId=${sessionId}&limit=3`, headers: { cookie: ctx.cookie } });
    expect(page.json().records).toHaveLength(3);
    expect(page.json().records[0]).not.toHaveProperty('payload');
    const next = await ctx.app.inject({ url: `/api/native-events?sessionId=${sessionId}&after=${page.json().next}&limit=3`, headers: { cookie: ctx.cookie } });
    expect(next.json().records[0].id).toBeGreaterThan(page.json().next);
    expect((await ctx.app.inject({ url: '/api/native-events' })).statusCode).toBe(401);
    expect((await ctx.app.inject({ url: '/api/native-events?limit=101', headers: { cookie: ctx.cookie } })).statusCode).toBe(400);
  } finally { await ctx.close(); }
});

it('NP-05 a crash window before event commit does not turn an unprojected native record into a duplicate', () => {
  const db = openDb(':memory:');
  try {
    let store = new Store(db); const workspace = store.createWorkspace('projection', '/tmp');
    const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    const context = { sessionId: session.id, agent: 'codex', nativeId: 'native' };
    const event: AdapterEvent = { type: 'item.complete', itemKey: 'native-item', kind: 'assistant.message', data: { text: 'durable' }, native: { id: 'native-item' } };
    expect(store.nativeEvents.mapping(context, event, 'accepted').duplicate).toBe(false);
    store = new Store(db);
    const recovered = store.nativeEvents.mapping(context, event, 'accepted');
    expect(recovered.duplicate).toBe(false);
    store.appendEvent({ sessionId: session.id, turnId: null, itemKey: 'native-item', kind: 'assistant.message', data: { text: 'durable' }, nativeEnvelopeId: recovered.id });
    expect(store.nativeEvents.mapping(context, event, 'accepted').duplicate).toBe(true);
    expect(store.allEvents(session.id)).toHaveLength(1);
  } finally { db.close(); }
});

it('NP-05 durable native capture precedes projection and capture failure blocks native admission', async () => {
  const ctx = await createTestApp(); const adapter = new FakeAdapter({ id: 'codex' });
  let opts!: CreateOpts; let callback!: (id: string, event: AdapterEvent) => void;
  adapter.onEvent = cb => { callback = cb; }; adapter.create = async input => { opts = input; return { nativeId: 'native' }; };
  adapter.send = async () => undefined;
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    const receipt = opts.nativeEvents!.record({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { method: 'new/unknown', params: { threadId: 'native', extra: 'retained' } } });
    expect(receipt.accepted).toBe(true);
    expect(ctx.store.allEvents(sessionId)).toHaveLength(0);
    callback(sessionId, { type: 'item.complete', itemKey: 'unknown', kind: 'unknown', data: { nativeType: 'new/unknown' }, runtime: opts.runtime, nativeEnvelopeId: receipt.envelopeId });
    const mapped = ctx.store.nativeEvents.get(ctx.store.allEvents(sessionId)[0]!.nativeEnvelopeId!);
    expect(mapped?.rawEnvelopeId).toBe(receipt.envelopeId);
    expect(ctx.store.nativeEvents.get(receipt.envelopeId)?.payload).toMatchObject({ params: { extra: 'retained' } });
    callback(sessionId, { type: 'item.complete', itemKey: 'internal', kind: 'internal', data: { nativeType: 'arbitrary/internal', extra: 'kept' }, runtime: opts.runtime });
    const internal = ctx.store.allEvents(sessionId).find(event => event.itemKey === 'internal')!;
    expect(internal.data).toMatchObject({ nativeType: 'arbitrary/internal', extra: 'kept' });
    const located = await ctx.app.inject({ url: `/api/sessions/${sessionId}/events/${internal.seq}/evidence`, headers: { cookie: ctx.cookie } });
    expect(located.json().event).toMatchObject({ seq: internal.seq, turnId: null, data: { nativeType: 'arbitrary/internal', extra: 'kept' } });
    ctx.store.nativeEvents.frame = () => { throw new Error('fixture storage unavailable'); };
    expect(opts.nativeEvents!.record({ i: 2, t: 0, dir: 'out', ch: 'rpc', frame: { id: 1, method: 'turn/start' } }).accepted).toBe(false);
    await expect(ctx.manager.send(sessionId, { text: 'must not dispatch' })).rejects.toMatchObject({ code: 'uncertain' });
  } finally { await ctx.close(); }
});

it('NP-05/47 v6 migration preserves old events and marks absent native evidence without inventing envelopes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-envelope-migration-'));
  let db = openDb(join(directory, 'db.sqlite'));
  try {
    let store = new Store(db); const workspace = store.createWorkspace('migration', directory);
    const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    const event = store.appendEvent({ sessionId: session.id, turnId: null, itemKey: 'legacy', kind: 'unknown', data: { nativeType: 'legacy' } });
    db.exec('DROP TABLE native_event_projections; DROP TABLE native_event_envelopes; DROP TABLE native_owners; ALTER TABLE events DROP COLUMN native_envelope_id');
    db.pragma('user_version = 6'); db.close(); db = openDb(join(directory, 'db.sqlite')); store = new Store(db);
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(store.allEvents(session.id)).toEqual([event]);
    expect(store.nativeEvents.list(session.id)).toEqual([]);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

it('NP-05 redaction preserves real JSON-RPC wire content, while a rejected capture transmits no request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-native-wire-')); const db = openDb(':memory:'); const store = new Store(db);
  const fixture = join(directory, 'echo.cjs'); const marker = join(directory, 'received');
  await writeFile(fixture, "const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const f=JSON.parse(line);fs.writeFileSync(process.argv[2],line);process.stdout.write(JSON.stringify({id:f.id,result:f.params})+'\\n');});\n");
  const secret = 'fixture-wire-private-value'; store.nativeEvents.addSecret(secret);
  const context = { sessionId: 'wire', agent: 'codex' };
  let number = 0;
  const rpc = JsonRpcStdio.start({ command: process.execPath, args: [fixture, marker], onFrame: (dir, frame) => { store.nativeEvents.frame(context, { i: ++number, t: 0, dir, ch: 'rpc', frame }, true); } });
  try {
    expect(await rpc.request('echo', { text: secret })).toEqual({ text: secret });
    expect(await readFile(marker, 'utf8')).toContain(secret);
    expect(JSON.stringify(store.nativeEvents.list('wire').map(row => store.nativeEvents.get(row.id)))).not.toContain(secret);
    await rpc.kill(); await rm(marker);
    const blocked = JsonRpcStdio.start({ command: process.execPath, args: [fixture, marker], onFrame: () => false });
    try { await expect(blocked.request('echo', { text: 'blocked' })).rejects.toThrow('未持久化'); expect(blocked.resourceCounts.pending).toBe(0); expect(existsSync(marker)).toBe(false); }
    finally { await blocked.kill(); }
  } finally { await rpc.kill(); db.close(); await rm(directory, { recursive: true, force: true }); }
});
