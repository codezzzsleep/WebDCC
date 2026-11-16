# Claude task view and output identity

This stage builds on #207's shared task projection. It delivers the Claude task
view and actor output portion of #65/#66, linked to #51/#84. It does not merge,
deploy, or close the aggregate implementation Issues.

## Behavior

The public task bar shows the native task hierarchy and current run, including
running, paused, completed, failed, stopped, and unknown states. Unknown parents
remain native IDs; they do not create phantom tasks. Cyclic parent observations
remain inspectable without recursive rendering failure. The task list can be
expanded and is bounded on desktop and mobile screens.

Child text, thinking, tool inputs/results, terminal summaries and output-file
origins retain their own identities. Native session, parent tool, message and
block fields survive streaming, completion, SQLite persistence and replay.
Child events use session scope and are excluded from the parent answer. Child
TaskList/TodoWrite results cannot replace the parent plan. Existing root task
creation/deletion remains covered by its regressions.

Previous run output stays under the previous run. The native spawning-tool join
is used only when it identifies one known task run. If a tool ID is reused
across runs and the message has no run identity, its output remains under
"task identity pending". It is not assigned to the newest run by arrival time.

Conversation references and relay excerpts use the main actor's assistant
output. SDK messages, prompts, tools, permissions and agent execution are not
changed. There is no simulated child input or Teams/dialog expansion.

## Native contract and recovery

SDK **0.3.322**, bundled CLI **2.1.322**; the SDK/source hashes are recorded in
the [projection report](claude-task-projection-20261116.md). Child content is
identified by native `session_id`, `parent_tool_use_id`, message ID and block
index. `task_started.tool_use_id` connects it to the originating task. The SDK
does not supply a run ID on every child assistant message, so ambiguous run
associations stay unknown.

The same task/run view is reconstructed from stored original SDK messages and
keyed live items. Missing snapshot membership does not create completion.
Changing the selected WebDCC session switches the event source and preserves
each session's tasks and output identities.

The actual source Chromium test verifies hierarchy, interleaved outputs, parent
answer separation, older/current runs, failed and unknown states, refresh,
WebSocket reconnect and session switching, with SQLite and real HTTP/WebSocket.
It also verifies readable 390px layout. Its producer is a controlled SDK-shaped
fixture sent through the production handler; it is not a live model or actual
`stopTask` execution. Original failed attempts remain in the private evidence
ledger: four original source regressions failed; browser navigation used an
unbroadcast synthetic title and timed out before the switch. The final test
uses actual session identity links and does not change product behavior.
An additional original reconnect assertion compared a fixed total receive
sequence while other events advanced it. The final assertion binds recovery to
the stored task message's sequence and checks its run and visible description;
the original failure is retained rather than credited as a pass.

The compatible 156-frame real Claude model/native trajectory is reused to
check existing main text/file/tool behavior. New model requests are zero. That
capture did not trigger task stopping or provider availability checks, and its
original validator failure remains recorded.

`perTaskStopAffordance` remains false. Actual single-task stop controls and
native/target-platform stop acceptance are subsequent work. Process-loss and
partial-output recovery remain separately scoped from the browser's stored
event refresh/reconnect check.

## Targeted verification

```sh
pnpm exec vitest run packages/adapters/claude/test/task-output-identity.spec.ts \
  packages/protocol/test/claude-task-view.spec.ts \
  packages/protocol/test/turn.spec.ts \
  packages/adapters/claude/src/content.spec.ts \
  packages/adapters/claude/test/task-deletion.spec.ts --maxWorkers=1 --minWorkers=1
pnpm exec vitest run --config vitest.browser.config.ts browser-tests/claude-tasks.spec.ts
```

Claude, server, web and script types and changed-file lint are checked before
PR delivery. Validation outcomes and evidence hashes are bound to the delivered
PR head in its private summary; the public PR records the scope and results.
