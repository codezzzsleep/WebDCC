import type { NativeStdioCaptureMetadata, TraceFrame } from '@webdcc/protocol';

export type ClaudeStdioCaptureMetadata = NativeStdioCaptureMetadata;
export interface ClaudeStdioEnvelope { frame: Record<string, unknown>; stdio: ClaudeStdioCaptureMetadata }
export interface ClaudeStdioCaptureOptions {
  record(frame: TraceFrame<ClaudeStdioEnvelope>): void;
  maxLineBytes?: number;
}
export interface ClaudeStdioCaptureState { enabled: boolean; failed: boolean }

/** Bounded observer of bytes already travelling through a stream. The recorder
 * sees parsed JSON through the existing sensitive NativeFrameSink policy;
 * malformed/oversize/stderr content is never copied into diagnostic strings
 * or hashes. It cannot interpret control responses or change transport bytes. */
export class ClaudeStdioLines {
  private readonly pieces: Buffer[] = [];
  private bytes = 0;
  private line = 0;
  private oversize = false;
  private ended = false;
  private readonly maxLineBytes: number;

  constructor(private readonly stream: ClaudeStdioCaptureMetadata['stream'], private readonly emit: (envelope: ClaudeStdioEnvelope) => void, maxLineBytes = 256 * 1024) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 16 || maxLineBytes > 1024 * 1024) throw new Error('Claude stdio capture limit must be 16 bytes to 1 MiB');
    this.maxLineBytes = maxLineBytes;
  }
  feed(chunk: Buffer): void {
    if (this.ended) return;
    for (let offset = 0; offset < chunk.length;) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline + 1;
      const part = chunk.subarray(offset, end);
      this.bytes += part.length;
      if (this.bytes > this.maxLineBytes) {
        const firstOverflow = !this.oversize;
        this.oversize = true; this.pieces.length = 0;
        // An invalid peer may never send LF/EOF. Surface missing coverage as soon
        // as its line exceeds the cap; a later terminator records the final size.
        if (firstOverflow && newline < 0) this.safeEmit({ frame: { omitted: 'stdio-line-size-limit' }, stdio: {
          stream: this.stream, line: this.line + 1, byteLength: this.bytes, coverage: 'oversize', terminated: false,
        } });
      }
      // stderr is deliberately metadata-only, even when it happens to look like JSON.
      if (!this.oversize && this.stream !== 'stderr') this.pieces.push(Buffer.from(part));
      if (newline >= 0) this.complete(true);
      offset = end;
    }
  }
  finish(interrupted = false): void {
    if (this.ended) return;
    this.ended = true;
    if (this.bytes > 0) this.complete(false, interrupted);
    else if (interrupted) this.safeEmit({ frame: { omitted: 'stdio-closed-before-eof' }, stdio: { stream: this.stream, line: ++this.line, byteLength: 0, coverage: 'incomplete', terminated: false } });
  }
  private complete(terminated: boolean, interrupted = false): void {
    let coverage: ClaudeStdioCaptureMetadata['coverage'] = 'complete';
    let frame: Record<string, unknown> = {};
    if (interrupted) { coverage = 'incomplete'; frame = { omitted: 'stdio-closed-before-eof' }; }
    else if (this.oversize) { coverage = 'oversize'; frame = { omitted: 'stdio-line-size-limit' }; }
    else if (this.stream === 'stderr') { coverage = 'unstructured'; frame = { omitted: 'unstructured-stderr' }; }
    else {
      let text: string | undefined;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(this.pieces, this.bytes)); }
      catch { coverage = 'invalid-utf8'; frame = { omitted: 'invalid-utf8' }; }
      if (text !== undefined) try {
        const parsed: unknown = JSON.parse(text);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) frame = parsed as Record<string, unknown>;
        else { coverage = 'non-object'; frame = { omitted: 'non-object-json' }; }
      } catch { coverage = terminated ? 'invalid-json' : 'incomplete'; frame = { omitted: terminated ? 'invalid-json' : 'unterminated-invalid-json' }; }
    }
    const envelope = { frame, stdio: { stream: this.stream, line: ++this.line, byteLength: this.bytes, coverage, terminated } };
    this.pieces.length = 0; this.bytes = 0; this.oversize = false;
    this.safeEmit(envelope);
  }
  private safeEmit(envelope: ClaudeStdioEnvelope): void {
    try { this.emit(envelope); } catch { /* The transport remains byte-preserving even when its observer fails. */ }
  }
}
