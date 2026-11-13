import type {
  DraftDto,
  EventData,
  EventKind,
  FeedPatch,
  FileDto,
  ProviderDto,
  SessionDto,
  StoredEvent,
  WorkspaceDto,
  WatchdogJob,
  WatchdogSettings,
} from '@webdcc/protocol';
import { ulid } from '@webdcc/protocol';
import type { Db } from './db.js';
import { CommandJournal } from './command-journal.js';

interface SessionRow {
  id: string;
  workspace_id: string;
  agent: string;
  native_id: string | null;
  title: string | null;
  provider_id: string | null;
  model: string | null;
  reasoning_effort: string | null;
  access_mode: string | null;
  status: string;
  pinned: number;
  archived: number;
  last_seq: number;
  native_meta: string | null;
  parent_id?: string | null;
  handoff_kind?: SessionDto['handoffKind'] | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  session_id: string;
  seq: number;
  turn_id: string;
  item_key: string;
  kind: string;
  native_seq: number | null;
  data: string;
  native: string | null;
  at: string;
  late: number;
}

export interface ProviderRecord {
  id: string;
  name: string;
  baseUrl: string;
  source: string;
  sourceKey: string | null;
  endpoints: string | null;
  note: string | null;
  protocols: string[];
  models: string[];
  modelDetails: NonNullable<ProviderDto['modelDetails']>;
  codexCatalogPath: string | null;
  secretRef: string;
  createdAt: string;
}

interface ProviderDbRow {
  id: string;
  name: string;
  base_url: string;
  protocols: string;
  models: string;
  model_details: string | null;
  codex_catalog_path: string | null;
  secret_ref: string;
  created_at: string;
  source: string | null;
  source_key: string | null;
  endpoints: string | null;
  note: string | null;
}

function toProviderRecord(row: ProviderDbRow): ProviderRecord {
  const rawModels = JSON.parse(row.models) as unknown;
  const modelIds = Array.isArray(rawModels) ? rawModels.filter((model): model is string => typeof model === 'string' && model !== '') : [];
  const rawDetails = row.model_details === null ? [] : JSON.parse(row.model_details) as unknown;
  const details = Array.isArray(rawDetails)
    ? rawDetails.filter((model): model is NonNullable<ProviderDto['modelDetails']>[number] => {
      if (typeof model !== 'object' || model === null) return false;
      const value = model as Record<string, unknown>;
      return typeof value['id'] === 'string' && typeof value['name'] === 'string';
    })
    : [];
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    protocols: JSON.parse(row.protocols) as string[],
    models: modelIds,
    modelDetails: modelIds.map((id) => details.find((model) => model.id === id) ?? { id, name: id }),
    codexCatalogPath: row.codex_catalog_path,
    secretRef: row.secret_ref,
    createdAt: row.created_at,
    source: row.source ?? 'manual',
    sourceKey: row.source_key,
    endpoints: row.endpoints,
    note: row.note,
  };
}

interface FileRow {
  id: string;
  sha256: string;
  name: string;
  mime: string;
  size: number;
  created_at: string;
}

interface UploadRow {
  id: string;
  sha256: string;
  name: string;
  mime: string;
  size: number;
  received: string;
  created_at: string;
}

export interface AppendEventInput {
  sessionId: string;
  turnId: string | null;
  itemKey: string;
  kind: EventKind;
  data: EventData[EventKind];
  native?: unknown;
  nativeSeq?: number;
  late?: boolean;
}

export interface CreateSessionInput {
  workspaceId: string;
  agent: string;
  providerId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  accessMode?: string | null;
  title?: string | null;
  parentId?: string | null;
  handoffKind?: SessionDto['handoffKind'];
}

