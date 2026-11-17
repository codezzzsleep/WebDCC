# Recovering abandoned session creation commands

`create-session` commands have no `sessionId` while their native creation call
is pending. Session-owner recovery cannot identify these commands by the
eventual Web session. Previously, a service exit left them dispatching, and a
retry returned an `ok: true` dispatching placeholder without a session result.

Command acquisition now stores a version1 Web execution witness in
`app_settings`, under `command-execution:<commandId>`, in the same IMMEDIATE
transaction as the received-to-dispatching CAS. A failed witness write rolls
back the claim to received before native execution. Repeated acquisitions do
not replace the original witness. This uses the existing private settings table
and does not change the database schema, native protocol, command payload, or
public receipt format.

The witness records the Web executor's PID, boot identity, machine identity,
and process start ticks using the existing process identity helper. It does
not identify the native writer or prove the native operation's outcome.
Missing, malformed, unsupported, or unverifiable witnesses remain unknown.
PID reuse and a different boot identify a different Web execution process.

Recovery handles sessionless dispatching creation commands independently of
the list of recoverable sessions. A matching live Web executor remains
dispatching, including when another Manager or process performs recovery before
the native session is created. An exited or unverifiable executor leaves the
command uncertain. Unfiltered journal recovery preserves this live-global
exception while retaining the previous behavior for other in-flight states.
Received and terminal records keep their original payload, status, and receipt.

Retrying the original uncertain command returns `ok: false, code: uncertain`
and does not invoke native creation again. Reusing its ID with another payload
still produces a command conflict. This fix does not release a native writer,
claim that it finished, fabricate a user interruption, or reconstruct a missing
session creation result. Resolving that result requires the actual native
identity and reconciliation interface.

Tests use actual SQLite trigger failures and HTTP command delivery, 100
concurrent identical HTTP requests, three controlled Adapter identities with
real Node SIGKILL during creation, database reopen, PID/boot/unknown witness
cases, and real cross-process recovery with both live and orphaned executors.
Existing send cancellation, queue persistence, interaction recovery, and
pre-native ownership failure regressions retain their separate evidence.
These tests do not execute an official Agent, live Provider, paid model, or
production deployment.
