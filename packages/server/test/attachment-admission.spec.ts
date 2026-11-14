import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { FakeAdapter } from '@webdcc/fake-adapter';
import type { AdapterEvent, Command, InputContent, UserInput } from '@webdcc/protocol';
import { buildApp } from '../src/app.js';
import { CURRENT_SCHEMA_VERSION, openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/manager.js';
import { FileStore } from '../src/files.js';
import { ProviderRegistry } from '../src/providers.js';
import { DshConnectionStore } from '../src/dsh-connection.js';
import { issueCookie } from '../src/auth.js';
import { createEncryptedBackup, inspectEncryptedBackup, restoreEncryptedBackup } from '../src/backup.js';
import { createTestApp, seedWorkspaceAndSession, TEST_TOKEN, type TestApp } from './helpers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nAAAAABJRU5ErkJggg==', 'base64');
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
class CapturingAdapter extends FakeAdapter {
  readonly sent: { sessionId: string; input: UserInput }[] = [];
  readonly steered: { sessionId: string; input: UserInput }[] = [];
  private readonly sinks: ((sessionId: string, event: AdapterEvent) => void)[] = [];
  override onEvent(callback: (sessionId: string, event: AdapterEvent) => void): void { super.onEvent(callback); this.sinks.push(callback); }
  override async send(sessionId: string, input: UserInput): Promise<void> {
    this.sent.push({ sessionId, input: structuredClone(input) }); this.fire(sessionId, { type: 'turn.start', nativeTurnId: `native-${this.sent.length}` });
  }
  async steer(sessionId: string, input: UserInput): Promise<void> { this.steered.push({ sessionId, input: structuredClone(input) }); }
  fire(sessionId: string, event: AdapterEvent): void { for (const sink of this.sinks) sink(sessionId, event); }
  finish(sessionId: string, index: number): void {
    this.fire(sessionId, { type: 'item.complete', itemKey: `end-${index}`, kind: 'turn.completed', nativeTurnId: `native-${index}`, data: { status: 'completed', durationMs: 1 } });
  }
}
async function waitFor(check: () => boolean): Promise<void> {
  const start = Date.now(); while (!check()) { if (Date.now() - start > 5000) throw new Error('server admission condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function upload(ctx: Pick<TestApp, 'app' | 'cookie'>, bytes: Buffer, options: { name: string; mime: string; sessionId?: string }): Promise<string> {
  const init = await ctx.app.inject({ method: 'POST', url: '/api/uploads', headers: { cookie: ctx.cookie }, payload: { ...options, size: bytes.length, sha256: hash(bytes) } });
  expect(init.statusCode).toBe(200); const started = init.json() as { uploadId: string; existingFileId?: string };
  if (started.existingFileId !== undefined) return started.existingFileId;
  if (bytes.length) expect((await ctx.app.inject({ method: 'PUT', url: `/api/uploads/${started.uploadId}/chunks/0`, headers: { cookie: ctx.cookie, 'content-type': 'application/octet-stream' }, payload: bytes })).statusCode).toBe(200);
  const complete = await ctx.app.inject({ method: 'POST', url: `/api/uploads/${started.uploadId}/complete`, headers: { cookie: ctx.cookie } }); expect(complete.statusCode).toBe(200);
  return (complete.json() as { fileId: string }).fileId;
}
async function send(ctx: Pick<TestApp, 'app' | 'cookie'>, command: Command) {
  return ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } });
}
async function fixture() {
  const ctx = await createTestApp(); const adapter = new CapturingAdapter({ id: 'dsh' }); ctx.manager.registerAdapter(adapter);
  const { sessionId } = await seedWorkspaceAndSession(ctx); return { ...ctx, adapter, sessionId };
}
async function persistent(dataDir: string) {
  const db = openDb(join(dataDir, 'webdcc.db')); const store = new Store(db); const files = new FileStore(dataDir, store); await files.init();
  const providers = new ProviderRegistry(store, dataDir); await providers.init(); const dsh = new DshConnectionStore(dataDir); await dsh.init();
  const manager = new SessionManager(store, { idleDisposeMin: 0, files }); const adapter = new CapturingAdapter({ id: 'dsh' }); manager.registerAdapter(adapter);
  const config = { host: '127.0.0.1', port: 0, dataDir, token: TEST_TOKEN, dshPort: 0, idleDisposeMin: 0, version: 'test' };
  const { app } = await buildApp({ config, store, files, manager, providers, dsh }); await app.ready();
  const cookie = `wdcc-auth=${issueCookie(TEST_TOKEN)}`;
  return { app, store, files, manager, adapter, cookie, db, async close() { await manager.disposeAll(); await app.close(); db.close(); } };
}

