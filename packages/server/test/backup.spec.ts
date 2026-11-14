import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, openSync, readlinkSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, readdir, rm, stat, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { createBackupKeyFile, createEncryptedBackup, inspectEncryptedBackup, restoreEncryptedBackup, type BackupManifest } from '../src/backup.js';
import { CURRENT_SCHEMA_VERSION, openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { CHUNK_SIZE, FileStore } from '../src/files.js';
import Database from 'better-sqlite3';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-backup-test-')); const dataDir = join(root, 'data'); await mkdir(dataDir);
  const db = openDb(join(dataDir, 'webdcc.db')); const store = new Store(db); const files = new FileStore(dataDir, store); await files.init();
  const workspace = store.createWorkspace('external workspace not copied', join(root, 'workspace'));
  const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' }); store.updateSession(session.id, { nativeId: 'native-preserved' });
  const image = await files.putBuffer(Buffer.from('PRIVATE_FILE_BYTES'), '.env', 'image/png');
  const empty = await files.putBuffer(Buffer.alloc(0), 'empty', 'text/plain');
  const event = store.appendEvent({ sessionId: session.id, turnId: 'old-turn', itemKey: 'user', kind: 'user.message', data: { text: 'PRIVATE_EVENT_TEXT', images: [image.id] } });
  store.journal.claim({ clientCommandId: 'queued-input', op: 'send', sessionId: session.id, text: 'PRIVATE_QUEUED_TEXT' });
  store.journal.enqueue('queued-input', session.id, 'queued-turn', { text: 'PRIVATE_QUEUED_TEXT', images: [{ fileId: image.id, path: files.objectPath(image.sha256), mime: image.mime }] });
  store.journal.claim({ clientCommandId: 'admitted-input', op: 'send', sessionId: session.id, text: 'ADMITTED_TEXT' });
  store.journal.enqueue('admitted-input', session.id, 'admitted-turn', { text: 'ADMITTED_TEXT' }); store.journal.beginInput('admitted-turn'); store.journal.inputState('admitted-turn', 'native-accepted');
  const nativeInputId = store.journal.nativeRequestId('admitted-turn');
  db.prepare('INSERT INTO commands (client_command_id, op, result, at) VALUES (?, ?, ?, ?)').run('legacy-result', 'send', '{"kept":true}', new Date().toISOString());
  await writeFile(join(dataDir, 'secrets.json'), '{"provider:test":"PRIVATE_PROVIDER_KEY"}', { mode: 0o600 });
  await writeFile(join(dataDir, 'provider-ignored.json'), '["ignored-source"]', { mode: 0o600 });
  await writeFile(join(dataDir, 'dsh-connection.json'), '{"url":"http://localhost:1234","cookie":"PRIVATE_COOKIE","connectedAt":"2026-11-14T00:00:00Z"}', { mode: 0o600 });
  await writeFile(join(dataDir, '.env'), 'MUST_NOT_COPY_ENV');
  const orphan = 'f'.repeat(64); await mkdir(join(dataDir, 'files', 'ff')); await writeFile(files.objectPath(orphan), 'MUST_NOT_COPY_ORPHAN');
  const key = randomBytes(32); const destination = join(root, 'backup');
  return { root, dataDir, db, store, files, session, image, empty, event, nativeInputId, key, destination,
    create: () => createEncryptedBackup({ db, dataDir, destination, key, consistency: 'operator-declared-offline', withMetadataSnapshot: capture => capture() }),
    close: async () => { if (db.open) db.close(); key.fill(0); await rm(root, { recursive: true, force: true }); } };
}

async function runCli(args: string[], keyPath?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const fd = keyPath === undefined ? undefined : openSync(keyPath, 'r');
  const child = spawn(process.execPath, ['--import=tsx', 'scripts/backup.ts', ...args], { cwd: '/root/WebDCC-repair', stdio: fd === undefined ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', fd] });
  if (fd !== undefined) closeSync(fd);
  let stdout = ''; let stderr = '';
  child.stdout!.on('data', value => { stdout += String(value); }); child.stderr!.on('data', value => { stderr += String(value); });
  return new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); });
}

async function handlePrototype(root: string): Promise<FileHandle> {
  const path = join(root, 'handle-probe'); const handle = await open(path, 'wx', 0o600);
  const prototype = Object.getPrototypeOf(handle) as FileHandle; await handle.close(); await rm(path); return prototype;
}

