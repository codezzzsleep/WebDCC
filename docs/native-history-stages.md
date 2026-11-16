# Completing a partial historical item

A reconnect opening can end with a tool call still in progress. Importing its
`item.start` persists a partial semantic event. The actual `item.complete` may
arrive in a later history batch after a service restart. Existing-item dedupe
previously dropped that result, leaving running or path-only data in history
even though the full result was retained in the raw records.

Schema 15 adds `native_history_partial_items`. Each row links a native start
record to its public event, scoped by session, native session, native turn,
item key, kind and projection version. Both pointers have foreign keys with
cascading cleanup. The row records partial projection evidence; it does not
declare native writer ownership or current native execution status.

An incoming complete can append the authoritative result only when the linked
partial event is still the latest item and its source sequence is older than
the result. Completion clears that partial proof in the same transaction.
Raw records, original start events, native and public identities remain intact.
An older result or an already persisted later terminal cannot replace the
current item. Duplicate native records still import once, and a tool result
does not manufacture a turn completion.

Version 14 retained no explicit stage index. Its DSH starts can be recognized
only from the retained `tool/call` source, exact call/item identity, matching raw
record and unambiguous public/native turn binding. Other unclassified legacy
records remain unconfirmed rather than being guessed from a running status.
This does not implement arbitrary versioned rebuilding or full actor recovery.

Migration adds a table and preserves existing rows and grants. A database
claiming version 15 without the stage fields is rejected. Existing deployment
database-range guards apply: an artifact that supports only version 14 cannot
open or roll back a version 15 database. Independent deployment owners must
bind the migration to the accepted artifact and their backup/recovery process.
This development window does not deploy or mutate a production database.

Source checks cover split success/failure with database reopen, legacy DSH
source-backed read failure, unclassified legacy data, absent native turns,
different item identities, source ordering, existing terminal preservation,
transaction failures during stage creation and cleanup, session deletion and
schema completeness. Before the fix, all 12 split-history cases failed while
retaining both raw records. Controlled `NativeHistoryRecord` values supply the
new cases; existing compatible native-history evidence remains separately
identified. SQLite, manager and source browser are actual local implementations.
No new official-native, provider, paid-model or production call is made.

See Issue #275 and `web_review/native-history-stages-20261116.summary.json` for
the final verification and evidence hashes. Independent source acceptance,
merge, Issue closure and complete three-Agent target verification/deployment
remain with the existing owners.