describe('structured input server API → journal → native adapter', () => {
  it('keeps real PNG MIME/name aliases independent while deduplicating the exact bytes across sessions', async () => {
    const ctx = await fixture();
    try {
      const generic = await upload(ctx, PNG, { name: 'generic.bin', mime: 'application/octet-stream', sessionId: ctx.sessionId });
      const other = (await seedWorkspaceAndSession(ctx)).sessionId;
      const image = await upload(ctx, PNG, { name: 'image.png', mime: 'image/png', sessionId: other }); expect(image).not.toBe(generic);
      expect(ctx.store.getFile(generic)).toMatchObject({ name: 'generic.bin', mime: 'application/octet-stream', sha256: hash(PNG) }); expect(ctx.store.getFile(image)).toMatchObject({ name: 'image.png', mime: 'image/png', sha256: hash(PNG) });
      expect(ctx.store.hasFileGrant(other, generic)).toBe(false); expect(ctx.store.hasFileGrant(ctx.sessionId, image)).toBe(false);
      expect((await send(ctx, { op: 'send', clientCommandId: 'real-png-alias', sessionId: other, text: 'read image', contentParts: { version: 1, parts: [{ type: 'text', text: 'read image' }, { type: 'image', fileId: image, mime: 'image/png', name: 'image.png' }] } })).json()).toMatchObject({ ok: true });
      expect(ctx.adapter.sent[0]?.input.contentParts?.parts[1]).toMatchObject({ type: 'image', path: ctx.files.objectPath(hash(PNG)), mime: 'image/png', name: 'image.png' });
      const started = await ctx.app.inject({ method: 'POST', url: '/api/uploads', headers: { cookie: ctx.cookie }, payload: { name: 'completed-image.png', size: PNG.length, mime: 'image/png', sessionId: ctx.sessionId } }); const uploadId = (started.json() as { uploadId: string }).uploadId;
      expect((await ctx.app.inject({ method: 'PUT', url: `/api/uploads/${uploadId}/chunks/0`, headers: { cookie: ctx.cookie, 'content-type': 'application/octet-stream' }, payload: PNG })).statusCode).toBe(200);
      const completed = await ctx.app.inject({ method: 'POST', url: `/api/uploads/${uploadId}/complete`, headers: { cookie: ctx.cookie } }); expect(completed.statusCode).toBe(200); const completedId = (completed.json() as { fileId: string }).fileId;
      expect(ctx.store.getFile(completedId)).toMatchObject({ name: 'completed-image.png', mime: 'image/png', sha256: hash(PNG) }); expect(ctx.store.fileStorageUsage()).toEqual({ stored: PNG.length, pending: 0 });
      expect(await readFile(ctx.files.objectPath(hash(PNG)))).toEqual(PNG);
    } finally { await ctx.close(); }
  });
  it('preserves exact text and ordered real image/file parts without a hidden prompt', async () => {
    const ctx = await fixture();
    try {
      const imageId = await upload(ctx, PNG, { name: 'image.png', mime: 'image/png', sessionId: ctx.sessionId });
      const document = Buffer.from('%PDF-1.7\nreal document bytes'); const fileId = await upload(ctx, document, { name: 'document.pdf', mime: 'application/pdf', sessionId: ctx.sessionId });
      const contentParts: InputContent = { version: 1, parts: [{ type: 'text', text: '  first\r\n' }, { type: 'image', fileId: imageId, sha256: hash(PNG), size: PNG.length }, { type: 'file', fileId }, { type: 'text', text: 'second  ' }] };
      const response = await send(ctx, { op: 'send', clientCommandId: 'ordered', sessionId: ctx.sessionId, text: '  first\r\nsecond  ', contentParts });
      expect(response.json()).toMatchObject({ ok: true, value: { queued: false } });
      const input = ctx.adapter.sent[0]!.input; expect(input.text).toBe('  first\r\nsecond  '); expect(input.images).toBeUndefined();
      expect(input.contentParts?.parts.map(part => part.type)).toEqual(['text', 'image', 'file', 'text']);
      const attachments = input.contentParts!.parts.filter(part => 'fileId' in part);
      expect(attachments).toEqual([expect.objectContaining({ fileId: imageId, path: ctx.files.objectPath(hash(PNG)), sha256: hash(PNG), size: PNG.length, mime: 'image/png' }), expect.objectContaining({ fileId, path: ctx.files.objectPath(hash(document)), sha256: hash(document), size: document.length, mime: 'application/pdf' })]);
      const user = ctx.store.allEvents(ctx.sessionId).find(event => event.kind === 'user.message')!;
      expect(user.data).toMatchObject({ text: input.text, intent: 'send', contentParts: { version: 1, parts: [expect.objectContaining({ type: 'text' }), expect.objectContaining({ type: 'image', fileId: imageId }), expect.objectContaining({ type: 'file', fileId }), expect.objectContaining({ type: 'text' })] } });
      expect(JSON.stringify(user.data)).not.toContain(ctx.dataDir);
      expect(ctx.store.journal.get('ordered')).toMatchObject({ state: 'native-accepted', payload: { text: input.text, contentParts } });
      expect(ctx.store.journal.nativeInput(ctx.sessionId, input.nativeRequestId!)).toMatchObject({ commandId: 'ordered' });
    } finally { await ctx.close(); }
  });

  it('rejects absent, corrupt, symlinked and mismatched references before command acceptance', async () => {
    const ctx = await fixture();
    try {
      const bytes = Buffer.from('trusted attachment'); const fileId = await upload(ctx, bytes, { name: 'file.txt', mime: 'text/plain', sessionId: ctx.sessionId });
      const command = (id: string, reference: InputContent['parts'][number]) => ({ op: 'send' as const, clientCommandId: id, sessionId: ctx.sessionId, text: 'read', contentParts: { version: 1 as const, parts: [{ type: 'text' as const, text: 'read' }, reference] } });
      expect((await send(ctx, command('absent', { type: 'file', fileId: 'missing' }))).json()).toMatchObject({ ok: false, code: 'not-found' });
      expect((await send(ctx, command('mismatch', { type: 'file', fileId, sha256: '0'.repeat(64) }))).json()).toMatchObject({ ok: false, code: 'conflict' });
      await writeFile(ctx.files.objectPath(hash(bytes)), Buffer.alloc(bytes.length, 42));
      expect((await send(ctx, command('corrupt', { type: 'file', fileId }))).json()).toMatchObject({ ok: false, code: 'conflict' });
      await rm(ctx.files.objectPath(hash(bytes))); const external = join(ctx.dataDir, 'external'); await writeFile(external, bytes); await symlink(external, ctx.files.objectPath(hash(bytes)));
      expect((await send(ctx, command('symlink', { type: 'file', fileId }))).json()).toMatchObject({ ok: false, code: 'conflict' });
      for (const id of ['absent', 'mismatch', 'corrupt', 'symlink']) expect(ctx.store.journal.get(id)).toBeUndefined();
      expect(ctx.adapter.sent).toHaveLength(0); expect(ctx.store.allEvents(ctx.sessionId).some(event => event.kind === 'turn.started')).toBe(false);
      expect(await readFile(external)).toEqual(bytes);
    } finally { await ctx.close(); }
  });

  it('requires an explicit grant across sessions and checks actual image MIME', async () => {
    const ctx = await fixture();
    try {
      const { sessionId: other } = await seedWorkspaceAndSession(ctx); const fileId = await upload(ctx, Buffer.from('file bytes'), { name: 'file.txt', mime: 'text/plain', sessionId: ctx.sessionId });
      const command: Command = { op: 'send', clientCommandId: 'other-session', sessionId: other, text: '', contentParts: { version: 1, parts: [{ type: 'file', fileId }] } };
      expect((await send(ctx, command)).json()).toMatchObject({ ok: false, code: 'forbidden' }); expect(ctx.store.journal.get('other-session')).toBeUndefined();
      const attached = await ctx.app.inject({ method: 'POST', url: `/api/sessions/${other}/attachments`, headers: { cookie: ctx.cookie }, payload: { fileId } }); expect(attached.statusCode).toBe(200); expect(attached.body).not.toContain(ctx.dataDir);
      expect((await send(ctx, command)).json()).toMatchObject({ ok: true });
      const forgedImage = await upload(ctx, Buffer.from('plain text is not a PNG'), { name: 'fake.png', mime: 'image/png', sessionId: ctx.sessionId });
      expect((await send(ctx, { op: 'send', clientCommandId: 'fake-image', sessionId: ctx.sessionId, text: 'image', images: [forgedImage] })).json()).toMatchObject({ ok: false, code: 'bad-request' }); expect(ctx.store.journal.get('fake-image')).toBeUndefined();
    } finally { await ctx.close(); }
  });

  it('retains a corrupt queued input at its ordinal and requires explicit repair/retry', async () => {
    const ctx = await fixture();
    try {
      const bytes = Buffer.from('queued original bytes'); const fileId = await upload(ctx, bytes, { name: 'queue.txt', mime: 'text/plain', sessionId: ctx.sessionId });
      await send(ctx, { op: 'send', clientCommandId: 'active', sessionId: ctx.sessionId, text: 'active' });
      const queued = await send(ctx, { op: 'send', clientCommandId: 'queued-file', sessionId: ctx.sessionId, text: ' exact queued\r\n', intent: 'queue', contentParts: { version: 1, parts: [{ type: 'file', fileId }, { type: 'text', text: ' exact queued\r\n' }] } }); expect(queued.json()).toMatchObject({ ok: true, value: { queued: true } });
      await send(ctx, { op: 'send', clientCommandId: 'later', sessionId: ctx.sessionId, text: 'later' }); const turnId = ctx.store.journal.get('queued-file')!.turnId!;
      expect(() => ctx.store.journal.nativeRequestId(turnId)).toThrow(); await writeFile(ctx.files.objectPath(hash(bytes)), Buffer.alloc(bytes.length, 1)); ctx.adapter.finish(ctx.sessionId, 1);
      await waitFor(() => ctx.store.journal.queue(ctx.sessionId)[0]?.preparationError !== undefined);
      expect(ctx.store.journal.queue(ctx.sessionId).map(row => row.commandId)).toEqual(['queued-file', 'later']); expect(ctx.store.journal.next(ctx.sessionId)).toBeUndefined(); expect(ctx.adapter.sent).toHaveLength(1);
      expect(() => ctx.store.journal.nativeRequestId(turnId)).toThrow();
      expect(await upload(ctx, bytes, { name: 'queue.txt', mime: 'text/plain', sessionId: ctx.sessionId })).toBe(fileId);
      const retry = await ctx.app.inject({ method: 'POST', url: `/api/sessions/${ctx.sessionId}/queue/queued-file/retry`, headers: { cookie: ctx.cookie } }); expect(retry.statusCode).toBe(200);
      expect(ctx.adapter.sent[1]?.input.text).toBe(' exact queued\r\n'); expect(ctx.adapter.sent[1]?.input.contentParts?.parts.map(part => part.type)).toEqual(['file', 'text']);
      expect(ctx.store.journal.get('queued-file')?.turnId).toBe(turnId); ctx.adapter.finish(ctx.sessionId, 2); await waitFor(() => ctx.adapter.sent.length === 3); expect(ctx.adapter.sent[2]?.input.text).toBe('later');
    } finally { await ctx.close(); }
  });

  it('pins steer UUIDs to the verified active turn and prevents stale or cross-session targeting', async () => {
    const ctx = await fixture();
    try {
      await send(ctx, { op: 'send', clientCommandId: 'steer-active', sessionId: ctx.sessionId, text: 'active' }); const active = ctx.manager.getRuntime(ctx.sessionId)!.turnId!;
      const fileId = await upload(ctx, Buffer.from('steer bytes'), { name: 'steer.txt', mime: 'text/plain', sessionId: ctx.sessionId });
      const command: Command = { op: 'send', clientCommandId: 'steer', sessionId: ctx.sessionId, text: ' exact steer ', intent: 'steer', expectedTurnId: active, contentParts: { version: 1, parts: [{ type: 'file', fileId }, { type: 'text', text: ' exact steer ' }] } };
      expect((await send(ctx, command)).json()).toMatchObject({ ok: true, value: { turnId: active, queued: false, confirmed: false } });
      const input = ctx.adapter.steered[0]!.input; const admission = ctx.store.journal.get('steer')!.turnId!; expect(admission).not.toBe(active); expect(ctx.store.journal.nativeTargetTurn(admission)).toBe(active);
      expect(input.expectedTurnId).toBe('native-1'); expect(ctx.store.journal.get('steer')?.state).toBe('native-accepted');
      expect(ctx.store.journal.nativeInput(ctx.sessionId, input.nativeRequestId!)).toEqual({ commandId: 'steer', turnId: active });
      expect(ctx.store.allEvents(ctx.sessionId).filter(event => event.kind === 'turn.started')).toHaveLength(1);
      expect(ctx.store.allEvents(ctx.sessionId).find(event => event.kind === 'user.message' && (event.data as { clientCommandId?: string }).clientCommandId === 'steer')?.turnId).toBe(active);
      expect(ctx.store.allEvents(ctx.sessionId).find(event => event.kind === 'user.message' && (event.data as { clientCommandId?: string }).clientCommandId === 'steer')?.data).toMatchObject({ intent: 'steer' });
      await send(ctx, { ...command, clientCommandId: 'stale-steer', expectedTurnId: 'different' }); expect(ctx.adapter.steered).toHaveLength(1);
      const { sessionId: other } = await seedWorkspaceAndSession(ctx); expect(ctx.store.journal.nativeInput(other, input.nativeRequestId!)).toBeUndefined();
      const nativeId = ctx.store.getSession(ctx.sessionId)!.nativeId!;
      ctx.store.nativeHistory.import(ctx.sessionId, nativeId, [{ nativeSeq: 900, at: '2026-11-14T00:00:00Z', native: { type: 'admitted-steer' }, admittedInputs: [{ nativeRequestId: input.nativeRequestId!, text: input.text }], events: [] }, { nativeSeq: 901, nativeTurnId: 'later-autonomous', at: '2026-11-14T00:00:01Z', native: { type: 'turn-start' }, events: [{ type: 'turn.start', nativeTurnId: 'later-autonomous' }] }]);
      expect(ctx.store.nativeHistory.turn(ctx.sessionId, 'later-autonomous')).not.toBe(active);
      expect(() => ctx.store.nativeHistory.import(ctx.sessionId, nativeId, [{ nativeSeq: 902, nativeTurnId: 'wrong-target', at: '2026-11-14T00:00:02Z', native: { type: 'wrong-steer-echo' }, events: [{ type: 'item.complete', itemKey: 'wrong-steer-user', kind: 'user.message', data: { text: input.text, clientCommandId: input.nativeRequestId } }] }])).toThrow('目标轮次');
      expect(ctx.store.journal.get('steer')?.state).toBe('native-accepted'); expect(ctx.store.nativeHistory.turn(ctx.sessionId, 'wrong-target')).toBeUndefined();
      expect(() => ctx.adapter.fire(ctx.sessionId, { type: 'item.complete', itemKey: 'mismatched-live-steer', kind: 'user.message', nativeTurnId: 'native-1', data: { text: 'different native text', clientCommandId: input.nativeRequestId } })).not.toThrow();
      expect(ctx.store.journal.get('steer')?.state).toBe('uncertain'); expect(ctx.store.allEvents(ctx.sessionId).some(event => event.kind === 'notice' && (event.data as { nativeType?: string }).nativeType === 'input-echo-mismatch')).toBe(true);
      ctx.adapter.fire(ctx.sessionId, { type: 'item.complete', itemKey: 'live-steer-echo', kind: 'user.message', nativeTurnId: 'native-1', data: { text: input.text, clientCommandId: input.nativeRequestId } });
      expect(ctx.store.journal.get('steer')?.state).toBe('completed');
      ctx.store.nativeHistory.import(ctx.sessionId, nativeId, [{ nativeSeq: 902, nativeTurnId: 'native-1', at: '2026-11-14T00:00:02Z', native: { type: 'real-steer-echo' }, events: [{ type: 'item.complete', itemKey: 'native-steer-user', kind: 'user.message', data: { text: input.text, clientCommandId: input.nativeRequestId } }] }]);
      expect(ctx.store.journal.get('steer')?.state).toBe('completed'); expect(ctx.store.allEvents(ctx.sessionId).filter(event => event.kind === 'user.message')).toHaveLength(2);
      ctx.adapter.steer = async (sessionId, input) => { ctx.adapter.fire(sessionId, { type: 'item.complete', itemKey: 'proved-before-rpc-loss', kind: 'user.message', nativeTurnId: input.expectedTurnId, data: { text: input.text, clientCommandId: input.nativeRequestId } }); throw new Error('RPC disconnected after a proved echo'); };
      expect((await send(ctx, { ...command, clientCommandId: 'proved-steer' })).json()).toMatchObject({ ok: true, value: { confirmed: true } }); expect(ctx.store.journal.get('proved-steer')?.state).toBe('completed');
    } finally { await ctx.close(); }
  });

  it('rejects an explicit send when busy while preserving legacy and explicit queue intent', async () => {
    const ctx = await fixture();
    try {
      expect((await send(ctx, { op: 'send', clientCommandId: 'explicit-active', sessionId: ctx.sessionId, text: 'active', intent: 'send' })).json()).toMatchObject({ ok: true, value: { queued: false } });
      const busy = await send(ctx, { op: 'send', clientCommandId: 'explicit-busy', sessionId: ctx.sessionId, text: 'must not queue', intent: 'send' }); expect(busy.statusCode).toBe(409); expect(ctx.store.journal.get('explicit-busy')).toBeUndefined();
      expect((await send(ctx, { op: 'send', clientCommandId: 'explicit-queue', sessionId: ctx.sessionId, text: 'queued', intent: 'queue' })).json()).toMatchObject({ ok: true, value: { queued: true } });
      expect((await send(ctx, { op: 'send', clientCommandId: 'legacy-queue', sessionId: ctx.sessionId, text: 'legacy' })).json()).toMatchObject({ ok: true, value: { queued: true } });
      expect(ctx.store.journal.queue(ctx.sessionId).map(row => row.commandId)).toEqual(['explicit-active', 'explicit-queue', 'legacy-queue']);
      ctx.adapter.finish(ctx.sessionId, 1); await waitFor(() => ctx.adapter.sent.length === 2); expect(ctx.adapter.sent[1]?.input.delivery).toBe('queue');
    } finally { await ctx.close(); }
  });

  it('keeps a proven pre-submission validation rejection separate from an uncertain native outcome', async () => {
    const ctx = await fixture(); const original = ctx.adapter.send.bind(ctx.adapter);
    try {
      ctx.adapter.send = async () => { throw Object.assign(new Error('native encoder rejected before submission'), { statusCode: 400, code: 'input-unsupported', nativeAdmission: 'not-submitted' }); };
      expect((await send(ctx, { op: 'send', clientCommandId: 'known-rejection', sessionId: ctx.sessionId, text: 'first', intent: 'send' })).json()).toMatchObject({ ok: false, code: 'bad-request' });
      expect(ctx.store.journal.get('known-rejection')?.state).toBe('failed'); expect(ctx.store.journal.queue(ctx.sessionId)).toHaveLength(0); expect(ctx.adapter.sent).toHaveLength(0);
      expect(ctx.store.allEvents(ctx.sessionId).find(event => event.kind === 'turn.completed')?.data).toMatchObject({ status: 'failed', reason: expect.stringContaining('native-input-not-submitted') });
      ctx.adapter.send = original;
      expect((await send(ctx, { op: 'send', clientCommandId: 'after-known-rejection', sessionId: ctx.sessionId, text: 'second', intent: 'send' })).json()).toMatchObject({ ok: true, value: { queued: false } }); expect(ctx.adapter.sent[0]?.input.text).toBe('second');
    } finally { await ctx.close(); }
  });
});

