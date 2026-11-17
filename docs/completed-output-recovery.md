# Completed output recovery in snapshots

An accepted native item can be retained with its actual Web assignment before
the corresponding semantic INSERT fails or the service exits. Session details
and WebSocket snapshots now include a read-only `completed` projection for
those missing immutable publications. The UI shows the original output in its
original public turn, including session-scoped `null`, without creating a
semantic sequence, changing replay watermarks or inferring a native turn result.

The reader reuses the versioned immutable native completion decoder and requires
the captured version 1 assignment. It verifies original metadata, owner,
generation, Host, schema and content digests. Original data and native fields,
actor/parent/request identities and every envelope origin stay intact. Equal
content in the same assigned scope is displayed once, with all original
assignments. Equal item keys in different actual Web turns stay separate.
Native opaque differences and explicit null values are retained as distinct
versions; conflicting versions are shown without choosing an arbitrary result.

Already committed semantic origins are not copied into another output card.
A matching committed mapping can certify that another retained envelope with
the same public/native/owner/item scope and bytes is already represented.
Late or unrelated client events cannot delete recovery data by item key alone;
only a committed original envelope or an authoritative snapshot replaces it.

Fenced runtimes also use the lost-observation snapshot. Their last native
`running` data remains unchanged and receives the separate lost marker, so the
UI does not keep showing a live animation. The owner check is repeated inside
the SQLite read transaction. A new live owner cannot be mislabeled lost when
it acquires the session between manager selection and snapshot reading.

Missing or corrupt context, unknown schema, sensitive or unavailable content,
unsupported kinds and child-native routing remain explicit in
`completedRecovery`. Reads are bounded to 5,000 summaries and 2 MiB; an unread
suffix returns partial coverage and does not silently select a completed
prefix. This increment covers immutable assistant/reasoning, command/tool,
file-read and terminal file-change output. Full historical turn, interaction,
child-native and turn-outcome reconstruction remain in #47.

The consumer does not invoke an Adapter, resend an input, release a writer,
change a command receipt or recreate a tool side effect. Native result fields
are recorded output; loss of Web observation is not evidence that a native
process stopped. #342 records assignments, #344 introduced retained hot output,
and #346 isolates SQLite publication errors; those remain separate deliveries.

Verification includes controlled mappings from all three Agents with actual
SQLite failures, Node SIGKILL, HTTP/WebSocket and Chromium refresh. Compatible
captured official Codex 0.169 tool completions are also replayed through the
current unmodified Adapter mapper and actual failed SQLite publication. Original
parent failure and uncaptured/untriggered scopes remain explicit. Replay does
not validate current Provider availability or deployment.
