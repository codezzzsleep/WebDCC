import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

export interface DiagnosticWriteLimits { maxFileBytes?: number; maxQueuedBytes?: number; maxDirectoryBytes?: number }
interface Lease { write(file: string, text: string, mode: string, limit: number, directoryLimit: number): Promise<void>; release(): Promise<void> }
interface DirectoryQueue { tail: Promise<void>; lease?: Lease; failure?: Error }
const directories = new Map<string, DirectoryQueue>();

// The owned helper performs the whole check/write while it holds the OS lock.
// A parent exit closes stdin; the helper finishes any current synchronous write
// and exits. The kernel releases the lock, including after a killed helper.
const helper = `
const fs = require('node:fs');
const path = require('node:path');
const markerName = '.wdcc-diagnostic-quota.json';
const quotaMessage = 'Diagnostic directory size limit reached';
function fileSize(file) {
  try { const info = fs.lstatSync(file); if (!info.isFile()) throw new Error('Diagnostic target must be a regular file'); return info.size; }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}
function directorySize(directory) {
  let bytes = 0;
  for (const name of fs.readdirSync(directory)) {
    try { const info = fs.lstatSync(path.join(directory, name)); if (info.isFile()) bytes += name === markerName ? Math.max(0, info.size - 4096) : info.size; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return bytes;
}
function writeTarget(file, text, mode, limit, directoryLimit) {
  const bytes = Buffer.byteLength(text);
  if (bytes > limit) throw new Error('Diagnostic file size limit reached');
  const previous = fileSize(file);
  const growth = mode === 'append' ? bytes : bytes - previous;
  if (directoryLimit !== undefined && directorySize(path.dirname(file)) + growth > directoryLimit) throw new Error(quotaMessage);
  let descriptor;
  try {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW
      | (mode === 'append' ? fs.constants.O_APPEND : 0);
    try { descriptor = fs.openSync(file, flags, 0o600); }
    catch (error) {
      if (error.code === 'ENXIO' || error.code === 'ELOOP') throw new Error('Diagnostic target must be a regular file');
      throw error;
    }
    const target = fs.fstatSync(descriptor);
    if (!target.isFile()) throw new Error('Diagnostic target must be a regular file');
    const current = () => {
      const named = fs.lstatSync(file);
      if (!named.isFile() || named.dev !== target.dev || named.ino !== target.ino) throw new Error('Diagnostic target changed during write');
    };
    current();
    const projected = mode === 'append' ? target.size + bytes : bytes;
    if (projected > limit) throw new Error('Diagnostic file size limit reached');
    if (directoryLimit !== undefined && directorySize(path.dirname(file)) - target.size + projected > directoryLimit) throw new Error(quotaMessage);
    if (mode !== 'append') fs.ftruncateSync(descriptor, 0);
    fs.writeFileSync(descriptor, text); current();
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
function recordQuotaFailure(file) {
  const marker = path.join(path.dirname(file), markerName);
  let failures = 0, descriptor;
  try {
    descriptor = fs.openSync(marker, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    const info = fs.fstatSync(descriptor);
    if (info.isFile() && info.size <= 4096) {
      const buffer = Buffer.alloc(info.size), count = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      const value = JSON.parse(buffer.subarray(0, count).toString('utf8'));
      if (Number.isSafeInteger(value.failures) && value.failures >= 0) failures = value.failures;
    }
  } catch { /* first or unavailable marker */ }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  writeTarget(marker, JSON.stringify({ version: 1, incomplete: true, scope: 'directory',
    failures: Math.min(Number.MAX_SAFE_INTEGER, failures + 1), updatedAt: new Date().toISOString(), errors: [quotaMessage] }), 'replace', 4096);
}
const lines = require('node:readline').createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ ready: true }) + '\\n');
lines.on('line', line => {
  let command;
  try { command = JSON.parse(line); }
  catch { process.stdout.write(JSON.stringify({ error: 'Invalid diagnostic helper command' }) + '\\n'); return; }
  try {
    writeTarget(command.file, command.text, command.mode, command.limit, command.directoryLimit);
    process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
  } catch (error) {
    let message = error.message;
    if (message === quotaMessage) { try { recordQuotaFailure(command.file); } catch { message += '; coverage marker unavailable'; } }
    process.stdout.write(JSON.stringify({ error: message }) + '\\n');
  }
});
lines.on('close', () => process.exit(0));
`;

