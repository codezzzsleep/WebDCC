import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';

export const MAX_NATIVE_CONTEXT_BYTES = 64 * 1024;
export interface NativeDiagnosticContext { value?: unknown; error?: 'unavailable' | 'not-regular' | 'too-large' | 'invalid-json' }

/** Optional attribution never waits on a special file or parses a cut body. */
export async function readNativeDiagnosticContext(file: string): Promise<NativeDiagnosticContext> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) return { error: 'not-regular' };
    if (info.size > MAX_NATIVE_CONTEXT_BYTES) return { error: 'too-large' };
    // Read at most one byte beyond the limit, even if a regular file grows
    // after stat. The descriptor stays the authority throughout the read.
    const bytes = Buffer.allocUnsafe(MAX_NATIVE_CONTEXT_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const next = await handle.read(bytes, used, bytes.length - used, used);
      if (next.bytesRead === 0) break;
      used += next.bytesRead;
    }
    if (used > MAX_NATIVE_CONTEXT_BYTES) return { error: 'too-large' };
    try { return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used))) as unknown }; }
    catch { return { error: 'invalid-json' }; }
  } catch { return { error: 'unavailable' }; }
  finally { await handle?.close().catch(() => undefined); }
}
