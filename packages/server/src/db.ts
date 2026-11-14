import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;
// v12 scopes input/drafts; v13 keeps file name/MIME identity separate from
// shared content bytes, without changing any existing file ID.
export const CURRENT_SCHEMA_VERSION = 13;

/** SPEC 11.2 的表结构 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
  protocols TEXT NOT NULL, secret_ref TEXT NOT NULL, models TEXT NOT NULL, model_details TEXT,
  codex_catalog_path TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent TEXT NOT NULL, native_id TEXT, title TEXT,
  provider_id TEXT REFERENCES providers(id), model TEXT, reasoning_effort TEXT, access_mode TEXT,
  status TEXT NOT NULL DEFAULT 'idle', pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
  last_seq INTEGER NOT NULL DEFAULT 0, native_meta TEXT, title_source TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL REFERENCES sessions(id), seq INTEGER NOT NULL,
  turn_id TEXT NOT NULL, item_key TEXT NOT NULL, kind TEXT NOT NULL, native_seq INTEGER,
  data TEXT NOT NULL, native TEXT, at TEXT NOT NULL, late INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS feed (
  feed_seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, patch TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS commands (
  client_command_id TEXT PRIMARY KEY, op TEXT NOT NULL, result TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
  size INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS files_sha256_lookup ON files(sha256);
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
  size INTEGER NOT NULL, received TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS drafts (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id), text TEXT NOT NULL,
  file_ids TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session_seq ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS feed_session ON feed(session_id, feed_seq);
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS watchdog_jobs (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, data TEXT NOT NULL
);
`;

export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  const schemaVersion = db.pragma('user_version', { simple: true }) as number;
  if (schemaVersion > CURRENT_SCHEMA_VERSION) {
    db.close();
    throw new Error(`数据库版本 ${schemaVersion} 高于支持的 ${CURRENT_SCHEMA_VERSION}，拒绝修改`);
  }
  if (schemaVersion >= 12) {
    const columns = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name));
    if (!columns('file_session_grants').has('file_id') || !columns('uploads').has('session_id') || !columns('drafts').has('revision') || !columns('drafts').has('content_parts') || !columns('native_input_ids').has('target_turn_id') || !columns('input_queue').has('preparation_error')) {
      db.close(); throw new Error('数据库 schema v12 不完整，拒绝启动或补造授权');
    }
  }
  if (schemaVersion >= 13 && uniqueFileHash(db)) { db.close(); throw new Error('数据库 schema v13 的文件别名能力不完整，拒绝启动'); }
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = FULL');
  db.exec(SCHEMA);
  try { db.transaction(() => {
    if (schemaVersion < 13) migrateFileAliases(db);
    db.exec(`CREATE TABLE IF NOT EXISTS native_owners (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      agent TEXT NOT NULL, host_id TEXT NOT NULL, native_id TEXT,
      owner_id TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL,
      active_native_turn_id TEXT, last_observed_seq INTEGER,
      lease_until INTEGER NOT NULL, observed_at TEXT NOT NULL,
      server_pid INTEGER NOT NULL, server_boot TEXT NOT NULL, server_start TEXT NOT NULL
    ); CREATE UNIQUE INDEX IF NOT EXISTS native_owners_identity ON native_owners(host_id, agent, native_id) WHERE native_id IS NOT NULL;`);
    const ownerColumns = db.prepare('PRAGMA table_info(native_owners)').all() as { name: string }[];
    if (!ownerColumns.some(column => column.name === 'managed_process')) db.exec('ALTER TABLE native_owners ADD COLUMN managed_process TEXT');
    db.exec(`CREATE TABLE IF NOT EXISTS native_reconciliations (
      revision TEXT PRIMARY KEY, session_id TEXT NOT NULL, generation INTEGER, owner_id TEXT,
      native_id TEXT NOT NULL, observed_at TEXT NOT NULL, data TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0
    ); CREATE INDEX IF NOT EXISTS native_reconciliations_session ON native_reconciliations(session_id, observed_at);`);
    db.exec(`CREATE TABLE IF NOT EXISTS native_event_envelopes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, agent TEXT NOT NULL, native_id TEXT,
      owner_id TEXT, generation INTEGER, received_at TEXT NOT NULL,
      source TEXT NOT NULL, direction TEXT NOT NULL, channel TEXT NOT NULL, disposition TEXT NOT NULL,
      schema_hash TEXT NOT NULL, raw_envelope_id INTEGER, native_seq INTEGER, native_turn_id TEXT, native_request_id TEXT,
      actor_id TEXT, parent_tool_use_id TEXT, payload_coverage TEXT NOT NULL, payload TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS native_event_envelopes_session ON native_event_envelopes(session_id, id);
    CREATE INDEX IF NOT EXISTS native_event_envelopes_request ON native_event_envelopes(session_id, generation, native_request_id);
    CREATE TABLE IF NOT EXISTS native_event_projections (
      projection_version INTEGER NOT NULL, event_key TEXT NOT NULL, envelope_id INTEGER NOT NULL, event_seq INTEGER,
      PRIMARY KEY (projection_version, event_key)
    );`);
    const eventColumns = db.prepare('PRAGMA table_info(events)').all() as { name: string }[];
    if (!eventColumns.some(column => column.name === 'native_envelope_id')) db.exec('ALTER TABLE events ADD COLUMN native_envelope_id INTEGER');
    db.exec(`CREATE TABLE IF NOT EXISTS interactions (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, id TEXT NOT NULL, group_id TEXT NOT NULL,
      state TEXT NOT NULL, revision INTEGER NOT NULL, command_id TEXT,
      request TEXT NOT NULL, error TEXT,
      PRIMARY KEY (session_id, kind, id)
    ); CREATE INDEX IF NOT EXISTS interactions_group ON interactions(session_id, kind, group_id, state);`);
    if (schemaVersion < 5) db.prepare('DELETE FROM app_settings WHERE key = ?').run('interaction-index-v5');
    const columns = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'permission_state')) db.exec('ALTER TABLE sessions ADD COLUMN permission_state TEXT');
    db.exec(`UPDATE sessions SET permission_state = json_object(
      'requested', CASE WHEN access_mode IS NULL OR access_mode = 'inherit' THEN NULL ELSE access_mode END,
      'effective', NULL, 'phase', 'unknown', 'revision', 1) WHERE permission_state IS NULL`);
    db.exec(`CREATE TABLE IF NOT EXISTS capability_snapshots (
      scope TEXT PRIMARY KEY, revision TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS native_turns (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      native_turn_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      PRIMARY KEY (session_id, native_turn_id)
    );
    CREATE TABLE IF NOT EXISTS native_history_records (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      native_id TEXT NOT NULL, native_seq INTEGER NOT NULL, at TEXT NOT NULL, native TEXT NOT NULL,
      PRIMARY KEY (session_id, native_id, native_seq)
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS command_journal (
      command_id TEXT PRIMARY KEY, payload_hash TEXT, payload TEXT, op TEXT NOT NULL,
      session_id TEXT, state TEXT NOT NULL, turn_id TEXT, result TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS input_queue (
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT, command_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL REFERENCES sessions(id), turn_id TEXT NOT NULL UNIQUE,
      input TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS input_queue_session ON input_queue(session_id, state, ordinal);
    INSERT OR IGNORE INTO command_journal (command_id, op, state, result, updated_at)
      SELECT client_command_id, op, 'uncertain', result, at FROM commands;`);
    db.exec(`CREATE TABLE IF NOT EXISTS native_actions (
      command_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
      type TEXT NOT NULL, payload_hash TEXT NOT NULL, state TEXT NOT NULL,
      target_key TEXT NOT NULL, runtime_key TEXT, native_id TEXT, server_process TEXT NOT NULL, reference TEXT, error TEXT, updated_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS native_actions_session ON native_actions(session_id, updated_at);`);
    db.exec(`CREATE TABLE IF NOT EXISTS native_input_ids (
      command_id TEXT PRIMARY KEY REFERENCES input_queue(command_id),
      session_id TEXT NOT NULL REFERENCES sessions(id), turn_id TEXT NOT NULL UNIQUE,
      native_request_id TEXT NOT NULL UNIQUE
    )`);
    const inputColumns = db.prepare('PRAGMA table_info(native_input_ids)').all() as { name: string }[];
    if (!inputColumns.some(column => column.name === 'target_turn_id')) db.exec('ALTER TABLE native_input_ids ADD COLUMN target_turn_id TEXT');
    const queueColumns = db.prepare('PRAGMA table_info(input_queue)').all() as { name: string }[];
    if (!queueColumns.some(column => column.name === 'preparation_error')) db.exec('ALTER TABLE input_queue ADD COLUMN preparation_error TEXT');
    const uploadColumns = db.prepare('PRAGMA table_info(uploads)').all() as { name: string }[];
    if (!uploadColumns.some(column => column.name === 'session_id')) db.exec('ALTER TABLE uploads ADD COLUMN session_id TEXT REFERENCES sessions(id)');
    const draftColumns = db.prepare('PRAGMA table_info(drafts)').all() as { name: string }[];
    if (!draftColumns.some(column => column.name === 'revision')) db.exec('ALTER TABLE drafts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)');
    if (!draftColumns.some(column => column.name === 'content_parts')) db.exec('ALTER TABLE drafts ADD COLUMN content_parts TEXT');
    db.exec(`CREATE TABLE IF NOT EXISTS file_session_grants (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      source TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, file_id)
    )`);
    if (schemaVersion < 12) migrateFileGrants(db);
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
  })(); } catch (error) { db.close(); throw error; }
  // M8 F16：Provider 增加来源与按协议的多端点
  const columns = db.prepare('PRAGMA table_info(providers)').all() as { name: string }[];
  const has = (name: string): boolean => columns.some((column) => column.name === name);
  if (!has('source')) db.exec("ALTER TABLE providers ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
  if (!has('source_key')) db.exec('ALTER TABLE providers ADD COLUMN source_key TEXT');
  if (!has('endpoints')) db.exec('ALTER TABLE providers ADD COLUMN endpoints TEXT');
  if (!has('note')) db.exec('ALTER TABLE providers ADD COLUMN note TEXT');
  if (!has('model_details')) db.exec('ALTER TABLE providers ADD COLUMN model_details TEXT');
  // M8 C1：用户改过名字的会话不被原生标题覆盖
  const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  if (!sessionColumns.some((column) => column.name === 'reasoning_effort')) db.exec('ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT');
  if (!sessionColumns.some((column) => column.name === 'title_source')) db.exec('ALTER TABLE sessions ADD COLUMN title_source TEXT');
  // 接续会话：记录上一棒（"在另一个 Agent 中继续"）
  if (!sessionColumns.some((column) => column.name === 'parent_id')) db.exec('ALTER TABLE sessions ADD COLUMN parent_id TEXT');
  if (!sessionColumns.some((column) => column.name === 'handoff_kind')) {
    db.transaction(() => {
      db.exec('ALTER TABLE sessions ADD COLUMN handoff_kind TEXT');
      // A source's automatic command identifies recovery even if its job was
      // cleared by later manual input. Same-session retries use the child's ID.
      db.exec(`UPDATE sessions SET handoff_kind = CASE WHEN
        EXISTS (SELECT 1 FROM watchdog_jobs WHERE json_extract(data, '$.targetSessionId') = sessions.id)
        OR EXISTS (SELECT 1 FROM events WHERE session_id = sessions.id AND kind = 'user.message'
          AND json_extract(data, '$.clientCommandId') LIKE 'watchdog:' || sessions.parent_id || ':%')
        THEN 'watchdog' ELSE 'manual' END WHERE parent_id IS NOT NULL`);
      // Cached browsers also need the migrated relation when they resume feed.
      db.prepare(`INSERT INTO feed (session_id, patch, at)
        SELECT id, json_object('handoffKind', handoff_kind), ? FROM sessions WHERE handoff_kind IS NOT NULL`)
        .run(new Date().toISOString());
    })();
  }
  // M9：旧版本没有保存所有 Harness 的原生思考强度；从已持久化的
  // 原生初始化/请求头回填，避免页面把“未记录”误显示成 medium。
  backfillNativeReasoningEffort(db);
  const eventColumns = db.prepare('PRAGMA table_info(events)').all() as { name: string }[];
  if (!eventColumns.some((column) => column.name === 'late')) db.exec('ALTER TABLE events ADD COLUMN late INTEGER NOT NULL DEFAULT 0');
  return db;
}

function uniqueFileHash(db: Db): boolean {
  return (db.prepare('PRAGMA index_list(files)').all() as { name: string; unique: number }[]).some(index => {
    const columns = db.prepare(`PRAGMA index_info("${index.name.replaceAll('"', '""')}")`).all() as { name: string | null }[];
    return index.unique !== 0 && columns.length === 1 && columns[0]?.name === 'sha256';
  });
}

/** Old files.sha256 UNIQUE combined byte identity with user-selected MIME.
 * Rebuild only this known schema; preserve IDs and every existing grant. */
