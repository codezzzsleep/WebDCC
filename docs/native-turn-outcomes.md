# Rebuilding recorded native turn outcomes

`readNativeTurnOutcomes(databasePath, options)` reads an existing schema15
SQLite database with `readonly`, `fileMustExist`, `query_only`, and one read
transaction. `rebuildNativeTurnOutcomes(source, options)` is the pure decoder.
Both return a version1 `native-turn-outcomes` evidence artifact. They do not
invoke Adapters or update events, commands, queues, receipts, or ownership.

Supported inputs are accepted `turn.end` mappings and validated
`item.complete` / `turn.completed` mappings with explicit completed, failed,
or interrupted status. A persisted `native_turns` binding supplies the original
Web turn ID. The legacy binding table has no native session column, so the
SQLite reader additionally requires a committed public event linked to an
accepted original envelope with the same native session and turn. Current
session state alone does not certify an old association. Missing witnesses
remain unverified; no new Web turn ID is allocated.

Each result retains the native status, usage, original native and public IDs,
and complete redacted source envelopes in `origins`. Identical JSON values
deduplicate while retaining every origin. Session, Agent, native session,
native turn, public turn, recorded Host, actor, and parent tool identities form
the versioned scope. Contradictory results within that scope retain all outcomes
and mark their records as conflict. The reader never chooses a terminal result
by arrival order.

Bare `turn.end` mappings do not supply a recoverable Web runtime duration or
answer projection. The artifact therefore does not invent `durationMs`, answer
item references, or a UI `turn.completed` event. Such fields in a recorded
completion item remain available in its original envelope. This is a bounded
outcome reconstruction step; full turns, hot items, interactions, and snapshots
still require their own versioned context and mappers.

Every selected raw record has a rebuilt, duplicate, conflict, raw-only,
unsupported, unverified, or unavailable status. Missing binding, unsupported
schema, stale disposition, conflicting metadata/runtime identity, omitted or
sensitive content, malformed JSON, and output limits remain explicit.
`complete` applies only to this artifact's selected native terminal scope. It
requires a nonempty fully supported window without conflicts or a remaining
page. It does not establish complete native history or current writer release.
`next` is a processed SQLite raw row ID, not a native continuous watermark.

Options accept an optional session, `after`, 1–500 record limit, and a 4KiB–2MiB
JSON output cap. Excluded large records have an unavailable marker when it fits;
otherwise the cursor remains before that record. Empty or partial output cannot
claim complete reconstruction. The reader returns an object and provides no
file-output replacement path.

Tests use actual SQLite terminal projection abort, read-only reopen and byte
checks, and a real Node SIGKILL after raw persistence but before semantic
completion. They also cover three controlled Agent identities, all native
terminal statuses, duplicate/conflicting results, unavailable sources, and
pagination/budget boundaries. These are controlled source tests, without a new
official Agent, live Provider, paid model, or target deployment call.
