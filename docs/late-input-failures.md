# Late input failures

A submission response belongs to its admission turn, even when native has
already started its next autonomous turn in the same runtime generation.
`startTurn` may finish a failed input only while that exact runtime, owner fence
and turn are current. A late error for A must not finish B or clear B's active
native turn, streaming items or status.

Non-current submission errors use `CommandJournal.settleInputFailure` in a
SQLite immediate transaction. It updates only that input's dispatching,
native-accepted or uncertain admission. Queued work and confirmed
completed/failed/cancelled input or command states retain their existing receipt,
bytes, ordering and native request identity. Internal admissions remain supported.
Steer failure uses the same guarded settlement, retaining its confirmed-echo path.

The original RPC receipt and the independently observed native outcome remain
separate. A lost response stays a lost response; a known terminal admission is
preserved, and uncertain input is not blindly submitted again. The current input's
ordinary failure handling remains unchanged by this turn-ownership fix.

Issue #264 covers A-uncertain/A-completed while B runs, old owner generations,
database reopen, rollback, internal inputs and terminal receipts. Controlled
adapters drive the actual manager/HTTP/SQLite; source Chromium confirms B streams
after A's error, completes only from B's own end event and survives reload.
These checks do not certify current official providers or target native platforms.
