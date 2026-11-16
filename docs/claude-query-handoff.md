# Claude configuration query handoff

Claude startup-only controls replace an idle query. The old query must close
before another native writer starts. Query initialization and rollback are
asynchronous, so a user recovery or explicit close can supersede an operation
before its original SDK call returns.

Every continuation in `replaceIdleQuery` checks the captured query instance
and the adapter's generation. A late initialization or rollback failure cannot
dispose, clear permissions, overwrite settings or start another writer over a
new query. The superseded operation returns `uncertain` with its original error
content. An explicitly closed replacement stays closed.

When the failed query still owns its generation, the existing rollback to the
previous accepted native session and options remains available. If the owned
rollback also fails, the current operation still reports
`native-runtime-unavailable`. Public owner fencing is reused; the manager,
database schema and other Agents do not change.

The author checks use controlled SDK promises and messages through the actual
production adapter, HTTP routes, manager, native action receipts and SQLite.
They cover both initialization and rollback takeover, the retired pump window,
two retained tasks and a pending approval, uncertain receipt recovery through a
second database connection and reopen, and no resubmission of an old command.
These checks establish source behavior. They do not establish the occurrence of
the same timing on a current real Provider or the target platform.
