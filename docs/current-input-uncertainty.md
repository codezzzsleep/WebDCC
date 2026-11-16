# Current input with an unknown native outcome

A failed send response does not establish that the native turn failed or
finished. Previously the manager wrote `turn.completed(status=failed)`, cleared
the current turn and hot items, and ended the tracker while its command journal
reported `uncertain`. The real turn's later output and terminal could no longer
finish the admission through the current-turn path.

This change uses PR #265's guarded admission settlement. An explicitly
`not-submitted` error retains the existing known-failure handling. An unknown
result for the same runtime, owner and admission creates a warning and keeps
the input uncertain. A completed admission and its original receipt are
preserved. No RPC success or native terminal is manufactured.

When a native turn is already bound, its identity, hot items and observed
running/waiting state remain available. An unrelated native terminal cannot
finish it. Its own actual native end, including one already in the completion
settle window, determines its terminal state through the existing pipeline.
The uncertain input blocks queue dispatch and duplicate submission meanwhile.

When no native turn has been observed, the manager uses the existing managed
disposal and unobserved recovery contract. The input, request UUID and unknown
outcome survive; closing a channel is not completion proof. An unconfirmed
close is recorded separately and remains uncertain. Fresh sends cannot blindly
replay that input. Recovery still uses the existing Agent-specific read-only
reconciliation interfaces and their ownership checks.

The regression preserves five original failures, two test-fixture mistakes
and a cleanup-error failure. Final checks cover three controlled Agent
identities, native end after a lost response, an unrelated native end, a pending
confirmed completion, completed receipt preservation, no observed native turn,
unconfirmed disposal and actual SIGKILL/database reopen. Source Chromium checks
verify stop availability, WebSocket streaming and reload before the actual
native terminal. `FakeAdapter` (`fake-1.0.0`) supplies controlled native events;
manager, SQLite, HTTP/WebSocket, process kill and browser are actual local
implementations. New official-native, provider, paid-model and production calls
are zero; full native/target-platform acceptance is separate.

This PR depends on #265 and does not duplicate its implementation. Public
control lifecycle acceptance, including the shared activation fix in #270,
remains a separate integration dependency for the merge reviewers. It changes
no native Agent, prompt, tool, permission or schema. See Issue #271 and
`web_review/current-input-uncertainty-20261116.summary.json`. Existing windows
own independent acceptance, merge, Issue closure and deployment.
