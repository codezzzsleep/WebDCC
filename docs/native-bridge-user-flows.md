# Native bridge user flows

The native Agent continues to own its model loop, tools, configuration and
permission decisions. These repairs reuse existing transports and projections.

Known Codex descendants can send questions, approvals and MCP elicitation over
the parent's app-server connection. A pending request records its native thread
and request ID. Only a matching resolution settles it. Child requests remain
session cards rather than creating parent turns; cancelling parent requests does
not answer independently waiting child requests. Original native frames and
response formats remain unchanged.

DSH child history can request `includeActive=true` for the latest window. When
the native child is running, the adapter reads one passive `session/follow`
opening with `activate=false` and `assistantStream=true`, then releases the
subscription. The existing assistant bridge validates the dense native attempt.
The UI shows its uncommitted prefix and original stream records. Historical
paging stays pinned and excludes current attempts. A native settlement replaces
the transient view with committed history; it does not create a parent answer.

`@` reads the source session without subscribing or replaying its outboxes. It
uses the same completed `TurnView` answer as the timeline, including every final
part. Missing source history is read with existing bounded paging; incomplete
answers and failed reads leave the target draft intact. Late replies cannot
overwrite an edited or switched target draft.

Native attempt token totals remain unknown if an attempt did not report that
dimension. A reported zero stays zero. The UI distinguishes observed partial
usage from complete totals. Capability registration that has not been checked
is displayed as unverified coverage rather than a missing native function.

Automatic reconciliation still requires the original writer, profile and
terminal outcome proofs. Detached Claude SDK history and an already connected
DSH Host can be read without activating a writer. These reads use the currently
configured native profile or Host; they do not prove the original owner's
identity or release authority. They never unlock uncertain inputs or resend the
queue. The recovery page offers the existing native view and an explicit
independent new-session exit when automatic reconciliation is unavailable.

The trajectory verifier waits for the admitted user turn, not a count of
unrelated completions. Native events and provider chunks reset its idle deadline;
an explicit absolute observation budget remains. Defaults are 150 seconds idle
and 900 seconds total, configurable through `nativeIdleTimeoutMs` and
`nativeTurnMaxDurationMs`. It waits for started provider receipts before closing
owned services. A drain exceeding `receiptDrainTimeoutMs` (120 seconds by
default) records deferred cleanup and continues collecting the admitted calls.
Uncertain receipts stay failed and their inputs are not repeated.

Run `scripts/accept-deployed-trajectories.mjs` together with the cleanup and wait
helpers from the same accepted commit. Historical private validator copies and
their failed evidence are retained; a new run must use a new admission identity.
Source checks, controlled protocol fixtures, captured real replay and live
provider or target acceptance have separate meanings. Every production
deployment still verifies all three native Agents on its actual target.
