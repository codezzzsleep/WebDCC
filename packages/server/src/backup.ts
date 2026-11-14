import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import { dshBaseUrl } from '@webdcc/adapter-dsh';
import { CURRENT_SCHEMA_VERSION, openDb, type Db } from './db.js';
import { CHUNK_SIZE } from './files.js';

const FORMAT = 'webdcc-encrypted-backup';
const VERSION = 1;
const MAGIC = Buffer.from('WDCCBKV1');
const HEADER_BYTES = MAGIC.length + 12;
const TAG_BYTES = 16;
const SIDECARS = ['secrets.json', 'provider-ignored.json', 'dsh-connection.json'] as const;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export interface BackupLimits { maxBytes?: number; maxEntries?: number; maxManifestBytes?: number }
export interface BackupEntry { path: string; object: string; bytes: number; sha256: string }
export interface BackupManifest {
  format: typeof FORMAT;
  version: typeof VERSION;
  createdAt: string;
  schemaVersion: number;
  entries: BackupEntry[];
  tableCounts: Record<string, number>;
  consistency: 'settings-writes-paused' | 'operator-declared-offline';
  sidecars: Record<string, 'included-encrypted' | 'absent-at-source'>;
  scope: {
    database: 'unmodified-online-snapshot';
    cas: 'only-objects-referenced-by-snapshot-files-table';
    uploads: 'snapshot-received-chunks-included';
    credentials: 'persisted-webdcc-sidecars-encrypted';
    excluded: string[];
  };
}
export interface CreateBackupOptions extends BackupLimits {
  db: Db;
  dataDir: string;
  destination: string;
  /** Independent random 256-bit key. Never derive it from an auth token. */
  key: Buffer;
  /** This must freeze every Provider/DSH settings writer while snapshotting.
   * SQLite event/input writes may continue. External writers require quiescence. */
  withMetadataSnapshot<T>(capture: () => Promise<T>): Promise<T>;
  consistency: BackupManifest['consistency'];
  signal?: AbortSignal;
  onProgress?(value: { phase: 'snapshot' | 'encrypt'; completed: number; total: number }): void;
}
export interface RestoreBackupOptions extends BackupLimits {
  backupDir: string;
  destination: string;
  key: Buffer;
  upgradeSchema?: boolean;
  signal?: AbortSignal;
}
export interface BackupResult {
  path: string;
  createdAt: string;
  schemaVersion: number;
  encrypted: true;
  entries: number;
  bytes: number;
  excluded: string[];
}
export class BackupError extends Error {
  readonly code = 'backup-invalid';
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

interface PublicHeader { format: typeof FORMAT; version: typeof VERSION; cipher: 'aes-256-gcm'; key: 'external-random-256-bit'; archiveId: string }
interface SourceEntry { path: string; source?: string; buffer?: Buffer; bytes: number; sha256?: string }
function fail(message: string): never { throw new BackupError(message); }
function bounds(value: BackupLimits): Required<BackupLimits> {
  const limits = { maxBytes: value.maxBytes ?? 16 * 1024 ** 3, maxEntries: value.maxEntries ?? 100_000, maxManifestBytes: value.maxManifestBytes ?? 64 * 1024 ** 2 };
  if (Object.values(limits).some(limit => !Number.isSafeInteger(limit) || limit <= 0) || limits.maxManifestBytes > Number.MAX_SAFE_INTEGER - HEADER_BYTES - TAG_BYTES - 1) fail('备份容量上限必须是正的安全整数');
  return limits;
}
const digest = (value: Buffer): string => createHash('sha256').update(value).digest('hex');
const aad = (header: PublicHeader, path: string): Buffer => Buffer.from(`${FORMAT}:1:${header.archiveId}:${path}`);
const inside = (root: string, path: string): boolean => { const value = relative(root, path); return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value); };
function keyCopy(key: Buffer): Buffer { if (!Buffer.isBuffer(key) || key.length !== 32) fail('备份需要独立的随机 32 字节密钥'); return Buffer.from(key); }
function cancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new BackupError('备份操作已取消', 409); }