// Deliberately re-authenticate malformed content to exercise semantic checks,
// separately from the existing wrong-key/ciphertext-tampering cases.
async function replaceSidecar(backupDir: string, key: Buffer, path: string, value: string): Promise<void> {
  const header = JSON.parse(await readFile(join(backupDir, 'backup.json'), 'utf8')) as { archiveId: string };
  const aad = (name: string) => Buffer.from(`webdcc-encrypted-backup:1:${header.archiveId}:${name}`);
  const encrypted = await readFile(join(backupDir, 'manifest.enc'));
  const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(8, 20)); decipher.setAAD(aad('manifest')); decipher.setAuthTag(encrypted.subarray(-16));
  const clear = Buffer.concat([decipher.update(encrypted.subarray(20, -16)), decipher.final()]);
  const manifest = JSON.parse(clear.toString('utf8')) as BackupManifest; clear.fill(0);
  const content = Buffer.from(value); const entry = manifest.entries.find(entry => entry.path === path)!;
  entry.bytes = content.length; entry.sha256 = createHash('sha256').update(content).digest('hex');
  const encrypt = (bytes: Buffer, name: string) => {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad(name));
    return Buffer.concat([Buffer.from('WDCCBKV1'), iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
  };
  await writeFile(join(backupDir, entry.object), encrypt(content, path)); content.fill(0);
  const updated = Buffer.from(JSON.stringify(manifest)); await writeFile(join(backupDir, 'manifest.enc'), encrypt(updated, 'manifest')); updated.fill(0);
}

