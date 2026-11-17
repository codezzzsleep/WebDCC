import Database from 'better-sqlite3';
import { CURRENT_SCHEMA_VERSION, type Db } from './db.js';
import { NativeEventStore } from './native-events.js';
import { readNativeProjectionContext } from './native-projection-context.js';
import { rebuildNativeTurnOutcomes, type NativeTurnOutcomeOptions, type NativeTurnOutcomes, type NativeTurnOutcomeSource } from './native-turn-outcomes.js';

/** No migration, source writes, Adapter calls, or live outcome application. */
export function readNativeTurnOutcomes(databasePath: string, options: NativeTurnOutcomeOptions = {}): NativeTurnOutcomes {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const version = db.pragma('user_version', { simple: true });
    if (version !== CURRENT_SCHEMA_VERSION) throw new Error(`Native turn rebuild requires schema ${CURRENT_SCHEMA_VERSION}; found ${String(version)}`);
    db.pragma('query_only = 1');
    return db.transaction(() => rebuildNativeTurnOutcomes(storedNativeTurnOutcomeSource(db), options))();
  } finally { db.close(); }
}

/** Read-only source shared by a single Store read transaction. */
export function storedNativeTurnOutcomeSource(db: Db): NativeTurnOutcomeSource {
  const native = new NativeEventStore(db);
  return { schemaHash: native.schemaHash,
      list: (session, after, limit) => native.list(session, after, limit), get: id => native.get(id),
      restricted: session => native.restricted(session), diagnosticValue: value => native.diagnosticValue(value),
      context: id => readNativeProjectionContext(db, native, id),
      // The legacy binding table does not include native session identity.
      // Require a committed public event with its original accepted envelope
      // to certify that association, rather than guessing from current state.
      publicTurn: (session, nativeId, nativeTurn) => (db.prepare(`SELECT t.turn_id FROM native_turns t
        JOIN native_event_envelopes e ON e.session_id = t.session_id AND e.native_turn_id = t.native_turn_id
        JOIN events v ON v.native_envelope_id = e.id AND v.session_id = t.session_id AND v.turn_id = t.turn_id
        WHERE t.session_id = ? AND t.native_turn_id = ? AND e.native_id = ? AND e.source = 'mapping'
          AND e.disposition = 'accepted' LIMIT 1`).get(session, nativeTurn, nativeId) as { turn_id: string } | undefined)?.turn_id,
    };
}