async function safeFile(root: string, path: string): Promise<FileHandle> {
  const parent = await realpath(dirname(path));
  if (!inside(root, parent)) fail('备份文件越出授权目录');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (!(await handle.stat()).isFile()) fail('备份只接受普通文件'); return handle; }
  catch (error) { await handle.close(); throw error; }
}
async function smallFile(root: string, path: string, maximum: number): Promise<Buffer> {
  const handle = await safeFile(root, path);
  const chunks: Buffer[] = []; let bytes = 0;
  try {
    if ((await handle.stat()).size > maximum) fail('备份元数据超过读取上限');
    // A file can grow after stat. Read at most the limit plus one byte, rather
    // than allowing readFile() to allocate an unbounded metadata buffer.
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maximum + 1 - bytes)); chunks.push(chunk);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, bytes);
      bytes += bytesRead;
      if (bytes > maximum) fail('备份元数据超过读取上限');
      if (bytesRead === 0) return Buffer.concat(chunks, bytes);
      // A short read is not necessarily EOF, so preserve only the bytes read.
      chunks[chunks.length - 1] = chunk.subarray(0, bytesRead);
    }
  } finally { for (const chunk of chunks) chunk.fill(0); await handle.close(); }
}
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function syncTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await syncTree(path);
    else if (entry.isFile()) { const handle = await safeFile(root, path); try { await handle.sync(); } finally { await handle.close(); } }
    else fail('恢复暂存目录包含非普通文件');
  }
  await syncDirectory(root);
}
async function writableFile(path: string): Promise<FileHandle> { return open(path, 'wx', 0o600); }
async function closeFiles(...handles: (FileHandle | undefined)[]): Promise<void> {
  const outcomes = await Promise.allSettled(handles.filter((handle): handle is FileHandle => handle !== undefined).map(handle => handle.close()));
  const failed = outcomes.find(outcome => outcome.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason;
}

function inspectDatabase(db: Db): { schemaVersion: number; tableCounts: Record<string, number> } {
  const schemaVersion = db.pragma('user_version', { simple: true }) as number;
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0 || schemaVersion > CURRENT_SCHEMA_VERSION) fail('数据库 schema 版本不兼容');
  const integrity = db.pragma('integrity_check') as { integrity_check: string }[];
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') fail('数据库完整性检查失败');
  if ((db.pragma('foreign_key_check') as unknown[]).length !== 0) fail('数据库外键检查失败');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  if (!['sessions', 'events', 'files'].every(name => tables.some(table => table.name === name))) fail('数据库缺少 WebDCC 必需表');
  if (schemaVersion >= 11 && !tables.some(table => table.name === 'native_input_ids')) fail('数据库缺少该 schema 版本的原生输入身份表');
  if (schemaVersion >= 12) {
    const columns = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name));
    if (!columns('file_session_grants').has('file_id') || !columns('uploads').has('session_id') || !columns('drafts').has('revision') || !columns('drafts').has('content_parts') || !columns('native_input_ids').has('target_turn_id') || !columns('input_queue').has('preparation_error')) fail('数据库缺少 schema v12 的附件授权、草稿版本或输入关联字段');
  }
  if (schemaVersion >= 13) for (const index of db.prepare('PRAGMA index_list(files)').all() as { name: string; unique: number }[]) {
    const fields = db.prepare(`PRAGMA index_info("${index.name.replaceAll('"', '""')}")`).all() as { name: string | null }[];
    if (index.unique !== 0 && fields.length === 1 && fields[0]?.name === 'sha256') fail('数据库缺少 schema v13 的文件别名能力');
  }
  const tableCounts: Record<string, number> = {};
  for (const { name } of tables) tableCounts[name] = (db.prepare(`SELECT COUNT(*) AS count FROM "${name.replaceAll('"', '""')}"`).get() as { count: number }).count;
  return { schemaVersion, tableCounts };
}

