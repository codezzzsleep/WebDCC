import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface DiagnosticWriteLimits { maxFileBytes?: number; maxQueuedBytes?: number }
/** Local writer bounds. Cross-process aggregate quotas are a separate concern. */
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
  pendingFor(file: string): Promise<void> | undefined { return this.queues.get(file); }
  get pendingBytes(): number { return this.queuedBytes; }
  write(file: string, text: string, mode: 'append' | 'replace' = 'append', onError: (error: Error) => void = () => undefined): Promise<void> {
    const report = (message: string): void => { try { onError(new Error(message)); } catch { /* diagnostic error handler */ } };
    const bytes = Buffer.byteLength(text);
    if (this.queuedBytes + bytes > this.maxQueuedBytes) { report('Diagnostic write queue limit reached'); return Promise.resolve(); }
    this.queuedBytes += bytes;
    const work = (this.queues.get(file) ?? Promise.resolve()).then(async () => {
      const previous = mode === 'replace' ? 0 : await stat(file).then(info => info.size).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return 0; throw error; });
      if (previous + bytes > this.maxFileBytes) throw new Error('Diagnostic file size limit reached');
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      if (mode === 'append') await appendFile(file, text, { mode: 0o600 });
      else await writeFile(file, text, { mode: 0o600 });
    }).catch((error: unknown) => report(error instanceof Error ? error.message : 'Diagnostic write failed')).finally(() => {
      this.queuedBytes -= bytes;
      if (this.queues.get(file) === work) this.queues.delete(file);
    });
    this.queues.set(file, work);
    return work;
  }
  async flush(): Promise<void> { while (this.queues.size > 0) await Promise.all([...this.queues.values()]); }
}
