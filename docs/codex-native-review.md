# Codex native Review

The native controls panel offers uncommitted changes, a baseline branch and a
commit SHA. Each submits the corresponding original `review/start` target with
`delivery: "inline"`; it does not send a chat message. A read-only `thread/read`
checks the native thread and its working directory immediately before submission.
A mismatch, failed read or changed runtime rejects the action before submission.

## Operation and execution identities

Official Codex 0.169.0 can acknowledge a Review operation with turn ID R, emit
`enteredReviewMode` under R, then report an execution turn A with `rootTurnId: R`.
Review items and its final completion remain under R. The upstream 0.168.0
source, commit `9480ec100c3edee9fc69172e8e80a4730444094d`, explains this in
`core/src/session/review.rs`: the Review parent has no `TurnStarted` event.
`core/src/tasks/review.rs` forwards execution starts, suppresses execution
completion and emits the formatted Review result and parent completion.

The Codex adapter establishes R only from a same-thread native Review marker or
a validated, correlated `review/start` response. Public items use that operation
binding; original frames, item IDs, execution IDs and request IDs remain intact.
Production and captured replay share the acceptance and notification handlers.
Reverse requests and client responses retain their separate ID namespaces.

`nativeState.activeTurnId` identifies the current native execution. The optional
Codex `nativeState.review` contains `rootTurnId`, the current `executionTurnId`
and observed `executionTurnIds`. Interrupt uses the current execution ID because
the official server checks its active turn identity. Only parent completion
finishes the public Review. Known late Review starts and accepted responses do
not reopen it or overwrite a newer turn. A new ordinary turn whose provenance
points to a completed Review keeps its own identity.

These optional fields do not change the public command ledger, database,
owner/generation checks or queue contract. An unrelated `rootTurnId` does not
create an alias or admit another native thread into the parent session.

## Results and recovery

The Timeline reads original `exitedReviewMode.review` Markdown, including the
native interrupted or missing-result text, without requiring generic tool JSON
expansion. It suppresses an identical final assistant copy in the same Review
while retaining both source records and separate commentary. Review markers are
not counted as executed tools.
Stored native marker rows render through the same reader after browser refresh.
The existing native action receipt remains separate from Review completion.

## Verification

```bash
pnpm exec vitest run packages/adapters/codex/test/review-stream.spec.ts packages/adapters/codex/test/review.spec.ts packages/adapters/codex/test/permissions.spec.ts packages/server/test/turn-stream-identity.spec.ts --maxWorkers=1
pnpm test:browser browser-tests/codex-review.spec.ts browser-tests/native-controls.spec.ts
pnpm exec tsx scripts/verify-codex-review-replay.ts --capture /private/existing-review.json --report /private/new-replay.json
pnpm exec tsx scripts/verify-native-codex-review.ts --binary /absolute/path/to/codex --report /private/new-native-review.json
```

Both scripts refuse to overwrite an existing report. The replay script consumes
an existing capture produced by the native verifier and starts no native process
or model request. The native verifier uses the actual official CLI, an isolated
Git workspace, production HTTP/WebSocket/SQLite/Chromium and a local Responses
model fixture. It registers each browser command before forwarding it, checks
all three targets, original formatted results, refresh and an actual interrupt,
then observes its own profile processes for at most five seconds before cleanup.

This is controlled-model native verification, not a current live Provider test.
An earlier failed capture remains failed even when its frames replay correctly.
Independent source acceptance, target-platform verification, live Review tool
use and project/environment/worktree workflows remain separate scopes under
#50, #75 and #42. This change does not add unverified project or queue APIs.
