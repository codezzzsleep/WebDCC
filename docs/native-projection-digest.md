# Versioned native completion identity

Refs #310, #47 (NP-05), #295, #297, #42.

An unchanged tool completion containing Unicode JSON keys could acquire a
different projection key after Node locale changed. Reopening the same
SQLite database then appended the completion a second time even though its
native session, item, sequence and content were unchanged.

Completion keys now use a versioned JSON digest with deterministic key order,
an explicit native-completion namespace and the source Agent. The existing
native scope/binding identity remains the input. The command digest reuses
the same encoding with identical bytes and its existing API; other shared
queue, native-action and revision digests retain their existing format.

An old key may be aliased only through its real committed semantic event
and native mapping in the same Agent/session/native/turn/item/kind scope.
Matching a recognized old digest remains sufficient. Otherwise, a complete
mapping can certify its canonical identity across locale. Old keys and raw
observations remain stored. A missing event pointer or pending transaction
is not a committed projection.

An omitted, redacted or unknown-format identity remains explicitly
`legacy-projection-unverified`. Its mapping receipt reports `unverified`,
not a verified duplicate. The manager skips that semantic completion and
clears only its matching hot item; it does not dispose or interrupt the
native writer or change accepted input outcomes. Raw capture precedes the
writer transaction that certifies and records an alias.

Two additive item/envelope lookup indexes support the compatibility query.
There are no new tables, columns or schema version. A projection key version
is separate from the existing semantic projection version.

Source regression uses actual en-US/sv-SE Node processes, SQLite reopening,
ten replays, complete legacy keys, missing/redacted/future identities and a
live FakeAdapter manager with a persisted native-accepted input. Native IDs,
raw observations and original failures remain available. These are controlled
mapping tests, not new official transport, provider or target acceptance;
complete Host/profile verification and rebuilding every UI projection from
all raw transport frames remain separate scopes.
