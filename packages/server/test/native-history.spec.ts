import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import type { AdapterEvent, NativeHistoryRecord, TraceFrame } from '@webdcc/protocol';
import { FakeAdapter, ReplayAdapter } from '@webdcc/fake-adapter';
import { DshAdapter } from '@webdcc/adapter-dsh';
import { CURRENT_SCHEMA_VERSION, openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/manager.js';
import { createTestApp, seedWorkspaceAndSession } from './helpers.js';

const record = (seq: number, event: Exclude<AdapterEvent, { type: 'history' }>, nativeTurnId = 'native:1'): NativeHistoryRecord => ({ nativeSeq: seq, nativeTurnId, at: new Date(1000 + seq * 1000).toISOString(), native: { type: event.type, seq, data: event }, events: [event] });
const turn = (text: string, nativeTurnId = 'native:1'): NativeHistoryRecord[] => [
  record(0, { type: 'turn.start' }, nativeTurnId),
  record(1, { type: 'item.complete', itemKey: 'native-user', kind: 'user.message', data: { text, clientCommandId: 'request' } }, nativeTurnId),
  record(2, { type: 'item.complete', itemKey: 'native-answer', kind: 'assistant.message', data: { text: 'answer' } }, nativeTurnId),
  record(3, { type: 'turn.end', status: 'completed' }, nativeTurnId),
];

it('NP-05/10 durably joins native echoes to local prewrites and imports each source once after reopening SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-native-history-'));
  let db = openDb(join(directory, 'db.sqlite'));
  try {
    let store = new Store(db);
    const workspace = store.createWorkspace('workspace', directory);
    const session = store.createSession({ workspaceId: workspace.id, agent: 'dsh' });
    store.updateSession(session.id, { nativeId: 'native' });
    store.appendEvent({ sessionId: session.id, turnId: 'local-turn', itemKey: 'local-user', kind: 'user.message', data: { text: 'original\r\n', clientCommandId: 'request' } });
    store.appendEvent({ sessionId: session.id, turnId: 'local-turn', itemKey: 'local-start', kind: 'turn.started', data: {} });
    expect(store.nativeHistory.import(session.id, 'native', turn('original\r\n'))).toHaveLength(2);
    expect(store.allEvents(session.id).filter(event => event.kind === 'user.message')).toHaveLength(1);
    expect(store.allEvents(session.id).map(event => event.turnId)).toEqual(['local-turn', 'local-turn', 'local-turn', 'local-turn']);
    expect(store.allEvents(session.id).at(-1)).toMatchObject({ kind: 'turn.completed', data: { answerItemKeys: ['native-answer'] } });
    db.close();
    db = openDb(join(directory, 'db.sqlite'));
    store = new Store(db);
    expect(store.nativeHistory.import(session.id, 'native', turn('original\r\n'))).toEqual([]);
    expect(store.nativeHistory.turn(session.id, 'native:1')).toBe('local-turn');
    expect(store.allEvents(session.id)).toHaveLength(4);
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    store.deleteSession(session.id);
    expect(db.prepare('SELECT COUNT(*) AS count FROM native_history_records').get()).toEqual({ count: 0 });
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

it('NP-05 rejects source collisions and rolls back the whole projection batch', () => {
  const db = openDb(':memory:');
  try {
    const store = new Store(db);
    const workspace = store.createWorkspace('workspace', '/tmp/isolated');
    const session = store.createSession({ workspaceId: workspace.id, agent: 'dsh' });
    store.updateSession(session.id, { nativeId: 'native' });
    store.nativeHistory.import(session.id, 'native', turn('first'));
    const before = store.allEvents(session.id);
    expect(() => store.nativeHistory.import(session.id, 'native', [record(4, { type: 'item.complete', itemKey: 'extra', kind: 'notice', data: { level: 'info', text: 'new' } }), { ...turn('changed')[0]!, native: { changed: true } }])).toThrow('冲突');
    expect(store.allEvents(session.id)).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS count FROM native_history_records').get()).toEqual({ count: 4 });
    expect(() => store.nativeHistory.import(session.id, 'different-host-session', turn('first'))).toThrow('不属于');
  } finally { db.close(); }
});

it('NP-10 recovered old turn ends cannot finish an unrelated currently executing turn', async () => {
  const ctx = await createTestApp();
  const adapter = new FakeAdapter({ id: 'dsh' });
  let callback!: (id: string, event: AdapterEvent) => void;
  adapter.onEvent = cb => { callback = cb; };
  adapter.send = async () => undefined;
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    const current = await ctx.manager.send(sessionId, { text: 'current' }, 'current-request');
    const nativeId = ctx.store.getSession(sessionId)?.nativeId ?? '';
    callback(sessionId, { type: 'history', nativeId, records: turn('old', 'native:old') });
    expect(ctx.manager.getRuntime(sessionId)?.turnId).toBe(current.turnId);
    expect(ctx.store.journal.queue(sessionId)[0]?.state).toBe('native-accepted');
    const imported = ctx.store.allEvents(sessionId).filter(event => event.kind === 'turn.completed');
    expect(imported).toHaveLength(1);
    expect(imported[0]?.turnId).not.toBe(current.turnId);
  } finally { await ctx.close(); }
});

