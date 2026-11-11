import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

/** SPEC 11.2 的表结构 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
  protocols TEXT NOT NULL, secret_ref TEXT NOT NULL, models TEXT NOT NULL,
  codex_catalog_path TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent TEXT NOT NULL, native_id TEXT, title TEXT,
  provider_id TEXT REFERENCES providers(id), model TEXT, access_mode TEXT,
  status TEXT NOT NULL DEFAULT 'idle', pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
  last_seq INTEGER NOT NULL DEFAULT 0, native_meta TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL REFERENCES sessions(id), seq INTEGER NOT NULL,
  turn_id TEXT NOT NULL, item_key TEXT NOT NULL, kind TEXT NOT NULL, native_seq INTEGER,
  data TEXT NOT NULL, native TEXT, at TEXT NOT NULL,
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
`;

export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  // M8 F16：Provider 增加来源与按协议的多端点
  const columns = db.prepare('PRAGMA table_info(providers)').all() as { name: string }[];
  const has = (name: string): boolean => columns.some((column) => column.name === name);
  if (!has('source')) db.exec("ALTER TABLE providers ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
  if (!has('source_key')) db.exec('ALTER TABLE providers ADD COLUMN source_key TEXT');
  if (!has('endpoints')) db.exec('ALTER TABLE providers ADD COLUMN endpoints TEXT');
  if (!has('note')) db.exec('ALTER TABLE providers ADD COLUMN note TEXT');
  return db;
}
