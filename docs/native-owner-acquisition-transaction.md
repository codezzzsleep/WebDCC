# Concurrent native owner acquisition

Refs #321, #46 (NP-04), #45, #42. Target updates while reopening are tracked
separately by #315 / PR #319.

Acquisition starts a SQLite writer transaction before reading the current
owner and target reservation. Concurrent requests serialize at that
boundary. The loser reads the committed owner and returns the existing
ownership conflict before its adapter resumes.

Previously, two deferred transactions could read the same old snapshot.
One then failed to upgrade its read transaction, producing SQLITE_BUSY or
SQLITE_BUSY_SNAPSHOT instead of the ownership conflict. Concurrent command
traffic could invalidate both snapshots, starting no owner. Those database
errors could become durable uncertain command receipts despite no native
resume taking place.

This changes acquisition's transaction mode only. The unique owner rule,
Host/Agent/NativeID identity, generation, lease and verified-release rules
remain in effect. Real lock timeouts and other database failures retain
their original errors; they are not rewritten as ownership conflicts.
No schema or native protocol changes are needed.

Directed tests run two real Node processes and SQLite connections. A fixed
pause in an actual acquisition read exercises concurrent commits through
the store and production HTTP command handlers, using FakeAdapters. The
same timing fixture runs before and after the change. Transaction failure,
old owner, queue and cancellation checks cover compatibility. These are
controlled local tests, not official native writer or provider acceptance.
