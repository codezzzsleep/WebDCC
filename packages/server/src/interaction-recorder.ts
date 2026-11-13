import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AdapterEvent, AgentId, TraceFrame, TraceSink } from '@webdcc/protocol';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import type { FileOperation } from './workspace-files.js';

export interface InteractionContext { sessionId: string; agent: AgentId; workspaceId: string; cwd: string; nativeId?: string; turnId?: string | null; model?: string; providerId?: string | null; }
export interface InteractionRecord { version: 1; runId: string; seq: number; at: string; elapsedMs: number; source: string; channel: string; direction?: 'in' | 'out'; context?: InteractionContext; value: unknown; }
export interface RecordingSummary { records: number; nativeFrames: number; modelRequests: number; fileOperations: number; incomplete: boolean; errors: string[]; }
const secretField = /^(authorization|proxy.authorization|cookie|set.cookie|api.?key|auth.?token|access.?token|refresh.?token|password|secret)$/i;
function key(id: string): string { return encodeURIComponent(id); }

/** Private, correlated side-channel. Recording failures remain visible without
 * changing native Agent inputs, events, or command acknowledgements. */
export class InteractionRecorder {
  readonly directory: string;
  private readonly runId = randomUUID();
  private readonly begun = performance.now();
  private readonly contexts = new Map<string, InteractionContext>();
  private readonly summaries = new Map<string, RecordingSummary>();
  private readonly secrets = new Set<string>();
  private readonly queues = new Map<string, Promise<void>>();
  private seq = 0;
  constructor(dataDir: string) { this.directory = join(dataDir, 'traces'); }
  async init(): Promise<void> { await mkdir(this.directory, { recursive: true, mode: 0o700 }); await chmod(this.directory, 0o700); }
  addSecret(value: string | undefined): void { if (value !== undefined && value.length > 0) this.secrets.add(value); }
  bind(context: InteractionContext): void { this.contexts.set(context.sessionId, { ...this.contexts.get(context.sessionId), ...context }); this.persistContext(context.sessionId); }
  nativeId(sessionId: string, nativeId: string): void { const context = this.contexts.get(sessionId); if (context !== undefined) { context.nativeId = nativeId; this.persistContext(sessionId); } }
  turn(sessionId: string, turnId: string | null): void { const context = this.contexts.get(sessionId); if (context !== undefined) { context.turnId = turnId; this.persistContext(sessionId); } }
  async turnContext(sessionId: string, turnId: string | null): Promise<void> {
    this.turn(sessionId, turnId);
    const nativeId = this.contexts.get(sessionId)?.nativeId;
    if (nativeId !== undefined) await this.queues.get(join(this.directory, `context-${key(nativeId)}.json`));
  }
  context(sessionId: string): InteractionContext | undefined { const value = this.contexts.get(sessionId); return value === undefined ? undefined : { ...value }; }
  private sanitize(value: unknown, field = ''): unknown {
    if (typeof value === 'string') {
      if (secretField.test(field)) return '<redacted>';
      let text = value.replace(/\bBearer\s+[^\s"']+/gi, 'Bearer <redacted>').replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '<redacted:key>').replace(/([?&](?:token|api_key|key|secret)=)[^&\s"']+/gi, '$1<redacted>');
      for (const secret of this.secrets) text = text.replaceAll(secret, '<redacted>');
      return text;
    }
    if (Array.isArray(value)) return value.map(item => this.sanitize(item));
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, this.sanitize(child, name)]));
    return value;
  }
  private summaryFor(sessionId: string): RecordingSummary {
    let summary = this.summaries.get(sessionId);
    if (summary === undefined) { summary = { records: 0, nativeFrames: 0, modelRequests: 0, fileOperations: 0, incomplete: false, errors: [] }; this.summaries.set(sessionId, summary); }
    return summary;
  }
  private enqueue(file: string, operation: () => Promise<void>, sessionId: string): void {
    const previous = this.queues.get(file) ?? Promise.resolve();
    const work = previous.then(operation).catch((error: unknown) => {
      const summary = this.summaryFor(sessionId); summary.incomplete = true;
      const message = String(this.sanitize(error instanceof Error ? error.message : String(error)));
      if (!summary.errors.includes(message)) summary.errors.push(message);
    });
    this.queues.set(file, work);
    void work.finally(() => { if (this.queues.get(file) === work) this.queues.delete(file); });
  }
  private persistContext(sessionId: string): void {
    const context = this.contexts.get(sessionId);
    if (context?.nativeId === undefined || context.nativeId === '') return;
    const file = join(this.directory, `context-${key(context.nativeId)}.json`);
    const content = JSON.stringify(context);
    this.enqueue(file, () => writeFile(file, content, { mode: 0o600 }), sessionId);
  }
  record(sessionId: string, source: string, channel: string, value: unknown, direction?: 'in' | 'out', context?: InteractionContext): void {
    const summary = this.summaryFor(sessionId);
    summary.records += 1;
    if (source === 'native') summary.nativeFrames += 1;
    if (source === 'model-http' && channel === 'request') summary.modelRequests += 1;
    if (source === 'file') summary.fileOperations += 1;
    const owner = context ?? this.context(sessionId);
    const record: InteractionRecord = { version: 1, runId: this.runId, seq: ++this.seq, at: new Date().toISOString(), elapsedMs: performance.now() - this.begun, source, channel, ...(direction === undefined ? {} : { direction }), ...(owner === undefined ? {} : { context: owner }), value: this.sanitize(value) };
    const file = join(this.directory, `${key(sessionId)}.jsonl`);
    const text = `${JSON.stringify(record)}\n`;
    this.enqueue(file, () => appendFile(file, text, { mode: 0o600 }), sessionId);
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
  async flush(): Promise<void> { await Promise.all([...this.queues.values()]); }
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
    summary.records = rows.length;
    summary.nativeFrames = rows.filter(row => row.source === 'native').length;
    summary.modelRequests = rows.filter(row => row.source === 'model-http' && row.channel === 'request').length;
    summary.fileOperations = rows.filter(row => row.source === 'file').length;
    const pending = new Set<string>();
    for (const row of rows.filter(row => row.source === 'model-http')) {
      const id = (row.value as { requestId?: string }).requestId;
      if (id !== undefined && row.channel === 'request') pending.add(id);
      if (id !== undefined && row.channel === 'complete') pending.delete(id);
    }
    if (pending.size > 0) { summary.incomplete = true; summary.errors.push(`${pending.size} model requests lack a terminal recording (may still be running)`); }
    if (rows.some(row => row.source === 'recording' && row.channel === 'error')) summary.incomplete = true;
    return summary;
  }
}