function toSessionDto(row: SessionRow): SessionDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agent: row.agent,
    ...(row.native_id === null ? {} : { nativeId: row.native_id }),
    ...(row.title === null ? {} : { title: row.title }),
    providerId: row.provider_id,
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.reasoning_effort === null ? {} : { reasoningEffort: row.reasoning_effort }),
    ...(row.access_mode === null ? {} : { accessMode: row.access_mode }),
    ...(row.parent_id === null || row.parent_id === undefined ? {} : { parentId: row.parent_id }),
    ...(row.handoff_kind == null ? {} : { handoffKind: row.handoff_kind }),
    status: row.status as SessionDto['status'],
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    lastSeq: row.last_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEvent(row: EventRow): StoredEvent {
  return {
    sessionId: row.session_id,
    seq: row.seq,
    turnId: row.turn_id === '' ? null : row.turn_id,
    itemKey: row.item_key,
    at: row.at,
    kind: row.kind as EventKind,
    data: JSON.parse(row.data) as EventData[EventKind],
    ...(row.native === null ? {} : { native: JSON.parse(row.native) as unknown }),
    ...(row.native_seq === null ? {} : { nativeSeq: row.native_seq }),
    ...(row.late === 1 ? { late: true } : {}),
  };
}

function toWatchdogJob(data: string): WatchdogJob {
  const job = JSON.parse(data) as WatchdogJob;
  return { ...job, retries: job.retries ?? Math.max(0, job.attempts - job.handoffs) };
}

export class Store {
  readonly journal: CommandJournal;
  constructor(private readonly db: Db) { this.journal = new CommandJournal(db); }

  watchdogSettings(): WatchdogSettings | undefined {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = 'codex-watchdog'").get() as { value: string } | undefined;
    return row === undefined ? undefined : JSON.parse(row.value) as WatchdogSettings;
  }

  saveWatchdogSettings(settings: WatchdogSettings): void {
    this.db.prepare("INSERT INTO app_settings (key, value) VALUES ('codex-watchdog', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(settings));
  }

  watchdogJobs(): WatchdogJob[] {
    return (this.db.prepare('SELECT data FROM watchdog_jobs').all() as { data: string }[]).map((row) => toWatchdogJob(row.data));
  }

  watchdogJob(sessionId: string): WatchdogJob | undefined {
    const row = this.db.prepare('SELECT data FROM watchdog_jobs WHERE session_id = ?').get(sessionId) as { data: string } | undefined;
    return row === undefined ? undefined : toWatchdogJob(row.data);
  }

  saveWatchdogJob(job: WatchdogJob): void {
    this.db.prepare('INSERT INTO watchdog_jobs (session_id, data) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET data = excluded.data').run(job.sessionId, JSON.stringify(job));
  }

  clearWatchdogJob(sessionId: string): void {
    this.db.prepare('DELETE FROM watchdog_jobs WHERE session_id = ?').run(sessionId);
  }

  // ---------- workspaces ----------
  listWorkspaces(): WorkspaceDto[] {
    const rows = this.db
      .prepare('SELECT id, name, path, created_at FROM workspaces ORDER BY created_at ASC')
      .all() as { id: string; name: string; path: string; created_at: string }[];
    return rows.map((row) => ({ id: row.id, name: row.name, path: row.path, createdAt: row.created_at }));
  }

  getWorkspace(id: string): WorkspaceDto | undefined {
    const row = this.db
      .prepare('SELECT id, name, path, created_at FROM workspaces WHERE id = ?')
      .get(id) as { id: string; name: string; path: string; created_at: string } | undefined;
    return row === undefined ? undefined : { id: row.id, name: row.name, path: row.path, createdAt: row.created_at };
  }

  findWorkspaceByPath(path: string): WorkspaceDto | undefined {
    const row = this.db
      .prepare('SELECT id, name, path, created_at FROM workspaces WHERE path = ?')
      .get(path) as { id: string; name: string; path: string; created_at: string } | undefined;
    return row === undefined ? undefined : { id: row.id, name: row.name, path: row.path, createdAt: row.created_at };
  }

  createWorkspace(name: string, path: string): WorkspaceDto {
    const id = ulid();
    const at = new Date().toISOString();
    this.db.prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(id, name, path, at);
    return { id, name, path, createdAt: at };
  }

  // ---------- sessions ----------
  listSessions(includeArchived = false): SessionDto[] {
    const sql = includeArchived
      ? 'SELECT * FROM sessions ORDER BY pinned DESC, updated_at DESC'
      : 'SELECT * FROM sessions WHERE archived = 0 ORDER BY pinned DESC, updated_at DESC';
    return (this.db.prepare(sql).all() as SessionRow[]).map(toSessionDto);
  }

  listSessionsByWorkspace(workspaceId: string): SessionDto[] {
    return (this.db
      .prepare('SELECT * FROM sessions WHERE workspace_id = ? AND archived = 0 ORDER BY pinned DESC, updated_at DESC')
      .all(workspaceId) as SessionRow[]).map(toSessionDto);
  }

  getSession(id: string): SessionDto | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return row === undefined ? undefined : toSessionDto(row);
  }

