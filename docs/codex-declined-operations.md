# Native refused Codex operations

Codex's reviewed `CommandExecutionStatus` and `PatchApplyStatus` distinguish
`inProgress`, `completed`, `failed` and `declined`. A declined command did not
execute; a declined patch is proposed content, not an applied workspace edit.

WebDCC maps `inProgress` to running, native completion to completed, and native
failure/refusal to its existing non-success state. The exact original native
item and status remain in the native evidence and persisted event. Timeline
labels distinguish “命令已拒绝” and “改动已拒绝”. Refused commands are excluded from
the executed-command summary, and refused patches have no successful edit
count, change card or clickable applied diff.

Older rows may contain `data.status: completed` alongside an original native
item with `status: declined`. The pure projection and renderer consult that
item when its type is exactly `commandExecution` or `fileChange`. They correct
the view without rewriting the old data or discarding the refusal. Other
Agent file-operation logic and actual completed/failed command counts remain
unchanged. No database migration or native configuration change is required.

The concrete defect is #258, within #50 / NP-08. The installed development
binary remains official Codex 0.169.0. The original real command-refusal
evidence uses Codex 0.168.0; both status enums are unchanged in the reviewed
0.167.0 request baseline and unmodified 0.169.0 compatibility schema.

Reproduce the source and existing-capture checks:

```bash
pnpm exec vitest run packages/adapters/codex/test/operation-status.spec.ts packages/protocol/test/declined-operation.spec.ts --maxWorkers=1 --minWorkers=1
pnpm exec vitest run --config vitest.browser.config.ts browser-tests/codex-declined.spec.ts
pnpm exec tsx scripts/replay-codex-declined.ts --trace /private/interaction.jsonl --sha256 ORIGINAL_CAPTURE_SHA256 --report /private/declined-replay.json
```

The replay script consumes previously recorded native frames through the
production Codex Handler. It verifies the original trace hash, original
turn/item identity, refused command mapping and historical projection. It
executes no original native command or model request. Replay evidence does
not establish current Provider availability or latest model behavior.

The browser regression uses controlled native shapes with production
HTTP/WebSocket/SQLite/Chromium and checks both current and legacy data after
refresh. Patch refusal is covered by the reviewed native schema and controlled
fixtures; it has no real-model patch-refusal sample in the reused command
capture. Source implementation, independent source acceptance, live native
and target-platform acceptance, Issue closure and deployment are separate.
