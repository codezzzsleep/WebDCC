# Claude task projection: source delivery

This stage covers the Claude task projection portion of #51/#65/#66, linked to
#84. The public task view and verified per-task controls are subsequent stages.
The aggregate Issues remain open. Source review, native acceptance, and
deployment are separate records.

## Resulting behavior

`ClaudeNativeState` and recovery from stored original SDK envelopes use the same
`ClaudeTaskProjection`. The projection preserves task/run/session identities,
parent and spawning tool, task and subagent types, progress, terminal summary,
output path/resource origins, native status, and the stopped notification.

An older or unidentified run cannot overwrite an identified newer run. A new
run starts with its own fields and does not inherit the old output or error.
Late start/progress/level messages cannot downgrade a terminal state. Ignored
run messages remain in the native ledger as session-scoped internal events.

Background membership is recorded separately from lifecycle. A level entry
does not manufacture `running`; an absent entry does not manufacture
`completed`. A description-only patch remains unknown. The SDK's `killed`
update displays as stopped while preserving `nativeStatus=killed`; it does not
manufacture the confirming stopped notification.

Task events are session-scoped. A parent's turn ending cannot determine a
task's outcome. Task cards preserve stopped as a distinct outcome from failed.

## Native contract

- `@anthropic-ai/claude-agent-sdk`: **0.3.322**; bundled CLI: **2.1.322**.
- `sdk.d.ts` SHA-256:
  `c228b60931a217ea96e222ef41f47a0a83bee0a394d1735e3eb668e3f8838b2f`.
- `sdk.mjs` SHA-256:
  `1c70356fe073f6c5423fb7138e2f2f6580a790eb055ad247e5d7927f57b53e8b`.
- The five SDK messages are `task_started`, `task_progress`, `task_updated`,
  `task_notification`, and `background_tasks_changed`.
- Run IDs are opaque strings ordered by plain string comparison per task.
- The full background set is a per-process level signal. Its ordering relative
  to start and completion bookends is unspecified. It is not a terminal list.
- `stopTask(taskId)` returns independently of the subsequent
  `task_notification(status=stopped)`.

No SDK, native prompt, tool, permission, or agent behavior is changed.
`perTaskStopAffordance` remains false; single-task stop availability is not
claimed by this stage.

## Verification scope

The original source failed all 11 initial controlled regressions. The failures
were retained before implementation. The expanded final task regressions cover
unknown/pending/paused level semantics, old run isolation, terminal stability,
output origins, stopped classification, and reconstruction from original
stored envelopes. Existing Claude lifecycle, native controls, content, query
cleanup, permissions, and filesystem/stdio contract regressions passed.

The task replay test uses the existing `claude-code/default/S06/native.jsonl`:
SHA-256 `a949e872351ad2f13ece26b43403f487944232e72e6d58c25f585114ac7184f0`.
Its model transcript records the SDK/CLI versions above. The captured task is
`b1avilice`, run `0mwcram8t-5fd1d416`; its level and start bookend are preserved.
The recording does **not** contain its terminal task notification, so the test
does not invent completion from the parent result. Original fixture files and
golden expectations are unchanged. This historical fixture does not establish
current provider availability or supplied-provider acceptance.

The compatible previously captured real Claude trajectory was also replayed:
156 native frames, trace SHA-256
`159efc0462aa075b85a19d5c275dcdee1505c603e755c538a34e786eb1d6e584`.
It preserves main text and file/tool behavior, with zero added model requests.
Its original strict-validator failure remains recorded. It did not exercise
task concurrency or stop and is not credited to those acceptance scenarios.

Targeted checks:

```sh
pnpm exec vitest run packages/adapters/claude/test/task-projection.spec.ts \
  packages/protocol/test/claude-tasks.spec.ts \
  packages/adapters/claude/test/native-contracts.spec.ts \
  packages/adapters/claude/test/lifecycle.spec.ts \
  packages/adapters/claude/src/content.spec.ts --maxWorkers=1 --minWorkers=1
pnpm exec tsc -p packages/adapters/claude --noEmit
pnpm exec tsc -p packages/server --noEmit
pnpm exec tsc -p packages/web --noEmit
```

Actual concurrent task stopping, full refresh/reconnect/session switching, and
target-platform deployment acceptance remain to be completed independently of
this source projection delivery.