describe('encrypted WebDCC stored-state backup', () => {
  it('runs the explicit key-fd CLI without printing key material or defaulting to an environment data directory', async () => {
    const ctx = await fixture();
    try {
      const keyPath = join(ctx.root, 'cli.key'); expect((await runCli(['keygen', '--out', keyPath])).code).toBe(0);
      const key = await readFile(keyPath); const made = await runCli(['create', '--data-dir', ctx.dataDir, '--out', ctx.destination, '--key-fd', '3', '--offline'], keyPath);
      expect(made.stderr).toBe(''); expect(made.code).toBe(0); expect(made.stdout).not.toContain(key.toString('hex')); expect(made.stdout).not.toContain('PRIVATE_PROVIDER_KEY');
      expect((await runCli(['inspect', '--backup', ctx.destination, '--key-fd', '3'], keyPath)).code).toBe(0);
      const target = join(ctx.root, 'cli-restored'); expect((await runCli(['restore', '--backup', ctx.destination, '--out', target, '--key-fd', '3'], keyPath)).code).toBe(0);
      expect((await runCli(['create', '--out', join(ctx.root, 'no-default'), '--key-fd', '3', '--offline'], keyPath)).stderr).toContain('--data-dir');
      await expect(stat(join(ctx.root, 'no-default'))).rejects.toThrow(); key.fill(0);
    } finally { await ctx.close(); }
  });
  it('rejects malformed or publicly readable CLI keys and requires an explicit offline declaration', async () => {
    const ctx = await fixture();
    const args = ['create', '--data-dir', ctx.dataDir, '--out', ctx.destination, '--key-fd', '3'];
    try {
      for (const bytes of [31, 33]) {
        const path = join(ctx.root, `key-${bytes}`); await writeFile(path, Buffer.alloc(bytes, 19), { mode: 0o600 });
        const output = await runCli([...args, '--offline'], path); expect(output.code).toBe(1); expect(output.stdout).toBe(''); expect(output.stderr).toContain('恰好是 32 字节'); await expect(stat(ctx.destination)).rejects.toThrow();
      }
      const publicPath = join(ctx.root, 'public-key'); await writeFile(publicPath, ctx.key, { mode: 0o644 });
      const publicOutput = await runCli([...args, '--offline'], publicPath); expect(publicOutput.code).toBe(1); expect(publicOutput.stderr).toContain('其他用户读取'); expect(publicOutput.stdout).toBe('');
      const keyPath = join(ctx.root, 'private-key'); await writeFile(keyPath, ctx.key, { mode: 0o600 });
      const onlineOutput = await runCli(args, keyPath); expect(onlineOutput.code).toBe(1); expect(onlineOutput.stderr).toContain('--offline'); await expect(stat(ctx.destination)).rejects.toThrow();
    } finally { await ctx.close(); }
  });
  it('uses an online SQLite snapshot while another connection accepts a transaction of events and native inputs', async () => {
    const ctx = await fixture(); const other = new Database(join(ctx.dataDir, 'webdcc.db')); let changed = false;
    try {
      const store = new Store(other);
      await createEncryptedBackup({ db: ctx.db, dataDir: ctx.dataDir, destination: ctx.destination, key: ctx.key, consistency: 'operator-declared-offline', withMetadataSnapshot: capture => capture(), onProgress: progress => {
        if (progress.phase !== 'snapshot' || changed) return; changed = true;
        other.transaction(() => { store.appendEvent({ sessionId: ctx.session.id, turnId: 'online-turn', itemKey: 'online', kind: 'user.message', data: { text: 'online accepted input' } }); store.journal.claim({ clientCommandId: 'online-accepted', op: 'send', sessionId: ctx.session.id, text: 'online accepted input' }); store.journal.enqueue('online-accepted', ctx.session.id, 'online-turn', { text: 'online accepted input' }); store.journal.beginInput('online-turn'); })();
      } });
      expect(changed).toBe(true); const target = join(ctx.root, 'restored'); await restoreEncryptedBackup({ backupDir: ctx.destination, destination: target, key: ctx.key });
      const restored = openDb(join(target, 'webdcc.db'));
      try { const store = new Store(restored); const exists = store.journal.get('online-accepted') !== undefined; expect(store.allEvents(ctx.session.id).some(event => event.itemKey === 'online')).toBe(exists); expect(store.journal.nativeInput(ctx.session.id, exists ? store.journal.nativeRequestId('online-turn') : 'absent') !== undefined).toBe(exists); }
      finally { restored.close(); }
    } finally { other.close(); await ctx.close(); }
  });
  it('preserves SQLite identity/results/native input UUID/accepted queue/attachments and encrypts every secret-bearing object', async () => {
    const ctx = await fixture();
    const fdBaseline = readdirSync('/proc/self/fd').length;
    try {
      const output = await ctx.create(); expect(output.encrypted).toBe(true);
      const manifest = await inspectEncryptedBackup({ backupDir: ctx.destination, key: ctx.key });
      expect(manifest.schemaVersion).toBe(CURRENT_SCHEMA_VERSION); expect(manifest.entries.filter(entry => entry.path.startsWith('files/'))).toHaveLength(2);
      expect(manifest.scope.excluded.join(' ')).toContain('native homes'); expect(manifest.sidecars['secrets.json']).toBe('included-encrypted');
      const all = [await readFile(join(ctx.destination, 'backup.json')), await readFile(join(ctx.destination, 'manifest.enc')), ...await Promise.all((await readdir(join(ctx.destination, 'objects'))).map(name => readFile(join(ctx.destination, 'objects', name))))];
      for (const secret of ['PRIVATE_QUEUED_TEXT', 'PRIVATE_PROVIDER_KEY', 'PRIVATE_COOKIE', 'PRIVATE_FILE_BYTES', 'MUST_NOT_COPY_ENV', 'MUST_NOT_COPY_ORPHAN']) expect(Buffer.concat(all).includes(Buffer.from(secret))).toBe(false);
      expect((await stat(join(ctx.destination, 'manifest.enc'))).mode & 0o777).toBe(0o600);
      const restored = join(ctx.root, 'restored'); await restoreEncryptedBackup({ backupDir: ctx.destination, destination: restored, key: ctx.key });
      const db = openDb(join(restored, 'webdcc.db'));
      try {
        const store = new Store(db); const files = new FileStore(restored, store);
        expect(store.getSession(ctx.session.id)).toMatchObject({ id: ctx.session.id, nativeId: 'native-preserved' }); expect(store.allEvents(ctx.session.id)).toEqual([ctx.event]);
        expect(store.journal.queue(ctx.session.id).map(input => [input.commandId, input.turnId, input.state, input.input.text])).toEqual([['queued-input', 'queued-turn', 'queued', 'PRIVATE_QUEUED_TEXT'], ['admitted-input', 'admitted-turn', 'native-accepted', 'ADMITTED_TEXT']]);
        expect(store.journal.nativeRequestId('admitted-turn')).toBe(ctx.nativeInputId);
        expect(db.prepare('SELECT result FROM commands WHERE client_command_id = ?').get('legacy-result')).toEqual({ result: '{"kept":true}' });
        expect((await files.readAll(ctx.image.id))?.buffer.toString()).toBe('PRIVATE_FILE_BYTES'); expect((await files.readAll(ctx.empty.id))?.buffer.length).toBe(0);
        expect(await readFile(join(restored, 'secrets.json'), 'utf8')).toContain('PRIVATE_PROVIDER_KEY'); expect(await readFile(join(restored, 'dsh-connection.json'), 'utf8')).toContain('PRIVATE_COOKIE');
        await expect(readFile(join(restored, '.env'))).rejects.toThrow();
      } finally { db.close(); }
      expect(readdirSync('/proc/self/fd').length).toBe(fdBaseline);
    } finally { await ctx.close(); }
  });

  it('preserves accepted pending upload chunks instead of inventing resumable metadata without bytes', async () => {
    const ctx = await fixture();
    try {
      const upload = await ctx.files.initUpload({ name: 'pending', mime: 'application/octet-stream', size: CHUNK_SIZE + 3 });
      const first = Buffer.alloc(CHUNK_SIZE, 17); await ctx.files.writeChunk(upload.uploadId, 0, first);
      await ctx.create(); const restored = join(ctx.root, 'restored'); await restoreEncryptedBackup({ backupDir: ctx.destination, destination: restored, key: ctx.key });
      const db = openDb(join(restored, 'webdcc.db'));
      try { const files = new FileStore(restored, new Store(db)); expect(files.uploadStatus(upload.uploadId).received).toEqual([0]); expect(await readFile(join(restored, 'uploads', upload.uploadId, '0'))).toEqual(first); await files.writeChunk(upload.uploadId, 1, Buffer.from('end')); const complete = await files.completeUpload(upload.uploadId); expect((await files.readAll(complete.fileId))?.buffer).toEqual(Buffer.concat([first, Buffer.from('end')])); }
      finally { db.close(); }
    } finally { await ctx.close(); }
  });

  it('never publishes an incomplete backup when a referenced CAS object is missing or corrupt', async () => {
    const ctx = await fixture();
    try {
      await writeFile(ctx.files.objectPath(ctx.image.sha256), 'bad'); await expect(ctx.create()).rejects.toThrow();
      await expect(stat(ctx.destination)).rejects.toThrow(); expect((await readdir(ctx.root)).some(name => name.startsWith('.backup-encrypted-'))).toBe(false);
    } finally { await ctx.close(); }
  });

  it('closes its source file when encrypted output creation fails without publishing an archive', async () => {
    const ctx = await fixture(); const fdBaseline = readdirSync('/proc/self/fd').length; let removed = false;
    try {
      await expect(createEncryptedBackup({ db: ctx.db, dataDir: ctx.dataDir, destination: ctx.destination, key: ctx.key, consistency: 'operator-declared-offline', withMetadataSnapshot: capture => capture(), onProgress: progress => {
        if (progress.phase !== 'snapshot' || removed) return;
        const stage = readdirSync(ctx.root).find(name => name.startsWith('.backup-encrypted-'));
        if (stage !== undefined) { removed = true; rmSync(join(ctx.root, stage, 'objects'), { recursive: true }); }
      } })).rejects.toThrow();
      expect(removed).toBe(true); expect(readdirSync('/proc/self/fd').length).toBe(fdBaseline);
      await expect(stat(ctx.destination)).rejects.toThrow(); expect((await readdir(ctx.root)).some(name => name.startsWith('.backup-encrypted-'))).toBe(false);
    } finally { await ctx.close(); }
  });

  it('rejects a wrong key and tampered ciphertext before publishing a restore directory', async () => {
    const ctx = await fixture();
    try {
      await ctx.create(); const target = join(ctx.root, 'wrong-key'); await expect(restoreEncryptedBackup({ backupDir: ctx.destination, destination: target, key: randomBytes(32) })).rejects.toThrow(); await expect(stat(target)).rejects.toThrow();
      const objects = await readdir(join(ctx.destination, 'objects')); const path = join(ctx.destination, 'objects', objects[0]!); const bytes = await readFile(path); bytes[25] = bytes[25]! ^ 1; await writeFile(path, bytes);
      await expect(restoreEncryptedBackup({ backupDir: ctx.destination, destination: target, key: ctx.key })).rejects.toThrow(); await expect(stat(target)).rejects.toThrow();
      expect((await readdir(ctx.root)).some(name => name.startsWith('.restore-private-'))).toBe(false);
    } finally { await ctx.close(); }
  });

  it('refuses any existing data directory and never overwrites a running SQLite file', async () => {
    const ctx = await fixture();
    try {
      await ctx.create(); const before = ctx.db.prepare('SELECT COUNT(*) AS count FROM sessions').get();
      await expect(restoreEncryptedBackup({ backupDir: ctx.destination, destination: ctx.dataDir, key: ctx.key })).rejects.toThrow('隔离目录');
      await expect(restoreEncryptedBackup({ backupDir: ctx.destination, destination: join(ctx.dataDir, 'webdcc.db'), key: ctx.key })).rejects.toThrow('隔离目录'); expect(ctx.db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual(before);
    } finally { await ctx.close(); }
  });

  it('rejects unencrypted operation and generates a separate non-overwriting private key file', async () => {
    const ctx = await fixture();
    try {
      await expect(createEncryptedBackup({ db: ctx.db, dataDir: ctx.dataDir, destination: ctx.destination, key: Buffer.alloc(0), consistency: 'operator-declared-offline', withMetadataSnapshot: capture => capture() })).rejects.toThrow('32 字节');
      const keyPath = join(ctx.root, 'separate.key'); await createBackupKeyFile(keyPath); expect((await stat(keyPath)).mode & 0o777).toBe(0o600); expect((await readFile(keyPath)).length).toBe(32); await expect(createBackupKeyFile(keyPath)).rejects.toThrow();
    } finally { await ctx.close(); }
  });
  it('rejects invalid capacity limits in create, inspection and restore instead of bypassing a quota', async () => {
    const ctx = await fixture();
    try {
      await ctx.create();
      for (const name of ['maxBytes', 'maxEntries', 'maxManifestBytes'] as const) for (const value of [NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        const limits = { [name]: value }; const destination = join(ctx.root, 'invalid-limits');
        await expect(createEncryptedBackup({ db: ctx.db, dataDir: ctx.dataDir, destination, key: ctx.key, consistency: 'operator-declared-offline', withMetadataSnapshot: capture => capture(), ...limits })).rejects.toThrow('安全整数');
        await expect(inspectEncryptedBackup({ backupDir: ctx.destination, key: ctx.key, ...limits })).rejects.toThrow('安全整数');
        await expect(restoreEncryptedBackup({ backupDir: ctx.destination, destination, key: ctx.key, ...limits })).rejects.toThrow('安全整数');
        await expect(stat(destination)).rejects.toThrow();
      }
      await expect(inspectEncryptedBackup({ backupDir: ctx.destination, key: ctx.key, maxBytes: 1 })).rejects.toThrow('容量上限');
      await expect(inspectEncryptedBackup({ backupDir: ctx.destination, key: ctx.key, maxEntries: 1 })).rejects.toThrow('manifest');
      await expect(inspectEncryptedBackup({ backupDir: ctx.destination, key: ctx.key, maxManifestBytes: 1 })).rejects.toThrow('读取上限');
      expect((await readdir(ctx.root)).some(name => name.startsWith('.restore-private-') || name.startsWith('.backup-encrypted-'))).toBe(false);
    } finally { await ctx.close(); }
  });
  it('refuses malformed persisted DSH connection fields before creating an archive', async () => {
    const ctx = await fixture();
    try {
      const connection = { url: 'http://localhost:1234', cookie: 'PRIVATE_COOKIE', connectedAt: '2026-11-14T00:00:00Z' };
      for (const patch of [{ url: 'file:///etc/passwd' }, { url: 'http://name:password@localhost:1234' }, { cookie: '' }, { cookie: 'cookie\nheader' }, { cookie: 'x'.repeat(16385) }, { connectedAt: 'invalid date' }, { browserCookie: 'invalid peer cookie' }, { version: 4 }]) {
        await writeFile(join(ctx.dataDir, 'dsh-connection.json'), JSON.stringify({ ...connection, ...patch }));
        await expect(ctx.create()).rejects.toThrow('设置文件格式'); await expect(stat(ctx.destination)).rejects.toThrow();
      }
      await writeFile(join(ctx.dataDir, 'dsh-connection.json'), JSON.stringify({ ...connection, browserCookie: 'dsh-auth-host=v1.browser', futureField: { kept: true } }));
      await ctx.create(); const restored = join(ctx.root, 'restored'); await restoreEncryptedBackup({ backupDir: ctx.destination, destination: restored, key: ctx.key });
      expect(JSON.parse(await readFile(join(restored, 'dsh-connection.json'), 'utf8'))).toMatchObject({ browserCookie: 'dsh-auth-host=v1.browser', futureField: { kept: true } });
    } finally { await ctx.close(); }
  });
  it('preserves an explicitly cleared or absent DSH connection without inventing credentials', async () => {
    const ctx = await fixture();
    try {
      await writeFile(join(ctx.dataDir, 'dsh-connection.json'), 'null'); await ctx.create();
      const restored = join(ctx.root, 'cleared'); await restoreEncryptedBackup({ backupDir: ctx.destination, destination: restored, key: ctx.key });
      expect(await readFile(join(restored, 'dsh-connection.json'), 'utf8')).toBe('null');
      await rm(ctx.destination, { recursive: true }); await rm(join(ctx.dataDir, 'dsh-connection.json')); await ctx.create();
      const manifest = await inspectEncryptedBackup({ backupDir: ctx.destination, key: ctx.key }); expect(manifest.sidecars['dsh-connection.json']).toBe('absent-at-source');
      const absent = join(ctx.root, 'absent'); await restoreEncryptedBackup({ backupDir: ctx.destination, destination: absent, key: ctx.key }); await expect(stat(join(absent, 'dsh-connection.json'))).rejects.toThrow();
    } finally { await ctx.close(); }
  });
  it('rejects authenticated malformed sidecars in inspection and restore instead of declaring them valid', async () => {
    const ctx = await fixture();
    try {
      await ctx.create();
      for (const [path, value] of [['dsh-connection.json', '{"url":"file:///private","cookie":"test","connectedAt":"2026-11-14T00:00:00Z"}'], ['provider-ignored.json', '{}'], ['secrets.json', '{"provider:test":42}']] as const) {
        await replaceSidecar(ctx.destination, ctx.key, path, value);
        await expect(inspectEncryptedBackup({ backupDir: ctx.destination, key: ctx.key })).rejects.toThrow('设置文件格式');
        const target = join(ctx.root, 'malformed-restore'); await expect(restoreEncryptedBackup({ backupDir: ctx.destination, destination: target, key: ctx.key })).rejects.toThrow('设置文件格式'); await expect(stat(target)).rejects.toThrow();
        await replaceSidecar(ctx.destination, ctx.key, path, await readFile(join(ctx.dataDir, path), 'utf8'));
      }
      expect((await readdir(ctx.root)).some(name => name.startsWith('.restore-private-'))).toBe(false);
    } finally { await ctx.close(); }
  });
  it('bounds metadata reads when a valid JSON sidecar grows after stat', async () => {
    const ctx = await fixture(); const prototype = await handlePrototype(ctx.root); const originalStat = prototype.stat;
    let calls = 0; let changed = false;
    const readSpy = vi.spyOn(prototype, 'read'); const readFileSpy = vi.spyOn(prototype, 'readFile');
    const spy = vi.spyOn(prototype, 'stat').mockImplementation(async function (this: FileHandle) {
      const status = await originalStat.call(this);
      if (readlinkSync(`/proc/self/fd/${this.fd}`) === join(ctx.dataDir, 'secrets.json') && ++calls === 2) { changed = true; appendFileSync(join(ctx.dataDir, 'secrets.json'), Buffer.alloc(4 * 1024 ** 2, 32)); }
      return status;
    });
    try {
      await expect(ctx.create()).rejects.toThrow('读取上限'); expect(changed).toBe(true); await expect(stat(ctx.destination)).rejects.toThrow();
      const reads = await Promise.all(readSpy.mock.results.filter(result => result.type === 'return').map(result => result.value as Promise<{ bytesRead: number }>));
      const wholeReads = await Promise.all(readFileSpy.mock.results.filter(result => result.type === 'return').map(result => result.value as Promise<Buffer>));
      expect(reads.reduce((bytes, value) => bytes + value.bytesRead, 0) + wholeReads.reduce((bytes, value) => bytes + value.length, 0)).toBeLessThanOrEqual(4 * 1024 ** 2 + 1);
    }
    finally { spy.mockRestore(); readSpy.mockRestore(); readFileSpy.mockRestore(); await ctx.close(); }
  });
  it('does not publish a restore if an attachment directory cannot be made durable', async () => {
    const ctx = await fixture();
    try {
      await ctx.create(); const fdBaseline = readdirSync('/proc/self/fd').length; const prototype = await handlePrototype(ctx.root); const originalSync = prototype.sync; let failed = false;
      const spy = vi.spyOn(prototype, 'sync').mockImplementation(function (this: FileHandle) {
        const path = readlinkSync(`/proc/self/fd/${this.fd}`);
        if (path.includes('/.restore-private-') && path.endsWith(`/files/${ctx.image.sha256.slice(0, 2)}`)) { failed = true; return Promise.reject(new Error('injected directory I/O failure')); }
        return originalSync.call(this);
      });
      const target = join(ctx.root, 'durable-restore');
      try { await expect(restoreEncryptedBackup({ backupDir: ctx.destination, destination: target, key: ctx.key })).rejects.toThrow('恢复验证'); expect(failed).toBe(true); await expect(stat(target)).rejects.toThrow(); expect(readdirSync('/proc/self/fd').length).toBe(fdBaseline); }
      finally { spy.mockRestore(); }
      expect((await readdir(ctx.root)).some(name => name.startsWith('.restore-private-'))).toBe(false);
      await restoreEncryptedBackup({ backupDir: ctx.destination, destination: target, key: ctx.key }); expect(await readFile(join(target, 'files', ctx.image.sha256.slice(0, 2), ctx.image.sha256), 'utf8')).toBe('PRIVATE_FILE_BYTES');
    } finally { await ctx.close(); }
  });
  it('fails key generation and removes the new key if its parent directory cannot be made durable', async () => {
    const ctx = await fixture(); const prototype = await handlePrototype(ctx.root); const originalSync = prototype.sync; let failed = false;
    const spy = vi.spyOn(prototype, 'sync').mockImplementation(function (this: FileHandle) {
      if (readlinkSync(`/proc/self/fd/${this.fd}`) === ctx.root) { failed = true; return Promise.reject(new Error('injected key directory I/O failure')); }
      return originalSync.call(this);
    });
    const keyPath = join(ctx.root, 'failed-key');
    try { await expect(createBackupKeyFile(keyPath)).rejects.toThrow('I/O failure'); expect(failed).toBe(true); await expect(stat(keyPath)).rejects.toThrow(); }
    finally { spy.mockRestore(); await ctx.close(); }
  });
  it('fails closed for unsupported schema and foreign key violations', async () => {
    const ctx = await fixture();
    try {
      ctx.db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION + 1}`); await expect(ctx.create()).rejects.toThrow('schema'); await expect(stat(ctx.destination)).rejects.toThrow();
      ctx.db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`); ctx.db.pragma('foreign_keys = OFF');
      ctx.db.prepare('INSERT INTO events (session_id, seq, turn_id, item_key, kind, data, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('missing-session', 1, 'bad-turn', 'bad', 'user.message', '{}', new Date().toISOString());
      await expect(ctx.create()).rejects.toThrow('外键'); await expect(stat(ctx.destination)).rejects.toThrow();
    } finally { await ctx.close(); }
  });
  it('rejects metadata changes and cancellation without publishing a partial archive', async () => {
    const ctx = await fixture();
    try {
      let changed = false;
      await expect(createEncryptedBackup({ db: ctx.db, dataDir: ctx.dataDir, destination: ctx.destination, key: ctx.key, consistency: 'operator-declared-offline', withMetadataSnapshot: capture => capture(), onProgress: progress => { if (progress.phase === 'snapshot' && !changed) { changed = true; writeFileSync(join(ctx.dataDir, 'secrets.json'), '{"provider:test":"CHANGED_KEY"}'); } } })).rejects.toThrow('设置');
      await expect(stat(ctx.destination)).rejects.toThrow(); const controller = new AbortController();
      await expect(createEncryptedBackup({ db: ctx.db, dataDir: ctx.dataDir, destination: ctx.destination, key: ctx.key, consistency: 'operator-declared-offline', withMetadataSnapshot: capture => capture(), signal: controller.signal, onProgress: progress => { if (progress.phase === 'encrypt') controller.abort(); } })).rejects.toThrow('取消');
      await expect(stat(ctx.destination)).rejects.toThrow(); expect((await readdir(ctx.root)).some(name => name.startsWith('.backup-encrypted-'))).toBe(false);
    } finally { await ctx.close(); }
  });
  it('fails rather than inventing upload recovery when an accepted chunk is missing', async () => {
    const ctx = await fixture();
    try { const upload = await ctx.files.initUpload({ name: 'partial', size: 3, mime: 'text/plain' }); await ctx.files.writeChunk(upload.uploadId, 0, Buffer.from('one')); await rm(join(ctx.dataDir, 'uploads', upload.uploadId, '0')); await expect(ctx.create()).rejects.toThrow(); await expect(stat(ctx.destination)).rejects.toThrow(); }
    finally { await ctx.close(); }
  });
  it('rejects a CAS symlink and authenticated path traversal before any target is published', async () => {
    const ctx = await fixture();
    try {
      const path = ctx.files.objectPath(ctx.image.sha256); const external = join(ctx.root, 'outside'); await writeFile(external, 'PRIVATE_FILE_BYTES'); await rm(path); await symlink(external, path);
      await expect(ctx.create()).rejects.toThrow(); await rm(path); await writeFile(path, 'PRIVATE_FILE_BYTES'); await ctx.create();
      const header = JSON.parse(await readFile(join(ctx.destination, 'backup.json'), 'utf8')) as { archiveId: string };
      const encrypted = await readFile(join(ctx.destination, 'manifest.enc')); const associated = Buffer.from(`webdcc-encrypted-backup:1:${header.archiveId}:manifest`);
      const decipher = createDecipheriv('aes-256-gcm', ctx.key, encrypted.subarray(8, 20)); decipher.setAAD(associated); decipher.setAuthTag(encrypted.subarray(-16));
      const manifest = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(20, -16)), decipher.final()]).toString()) as { entries: { path: string }[] };
      manifest.entries[0]!.path = '../../outside'; const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', ctx.key, iv); cipher.setAAD(associated);
      await writeFile(join(ctx.destination, 'manifest.enc'), Buffer.concat([Buffer.from('WDCCBKV1'), iv, cipher.update(Buffer.from(JSON.stringify(manifest))), cipher.final(), cipher.getAuthTag()]));
      const target = join(ctx.root, 'rejected'); await expect(restoreEncryptedBackup({ backupDir: ctx.destination, destination: target, key: ctx.key })).rejects.toThrow('manifest'); await expect(stat(target)).rejects.toThrow(); expect(await readFile(external, 'utf8')).toBe('PRIVATE_FILE_BYTES');
    } finally { await ctx.close(); }
  });
  it('restores an older stored schema through the existing migration without losing URLs, results, queue, or CAS bytes', async () => {
    const ctx = await fixture();
    try {
      ctx.db.exec('DROP TABLE native_input_ids'); ctx.db.pragma('user_version = 10'); await ctx.create();
      const target = join(ctx.root, 'upgraded'); await restoreEncryptedBackup({ backupDir: ctx.destination, destination: target, key: ctx.key, upgradeSchema: true }); const db = openDb(join(target, 'webdcc.db'));
      try { const store = new Store(db); expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION); expect(store.getSession(ctx.session.id)?.nativeId).toBe('native-preserved'); expect(store.allEvents(ctx.session.id)).toEqual([ctx.event]); expect(store.journal.queue(ctx.session.id)[0]?.input.text).toBe('PRIVATE_QUEUED_TEXT'); expect((await new FileStore(target, store).readAll(ctx.image.id))?.buffer.toString()).toBe('PRIVATE_FILE_BYTES'); expect(db.prepare('SELECT result FROM commands WHERE client_command_id = ?').get('legacy-result')).toEqual({ result: '{"kept":true}' }); }
      finally { db.close(); }
    } finally { await ctx.close(); }
  });
});
