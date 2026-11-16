import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';

export class DiagnosticReadError extends Error {
  readonly statusCode = 503;
  constructor(readonly reason: 'unavailable' | 'not-regular' | 'too-large' | 'invalid-utf8' | 'invalid-limit' = 'unavailable') { super('Diagnostic recording read failed'); this.name = 'DiagnosticReadError'; }
}

/** Read-only optional diagnostics, with the same FD boundary as the writer. */
export async function readDiagnosticText(file: string, maxBytes: number, missingAllowed = false): Promise<string | undefined> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new DiagnosticReadError('invalid-limit');
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) throw new DiagnosticReadError('not-regular');
    if (info.size > maxBytes) throw new DiagnosticReadError('too-large');
    const chunks: Buffer[] = []; let used = 0;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
    while (used <= maxBytes) {
      const next = await handle.read(buffer, 0, Math.min(buffer.length, maxBytes + 1 - used), used);
      if (next.bytesRead === 0) break;
      used += next.bytesRead;
      if (used > maxBytes) throw new DiagnosticReadError('too-large');
      chunks.push(Buffer.from(buffer.subarray(0, next.bytesRead)));
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, used)); }
    catch { throw new DiagnosticReadError('invalid-utf8'); }
  } catch (error) {
    if (missingAllowed && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof DiagnosticReadError) throw error;
    throw new DiagnosticReadError();
  } finally { await handle?.close().catch(() => undefined); }
}