function migrateFileAliases(db: Db): void {
  if (!uniqueFileHash(db)) return;
  const columns = db.prepare('PRAGMA table_info(files)').all() as { name: string }[];
  if (columns.some(column => !['id', 'sha256', 'name', 'mime', 'size', 'created_at'].includes(column.name))) throw new Error('files 表包含未知字段，拒绝可能丢失数据的迁移');
  const grantTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'file_session_grants'").get();
  const grants = grantTable === undefined ? [] : db.prepare('SELECT session_id, file_id, source, created_at FROM file_session_grants').all() as { session_id: string; file_id: string; source: string; created_at: string }[];
  const definitions = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'files' AND type IN ('index', 'trigger') AND sql IS NOT NULL").all() as { type: string; name: string; sql: string }[];
  const keep = definitions.filter(definition => {
    if (definition.type !== 'index') return true;
    const index = (db.prepare('PRAGMA index_list(files)').all() as { name: string; unique: number }[]).find(index => index.name === definition.name);
    const fields = db.prepare(`PRAGMA index_info("${definition.name.replaceAll('"', '""')}")`).all() as { name: string | null }[];
    return index?.unique === 0 || fields.length !== 1 || fields[0]?.name !== 'sha256';
  });
  db.pragma('defer_foreign_keys = ON');
  db.exec(`CREATE TABLE files_migrate_v13 (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO files_migrate_v13 (id, sha256, name, mime, size, created_at) SELECT id, sha256, name, mime, size, created_at FROM files;
    DROP TABLE files; ALTER TABLE files_migrate_v13 RENAME TO files;`);
  for (const definition of keep) db.exec(definition.sql);
  db.exec('CREATE INDEX IF NOT EXISTS files_sha256_lookup ON files(sha256)');
  if (grantTable !== undefined) for (const grant of grants) db.prepare('INSERT INTO file_session_grants (session_id, file_id, source, created_at) VALUES (?, ?, ?, ?)').run(grant.session_id, grant.file_id, grant.source, grant.created_at);
  if ((db.pragma('foreign_key_check') as unknown[]).length !== 0) throw new Error('文件别名迁移外键检查失败');
}

