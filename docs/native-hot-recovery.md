# Retained hot output after loss of observation

When a WebDCC executor is gone, REST session details and WebSocket snapshots
can now display its last retained open items. Recovery uses the accepted mapped
envelopes in database ID order and the version 1 projection assignments recorded
by `NativeProjectionContexts`. Anonymous native turns retain their actual public
turn ID; session scoped items retain `null`. The original native bodies, mapped
data, owner, generation, Host, actor, parent and request identities remain intact.

Recovered items carry a separate `observation.state: lost` with their source
identities and envelope origins. A native command whose last reported status was
`running` keeps that data. The UI displays retained output and an observation loss
label without running animations, completion claims or interactive actions. No
Adapter is started, no command is resent, and no semantic terminal event, input
receipt or owner state is written by the recovery reader. A browser reconnect to
an existing runtime continues to receive its ordinary live snapshot. A different
live executor is not labeled lost by a second manager.

This increment covers current lost-owner root items: assistant text, reasoning,
commands, tool calls, file reads/changes, turn diffs and plans. Start replaces data;
delta appends the original text/output; update retains the complete mapped data.
Cancel, item completion and original turn termination close items. Persisted
semantic terminal events also suppress stale hot output. Late starts whose actual
assignment was already closed or ended do not reopen it. Recovery does not infer
native process termination from the loss of a Web connection.

Reads run in one SQLite read transaction. Missing or corrupt context, unsupported
schema, sensitive or missing body, unsupported hot kind and unverifiable prefix
produce explicit `recovery.coverage: partial`. To avoid reviving an item whose
later cancellation might be missing, a partial read returns no recovered items.
Reads stop at 5,000 envelope summaries or 2 MiB of relevant mapped bodies/output;
unread closure is reported as a limit, not a complete reconstruction. At most 50
issues are returned, with an omitted issue count. This is bounded current-owner
recovery, not complete historical turn, interaction or child-native reconstruction.
Those remaining contracts are tracked in #47.

New live deltas and updates do not append to a recovered browser prefix. A fresh
start replaces it, or an authoritative snapshot replaces the entire hot map.
Optional metadata keeps existing Agent fields and legacy snapshots compatible.
The semantic event replay cursor is unchanged and does not advance to native
envelope IDs. Conversation reset removes previous recovery metadata.

Verification distinguishes controlled `fake-1.0.0` mappings, actual SQLite/Node
SIGKILL and actual Chromium/HTTP/WebSocket recovery from official Agent and live
Provider acceptance. The latter and deployment are handled independently. No
official prompt, tool, permission or Agent behavior was changed.
