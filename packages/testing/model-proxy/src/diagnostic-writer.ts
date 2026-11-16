import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

export interface DiagnosticWriteLimits { maxFileBytes?: number; maxQueuedBytes?: number; maxActiveQueuedBytes?: number; maxDirectoryBytes?: number }
interface Lease { write(file: string, text: string, mode: string, limit: number, directoryLimit: number): Promise<void>; prune(cutoff: number): Promise<void>; coverage(message: string): Promise<void>; release(): Promise<void> }
interface DirectoryQueue { tail: Promise<void>; lease?: Lease; failure?: Error }
const directories = new Map<string, DirectoryQueue>();
interface WriteQueueBudget { used: number; maximum: number; coverageBytes: number }
const budgetKey = Symbol.for('webdcc.diagnostic.write.queue.budget');
const budgets = globalThis as unknown as Record<symbol, WriteQueueBudget>;
const writeQueueBudget = budgets[budgetKey] ??= { used: 0, maximum: 64 * 1024 * 1024, coverageBytes: 0 };
const COVERAGE_QUEUE_BYTES = 4096;
const QUEUE_LIMIT_ERROR = 'Diagnostic active write queue limit reached';
export function configureDiagnosticWriteQueueBudget(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid active diagnostic write queue budget');
  if (writeQueueBudget.used > bytes) throw new Error('Pending diagnostic writes exceed the requested budget');
  writeQueueBudget.maximum = bytes;
}
export function diagnosticWriteQueueBytes(): { queued: number; coverage: number } { return { queued: writeQueueBudget.used, coverage: writeQueueBudget.coverageBytes }; }

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
function recordQuotaFailure(file, message = quotaMessage) {
  const marker = path.join(path.dirname(file), markerName);
  let failures = 0, descriptor, errors = [];
  try {
    descriptor = fs.openSync(marker, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    const info = fs.fstatSync(descriptor);
    if (info.isFile() && info.size <= 4096) {
      const buffer = Buffer.alloc(info.size), count = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      const value = JSON.parse(buffer.subarray(0, count).toString('utf8'));
      if (Number.isSafeInteger(value.failures) && value.failures >= 0) failures = value.failures;
      if (Array.isArray(value.errors)) errors = value.errors.filter(error => typeof error === 'string' && error.length <= 256).slice(0, 8);
    }
  } catch { /* first or unavailable marker */ }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  writeTarget(marker, JSON.stringify({ version: 1, incomplete: true, scope: 'directory',
    failures: Math.min(Number.MAX_SAFE_INTEGER, failures + 1), updatedAt: new Date().toISOString(), errors: [...new Set([...errors, message])] }), 'replace', 4096);
}
function pruneExpired(directory, cutoff) {
  for (const name of fs.readdirSync(directory)) {
    if (name !== markerName && !name.endsWith('.jsonl') && !/^(context|coverage)-.*\\.json$/.test(name) && !/^model-.*\\.coverage\\.json$/.test(name)) continue;
    const file = path.join(directory, name);
    try {
      const info = fs.lstatSync(file);
      if (info.isFile() && info.mtimeMs < cutoff) fs.unlinkSync(file);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
const lines = require('node:readline').createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ ready: true }) + '\\n');
lines.on('line', line => {
  let command;
  try { command = JSON.parse(line); }
  catch { process.stdout.write(JSON.stringify({ error: 'Invalid diagnostic helper command' }) + '\\n'); return; }
  try {
    if (command.op === 'prune') pruneExpired(command.directory, command.cutoff);
    else if (command.op === 'coverage') recordQuotaFailure(path.join(command.directory, markerName), command.message);
    else writeTarget(command.file, command.text, command.mode, command.limit, command.directoryLimit);
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
        const send = (command: object) => new Promise<void>((resolveCommand, rejectCommand) => {
          if (exitError !== undefined) { rejectCommand(exitError); return; }
          pending = { resolve: resolveCommand, reject: rejectCommand };
          child.stdin.write(`${JSON.stringify(command)}\n`);
        });
        ready({
          write: (file, text, mode, limit, directoryLimit) => send({ file, text, mode, limit, directoryLimit }),
          prune: cutoff => send({ op: 'prune', directory, cutoff }),
          coverage: message => send({ op: 'coverage', directory, message }),
          release: async () => { child.stdin.end(); await closed; lines.close(); },
        });
      } else {
        const current = pending; pending = undefined;
        if (message.ok) current?.resolve(); else current?.reject(new Error(message.error ?? 'Diagnostic write failed'));
      }
    });
  });
}