function validConnection(value: unknown): boolean {
  if (value === null) return true; // Explicitly cleared DSH connection.
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { url?: unknown; cookie?: unknown; browserCookie?: unknown; connectedAt?: unknown; version?: unknown };
  const cookie = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 16384 && !/[^\x20-\x7e]/.test(value);
  if (typeof candidate.url !== 'string' || !cookie(candidate.cookie) || typeof candidate.connectedAt !== 'string' || !Number.isFinite(Date.parse(candidate.connectedAt)) || candidate.version !== undefined && typeof candidate.version !== 'string') return false;
  if (candidate.browserCookie !== undefined && (!cookie(candidate.browserCookie) || !/^dsh-auth-[^=;]+=v1\./.test(candidate.browserCookie))) return false;
  try { dshBaseUrl(candidate.url); return true; } catch { return false; }
}
function clearBuffers(entries: SourceEntry[]): void { for (const entry of entries) entry.buffer?.fill(0); }
async function sidecarBuffers(dataDir: string): Promise<{ entries: SourceEntry[]; states: BackupManifest['sidecars'] }> {
  const entries: SourceEntry[] = []; const states: BackupManifest['sidecars'] = {};
  try {
    for (const path of SIDECARS) {
      const source = join(dataDir, path);
      const exists = await lstat(source).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; });
      if (!exists) { states[path] = 'absent-at-source'; continue; }
      const buffer = await smallFile(dataDir, source, 4 * 1024 ** 2);
      entries.push({ path, buffer, bytes: buffer.length, sha256: digest(buffer) });
      let parsed: unknown; try { parsed = JSON.parse(buffer.toString('utf8')); } catch { fail('持久设置文件不是完整 JSON，备份已取消'); }
      if (path === 'provider-ignored.json' ? !Array.isArray(parsed) || parsed.some(value => typeof value !== 'string') : path === 'secrets.json' ? parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(value => typeof value !== 'string') : !validConnection(parsed)) fail('持久设置文件格式不兼容');
      states[path] = 'included-encrypted';
    }
    return { entries, states };
  } catch (error) { clearBuffers(entries); throw error; }
}
function databaseReferences(db: Db, dataDir: string): SourceEntry[] {
  const entries: SourceEntry[] = []; const hashes = new Map<string, number>();
  for (const row of db.prepare('SELECT sha256, size FROM files ORDER BY sha256').all() as { sha256: string; size: number }[]) {
    if (typeof row.sha256 !== 'string' || !SHA256.test(row.sha256) || !Number.isSafeInteger(row.size) || row.size < 0) fail('快照 CAS 引用无效');
    if (hashes.has(row.sha256)) { if (hashes.get(row.sha256) !== row.size) fail('同一 CAS hash 的文件别名大小不一致'); continue; }
    hashes.set(row.sha256, row.size);
    const path = `files/${row.sha256.slice(0, 2)}/${row.sha256}`;
    entries.push({ path, source: join(dataDir, path), bytes: row.size, sha256: row.sha256 });
  }
  const uploadsExist = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'uploads'").get() !== undefined;
  if (uploadsExist) for (const row of db.prepare('SELECT id, size, received FROM uploads ORDER BY id').all() as { id: string; size: number; received: string }[]) {
    if (typeof row.id !== 'string' || !UUID.test(row.id) || !Number.isSafeInteger(row.size) || row.size < 0) fail('快照上传引用无效');
    let indices: unknown; try { indices = JSON.parse(row.received); } catch { fail('快照上传分片索引无效'); }
    if (!Array.isArray(indices) || new Set(indices).size !== indices.length || indices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= Math.ceil(row.size / CHUNK_SIZE))) fail('快照上传分片索引无效');
    for (const index of indices as number[]) {
      const path = `uploads/${row.id}/${index}`;
      entries.push({ path, source: join(dataDir, path), bytes: Math.min(CHUNK_SIZE, row.size - index * CHUNK_SIZE) });
    }
  }
  return entries;
}