/** Grant only identities already explicitly referenced by stored user data.
 * Do not infer ownership from a global CAS entry or rewrite historical input. */
function migrateFileGrants(db: Db): void {
  const grant = db.prepare(`INSERT OR IGNORE INTO file_session_grants (session_id, file_id, source, created_at)
    SELECT ?, id, ?, ? FROM files WHERE id = ? AND EXISTS (SELECT 1 FROM sessions WHERE id = ?)`);
  const at = new Date().toISOString();
  const references = new Map<string, { sessionId: string; fileId: string; source: string }>();
  const parse = (value: string): unknown => { try { return JSON.parse(value) as unknown; } catch { return undefined; } };
  const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const add = (sessionId: string, ids: unknown[], source: string): void => {
    for (const id of ids) if (typeof id === 'string') references.set(JSON.stringify([sessionId, id]), { sessionId, fileId: id, source });
  };
  const parts = (value: unknown): unknown[] => {
    const content = object(value); if (content['version'] !== 1 || !Array.isArray(content['parts'])) return [];
    return content['parts'].flatMap(value => { const part = object(value); return ['image', 'file', 'audio'].includes(String(part['type'])) ? [part['fileId']] : []; });
  };
  for (const row of db.prepare('SELECT session_id, input FROM input_queue').iterate() as Iterable<{ session_id: string; input: string }>) {
    const input = object(parse(row.input)); const images = Array.isArray(input['images']) ? input['images'].map(value => object(value)['fileId']) : [];
    add(row.session_id, [...images, ...parts(input['contentParts'])], 'legacy-queue');
  }
  for (const row of db.prepare("SELECT session_id, data FROM events WHERE kind = 'user.message'").iterate() as Iterable<{ session_id: string; data: string }>) {
    const data = object(parse(row.data)); add(row.session_id, [...(Array.isArray(data['images']) ? data['images'] : []), ...parts(data['contentParts'])], 'legacy-user-message');
  }
  for (const row of db.prepare('SELECT session_id, file_ids, content_parts FROM drafts').iterate() as Iterable<{ session_id: string; file_ids: string; content_parts: string | null }>) {
    const ids = parse(row.file_ids); add(row.session_id, [...(Array.isArray(ids) ? ids : []), ...parts(row.content_parts === null ? undefined : parse(row.content_parts))], 'legacy-draft');
  }
  // Finish every read iterator before issuing writes. This also allows an
  // insertion fault to roll back and close the DB without an active cursor.
  for (const { sessionId, fileId, source } of references.values()) grant.run(sessionId, source, at, fileId, sessionId);
}

