import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;
// v6 adds a durable sent/awaiting-native state; v5 binaries cannot safely replay it.
export const CURRENT_SCHEMA_VERSION = 7;

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
  id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, name TEXT NOT NULL, mime TEXT NOT NULL,
  size INTEGER NOT NULL, created_at TEXT NOT NULL
);
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
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = FULL');
  db.exec(SCHEMA);
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS native_owners (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      agent TEXT NOT NULL, host_id TEXT NOT NULL, native_id TEXT,
      owner_id TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL,
      active_native_turn_id TEXT, last_observed_seq INTEGER,
      lease_until INTEGER NOT NULL, observed_at TEXT NOT NULL,
      server_pid INTEGER NOT NULL, server_boot TEXT NOT NULL, server_start TEXT NOT NULL
    ); CREATE UNIQUE INDEX IF NOT EXISTS native_owners_identity ON native_owners(host_id, agent, native_id) WHERE native_id IS NOT NULL;`);
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
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
  })();
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