async function encryptEntry(header: PublicHeader, key: Buffer, entry: SourceEntry, destination: string, sourceRoot: string, signal?: AbortSignal): Promise<BackupEntry> {
  cancelled(signal);
  const object = `objects/${randomUUID()}.enc`; const target = join(destination, object);
  const input = entry.buffer === undefined ? await safeFile(sourceRoot, entry.source!) : undefined;
  let output: FileHandle | undefined;
  const iv = randomBytes(12); const hash = createHash('sha256'); let bytes = 0;
  try {
    output = await writableFile(target);
    if (input && (await input.stat()).size !== entry.bytes) fail('快照引用文件大小已变化');
    await output.writeFile(Buffer.concat([MAGIC, iv]));
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad(header, entry.path));
    const measure = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; if (bytes > entry.bytes) callback(new BackupError('快照引用文件在读取时增长')); else { hash.update(chunk); callback(null, chunk); } } });
    await pipeline(input ? createReadStream(entry.source!, { fd: input.fd, autoClose: false }) : Readable.from([entry.buffer!]), measure, cipher, createWriteStream(target, { fd: output.fd, autoClose: false, start: HEADER_BYTES }), { signal });
    const sha256 = hash.digest('hex');
    if (bytes !== entry.bytes || entry.sha256 !== undefined && sha256 !== entry.sha256) fail('快照引用文件 hash 或大小不匹配');
    await output.write(cipher.getAuthTag(), 0, TAG_BYTES, HEADER_BYTES + bytes); await output.sync();
    return { path: entry.path, object, bytes, sha256 };
  } finally { entry.buffer?.fill(0); await closeFiles(input, output); }
}

async function decryptEntry(header: PublicHeader, key: Buffer, entry: BackupEntry, backupRoot: string, target?: string, signal?: AbortSignal): Promise<void> {
  cancelled(signal);
  const input = await safeFile(backupRoot, join(backupRoot, entry.object));
  let output: FileHandle | undefined;
  try {
    const size = (await input.stat()).size;
    if (size !== HEADER_BYTES + entry.bytes + TAG_BYTES) fail('密文大小与 manifest 不匹配');
    const prefix = Buffer.alloc(HEADER_BYTES); await input.read(prefix, 0, prefix.length, 0);
    if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) fail('密文格式无效');
    const tag = Buffer.alloc(TAG_BYTES); await input.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, prefix.subarray(MAGIC.length)); decipher.setAAD(aad(header, entry.path)); decipher.setAuthTag(tag);
    const hash = createHash('sha256'); let bytes = 0;
    const measure = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; if (bytes > entry.bytes) callback(new BackupError('明文超过 manifest 上限')); else { hash.update(chunk); callback(null, chunk); } } });
    if (target !== undefined) { await mkdir(dirname(target), { recursive: true, mode: 0o700 }); output = await writableFile(target); }
    const sink = output ? createWriteStream(target!, { fd: output.fd, autoClose: false }) : new Transform({ transform(_chunk, _encoding, callback) { callback(); } });
    await pipeline(entry.bytes === 0 ? Readable.from([]) : createReadStream(join(backupRoot, entry.object), { fd: input.fd, start: HEADER_BYTES, end: size - TAG_BYTES - 1, autoClose: false }), decipher, measure, sink, { signal });
    if (bytes !== entry.bytes || hash.digest('hex') !== entry.sha256) fail('恢复文件 hash 或大小检查失败');
    await output?.sync();
  } finally { await closeFiles(input, output); }
}