  createSession(input: CreateSessionInput): SessionDto {
    const id = ulid();
    const at = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions (id, workspace_id, agent, provider_id, model, reasoning_effort, access_mode, status, title, parent_id, handoff_kind, last_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, 0, ?, ?)`,
      )
      .run(id, input.workspaceId, input.agent, input.providerId ?? null, input.model ?? null, input.reasoningEffort ?? null, input.accessMode ?? null, input.title ?? null, input.parentId ?? null, input.parentId == null ? null : input.handoffKind ?? 'manual', at, at);
    return this.getSession(id) as SessionDto;
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM events WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM feed WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM drafts WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  updateSession(
    id: string,
    patch: {
      title?: string;
      status?: SessionDto['status'];
      nativeId?: string | null;
      model?: string | null;
      reasoningEffort?: string | null;
      accessMode?: string | null;
      providerId?: string | null;
      pinned?: boolean;
      archived?: boolean;
      nativeMeta?: string | null;
      touch?: boolean;
    },
  ): SessionDto | undefined {
    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.title !== undefined) push('title', patch.title);
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.nativeId !== undefined) push('native_id', patch.nativeId);
    if (patch.model !== undefined) push('model', patch.model);
    if (patch.reasoningEffort !== undefined) push('reasoning_effort', patch.reasoningEffort);
    if (patch.accessMode !== undefined) push('access_mode', patch.accessMode);
    if (patch.providerId !== undefined) push('provider_id', patch.providerId);
    if (patch.pinned !== undefined) push('pinned', patch.pinned ? 1 : 0);
    if (patch.archived !== undefined) push('archived', patch.archived ? 1 : 0);
    if (patch.nativeMeta !== undefined) push('native_meta', patch.nativeMeta);
    if (patch.touch !== false) push('updated_at', new Date().toISOString());
    if (sets.length === 0) return this.getSession(id);
    values.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getSession(id);
  }

  // ---------- providers ----------
  listProviders(): ProviderRecord[] {
    return (this.db.prepare('SELECT * FROM providers ORDER BY created_at ASC').all() as ProviderDbRow[]).map(toProviderRecord);
  }

  getProvider(id: string): ProviderRecord | undefined {
    const row = this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderDbRow | undefined;
    return row === undefined ? undefined : toProviderRecord(row);
  }

  createProvider(input: {
    id: string;
    name: string;
    baseUrl: string;
    protocols: string[];
    models: string[];
    modelDetails?: NonNullable<ProviderDto['modelDetails']>;
    secretRef: string;
    codexCatalogPath: string | null;
    source?: string;
    sourceKey?: string | null;
    endpoints?: string | null;
    note?: string | null;
  }): ProviderRecord {
    const at = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO providers (id, name, base_url, protocols, secret_ref, models, model_details, codex_catalog_path, created_at, source, source_key, endpoints, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.id,
        input.name,
        input.baseUrl,
        JSON.stringify(input.protocols),
        input.secretRef,
        JSON.stringify(input.models),
        JSON.stringify(input.modelDetails ?? input.models.map((id) => ({ id, name: id }))),
        input.codexCatalogPath,
        at,
        input.source ?? 'manual',
        input.sourceKey ?? null,
        input.endpoints ?? null,
        input.note ?? null,
      );
    return {
      id: input.id,
      name: input.name,
      baseUrl: input.baseUrl,
      protocols: input.protocols,
      models: input.models,
      modelDetails: input.modelDetails ?? input.models.map((id) => ({ id, name: id })),
      codexCatalogPath: input.codexCatalogPath,
      secretRef: input.secretRef,
      createdAt: at,
      source: input.source ?? 'manual',
      sourceKey: input.sourceKey ?? null,
      endpoints: input.endpoints ?? null,
      note: input.note ?? null,
    };
  }

  updateProvider(
    id: string,
    patch: { name?: string; baseUrl?: string; endpoints?: string | null; protocols?: string[]; models?: string[]; modelDetails?: NonNullable<ProviderDto['modelDetails']>; codexCatalogPath?: string | null },
  ): ProviderRecord | undefined {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) { sets.push('name = ?'); values.push(patch.name); }
    if (patch.baseUrl !== undefined) { sets.push('base_url = ?'); values.push(patch.baseUrl); }
    if (patch.endpoints !== undefined) { sets.push('endpoints = ?'); values.push(patch.endpoints); }
    if (patch.protocols !== undefined) { sets.push('protocols = ?'); values.push(JSON.stringify(patch.protocols)); }
    if (patch.models !== undefined) { sets.push('models = ?'); values.push(JSON.stringify(patch.models)); }
    if (patch.modelDetails !== undefined) { sets.push('model_details = ?'); values.push(JSON.stringify(patch.modelDetails)); }
    if (patch.codexCatalogPath !== undefined) { sets.push('codex_catalog_path = ?'); values.push(patch.codexCatalogPath); }
    if (sets.length > 0) {
      values.push(id);
      this.db.prepare(`UPDATE providers SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    }
    return this.getProvider(id);
  }

  /** 用户改过名字的会话不会被原生标题覆盖（C1 / SES-01） */
  setTitleSource(sessionId: string, source: 'user' | 'native'): void {
    this.db.prepare('UPDATE sessions SET title_source = ? WHERE id = ?').run(source, sessionId);
  }

  titleSource(sessionId: string): 'user' | 'native' | null {
    const row = this.db.prepare('SELECT title_source FROM sessions WHERE id = ?').get(sessionId) as { title_source: string | null } | undefined;
    if (row === undefined || row.title_source === null) return null;
    return row.title_source === 'user' ? 'user' : 'native';
  }

  deleteProvider(id: string): void {
    // sessions.provider_id 有外键引用：先解绑再删（PRV-03）
    this.db.prepare('UPDATE sessions SET provider_id = NULL WHERE provider_id = ?').run(id);
    this.db.prepare('DELETE FROM providers WHERE id = ?').run(id);
  }

  // ---------- events ----------
  lastSeq(sessionId: string): number {
    const row = this.db.prepare('SELECT last_seq FROM sessions WHERE id = ?').get(sessionId) as
      | { last_seq: number }
      | undefined;
    return row?.last_seq ?? 0;
  }

  /** seq 分配与事件写入在同一事务（SPEC 11.2） */
  appendEvent(input: AppendEventInput): StoredEvent {
    const at = new Date().toISOString();
    const tx = this.db.transaction((event: AppendEventInput): StoredEvent => {
      const current = this.db.prepare('SELECT last_seq FROM sessions WHERE id = ?').get(event.sessionId) as
        | { last_seq: number }
        | undefined;
      if (current === undefined) throw new Error(`会话不存在：${event.sessionId}`);
      const seq = current.last_seq + 1;
      this.db
        .prepare(
          `INSERT INTO events (session_id, seq, turn_id, item_key, kind, native_seq, data, native, at, late)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.sessionId,
          seq,
          event.turnId ?? '',
          event.itemKey,
          event.kind,
          event.nativeSeq ?? null,
          JSON.stringify(event.data),
          event.native === undefined ? null : JSON.stringify(event.native),
          at,
          event.late === true ? 1 : 0,
        );
      this.db.prepare('UPDATE sessions SET last_seq = ?, updated_at = ? WHERE id = ?').run(seq, at, event.sessionId);
      return {
        sessionId: event.sessionId,
        seq,
        turnId: event.turnId,
        itemKey: event.itemKey,
        at,
        kind: event.kind,
        data: event.data,
        ...(event.native === undefined ? {} : { native: event.native }),
        ...(event.nativeSeq === undefined ? {} : { nativeSeq: event.nativeSeq }),
        ...(event.late === true ? { late: true } : {}),
      };
    });
    return tx(input);
  }

  listEvents(sessionId: string, opts: { after?: number; before?: number; limit?: number } = {}): StoredEvent[] {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    const clauses = ['session_id = ?'];
    const values: unknown[] = [sessionId];
    if (opts.after !== undefined) {
      clauses.push('seq > ?');
      values.push(opts.after);
    }
    if (opts.before !== undefined) {
      clauses.push('seq < ?');
      values.push(opts.before);
    }
    values.push(limit);
    // 只给 before 时是"向前翻页"，要取紧邻 before 之前的 limit 条：先 DESC 再反转（SPEC 7.5）
    const descending = opts.before !== undefined && opts.after === undefined;
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE ${clauses.join(' AND ')} ORDER BY seq ${descending ? 'DESC' : 'ASC'} LIMIT ?`)
      .all(...values) as EventRow[];
    if (descending) rows.reverse();
    return rows.map(toEvent);
  }

  allEvents(sessionId: string): StoredEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC').all(sessionId) as EventRow[]).map(
      toEvent,
    );
  }

  // ---------- feed ----------
  appendFeed(sessionId: string, patch: FeedPatch): number {
    const at = new Date().toISOString();
    const info = this.db.prepare('INSERT INTO feed (session_id, patch, at) VALUES (?, ?, ?)').run(sessionId, JSON.stringify(patch), at);
    return Number(info.lastInsertRowid);
  }

  /** 会话状态更新与 feed 追加在同一事务（SPEC 11.2） */
  updateSessionAndFeed(
    id: string,
    patch: Parameters<Store['updateSession']>[1],
    feedPatch: FeedPatch,
  ): { session: SessionDto | undefined; feedSeq: number } {
    const tx = this.db.transaction(() => {
      const session = this.updateSession(id, patch);
      const feedSeq = this.appendFeed(id, feedPatch);
      return { session, feedSeq };
    });
    return tx();
  }

  feedSince(after: number, limit = 500): { feedSeq: number; sessionId: string; patch: FeedPatch }[] {
    const rows = this.db
      .prepare('SELECT feed_seq, session_id, patch FROM feed WHERE feed_seq > ? ORDER BY feed_seq ASC LIMIT ?')
      .all(after, Math.min(limit, 1000)) as { feed_seq: number; session_id: string; patch: string }[];
    return rows.map((row) => ({ feedSeq: row.feed_seq, sessionId: row.session_id, patch: JSON.parse(row.patch) as FeedPatch }));
  }

  maxFeedSeq(): number {
    const row = this.db.prepare('SELECT MAX(feed_seq) AS max FROM feed').get() as { max: number | null };
    return row.max ?? 0;
  }

  // ---------- commands ----------
  getCommandResult(clientCommandId: string): { op: string; result: unknown } | undefined {
    const row = this.db
      .prepare('SELECT op, result FROM commands WHERE client_command_id = ?')
      .get(clientCommandId) as { op: string; result: string } | undefined;
    return row === undefined ? undefined : { op: row.op, result: JSON.parse(row.result) as unknown };
  }

  recordCommand(clientCommandId: string, op: string, result: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO commands (client_command_id, op, result, at) VALUES (?, ?, ?, ?)')
      .run(clientCommandId, op, JSON.stringify(result), new Date().toISOString());
  }

  pruneCommands(olderThanDays = 7): void {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    this.db.prepare('DELETE FROM commands WHERE at < ?').run(cutoff);
  }

  /** 该 approvalId 是否已经被决策过（用于 approve 幂等与 already-resolved） */
  hasApprovalResolved(sessionId: string, approvalId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS hit FROM events
         WHERE session_id = ? AND kind = 'approval.resolved'
           AND json_extract(data, '$.approvalId') = ? LIMIT 1`,
      )
      .get(sessionId, approvalId) as { hit: number } | undefined;
    return row !== undefined;
  }

  // ---------- drafts ----------
  getDraft(sessionId: string): DraftDto {
    const row = this.db.prepare('SELECT text, file_ids, updated_at FROM drafts WHERE session_id = ?').get(sessionId) as
      | { text: string; file_ids: string; updated_at: string }
      | undefined;
    if (row === undefined) return { text: '', fileIds: [], updatedAt: new Date(0).toISOString() };
    return { text: row.text, fileIds: JSON.parse(row.file_ids) as string[], updatedAt: row.updated_at };
  }

  setDraft(sessionId: string, text: string, fileIds: string[]): DraftDto {
    const at = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO drafts (session_id, text, file_ids, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET text = excluded.text, file_ids = excluded.file_ids, updated_at = excluded.updated_at`,
      )
      .run(sessionId, text, JSON.stringify(fileIds), at);
    return { text, fileIds, updatedAt: at };
  }

  // ---------- files ----------
  insertFile(input: { id: string; sha256: string; name: string; mime: string; size: number }): FileDto {
    const at = new Date().toISOString();
    this.db
      .prepare('INSERT INTO files (id, sha256, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.id, input.sha256, input.name, input.mime, input.size, at);
    return { ...input, createdAt: at };
  }

  getFile(id: string): FileDto | undefined {
    const row = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined;
    if (row === undefined) return undefined;
    return { id: row.id, sha256: row.sha256, name: row.name, mime: row.mime, size: row.size, createdAt: row.created_at };
  }

  getFileBySha(sha256: string): FileDto | undefined {
    const row = this.db.prepare('SELECT * FROM files WHERE sha256 = ?').get(sha256) as FileRow | undefined;
    if (row === undefined) return undefined;
    return { id: row.id, sha256: row.sha256, name: row.name, mime: row.mime, size: row.size, createdAt: row.created_at };
  }

  // ---------- uploads ----------
  createUpload(input: { id: string; sha256: string; name: string; mime: string; size: number }): void {
    this.db
      .prepare('INSERT INTO uploads (id, sha256, name, mime, size, received, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(input.id, input.sha256, input.name, input.mime, input.size, '[]', new Date().toISOString());
  }

  getUpload(id: string): (UploadRow & { receivedList: number[] }) | undefined {
    const row = this.db.prepare('SELECT * FROM uploads WHERE id = ?').get(id) as UploadRow | undefined;
    return row === undefined ? undefined : { ...row, receivedList: JSON.parse(row.received) as number[] };
  }

  listUploads(): (UploadRow & { receivedList: number[] })[] {
    return (this.db.prepare('SELECT * FROM uploads').all() as UploadRow[]).map(row => ({ ...row, receivedList: JSON.parse(row.received) as number[] }));
  }

  fileStorageUsage(): { stored: number; pending: number } {
    const sum = (table: 'files' | 'uploads'): number => (this.db.prepare(`SELECT COALESCE(SUM(size), 0) AS bytes FROM ${table}`).get() as { bytes: number }).bytes;
    return { stored: sum('files'), pending: sum('uploads') };
  }

  saveCapabilitySnapshot(scope: string, revision: string, data: unknown): void {
    this.db.prepare('INSERT INTO capability_snapshots (scope, revision, data, at) VALUES (?, ?, ?, ?) ON CONFLICT(scope) DO UPDATE SET revision = excluded.revision, data = excluded.data, at = excluded.at')
      .run(scope, revision, JSON.stringify(data), new Date().toISOString());
  }

  setUploadReceived(id: string, received: number[]): void {
    this.db.prepare('UPDATE uploads SET received = ? WHERE id = ?').run(JSON.stringify(received), id);
  }

  deleteUpload(id: string): void {
    this.db.prepare('DELETE FROM uploads WHERE id = ?').run(id);
  }
}
