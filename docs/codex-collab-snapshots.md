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

These checks use typed, controlled native shapes through the production handler,
manager, SQLite and source UI. The reviewed 0.169 schema defines the fields; the
official 0.168 TUI `multi_agents.rs` also demonstrates separate completed and
errored wait results. They do not establish a new actual 0.169 collab execution or
live Provider availability. Native V2 waits may wake for mailbox/input/timeout
and carry empty `agentsStates`; that behavior remains explicit. V2-only tool
results/activity, full independent child controls and target acceptance are
separate scopes. Official prompts, tools, permissions, features and versions
must not be changed to force these scenarios to trigger.