function validEntry(entry: BackupEntry): boolean {
  return !!entry && typeof entry.path === 'string' && (entry.path === 'webdcc.db' || SIDECARS.some(path => path === entry.path) || /^files\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(entry.path) || /^uploads\/[a-f0-9-]{36}\/(?:0|[1-9]\d*)$/.test(entry.path))
    && typeof entry.object === 'string' && /^objects\/[a-f0-9-]{36}\.enc$/.test(entry.object) && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && typeof entry.sha256 === 'string' && SHA256.test(entry.sha256);
}
async function loadManifest(backupRoot: string, key: Buffer, limits: BackupLimits): Promise<{ header: PublicHeader; manifest: BackupManifest }> {
  const { maxManifestBytes, maxEntries, maxBytes } = bounds(limits);
  let parsed: unknown; try { parsed = JSON.parse((await smallFile(backupRoot, join(backupRoot, 'backup.json'), 4_096)).toString('utf8')); } catch { fail('备份公开头不存在或无效'); }
  const source = parsed as Partial<PublicHeader>;
  if (!source || source.format !== FORMAT || source.version !== VERSION || source.cipher !== 'aes-256-gcm' || source.key !== 'external-random-256-bit' || typeof source.archiveId !== 'string' || !UUID.test(source.archiveId) || Object.keys(source).some(field => !['format', 'version', 'cipher', 'key', 'archiveId'].includes(field))) fail('备份公开头不兼容');
  const header: PublicHeader = { format: FORMAT, version: VERSION, cipher: 'aes-256-gcm', key: 'external-random-256-bit', archiveId: source.archiveId };
  const encrypted = await smallFile(backupRoot, join(backupRoot, 'manifest.enc'), maxManifestBytes + HEADER_BYTES + TAG_BYTES);
  if (encrypted.length < HEADER_BYTES + TAG_BYTES || !encrypted.subarray(0, MAGIC.length).equals(MAGIC)) fail('加密 manifest 格式无效');
  let manifest: BackupManifest;
  const clearChunks: Buffer[] = [];
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(MAGIC.length, HEADER_BYTES)); decipher.setAAD(aad(header, 'manifest')); decipher.setAuthTag(encrypted.subarray(-TAG_BYTES));
    clearChunks.push(decipher.update(encrypted.subarray(HEADER_BYTES, -TAG_BYTES))); clearChunks.push(decipher.final());
    const clear = Buffer.concat(clearChunks);
    try { manifest = JSON.parse(clear.toString('utf8')) as BackupManifest; } finally { clear.fill(0); }
  } catch { fail('备份密钥错误或 manifest 已被篡改'); }
  finally { for (const chunk of clearChunks) chunk.fill(0); }
  if (!manifest || manifest.format !== FORMAT || manifest.version !== VERSION || !Number.isFinite(Date.parse(manifest.createdAt)) || !Number.isSafeInteger(manifest.schemaVersion) || manifest.schemaVersion < 0 || manifest.schemaVersion > CURRENT_SCHEMA_VERSION || !Array.isArray(manifest.entries) || manifest.entries.length > maxEntries || !manifest.entries.every(validEntry)) fail('备份 manifest 不兼容');
  if (new Set(manifest.entries.map(entry => entry.path)).size !== manifest.entries.length || new Set(manifest.entries.map(entry => entry.object)).size !== manifest.entries.length || manifest.entries.filter(entry => entry.path === 'webdcc.db').length !== 1) fail('备份 manifest 存在重复或缺失项');
  if (manifest.entries.reduce((total, entry) => total + entry.bytes, 0) > maxBytes) fail('备份超过恢复容量上限');
  if (!manifest.tableCounts || typeof manifest.tableCounts !== 'object' || Array.isArray(manifest.tableCounts) || Object.values(manifest.tableCounts).some(count => !Number.isSafeInteger(count) || count < 0)
    || !['settings-writes-paused', 'operator-declared-offline'].includes(manifest.consistency) || !manifest.sidecars || SIDECARS.some(path => !['included-encrypted', 'absent-at-source'].includes(manifest.sidecars[path] ?? ''))
    || !manifest.scope || manifest.scope.database !== 'unmodified-online-snapshot' || manifest.scope.cas !== 'only-objects-referenced-by-snapshot-files-table' || manifest.scope.uploads !== 'snapshot-received-chunks-included' || manifest.scope.credentials !== 'persisted-webdcc-sidecars-encrypted' || !Array.isArray(manifest.scope.excluded) || manifest.scope.excluded.some(value => typeof value !== 'string')) fail('备份范围和一致性说明不完整');
  for (const path of SIDECARS) if ((manifest.sidecars[path] === 'included-encrypted') !== manifest.entries.some(entry => entry.path === path)) fail('备份凭据清单与对象不一致');
  return { header, manifest };
}