async function acquire(directory: string): Promise<Lease> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockFile = join(directory, '.wdcc-diagnostic-writer.lock');
  const handle = await open(lockFile, 'a', 0o600); await handle.close();
  return new Promise((ready, reject) => {
    const child = spawn('flock', ['-x', '-w', '1', lockFile, process.execPath, '-e', helper], { stdio: ['pipe', 'pipe', 'ignore'] });
    let initialized = false;
    let exitError: Error | undefined;
    let pending: { resolve(): void; reject(error: Error): void } | undefined;
    const closed = new Promise<void>(done => child.once('close', () => done()));
    const failed = (error: Error) => { exitError = error; if (!initialized) reject(error); pending?.reject(error); pending = undefined; };
    child.on('error', () => failed(new Error('Diagnostic file lock unavailable')));
    child.on('close', () => failed(new Error('Diagnostic file lock helper exited')));
    child.stdin.on('error', () => failed(new Error('Diagnostic file lock helper input closed')));
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let message: { ready?: boolean; ok?: boolean; error?: string };
      try { message = JSON.parse(line) as typeof message; }
      catch { failed(new Error('Invalid diagnostic helper acknowledgement')); return; }
      if (message.ready && !initialized) {
        initialized = true;
        ready({
          write: (file, text, mode, limit, directoryLimit) => new Promise<void>((resolveWrite, rejectWrite) => {
            if (exitError !== undefined) { rejectWrite(exitError); return; }
            pending = { resolve: resolveWrite, reject: rejectWrite };
            child.stdin.write(`${JSON.stringify({ file, text, mode, limit, directoryLimit })}\n`);
          }),
          release: async () => { child.stdin.end(); await closed; lines.close(); },
        });
      } else {
        const current = pending; pending = undefined;
        if (message.ok) current?.resolve(); else current?.reject(new Error(message.error ?? 'Diagnostic write failed'));
      }
    });
  });
}

/** File and directory byte limits are shared by cooperating writers. Capture
 * memory and totals across directories remain separate. flock is required. */
export class DiagnosticFileWriter {
  private readonly queues = new Map<string, Promise<void>>();
  private queuedBytes = 0;
  private readonly maxFileBytes: number;
  private readonly maxQueuedBytes: number;
  private readonly maxDirectoryBytes: number;
  constructor(limits: DiagnosticWriteLimits = {}) {
    this.maxFileBytes = limits.maxFileBytes ?? 64 * 1024 * 1024;
    this.maxQueuedBytes = limits.maxQueuedBytes ?? 32 * 1024 * 1024;
    this.maxDirectoryBytes = limits.maxDirectoryBytes ?? 512 * 1024 * 1024;
    if (![this.maxFileBytes, this.maxQueuedBytes, this.maxDirectoryBytes].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid diagnostic write limits');
  }
  pendingFor(file: string): Promise<void> | undefined { return this.queues.get(resolve(file)); }
  get pendingBytes(): number { return this.queuedBytes; }
  write(file: string, text: string, mode: 'append' | 'replace' = 'append', onError: (error: Error) => void = () => undefined): Promise<void> {
    return this.schedule(file, text, mode, this.maxFileBytes, onError);
  }
  /** Small failure records count toward the directory budget. Only the fixed
   * directory quota marker has a separate 4 KiB reserve. */
  writeCoverage(file: string, text: string, onError: (error: Error) => void = () => undefined): Promise<void> {
    return this.schedule(file, text, 'replace', 64 * 1024, onError);
  }
  private schedule(file: string, text: string, mode: 'append' | 'replace', fileLimit: number, onError: (error: Error) => void): Promise<void> {
    const report = (message: string): void => { try { onError(new Error(message)); } catch { /* diagnostic error handler */ } };
    file = resolve(file);
    if (file === join(dirname(file), '.wdcc-diagnostic-quota.json')) { report('Reserved diagnostic coverage path'); return Promise.resolve(); }
    const bytes = Buffer.byteLength(text);
    if (this.queuedBytes + bytes > this.maxQueuedBytes) { report('Diagnostic write queue limit reached'); return Promise.resolve(); }
    this.queuedBytes += bytes;
    const directory = dirname(file);
    const queue = directories.get(directory) ?? { tail: Promise.resolve() };
    directories.set(directory, queue);
    const work = queue.tail.then(async () => {
      if (queue.failure !== undefined) throw queue.failure;
      if (queue.lease === undefined) {
        try { queue.lease = await acquire(directory); }
        catch (error) { queue.failure = error instanceof Error ? error : new Error('Diagnostic file lock unavailable'); throw queue.failure; }
      }
      await queue.lease.write(file, text, mode, fileLimit, this.maxDirectoryBytes);
    }).catch((error: unknown) => report(error instanceof Error ? error.message : 'Diagnostic write failed')).finally(async () => {
      if (queue.tail === work) {
        const lease = queue.lease; queue.lease = undefined;
        await lease?.release();
        if (queue.tail === work) directories.delete(directory);
      }
      this.queuedBytes -= bytes;
      if (this.queues.get(file) === work) this.queues.delete(file);
    });
    queue.tail = work;
    this.queues.set(file, work);
    return work;
  }
  async flush(): Promise<void> { while (this.queues.size > 0) await Promise.all([...this.queues.values()]); }
}

/** A bounded metadata read cannot follow a link or wait on a FIFO. */
export async function readDiagnosticDirectoryCoverage(directory: string): Promise<{ incomplete: true; errors: string[] } | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const unavailable = { incomplete: true as const, errors: ['Diagnostic directory coverage unavailable'] };
  try {
    handle = await open(join(directory, '.wdcc-diagnostic-quota.json'), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > 4096) return unavailable;
    const buffer = Buffer.alloc(info.size); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as { incomplete?: boolean; scope?: string; errors?: unknown };
    if (value.incomplete !== true || value.scope !== 'directory' || !Array.isArray(value.errors)) return unavailable;
    return { incomplete: true, errors: value.errors.filter((item): item is string => typeof item === 'string').slice(0, 8).map(error => error.slice(0, 128)) };
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : unavailable; }
  finally { await handle?.close().catch(() => undefined); }
}