function directoryOperation(directory: string, operation: (lease: Lease) => Promise<void>): Promise<void> {
  directory = resolve(directory);
  const queue = directories.get(directory) ?? { tail: Promise.resolve() };
  directories.set(directory, queue);
  let failure: Error | undefined;
  const work = queue.tail.then(async () => {
    if (queue.failure !== undefined) throw queue.failure;
    if (queue.lease === undefined) {
      try { queue.lease = await acquire(directory); }
      catch (error) { queue.failure = error instanceof Error ? error : new Error('Diagnostic file lock unavailable'); throw queue.failure; }
    }
    await operation(queue.lease);
  }).catch((error: unknown) => { failure = error instanceof Error ? error : new Error('Diagnostic directory operation failed'); }).finally(async () => {
    if (queue.tail === work) {
      const lease = queue.lease; queue.lease = undefined;
      await lease?.release();
      if (queue.tail === work) directories.delete(directory);
    }
  });
  queue.tail = work;
  return work.then(() => { if (failure !== undefined) throw failure; });
}

/** File and directory byte limits are shared by cooperating writers. Capture
 * memory and totals across directories remain separate. flock is required. */
export class DiagnosticFileWriter {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly maintenance = new Set<Promise<void>>();
  private queuedBytes = 0;
  private readonly maxFileBytes: number;
  private readonly maxQueuedBytes: number;
  private readonly maxDirectoryBytes: number;
  constructor(limits: DiagnosticWriteLimits = {}) {
    this.maxFileBytes = limits.maxFileBytes ?? 64 * 1024 * 1024;
    this.maxQueuedBytes = limits.maxQueuedBytes ?? 32 * 1024 * 1024;
    this.maxDirectoryBytes = limits.maxDirectoryBytes ?? 512 * 1024 * 1024;
    if (![this.maxFileBytes, this.maxQueuedBytes, this.maxDirectoryBytes].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid diagnostic write limits');
    if (limits.maxActiveQueuedBytes !== undefined) configureDiagnosticWriteQueueBudget(limits.maxActiveQueuedBytes);
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
  /** Expiration shares the write lease: stats are read only after preceding
   * cooperating writers finish, and unlink cannot race their next write. */
  pruneExpired(directory: string, cutoff: number): Promise<void> {
    if (!Number.isSafeInteger(cutoff)) throw new Error('Invalid diagnostic retention cutoff');
    const work = directoryOperation(directory, lease => lease.prune(cutoff)).finally(() => { this.maintenance.delete(work); });
    this.maintenance.add(work);
    return work;
  }
  private reportQueueOverflow(directory: string, report: (message: string) => void): Promise<void> {
    const bytes = Buffer.byteLength(QUEUE_LIMIT_ERROR);
    if (writeQueueBudget.coverageBytes + bytes > COVERAGE_QUEUE_BYTES) {
      report(`${QUEUE_LIMIT_ERROR}; coverage queue limit reached`); return Promise.resolve();
    }
    writeQueueBudget.coverageBytes += bytes;
    const work = directoryOperation(directory, lease => lease.coverage(QUEUE_LIMIT_ERROR))
      .catch(() => report(`${QUEUE_LIMIT_ERROR}; coverage marker unavailable`)).finally(() => {
        writeQueueBudget.coverageBytes -= bytes; this.maintenance.delete(work);
      });
    this.maintenance.add(work);
    return work;
  }
  private schedule(file: string, text: string, mode: 'append' | 'replace', fileLimit: number, onError: (error: Error) => void): Promise<void> {
    const report = (message: string): void => { try { onError(new Error(message)); } catch { /* diagnostic error handler */ } };
    file = resolve(file);
    if (file === join(dirname(file), '.wdcc-diagnostic-quota.json')) { report('Reserved diagnostic coverage path'); return Promise.resolve(); }
    const bytes = Buffer.byteLength(text);
    if (this.queuedBytes + bytes > this.maxQueuedBytes) { report('Diagnostic write queue limit reached'); return Promise.resolve(); }
    if (writeQueueBudget.used + bytes > writeQueueBudget.maximum) {
      report(QUEUE_LIMIT_ERROR); return this.reportQueueOverflow(dirname(file), report);
    }
    this.queuedBytes += bytes;
    writeQueueBudget.used += bytes;
    const work = directoryOperation(dirname(file), lease => lease.write(file, text, mode, fileLimit, this.maxDirectoryBytes))
      .catch((error: unknown) => report(error instanceof Error ? error.message : 'Diagnostic write failed')).finally(() => {
      this.queuedBytes -= bytes;
      writeQueueBudget.used -= bytes;
      if (this.queues.get(file) === work) this.queues.delete(file);
    });
    this.queues.set(file, work);
    return work;
  }
  async flush(): Promise<void> { while (this.queues.size > 0 || this.maintenance.size > 0) await Promise.all([...this.queues.values(), ...this.maintenance]); }
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