function validateReferences(db: Db, manifest: BackupManifest, root: string): void {
  const expected = databaseReferences(db, root); const present = new Map(manifest.entries.filter(entry => entry.path.startsWith('files/') || entry.path.startsWith('uploads/')).map(entry => [entry.path, entry]));
  if (expected.length !== present.size || expected.some(reference => {
    const entry = present.get(reference.path);
    return !entry || entry.bytes !== reference.bytes || reference.sha256 !== undefined && entry.sha256 !== reference.sha256;
  })) fail('数据库引用与备份对象 hash、大小或清单不一致');
}

async function emptyDestination(destination: string): Promise<string> {
  const path = resolve(destination);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const parent = await realpath(dirname(path)); const normalized = join(parent, basename(path));
  const exists = await lstat(normalized).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
  if (exists && (!exists.isDirectory() || exists.isSymbolicLink() || (await readdir(normalized)).length !== 0)) fail('恢复目标必须是不存在或空的隔离目录，不能覆盖现有数据');
  return normalized;
}
function result(path: string, manifest: BackupManifest): BackupResult {
  return { path, createdAt: manifest.createdAt, schemaVersion: manifest.schemaVersion, encrypted: true, entries: manifest.entries.length, bytes: manifest.entries.reduce((total, entry) => total + entry.bytes, 0), excluded: manifest.scope.excluded };
}