function backfillNativeReasoningEffort(db: Db): void {
  const sessions = db
    .prepare('SELECT id, agent FROM sessions WHERE reasoning_effort IS NULL')
    .all() as { id: string }[];
  const events = db.prepare("SELECT native FROM events WHERE session_id = ? AND kind = 'internal' AND native IS NOT NULL ORDER BY seq");
  const update = db.prepare('UPDATE sessions SET reasoning_effort = ? WHERE id = ? AND reasoning_effort IS NULL');
  const tx = db.transaction(() => {
    for (const session of sessions) {
      for (const row of events.all(session.id) as { native: string }[]) {
        try {
          const native = JSON.parse(row.native) as Record<string, unknown>;
          const effort = native['type'] === 'system' && native['subtype'] === 'init'
            ? native['effort']
            : native['type'] === 'request/header'
              ? (((native['data'] as Record<string, unknown> | undefined)?.['header'] as Record<string, unknown> | undefined)?.['config'] as Record<string, unknown> | undefined)?.['reasoningEffort']
              : (native['thread'] as Record<string, unknown> | undefined)?.['reasoningEffort'];
          if (typeof effort === 'string' && effort !== '') {
            update.run(effort, session.id);
            break;
          }
        } catch {
          // Ignore unrelated internal frames and continue looking for thread/start.
        }
      }
    }
  });
  tx();
}
