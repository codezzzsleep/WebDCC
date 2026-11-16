import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

export interface DiagnosticWriteLimits { maxFileBytes?: number; maxQueuedBytes?: number }
interface Lease { write(file: string, text: string, mode: string, limit: number): Promise<void>; release(): Promise<void> }
interface DirectoryQueue { tail: Promise<void>; lease?: Lease; failure?: Error }
const directories = new Map<string, DirectoryQueue>();

// The owned helper performs the whole check/write while it holds the OS lock.
// A parent exit closes stdin; the helper finishes any current synchronous write
// and exits. The kernel releases the lock, including after a killed helper.
const helper = `
const fs = require('node:fs');
const lines = require('node:readline').createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ ready: true }) + '\\n');
lines.on('line', line => {
  let command;
  try { command = JSON.parse(line); }
  catch { process.stdout.write(JSON.stringify({ error: 'Invalid diagnostic helper command' }) + '\\n'); return; }
  try {
    let previous = 0;
    if (command.mode === 'append') {
      try { previous = fs.statSync(command.file).size; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (previous + Buffer.byteLength(command.text) > command.limit) throw new Error('Diagnostic file size limit reached');
    if (command.mode === 'append') fs.appendFileSync(command.file, command.text, { mode: 0o600 });
    else fs.writeFileSync(command.file, command.text, { mode: 0o600 });
    process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
  } catch (error) { process.stdout.write(JSON.stringify({ error: error.message }) + '\\n'); }
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
          write: (file, text, mode, limit) => new Promise<void>((resolveWrite, rejectWrite) => {
            if (exitError !== undefined) { rejectWrite(exitError); return; }
            pending = { resolve: resolveWrite, reject: rejectWrite };
            child.stdin.write(`${JSON.stringify({ file, text, mode, limit })}\n`);
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

/** File limits are shared by cooperating writers in one directory. Aggregate
 * disk quotas are separate. flock is required for optional diagnostic writes. */
export class DiagnosticFileWriter {
  private readonly queues = new Map<string, Promise<void>>();
  private queuedBytes = 0;
  private readonly maxFileBytes: number;
  private readonly maxQueuedBytes: number;
  constructor(limits: DiagnosticWriteLimits = {}) {
    this.maxFileBytes = limits.maxFileBytes ?? 64 * 1024 * 1024;
    this.maxQueuedBytes = limits.maxQueuedBytes ?? 32 * 1024 * 1024;
    if (![this.maxFileBytes, this.maxQueuedBytes].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid diagnostic write limits');
  }
  pendingFor(file: string): Promise<void> | undefined { return this.queues.get(resolve(file)); }
  get pendingBytes(): number { return this.queuedBytes; }
  write(file: string, text: string, mode: 'append' | 'replace' = 'append', onError: (error: Error) => void = () => undefined): Promise<void> {
    const report = (message: string): void => { try { onError(new Error(message)); } catch { /* diagnostic error handler */ } };
    const bytes = Buffer.byteLength(text);
    if (this.queuedBytes + bytes > this.maxQueuedBytes) { report('Diagnostic write queue limit reached'); return Promise.resolve(); }
    this.queuedBytes += bytes;
    file = resolve(file);
    const directory = dirname(file);
    const queue = directories.get(directory) ?? { tail: Promise.resolve() };
    directories.set(directory, queue);
    const work = queue.tail.then(async () => {
      if (queue.failure !== undefined) throw queue.failure;
      if (queue.lease === undefined) {
        try { queue.lease = await acquire(directory); }
        catch (error) { queue.failure = error instanceof Error ? error : new Error('Diagnostic file lock unavailable'); throw queue.failure; }
      }
      await queue.lease.write(file, text, mode, this.maxFileBytes);
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
