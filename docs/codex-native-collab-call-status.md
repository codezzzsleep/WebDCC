# Codex native collaboration call lifecycle

`collabAgentToolCall.status` is the caller's lifecycle. It is separate from
`agentsStates`, child turns and child result messages. A completed call can
return running or errored children; an interrupted call does not establish that
the children stopped.

The adapter preserves the original item as input and native evidence. Native
`inProgress`, `completed`, `failed` and `interrupted` map to the existing public
`running`, `completed`, `failed` and `stopped` statuses. Missing or unreviewed
statuses remain `unknown`. Call IDs, sender/receiver IDs, caller turns, timestamps
and child states are unchanged. Live events, history and transport replay use the
same mapping.

The Codex timeline reads that original input through the same pure helper and
labels the call's status. This also corrects display of older rows whose
normalized status was incorrectly `completed`. The persisted row and original
envelope are not rewritten; other Agents keep their existing tool display.

```bash
pnpm exec vitest run packages/adapters/codex/test/collab-call-status.spec.ts --maxWorkers=1
pnpm test:browser browser-tests/codex-collab-call-status.spec.ts
```

The test fixture preserves five original RPC payloads from unchanged official
Codex 0.169 with a controlled local model: one parent start and two started/
completed spawn calls, original envelope IDs 47/58/64/82/102. Its source capture
hash and native binary version are embedded in the fixture. That original run
failed in the parent, and its wait observation was NOT_TRIGGERED; neither is
reclassified by this subset replay. Interrupted and unsupported status cases use
controlled shapes, and do not prove a new actual native interruption or current
Provider availability. The source browser check covers refresh and unchanged
legacy rows through the production manager, SQLite, HTTP and WebSocket.

No native mutation or new native/model task is needed for these checks. The
official request/compatibility schemas, prompts, tools, permissions, features
and version remain unchanged. Full target-platform acceptance is separate.
