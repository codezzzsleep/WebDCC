# Codex native child command observations

An established native Codex child can publish `commandExecution` items and
`item/commandExecution/outputDelta` notifications without admitting a command
or turn into its parent. The observer now records those notifications as
session-scoped `subagent` observations. Parent/child edges still come from
native spawn or thread provenance; an unknown thread stays in the raw journal.

The existing opaque `tool.call.output` gains three optional Codex observations:

- `commandStart`: `{ nativeTurnId, itemId, native }`, with the full started item.
- `commandDelta`: `{ nativeTurnId, itemId, text }`, with the original delta.
- `command`: `{ nativeTurnId, itemId, native }`, with the full completed item.

The optional `CodexSubagentView.commands` list keys observations by child,
native turn and native item. It retains the original command, working directory,
PTY process ID, source, actions, plugin fields, nullable exit/duration and output.
`output` uses the native completed aggregate when it is a string, including an
empty string. `streamedOutput` separately retains observed progress, including
any initial started-item aggregate. A null final aggregate keeps captured
progress visible without replacing the original null. A delta before metadata
does not fabricate a command or workspace; a delayed start keeps that delta.

`incomplete` means no command `item/completed` was observed. A child turn end,
caller snapshot, parent failure or Web stop does not settle a command. Native
`inProgress`, `completed`, `failed` and `declined` are read as their own states;
missing or future status remains unknown. Completed item and turn fences reject
late starts/deltas, including after restoring a child view. A late completed
item can settle an interrupted partial command without changing a newer child
turn. Captured progress has its own nonterminal observation status, so equal
chunks remain separate even if a caller snapshot already marked the child done.

The child panel displays the command and output as text, keeps a different
captured stream alongside the native aggregate, and restores the same native
identities and results on refreshed WebSocket connections. Ordinary Claude/DSH
tools keep their existing behavior. Existing CLI/process controls and their
permissions remain separate; this passive observer submits no native input.
Old raw-only records retain their original bytes; historical raw reconstruction
and the shared durable child-stop receipt are separately tracked scopes.

```bash
pnpm exec vitest run packages/adapters/codex/test/child-command.spec.ts packages/protocol/test/codex-child-command.spec.ts packages/adapters/codex/test/child-text.spec.ts packages/adapters/codex/test/subagent-identity.spec.ts packages/adapters/codex/test/collab-snapshots.spec.ts packages/adapters/codex/test/collab-call-status.spec.ts packages/protocol/test/codex-child-text.spec.ts packages/protocol/test/codex-collab.spec.ts --maxWorkers=1 --minWorkers=1
pnpm test:browser browser-tests/codex-child-command.spec.ts browser-tests/codex-child-text.spec.ts
```

Issue #356 was reproduced with unmodified reviewed 0.169 item and delta shapes
through the production handler. Controlled source tests cover concurrent child
identities, full 250-line aggregates, repeated Unicode/CRLF chunks, null/empty
results, interrupted partial output, restoration, late frames, literal HTML,
SQLite persistence and raw/mapping links. The original 4 failures/3 controls,
13 failing/2 passing unit cases and a browser fixture import failure are retained.

Actual child command execution and current Provider behavior are not captured.
The existing official 0.169 child-text trace contains no child commands; its
replay only checks compatibility and retains its original failed parent and
untriggered wait. The installed binary, reviewed 0.169 compatibility schema and
0.167 outgoing contract remain unchanged. Shared manager/database/command/queue
and owner/generation protocols are unchanged. New native/model/paid inputs: zero.