it('NP-10 persists a resume opening emitted synchronously before adapter.resume returns', async () => {
  const db = openDb(':memory:');
  const store = new Store(db);
  const workspace = store.createWorkspace('workspace', '/tmp/isolated-resume');
  const session = store.createSession({ workspaceId: workspace.id, agent: 'dsh' });
  store.updateSession(session.id, { nativeId: 'native' });
  const adapter = new FakeAdapter({ id: 'dsh' });
  let callback!: (id: string, event: AdapterEvent) => void;
  adapter.onEvent = cb => { callback = cb; };
  adapter.resume = async () => { callback(session.id, { type: 'history', nativeId: 'native', records: turn('old') }); };
  adapter.send = async () => undefined;
  const manager = new SessionManager(store, { idleDisposeMin: 0 });
  manager.registerAdapter(adapter);
  try {
    await manager.send(session.id, { text: 'new' }, 'new');
    expect(store.allEvents(session.id).filter(event => event.kind === 'user.message')).toHaveLength(2);
    expect(store.allEvents(session.id).filter(event => event.kind === 'turn.completed')).toHaveLength(1);
  } finally { await manager.disposeAll(); db.close(); }
});

it('NP-05/10 replays real DSH source identities without duplicating a current local send', async () => {
  const ctx = await createTestApp();
  const path = 'fixtures/traces/dsh/default/S01';
  const meta = JSON.parse(await readFile(`${path}/meta.json`, 'utf8')) as { prompt: string };
  const frames = (await readFile(`${path}/native.jsonl`, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as TraceFrame);
  const adapter = new ReplayAdapter({ id: 'dsh', frames, translate: () => [], speed: 1_000_000, replays: [{ key: 'S01', prompt: meta.prompt, frames, translate: () => [], createHandler: sessionId => DshAdapter.replay(sessionId) }] });
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    const sent = await ctx.manager.send(sessionId, { text: meta.prompt }, 'REPLAY-COMMAND');
    const events = ctx.store.allEvents(sessionId);
    expect(events.filter(event => event.kind === 'user.message')).toHaveLength(1);
    expect(events.filter(event => event.kind === 'turn.started')).toHaveLength(1);
    expect(events.filter(event => event.kind === 'user.message')[0]).toMatchObject({ turnId: sent.turnId, data: { clientCommandId: 'REPLAY-COMMAND', text: meta.prompt } });
    expect(events.filter(event => event.kind === 'assistant.message').length).toBeGreaterThan(0);
  } finally { await ctx.close(); }
});
