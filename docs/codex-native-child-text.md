# Codex child text before native completion

Known Codex child threads retain `item/started` agent-message text and
`item/agentMessage/delta` text in the existing child task view. These passive
observations preserve the native child, parent, turn and item identities. They
do not admit a parent Web turn or append a child answer to the parent's answer.
Unknown lineage and missing native turn/item identities remain raw evidence.

The existing session-scoped `subagent` tool observation has additive output
fields `resultStart` and `resultDelta`, containing the native turn ID, item ID
and original text. A start can also retain nullable native phase metadata.
Each delta stores its original chunk once, rather than a growing copy of the
entire prefix. The pure `currentCodexSubagents` projection rebuilds the text
under `results` with `incomplete=true`; the source UI labels it “正文未完成”.
Reading these fields does not modify stored rows. Earlier completed-result
rows remain compatible.

`item/completed.text` remains the authoritative complete result in the existing
`output.result` field. It replaces the partial text, including when the native
final text is empty or differs from the streamed text. Only this item completion
removes the incomplete marker. A completed, failed or interrupted child turn
without its completed message preserves the partial body and its marker.
Child-turn status and message completion therefore remain separate facts.

The adapter restores native terminal turn and message identities from persisted
child views. Late starts/deltas do not reopen those bodies; an authoritative
completed item can still arrive after its turn ended. Old-turn text and item
completion cannot replace the current child turn or task state. Accepted text
from the current child turn also participates in the existing process-local
collab snapshot fence, so an older caller observation remains visible with
`applied=false`. Text from an older child turn cannot invalidate a current query.

## Source checks and original replay

```bash
pnpm exec vitest run packages/adapters/codex/test/child-text.spec.ts packages/protocol/test/codex-child-text.spec.ts packages/adapters/codex/test/subagent-identity.spec.ts packages/adapters/codex/test/collab-snapshots.spec.ts packages/server/test/codex-subagent-watchdog.spec.ts --maxWorkers=1 --minWorkers=1
pnpm test:browser browser-tests/codex-child-text.spec.ts browser-tests/codex-subagents.spec.ts browser-tests/codex-collab-snapshots.spec.ts
pnpm exec tsx scripts/replay-codex-child-text.ts --capture /private/existing-collab-capture.json --report /private/new-child-text-replay.json
```

Unit and source-browser cases use controlled native shapes and the actual
producer, manager, SQLite, HTTP/WebSocket and Chromium. They cover two children,
reused item IDs, nullable phase, empty final text, interrupted/failed/completed
turns without a final item, old snapshots, restored identities and immutable
legacy rows. The native 0.167 outbound contract and unmodified reviewed 0.169
compatibility schema remain unchanged; the latter's SHA-256 is
`96ad5012f080b182a7ecfe2a0179ef04a8f9be80ff5e680f28afb37d9b4cf995`.

The replay command reads an existing official 0.169 capture made with a controlled
local model. It preserves the capture and creates a new private report, stopping
at the first original child delta to verify the incomplete body and browser
refresh, then replaying the remaining original frames and checking each delta's
native raw/mapping link, complete texts, parent terminal and final refresh.
It never submits a new native/model input. Native child/turn/item IDs identify
results directly; identical text is not used as a substitute for identity.

Issue #338 was reproduced with original envelope 86 of the #308 capture:
`Alpha offici` was already emitted by its known native child, but the old child
view had no result. That unchanged capture contains 105 RPC frames and 12 child
text deltas. Two native child tasks completed, while the original parent failed
and native wait was **NOT_TRIGGERED**; its 35 local model requests and zero paid
requests remain separate. Replaying it does not change the failed original run
into a successful native run.

Actual child interruption is not present in that capture; the terminal matrix
above is controlled source evidence. Independent child Stop needs the public
durable target/receipt contract recorded in #66. Native/service restart, current
Provider behavior and full target-platform acceptance remain separate scopes.
The shared command journal, queue, owner/generation and database schema are
unchanged, as are Claude and DSH behavior. Official prompts, tools, permissions,
features and native versions must not be altered to force a verification pass.
