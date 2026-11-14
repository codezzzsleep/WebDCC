import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export interface NativeOutputChunk { seq: number; data: string }

/** The replay window, disk transcript, and socket buffers have independent caps. */
export class NativeTerminalOutput {
  private chunks: NativeOutputChunk[] = [];
  private bytes = 0;
  private sequence = 0;
  private logBytes = 0;
  private fd?: number;
  private directory?: string;
  readonly logPath?: string;
  truncated = false;
  constructor(readonly replayBytes = 256 * 1024, root?: string, readonly maxLogBytes = 32 * 1024 * 1024) {
    if (root !== undefined) {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      this.directory = mkdtempSync(join(root, 'terminal-'));
      this.logPath = join(this.directory, 'output.txt');
      this.fd = openSync(this.logPath, 'wx', 0o600);
    }
  }
  append(data: string): NativeOutputChunk {
    const chunk = { seq: ++this.sequence, data };
    const size = Buffer.byteLength(data);
    this.chunks.push(chunk);
    this.bytes += size;
    while (this.bytes > this.replayBytes && this.chunks.length > 0) {
      this.bytes -= Buffer.byteLength(this.chunks.shift()!.data);
    }
    if (this.fd !== undefined) {
      const remaining = this.maxLogBytes - this.logBytes;
      if (size > remaining) {
        // Never write a partial UTF-8 chunk. The caller terminates on this cap.
        this.truncated = true;
      } else if (!this.truncated) {
        const bytes = Buffer.from(data);
        let offset = 0;
        try {
          while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset, bytes.length - offset);
          this.logBytes += size;
        } catch { this.truncated = true; }
      }
    }
    return chunk;
  }
  snapshot(afterSeq = 0): { chunks: NativeOutputChunk[]; firstSeq: number; lastSeq: number; gap: boolean } {
    const firstSeq = this.chunks[0]?.seq ?? this.sequence + 1;
    return { chunks: this.chunks.filter(chunk => chunk.seq > afterSeq), firstSeq, lastSeq: this.sequence, gap: afterSeq < firstSeq - 1 };
  }
  metrics(): { replayBytes: number; logBytes: number; logFiles: number } {
    return { replayBytes: this.bytes, logBytes: this.logBytes, logFiles: this.directory === undefined ? 0 : 1 };
  }
  seal(): void { if (this.fd !== undefined) { closeSync(this.fd); this.fd = undefined; } }
  dispose(): void {
    this.seal();
    if (this.directory !== undefined) rmSync(this.directory, { recursive: true, force: true });
    this.directory = undefined;
    this.chunks = [];
    this.bytes = 0;
  }
}
