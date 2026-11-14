import { chmod, mkdir, readFile, writeFile, readdir, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AdapterEvent, AgentId, TraceFrame, TraceSink } from '@webdcc/protocol';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import type { FileOperation } from './workspace-files.js';
import { DiagnosticFileWriter, redactDiagnosticValue, type DiagnosticWriteLimits, type ModelProxyEvent } from '@webdcc/model-proxy';

export interface InteractionContext { sessionId: string; agent: AgentId; workspaceId: string; cwd: string; nativeId?: string; turnId?: string | null; model?: string; providerId?: string | null; }
export interface InteractionRecord { version: 1; runId: string; seq: number; at: string; elapsedMs: number; source: string; channel: string; direction?: 'in' | 'out'; context?: InteractionContext; value: unknown; }
export interface RecordingSummary { records: number; nativeFrames: number; modelRequests: number; fileOperations: number; incomplete: boolean; errors: string[]; }
function key(id: string): string { return encodeURIComponent(id); }
function isInference(value: unknown): boolean {
  const event = value as { path?: string; url?: string; value?: { path?: string; url?: string } };
  const path = event.value?.path ?? event.value?.url ?? event.path ?? event.url ?? '';
  return /\/(responses|messages|chat\/completions|completions)(?:[/?#]|$)/.test(path);
}

/** Private, correlated side-channel. Recording failures remain visible without
 * changing native Agent inputs, events, or command acknowledgements. */
export class InteractionRecorder {
  readonly directory: string;
  private readonly runId = randomUUID();
  private readonly begun = performance.now();
  private readonly contexts = new Map<string, InteractionContext>();
  private readonly summaries = new Map<string, RecordingSummary>();
  private readonly secrets = new Set<string>();
  private readonly writer: DiagnosticFileWriter;
  private readonly retentionMs: number;
  readonly captureLimits: { maxCaptureBytes?: number; maxCaptureChunks?: number };
  private nextPruneAt = 0;
  private pruning?: Promise<void>;
  private seq = 0;
  constructor(dataDir: string, limits: DiagnosticWriteLimits & { retentionMs?: number; maxCaptureBytes?: number; maxCaptureChunks?: number } = {}) {
    this.directory = join(dataDir, 'traces'); this.writer = new DiagnosticFileWriter(limits); this.retentionMs = limits.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
    this.captureLimits = { maxCaptureBytes: limits.maxCaptureBytes, maxCaptureChunks: limits.maxCaptureChunks };
    if (!Number.isSafeInteger(this.retentionMs) || this.retentionMs < 1) throw new Error('Invalid diagnostic retention');
  }
  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 }); await chmod(this.directory, 0o700);
    await this.pruneExpired();
  }
  private async pruneExpired(): Promise<void> {
    this.nextPruneAt = Date.now() + 60 * 60 * 1000;
    const cutoff = Date.now() - this.retentionMs;
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith('.jsonl') && !/^(context|coverage)-.*\.json$/.test(name) && !/^model-.*\.coverage\.json$/.test(name)) continue;
      const file = join(this.directory, name); const info = await lstat(file);
      if (info.isFile() && info.mtimeMs < cutoff) await rm(file);
    }
  }
  addSecret(value: string | undefined): void { if (value !== undefined && value.length > 0) this.secrets.add(value); }
  bind(context: InteractionContext): void { this.contexts.set(context.sessionId, { ...this.contexts.get(context.sessionId), ...context }); this.persistContext(context.sessionId); }
  nativeId(sessionId: string, nativeId: string): void { const context = this.contexts.get(sessionId); if (context !== undefined) { context.nativeId = nativeId; this.persistContext(sessionId); } }
  turn(sessionId: string, turnId: string | null): void { const context = this.contexts.get(sessionId); if (context !== undefined) { context.turnId = turnId; this.persistContext(sessionId); } }
  async turnContext(sessionId: string, turnId: string | null): Promise<void> {
    this.turn(sessionId, turnId);
    const nativeId = this.contexts.get(sessionId)?.nativeId;
    if (nativeId !== undefined) await this.writer.pendingFor(join(this.directory, `context-${key(nativeId)}.json`));
  }
  context(sessionId: string): InteractionContext | undefined { const value = this.contexts.get(sessionId); return value === undefined ? undefined : { ...value }; }
  private sanitize(value: unknown, field = ''): unknown {
    return redactDiagnosticValue(value, [...this.secrets], field);
  }
  private summaryFor(sessionId: string): RecordingSummary {
    let summary = this.summaries.get(sessionId);
    if (summary === undefined) { summary = { records: 0, nativeFrames: 0, modelRequests: 0, fileOperations: 0, incomplete: false, errors: [] }; this.summaries.set(sessionId, summary); }
    return summary;
  }
  private enqueue(file: string, text: string, sessionId: string, mode: 'append' | 'replace' = 'append'): void {
    void this.writer.write(file, text, mode, (error: unknown) => {
      const summary = this.summaryFor(sessionId); summary.incomplete = true;
      const message = String(this.sanitize(error instanceof Error ? error.message : String(error)));
      if (!summary.errors.includes(message) && summary.errors.length < 16) summary.errors.push(message.slice(0, 512));
    });
  }
  private persistContext(sessionId: string): void {
    const context = this.contexts.get(sessionId);
    if (context?.nativeId === undefined || context.nativeId === '') return;
    const file = join(this.directory, `context-${key(context.nativeId)}.json`);
    const content = JSON.stringify(this.sanitize(context));
    this.enqueue(file, content, sessionId, 'replace');
  }
  record(sessionId: string, source: string, channel: string, value: unknown, direction?: 'in' | 'out', context?: InteractionContext): void {
    this.writeRecord(sessionId, source, channel, value, direction, context);
  }
  /** Only the controlled model observer calls this with already masked byte
   * records. Re-sanitizing their Base64 could corrupt the recorded payload. */
  recordModel(sessionId: string, event: ModelProxyEvent, context?: InteractionContext): void {
    this.writeRecord(sessionId, 'model-http', event.phase, event, event.phase === 'request' ? 'out' : 'in', context, true);
  }
  private writeRecord(sessionId: string, source: string, channel: string, value: unknown, direction?: 'in' | 'out', context?: InteractionContext, alreadyRedacted = false): void {
    const summary = this.summaryFor(sessionId);
    if (Date.now() >= this.nextPruneAt && this.pruning === undefined) {
      this.pruning = this.pruneExpired().catch(() => { summary.incomplete = true; if (!summary.errors.includes('Diagnostic retention cleanup failed')) summary.errors.push('Diagnostic retention cleanup failed'); }).finally(() => { this.pruning = undefined; });
    }
    summary.records += 1;
    if (source === 'native') summary.nativeFrames += 1;
    if (source === 'model-http' && channel === 'request' && isInference(value)) summary.modelRequests += 1;
    if (source === 'file') summary.fileOperations += 1;
    const owner = context ?? this.context(sessionId);
    try {
      const record: InteractionRecord = { version: 1, runId: this.runId, seq: ++this.seq, at: new Date().toISOString(), elapsedMs: performance.now() - this.begun, source, channel, ...(direction === undefined ? {} : { direction }), ...(owner === undefined ? {} : { context: this.sanitize(owner) as InteractionContext }), value: alreadyRedacted ? value : this.sanitize(value) };
      const file = join(this.directory, `${key(sessionId)}.jsonl`);
      this.enqueue(file, `${JSON.stringify(record)}\n`, sessionId);
    } catch { summary.incomplete = true; if (!summary.errors.includes('Diagnostic value cannot be recorded')) summary.errors.push('Diagnostic value cannot be recorded'); }
  }
  sink(sessionId: string): TraceSink { return { record: (frame: TraceFrame) => this.record(sessionId, 'native', frame.ch, frame, frame.dir) }; }
  /** Independent disk evidence; tool claims and actual filesystem state are
   * recorded separately. Large files have explicit coverage limits. */
  observeFiles(sessionId: string, event: AdapterEvent): void {
    if ((event.type !== 'item.start' && event.type !== 'item.complete') || (event.kind !== 'file.read' && event.kind !== 'file.change')) return;
    const context = this.context(sessionId);
    if (context === undefined) return;
    const data = event.data as { path?: string; changes?: { path: string }[] };
    for (const path of data.path === undefined ? (data.changes ?? []).map(change => change.path) : [data.path]) {
      try {
        const target = resolve(context.cwd, path);
        const canonical = existsSync(target) ? realpathSync(target) : resolve(realpathSync(resolve(target, '..')), relative(resolve(target, '..'), target));
        const rel = relative(realpathSync(context.cwd), canonical);
        if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw new Error('Tool path outside workspace; disk snapshot not collected');
        const info = existsSync(canonical) ? statSync(canonical) : undefined;
        const hash = info?.isFile() && info.size <= 8 * 1024 * 1024 ? createHash('sha256').update(readFileSync(canonical)).digest('hex') : undefined;
        this.record(sessionId, 'file', event.type === 'item.start' ? 'before' : 'after', { source: 'agent', itemKey: event.itemKey, operation: event.kind, path: rel, exists: info !== undefined, bytes: info?.size, sha256: hash, ...(hash === undefined && info !== undefined ? { coverage: 'unhashed', reason: 'Not a regular file or exceeds 8 MiB' } : {}), ...(existsSync(target) ? { symlink: lstatSync(target).isSymbolicLink() } : {}) });
      } catch (error) { this.record(sessionId, 'file', 'coverage', { itemKey: event.itemKey, path, error: error instanceof Error ? error.message : String(error) }); }
    }
  }
  file(event: FileOperation): void { this.record(`workspace-${event.workspaceId}`, 'file', event.operation, event); }
  async flush(): Promise<void> {
    await this.pruning;
    await this.writer.flush();
    for (const [sessionId, summary] of this.summaries) if (summary.incomplete) await writeFile(join(this.directory, `coverage-${key(sessionId)}.json`), JSON.stringify({ incomplete: true, errors: summary.errors.slice(0, 16) }), { mode: 0o600 }).catch(() => undefined);
  }
  async read(sessionId: string, nativeId?: string, workspaceId?: string): Promise<string> {
    await this.flush();
    const paths = [join(this.directory, `${key(sessionId)}.jsonl`)];
    if (nativeId !== undefined && nativeId !== '') paths.push(join(this.directory, `model-${key(nativeId)}.jsonl`));
    if (workspaceId !== undefined) paths.push(join(this.directory, `${key(`workspace-${workspaceId}`)}.jsonl`));
    const lines = (await Promise.all(paths.map(path => readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error; })))).join('').split('\n').filter(Boolean);
    return lines.map(line => ({ line, at: (JSON.parse(line) as InteractionRecord).at })).sort((a, b) => a.at.localeCompare(b.at)).map(row => row.line + '\n').join('');
  }
  async summary(sessionId: string, nativeId?: string, workspaceId?: string): Promise<RecordingSummary> {
    const summary = { ...this.summaryFor(sessionId), errors: [...this.summaryFor(sessionId).errors] };
    const rows = (await this.read(sessionId, nativeId, workspaceId)).split('\n').filter(Boolean).map(line => JSON.parse(line) as InteractionRecord);
    const coverageFiles = [join(this.directory, `coverage-${key(sessionId)}.json`), ...(nativeId === undefined ? [] : [join(this.directory, `model-${key(nativeId)}.coverage.json`)])];
    for (const file of coverageFiles) {
      const persisted = await readFile(file, 'utf8').then(text => JSON.parse(text) as { incomplete: boolean; errors: string[] }).catch(() => undefined);
      if (persisted?.incomplete) { summary.incomplete = true; summary.errors = [...new Set([...summary.errors, ...persisted.errors])].slice(0, 16); }
    }
    summary.records = rows.length;
    summary.nativeFrames = rows.filter(row => row.source === 'native').length;
    summary.modelRequests = rows.filter(row => row.source === 'model-http' && row.channel === 'request' && isInference(row.value)).length;
    summary.fileOperations = rows.filter(row => row.source === 'file').length;
    const pending = new Set<string>();
    for (const row of rows.filter(row => row.source === 'model-http')) {
      const id = (row.value as { requestId?: string }).requestId;
      if (id !== undefined && row.channel === 'request') pending.add(id);
      if (id !== undefined && row.channel === 'complete') pending.delete(id);
    }
    if (pending.size > 0) { summary.incomplete = true; summary.errors.push(`${pending.size} model requests lack a terminal recording (may still be running)`); }
    if (rows.some(row => row.source === 'recording' && row.channel === 'error')) summary.incomplete = true;
    const truncated = new Set(rows.filter(row => {
      if (row.source !== 'model-http') return false;
      const value = row.value as { coverage?: { truncated?: boolean }; value?: { coverage?: { truncated?: boolean } } };
      return value.coverage?.truncated === true || value.value?.coverage?.truncated === true;
    }).map(row => (row.value as { requestId?: string }).requestId ?? String(row.seq))).size;
    if (truncated > 0) { summary.incomplete = true; summary.errors.push(`${truncated} model payloads exceed diagnostic capture limits`); }
    return summary;
  }
}
