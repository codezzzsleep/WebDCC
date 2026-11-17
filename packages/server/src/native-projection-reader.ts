import Database from 'better-sqlite3';
import { CURRENT_SCHEMA_VERSION } from './db.js';
import { NativeEventStore } from './native-events.js';
import { rebuildNativeProjection, type NativeProjectionRebuild, type NativeProjectionRebuildOptions } from './native-projection-rebuild.js';

/** A failed/future database is not migrated as a side effect of rebuilding. */
export function readNativeProjection(databasePath: string, options: NativeProjectionRebuildOptions = {}): NativeProjectionRebuild {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const version = db.pragma('user_version', { simple: true });
    if (version !== CURRENT_SCHEMA_VERSION) throw new Error(`Native projection rebuild requires database schema ${CURRENT_SCHEMA_VERSION}; found ${String(version)}`);
    db.pragma('query_only = 1');
    return db.transaction(() => rebuildNativeProjection(new NativeEventStore(db), options))();
  } finally { db.close(); }
}
