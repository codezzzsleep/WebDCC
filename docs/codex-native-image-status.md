# Codex image-generation status observations

The official `rust-v0.169.0` source at commit
`d32063f96c2dff1dc96af839b3952abb6acfeda4` uses `in_progress`, `failed` and
`completed` in `codex-rs/ext/image-generation/src/tool.rs`. The extension item
keeps status as a string; it is not a closed schema enum. The history builder
can also retain an empty status for a begin event.

The Codex adapter and the separate `codexNativeImageStatus` reader map the three
reviewed strings to running, failed and completed. Missing, empty, malformed
and future strings remain unknown. The reader does not infer status from an
encoded result, file, completion timestamp or nullable failure object. It keeps
the full original item, including inline result or file ID, revised prompt,
generation ID, transparent flag, saved path, input-image hashes and quota
failure/limit/reset fields.

The existing Codex native tool status display uses this reader for live and
stored cards. An earlier normalized completed status cannot replace the original
native in-progress or unknown status. Reading a legacy row does not rewrite it.
Ordinary imageGeneration-named Claude/DSH tools retain their own behavior.
The WebSearch reader and its additive lifecycle field remain separate.

```bash
pnpm exec vitest run packages/adapters/codex/test/image-status.spec.ts packages/protocol/test/codex-image-generation.spec.ts packages/adapters/codex/test/native-tool-status.spec.ts packages/protocol/test/codex-tool-call.spec.ts packages/adapters/codex/test/collab-call-status.spec.ts packages/protocol/test/codex-collab.spec.ts --maxWorkers=1 --minWorkers=1
pnpm test:browser browser-tests/codex-image-status.spec.ts browser-tests/codex-native-tool-status.spec.ts
```

Issue #351 was reproduced using unmodified reviewed 0.169 schema shapes through
the actual producer: in_progress, empty and future statuses previously became
completed; completed/failed controls were correct. Tests preserve result and
file-backed forms, original call/turn/envelope identity, quota errors, nullable
fields, immutable legacy data and ordinary other-Agent cards. Source Chromium,
HTTP/WebSocket and SQLite validate live progress and failure plus refresh.

This is official-source/contract evidence and controlled native-shape source
validation. Actual image-generation execution and current Provider behavior are
not captured. No paid image task or new native/model input is submitted to force
the behavior. The installed official 0.169 executable, original 0.167 outgoing
contract and 0.169 compatibility schema are unchanged; schema SHA-256 is
`96ad5012f080b182a7ecfe2a0179ef04a8f9be80ff5e680f28afb37d9b4cf995`.
The shared manager, database, queue, command journal and owner/generation are
unchanged. Full native and target-platform acceptance remain separate scopes.
