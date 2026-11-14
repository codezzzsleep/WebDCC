import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DiagnosticFileWriter } from './diagnostic-writer.js';

it('NP-14 limits queued writes and files without throwing into the native transport', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-diagnostic-quota-'));
  const file = join(root, 'trace.jsonl');
  const errors: string[] = [];
  const onError = (error: Error) => errors.push(error.message);
  try {
    const writer = new DiagnosticFileWriter({ maxQueuedBytes: 6, maxFileBytes: 8 });
    const first = writer.write(file, 'first', 'append', onError);
    expect(writer.pendingBytes).toBe(5);
    await writer.write(file, 'second', 'append', onError);
    await first;
    expect(errors).toEqual(['Diagnostic write queue limit reached']);
    expect(await readFile(file, 'utf8')).toBe('first');
    await writer.write(file, 'too much', 'append', onError);
    await writer.write(file, 'more', 'append', onError);
    await writer.flush();
    expect(errors).toContain('Diagnostic file size limit reached');
    expect(await readFile(file, 'utf8')).toBe('first');
    expect(writer.pendingBytes).toBe(0);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});