export async function createEncryptedBackup(options: CreateBackupOptions): Promise<BackupResult> {
  const key = keyCopy(options.key);
  let scratch: string | undefined; let staged: string | undefined; let published: string | undefined;
  let captured: Awaited<ReturnType<typeof sidecarBuffers>> | undefined;
  try {
    const limits = bounds(options);
    if (typeof options.withMetadataSnapshot !== 'function' || !['settings-writes-paused', 'operator-declared-offline'].includes(options.consistency)) fail('备份需要明确的持久设置一致性边界');
    const dataDir = await realpath(options.dataDir); let destination = resolve(options.destination);
    if (inside(dataDir, destination)) fail('备份输出不能位于源数据目录中');
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    destination = join(await realpath(dirname(destination)), basename(destination));
    if (inside(dataDir, destination)) fail('备份输出不能通过符号链接位于源数据目录中');
    if (await lstat(destination).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; })) fail('备份目标已存在，拒绝覆盖');
    staged = await mkdtemp(join(dirname(destination), '.backup-encrypted-')); await mkdir(join(staged, 'objects'), { mode: 0o700 });
    scratch = await mkdtemp(join(tmpdir(), 'webdcc-backup-private-'));
    const snapshot = join(scratch, 'webdcc.db'); const reserved = await writableFile(snapshot); await reserved.close();
    const header: PublicHeader = { format: FORMAT, version: VERSION, cipher: 'aes-256-gcm', key: 'external-random-256-bit', archiveId: randomUUID() };
    captured = await options.withMetadataSnapshot(async () => {
      cancelled(options.signal); const before = await sidecarBuffers(dataDir);
      let after: Awaited<ReturnType<typeof sidecarBuffers>> | undefined; let retained = false;
      try {
        await options.db.backup(snapshot, { progress: progress => { cancelled(options.signal); options.onProgress?.({ phase: 'snapshot', completed: progress.totalPages - progress.remainingPages, total: progress.totalPages }); return 200; } });
        await chmod(snapshot, 0o600); after = await sidecarBuffers(dataDir);
        if (JSON.stringify(before.states) !== JSON.stringify(after.states) || before.entries.some(entry => after!.entries.find(value => value.path === entry.path)?.sha256 !== entry.sha256)) fail('持久设置在快照期间变化，备份已取消');
        // Retain for cleanup even if the caller's consistency wrapper fails.
        captured = after; retained = true; return after;
      } finally { clearBuffers(before.entries); if (after && !retained) clearBuffers(after.entries); }
    });
    const db = new Database(snapshot, { readonly: true, fileMustExist: true });
    let info: ReturnType<typeof inspectDatabase>; let entries: SourceEntry[];
    try { info = inspectDatabase(db); entries = [{ path: 'webdcc.db', source: snapshot, bytes: (await lstat(snapshot)).size }, ...databaseReferences(db, dataDir), ...captured.entries]; }
    finally { db.close(); }
    if (entries.length > limits.maxEntries || entries.reduce((total, entry) => total + entry.bytes, 0) > limits.maxBytes) fail('快照超过备份容量上限');
    const manifest: BackupManifest = { format: FORMAT, version: VERSION, createdAt: new Date().toISOString(), schemaVersion: info.schemaVersion, tableCounts: info.tableCounts, entries: [], consistency: options.consistency, sidecars: captured.states,
      scope: { database: 'unmodified-online-snapshot', cas: 'only-objects-referenced-by-snapshot-files-table', uploads: 'snapshot-received-chunks-included', credentials: 'persisted-webdcc-sidecars-encrypted', excluded: ['workspace working trees and external referenced paths', 'native homes/history/MCP/plugins/config and native OAuth credentials', 'external DSH Host state', 'server environment/token/key files', 'browser cache and unaccepted outbox', 'live processes, PTYs and in-memory-only secret answers', 'content already omitted/redacted by the original storage policy', 'unreferenced CAS/upload garbage and optional diagnostics', 'stored derived CAS paths require current fileId resolution before native admission; native outcomes must not be replayed automatically'] } };
    for (const entry of entries) {
      manifest.entries.push(await encryptEntry(header, key, entry, staged, entry.path === 'webdcc.db' ? scratch : dataDir, options.signal));
      options.onProgress?.({ phase: 'encrypt', completed: manifest.entries.length, total: entries.length });
    }
    const clear = Buffer.from(JSON.stringify(manifest));
    try {
      if (clear.length > limits.maxManifestBytes) fail('备份 manifest 超过上限');
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad(header, 'manifest'));
      await writeFile(join(staged, 'manifest.enc'), Buffer.concat([MAGIC, iv, cipher.update(clear), cipher.final(), cipher.getAuthTag()]), { mode: 0o600, flag: 'wx' });
    }
    finally { clear.fill(0); }
    await writeFile(join(staged, 'backup.json'), JSON.stringify(header) + '\n', { mode: 0o600, flag: 'wx' });
    for (const name of ['manifest.enc', 'backup.json']) { const handle = await open(join(staged, name), 'r'); try { await handle.sync(); } finally { await handle.close(); } }
    await syncDirectory(join(staged, 'objects')); await syncDirectory(staged); cancelled(options.signal);
    await inspectEncryptedBackup({ ...options, backupDir: staged, key });
    // A complete archive is published once. No incomplete directory can pass inspection.
    if (await lstat(destination).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; })) fail('备份目标已被占用，拒绝覆盖');
    await rename(staged, destination); staged = undefined; published = destination; await syncDirectory(dirname(destination));
    published = undefined;
    return result(destination, manifest);
  } catch (error) {
    if (published) { try { await rm(published, { recursive: true }); } catch { throw new BackupError('备份发布持久性未确认，需要人工验证目录', 409); } }
    if (error instanceof BackupError) throw error; throw new BackupError('备份未完成，没有发布可恢复产物', 409);
  }
  finally { key.fill(0); if (captured) clearBuffers(captured.entries); if (scratch) await rm(scratch, { recursive: true, force: true }); if (staged) await rm(staged, { recursive: true, force: true }); }
}

