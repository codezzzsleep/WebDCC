# Watchdog input receipts and native outcomes

Related to #280, #271 and #273. A recovery input can start a native turn
before its send call returns. A rejected or missing send receipt is separate
from that turn's outcome.

When a recovery turn remains active, Watchdog keeps its job in `recovering`.
A handoff keeps the saved parent/child link and the child's current observation.
It does not classify a transport error containing `429` as a native terminal
or create another recovery input. The native turn's own failed, completed or
interrupted result determines backoff, recovery or cancellation.

Without an active observation, an existing admission remains available for
reconciliation. Watchdog stops automatic retries and records the unresolved
input; it does not add a second input over queued or uncertain work. Known
failure before admission and already observed native terminal handling retain
their existing contracts.

The source regression uses a controlled adapter with actual Manager/SQLite
and native-shaped start/end events. It preserves unknown handoff and continue
receipts, confirms later native termination, and checks that an unobserved
uncertain input is not resubmitted. This does not establish current provider
availability or complete target-platform native acceptance.
