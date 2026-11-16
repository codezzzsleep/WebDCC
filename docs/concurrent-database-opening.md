# Concurrent database opening

Refs #304, #45 (NP-03), #46 (NP-04), #42.

Opening an existing database still performs initialization writes. The
previous deferred transaction first read schema metadata and then requested
a writer lock. Two Node processes reopening the same WAL database could
therefore fail with `SQLITE_BUSY` or `SQLITE_BUSY_SNAPSHOT` during the
permission-state initialization. A normal busy timeout cannot safely upgrade
an obsolete read snapshot.

The core initialization transaction now uses `BEGIN IMMEDIATE`, acquiring
the writer lock before its reads. Competing initializers wait before creating
their snapshot. The transaction remains atomic and errors remain errors;
there is no retry of native commands or suppression of storage failures.

The change adds no schema version, data migration or ownership inference.
Future and incomplete schemas retain their existing refusal, and failed
initialization rolls back without replacing commands, queued input, owner
identities or persisted native evidence.

Directed verification uses two real Node processes reopening one initialized
v15 database 40 times, retaining each result and comparing persisted records.
Separate tests cover refusal hashes and a real SQLite trigger failure.
Original BUSY/SNAPSHOT failures remain in the source evidence ledger.

This verification concerns reopening an initialized database. Concurrent
cold creation, simultaneous cross-version upgrades and complete native or
target-platform recovery are separate acceptance scopes. The original #300
child exit lacked stderr and is not retrospectively labelled as this error.