export async function inspectEncryptedBackup(options: { backupDir: string; key: Buffer; signal?: AbortSignal } & BackupLimits): Promise<BackupManifest> {
  const key = keyCopy(options.key); let scratch: string | undefined;
  try {
    const backupRoot = await realpath(options.backupDir); const { header, manifest } = await loadManifest(backupRoot, key, options);
    scratch = await mkdtemp(join(tmpdir(), 'webdcc-backup-inspect-'));
    for (const entry of manifest.entries) await decryptEntry(header, key, entry, backupRoot, entry.path === 'webdcc.db' || SIDECARS.some(path => path === entry.path) ? join(scratch, entry.path) : undefined, options.signal);
    clearBuffers((await sidecarBuffers(scratch)).entries);
    const db = new Database(join(scratch, 'webdcc.db'), { readonly: true, fileMustExist: true });
    try {
      const inspected = inspectDatabase(db);
      if (inspected.schemaVersion !== manifest.schemaVersion || JSON.stringify(inspected.tableCounts) !== JSON.stringify(manifest.tableCounts)) fail('数据库与 manifest 不一致');
      validateReferences(db, manifest, scratch);
    } finally { db.close(); }
    return manifest;
  } catch (error) { if (error instanceof BackupError) throw error; throw new BackupError('备份验证失败：密钥错误、内容损坏或文件缺失'); }
  finally { key.fill(0); if (scratch) await rm(scratch, { recursive: true, force: true }); }
}

export async function restoreEncryptedBackup(options: RestoreBackupOptions): Promise<BackupResult> {
  const key = keyCopy(options.key); let staged: string | undefined; let published: string | undefined;
  try {
    const backupRoot = await realpath(options.backupDir); const destination = await emptyDestination(options.destination);
    if (inside(backupRoot, destination) || inside(destination, backupRoot)) fail('恢复目录不能与备份目录重叠');
    const { header, manifest } = await loadManifest(backupRoot, key, options);
    staged = await mkdtemp(join(dirname(destination), '.restore-private-'));
    for (const entry of manifest.entries) await decryptEntry(header, key, entry, backupRoot, join(staged, entry.path), options.signal);
    const raw = new Database(join(staged, 'webdcc.db'), { readonly: true, fileMustExist: true });
    try {
      const inspected = inspectDatabase(raw);
      if (inspected.schemaVersion !== manifest.schemaVersion || JSON.stringify(inspected.tableCounts) !== JSON.stringify(manifest.tableCounts)) fail('恢复数据库与 manifest 不一致');
      validateReferences(raw, manifest, staged);
    } finally { raw.close(); }
    if (options.upgradeSchema) { const db = openDb(join(staged, 'webdcc.db')); try { inspectDatabase(db); db.pragma('wal_checkpoint(TRUNCATE)'); } finally { db.close(); } }
    await mkdir(join(staged, 'files'), { recursive: true, mode: 0o700 }); await mkdir(join(staged, 'uploads'), { recursive: true, mode: 0o700 });
    clearBuffers((await sidecarBuffers(staged)).entries); await syncTree(staged); cancelled(options.signal);
    await emptyDestination(destination); await rename(staged, destination); staged = undefined; published = destination; await syncDirectory(dirname(destination));
    published = undefined;
    return { ...result(destination, manifest), schemaVersion: options.upgradeSchema ? CURRENT_SCHEMA_VERSION : manifest.schemaVersion };
  } catch (error) {
    if (published) { try { await rm(published, { recursive: true }); } catch { throw new BackupError('恢复发布持久性未确认，需要人工验证目录', 409); } }
    if (error instanceof BackupError) throw error; throw new BackupError('恢复验证未完成，目标数据未被替换', 409);
  }
  finally { key.fill(0); if (staged) await rm(staged, { recursive: true, force: true }); }
}

/** Key generation is a separate explicit operation; the key is never put in
 * an archive, returned as JSON, or written to stdout/environment variables. */
export async function createBackupKeyFile(path: string): Promise<void> {
  const key = randomBytes(32); const destination = resolve(path); let created = false;
  try { const handle = await writableFile(destination); created = true; try { await handle.writeFile(key); await handle.sync(); } finally { await handle.close(); } await syncDirectory(dirname(destination)); }
  catch (error) { if (created) await rm(destination, { force: true }); throw error; }
  finally { key.fill(0); }
}

/** Explicit CLI input only; this opens the main DB read-only and never runs migrations. */
export function openBackupSource(file: string): Db { return new Database(file, { readonly: true, fileMustExist: true }); }
