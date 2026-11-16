# Codex child observations from native collab calls

The native `collabAgentToolCall.agentsStates` contains each target's last known
status and nullable message. Its call status is separate from those child states.
A completed wait does not imply a completed child, and an empty state map does
not supply a child result.

Known child identities retain each observation as an optional
`tool.call.output.collabSnapshot`: original call ID, sender thread, caller turn,
tool, call status, child status and message. `CodexSubagentView.snapshots` rebuilds
these records from persisted events; rows without the additive field retain their
existing identity, turns and results. The caller turn is never used as a child
turn. Unknown targets cannot establish a parent relation.

The adapter records the start of a native call and direct child observations in
process local state. A child change during the call, or a newer call that returned
first, prevents the older snapshot from changing the current child state. The
snapshot is still retained with `applied=false`. This Boolean describes Web
projection, not native acceptance or task success. Restored native call identities
prevent duplicate or late lifecycle frames from reopening a completed call.
Unreviewed child states remain evidence without a fabricated success or running
state. Calls without an observed start can only initialize an unobserved child.

The existing child details show original status/message and caller identity.
No parent answer, child turn, mutation, native tool response or queue is generated.
The shared manager, database, ownership and synchronization contracts are unchanged.

```bash
pnpm exec vitest run packages/adapters/codex/test/collab-snapshots.spec.ts packages/server/test/codex-subagent-watchdog.spec.ts --maxWorkers=1
pnpm test:browser browser-tests/codex-collab-snapshots.spec.ts
```

These tests use typed, controlled native shapes through the production handler,
manager, SQLite and source UI. The reviewed 0.169 schema defines the fields; the
official 0.168 TUI `multi_agents.rs` also demonstrates separate completed and
errored wait results. This controlled state matrix includes late returns,
overlapping child turns, restored call identities and unknown targets.

Actual unchanged Codex 0.169 with an isolated local model fixture also emitted
two native `spawnAgent` pending-init snapshots and completed two child tasks.
The capture contains 183 transport frames, including 105 RPC frames, and retains
the original child IDs, turns, result messages and failed parent. Its overall
verification failed: the fixture used the wrong wait argument and mishandled
internal child notifications. A native wait observation was **NOT_TRIGGERED**.
The 35 local fixture requests are recorded separately from paid Provider calls,
of which there were zero; cleanup reported no errors. Completed tasks are not
resubmitted to fill this missing scope.

Replay of those original 105 RPC frames verifies the pending-init snapshots,
completed child outputs, parent failure and browser refresh through production
code. It does not turn the failed native run into a successful wait validation,
and does not prove current Provider availability. Native V2 waits may wake for
mailbox/input/timeout and carry empty `agentsStates`; V2-only tool results/activity,
full independent child controls and target acceptance remain separate scopes.
Official prompts, tools, permissions, features and versions must not be changed
to force these scenarios to trigger.