describe('remote draft CAS and durable attachment migration', () => {
  it('migrates the v12 UNIQUE SHA constraint without changing old file identities or session grants', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wdcc-alias-migrate-')); const path = join(root, 'old.db'); let db = openDb(path);
    try {
      const store = new Store(db); const workspace = store.createWorkspace('old', root); const session = store.createSession({ workspaceId: workspace.id, agent: 'dsh' }); const files = new FileStore(root, store); await files.init();
      const file = await files.putBuffer(PNG, 'generic.bin', 'application/octet-stream'); await files.attachToSession(session.id, file.id); const oldGrant = db.prepare('SELECT * FROM file_session_grants').all(); store.setDraft(session.id, 'original draft', [file.id]);
      db.pragma('foreign_keys = OFF'); db.exec(`CREATE TABLE files_v12 (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL);
        INSERT INTO files_v12 SELECT id, sha256, name, mime, size, created_at FROM files; DROP TABLE files; ALTER TABLE files_v12 RENAME TO files;`); db.pragma('foreign_keys = ON'); db.pragma('user_version = 12'); db.close();
      db = openDb(path); const migrated = new Store(db); expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION); expect(migrated.getFile(file.id)).toEqual(file); expect(db.prepare('SELECT * FROM file_session_grants').all()).toEqual(oldGrant); expect(migrated.getDraft(session.id)).toMatchObject({ text: 'original draft', fileIds: [file.id] }); expect(db.pragma('foreign_key_check')).toEqual([]);
      const currentFiles = new FileStore(root, migrated); const alias = await currentFiles.initUpload({ name: 'image.png', size: PNG.length, sha256: hash(PNG), mime: 'image/png', sessionId: session.id }); expect(alias.existingFileId).not.toBe(file.id);
      expect(await currentFiles.resolveAttachment({ type: 'image', fileId: alias.existingFileId! }, session.id)).toMatchObject({ mime: 'image/png', name: 'image.png', sha256: hash(PNG) }); expect(migrated.getFile(file.id)).toEqual(file);
    } finally { if (db.open) db.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('backs up one encrypted CAS object for multiple MIME aliases and restores every fileId/grant', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wdcc-alias-backup-')); const sourceDir = join(root, 'source'); await mkdir(sourceDir); const key = randomBytes(32);
    let source: Awaited<ReturnType<typeof persistent>> | undefined; let restored: Awaited<ReturnType<typeof persistent>> | undefined;
    try {
      source = await persistent(sourceDir); const workspace = source.store.createWorkspace('aliases', root); const session = await source.manager.createSession({ workspaceId: workspace.id, agent: 'dsh' });
      const generic = await upload(source, PNG, { name: 'generic.bin', mime: 'application/octet-stream', sessionId: session.id }); const image = await upload(source, PNG, { name: 'image.png', mime: 'image/png', sessionId: session.id });
      const backupDir = join(root, 'backup'); await createEncryptedBackup({ db: source.db, dataDir: sourceDir, destination: backupDir, key, consistency: 'operator-declared-offline', withMetadataSnapshot: capture => capture() }); const manifest = await inspectEncryptedBackup({ backupDir, key }); expect(manifest.entries.filter(entry => entry.path.startsWith('files/'))).toHaveLength(1); expect(manifest.tableCounts['files']).toBe(2);
      const destination = join(root, 'restored'); await restoreEncryptedBackup({ backupDir, destination, key }); restored = await persistent(destination);
      expect(restored.store.getFile(generic)).toMatchObject({ name: 'generic.bin', mime: 'application/octet-stream' }); expect(restored.store.getFile(image)).toMatchObject({ name: 'image.png', mime: 'image/png' }); expect(restored.store.hasFileGrant(session.id, generic)).toBe(true); expect(restored.store.hasFileGrant(session.id, image)).toBe(true);
      expect(await restored.files.resolveAttachment({ type: 'image', fileId: image }, session.id)).toMatchObject({ path: join(destination, 'files', hash(PNG).slice(0, 2), hash(PNG)), mime: 'image/png' }); expect(restored.store.fileStorageUsage().stored).toBe(PNG.length);
    } finally { key.fill(0); await source?.close(); await restored?.close(); await rm(root, { recursive: true, force: true }); }
  });
  it('enforces CAS, preserves structured order, and rejects corrupt/ungranted draft attachments', async () => {
    const ctx = await fixture();
    try {
      const fileId = await upload(ctx, Buffer.from('draft'), { name: 'draft.txt', mime: 'text/plain', sessionId: ctx.sessionId });
      const url = `/api/sessions/${ctx.sessionId}/draft`; const contentParts: InputContent = { version: 1, parts: [{ type: 'file', fileId }, { type: 'text', text: 'draft text' }] };
      const original = await ctx.app.inject({ method: 'GET', url, headers: { cookie: ctx.cookie } }); expect(original.json()).toMatchObject({ revision: 0, fileIds: [] });
      expect((await ctx.app.inject({ method: 'PUT', url, headers: { cookie: ctx.cookie }, payload: { text: 'draft text', fileIds: [fileId] } })).statusCode).toBe(428);
      const responses = await Promise.all(['first', 'second'].map(text => ctx.app.inject({ method: 'PUT', url, headers: { cookie: ctx.cookie }, payload: { text, fileIds: [], expectedRevision: 0 } }))); expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
      const stored = await ctx.app.inject({ method: 'PUT', url, headers: { cookie: ctx.cookie }, payload: { text: 'draft text', fileIds: [fileId], contentParts, expectedRevision: 1 } }); expect(stored.json()).toMatchObject({ revision: 2, contentParts });
      const other = (await seedWorkspaceAndSession(ctx)).sessionId; const unauthorized = await ctx.app.inject({ method: 'PUT', url: `/api/sessions/${other}/draft`, headers: { cookie: ctx.cookie }, payload: { text: 'draft text', fileIds: [fileId], contentParts, expectedRevision: 0 } }); expect(unauthorized.statusCode).toBe(403);
      await writeFile(ctx.files.objectPath(hash(Buffer.from('draft'))), 'wrong'); expect((await ctx.app.inject({ method: 'PUT', url, headers: { cookie: ctx.cookie }, payload: { text: 'draft text', fileIds: [fileId], contentParts, expectedRevision: 2 } })).statusCode).toBe(409);
      expect((await ctx.app.inject({ method: 'GET', url, headers: { cookie: ctx.cookie } })).json()).toMatchObject({ revision: 2, text: 'draft text', contentParts }); expect(ctx.adapter.sent).toHaveLength(0);
    } finally { await ctx.close(); }
  });

  it('migrates only old persisted user references and rolls back a failed schema migration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wdcc-grants-migration-')); const path = join(root, 'old.db'); let db = openDb(path);
    try {
      const store = new Store(db); const workspace = store.createWorkspace('old', root); const a = store.createSession({ workspaceId: workspace.id, agent: 'dsh' }); const b = store.createSession({ workspaceId: workspace.id, agent: 'dsh' });
      const files = new FileStore(root, store); await files.init(); const referenced = await files.putBuffer(Buffer.from('old bytes'), 'old.txt', 'text/plain'); const orphan = await files.putBuffer(Buffer.from('orphan'), 'orphan.txt', 'text/plain');
      store.journal.claim({ op: 'send', clientCommandId: 'old-command', sessionId: a.id, text: 'old exact text' }); store.journal.enqueue('old-command', a.id, 'old-turn', { text: 'old exact text', contentParts: { version: 1, parts: [{ type: 'text', text: 'old exact text' }, { type: 'file', fileId: referenced.id, path: '/old/path', name: referenced.name, mime: referenced.mime, sha256: referenced.sha256, size: referenced.size }] } });
      store.setDraft(b.id, 'old draft', [referenced.id]); const oldEvent = store.appendEvent({ sessionId: a.id, turnId: 'old', itemKey: 'user', kind: 'user.message', data: { text: 'old event', images: [referenced.id] } });
      store.appendEvent({ sessionId: a.id, turnId: 'old', itemKey: 'tool', kind: 'internal', data: { nativeType: 'file', fileId: orphan.id } as never });
      db.exec('ALTER TABLE native_input_ids DROP COLUMN target_turn_id; ALTER TABLE input_queue DROP COLUMN preparation_error; ALTER TABLE uploads DROP COLUMN session_id; ALTER TABLE drafts DROP COLUMN revision; ALTER TABLE drafts DROP COLUMN content_parts;');
      db.exec("CREATE TRIGGER fail_grant BEFORE INSERT ON file_session_grants BEGIN SELECT RAISE(ABORT, 'injected migration fault'); END;"); db.pragma('user_version = 11'); db.close();
      expect(() => openDb(path)).toThrow('injected migration fault'); const failed = new Database(path); expect(failed.pragma('user_version', { simple: true })).toBe(11); expect((failed.prepare('PRAGMA table_info(drafts)').all() as { name: string }[]).map(column => column.name)).not.toContain('revision'); failed.exec('DROP TRIGGER fail_grant'); failed.close();
      db = openDb(path); const migrated = new Store(db); expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION); expect(migrated.hasFileGrant(a.id, referenced.id)).toBe(true); expect(migrated.hasFileGrant(b.id, referenced.id)).toBe(true); expect(migrated.hasFileGrant(a.id, orphan.id)).toBe(false); expect(migrated.hasFileGrant(b.id, orphan.id)).toBe(false);
      expect(migrated.allEvents(a.id)[0]).toEqual(oldEvent); expect(migrated.getDraft(b.id)).toMatchObject({ revision: 0, text: 'old draft', fileIds: [referenced.id] }); expect(migrated.journal.queue(a.id)[0]?.input.text).toBe('old exact text'); db.close(); db = openDb(path); expect(new Store(db).hasFileGrant(a.id, orphan.id)).toBe(false);
      db.exec('ALTER TABLE input_queue DROP COLUMN preparation_error'); db.close(); expect(() => openDb(path)).toThrow('schema v12 不完整');
    } finally { if (db.open) db.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('resolves copied queued attachments from the new data directory after a restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wdcc-queue-cas-restore-')); const sourceDir = join(root, 'source'); const targetDir = join(root, 'target'); await mkdir(sourceDir);
    let source: Awaited<ReturnType<typeof persistent>> | undefined; let target: Awaited<ReturnType<typeof persistent>> | undefined;
    try {
      source = await persistent(sourceDir); const workspace = source.store.createWorkspace('copied', root); const session = await source.manager.createSession({ workspaceId: workspace.id, agent: 'dsh' });
      const bytes = Buffer.from('restored attachment bytes'); const fileId = await upload(source, bytes, { name: 'restored.txt', mime: 'text/plain', sessionId: session.id });
      await send(source, { op: 'send', clientCommandId: 'restore-active', sessionId: session.id, text: 'active' });
      const command: Command = { op: 'send', clientCommandId: 'restore-queued', sessionId: session.id, text: ' preserved\r\n', contentParts: { version: 1, parts: [{ type: 'file', fileId }, { type: 'text', text: ' preserved\r\n' }] } }; expect((await send(source, command)).json()).toMatchObject({ ok: true, value: { queued: true } });
      const permissions = source.store.getSession(session.id)!.permissions!; source.store.updateSession(session.id, { permissions: { ...permissions, phase: 'failed', revision: permissions.revision + 1 } }); source.adapter.finish(session.id, 1); await waitFor(() => source!.manager.getRuntime(session.id)!.turnId === null);
      const old = source.store.journal.queue(session.id)[0]!; expect(JSON.stringify(old.input)).toContain(sourceDir); await source.close(); source = undefined;
      await cp(sourceDir, targetDir, { recursive: true }); await writeFile(join(sourceDir, 'files', hash(bytes).slice(0, 2), hash(bytes)), Buffer.alloc(bytes.length, 2));
      target = await persistent(targetDir); expect(target.adapter.sent).toHaveLength(0);
      expect((await send(target, { op: 'set-access-mode', clientCommandId: 'restore-access', sessionId: session.id, accessMode: 'read-only' })).json()).toMatchObject({ ok: true });
      const input = target.adapter.sent[0]!.input; expect(input.text).toBe(' preserved\r\n'); expect(input.contentParts?.parts[0]).toMatchObject({ fileId, path: join(targetDir, 'files', hash(bytes).slice(0, 2), hash(bytes)), sha256: hash(bytes) });
      expect(target.store.journal.get('restore-queued')?.turnId).toBe(old.turnId); expect(target.store.journal.get('restore-queued')?.payload).toEqual(command); expect(target.store.journal.nativeInput(session.id, input.nativeRequestId!)).toEqual({ commandId: 'restore-queued', turnId: old.turnId });
    } finally { await source?.close(); await target?.close(); await rm(root, { recursive: true, force: true }); }
  });
});
