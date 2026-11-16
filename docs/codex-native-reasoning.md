# Codex native reasoning content

Codex `ThreadItem.reasoning` has independent `summary` and `content` arrays.
`item/reasoning/summaryTextDelta.summaryIndex` addresses summary parts;
`item/reasoning/textDelta.contentIndex` addresses body parts. WebDCC keeps the
existing `reasoning.text` summary and adds optional `nativeContent` entries
`{ index, text }` for the original body. Sparse indices remain explicit without
allocating empty arrays up to an untrusted index. Other Agents keep their fields.
The native index contract is int64. Nonnegative JavaScript safe integers retain
their exact index, including values above u32; inexact or malformed indices stay
in the original envelope and produce a diagnostic unknown item.

The production handler and replay share the same indexed reducer. Completion
uses original native content, including empty parts and whitespace. When the
native completion does not include previously streamed content, those observed
parts remain marked incomplete. An interrupted turn records unfinished body
before closing; known late frames do not reopen it or alter another turn.
A late item start fills summary parts not yet observed while retaining any
already streamed summary or body parts.

The existing thinking view offers a separate collapsible native body. Old rows
read `native.content` through the same helper without a storage migration.
No text is inferred from encrypted content. The command ledger, database,
owner/generation and other Agent adapters are unchanged.

The original 0.167.0 schema and reviewed 0.169.0 compatibility export are retained.
Official 0.168.0 source `9480ec100c3edee9fc69172e8e80a4730444094d` sends raw
content events in `core/src/session/turn.rs` and maps them to public app-server
notifications; the adapter handles the native fields rather than changing the
CLI, prompts, tools or permissions.

```bash
pnpm exec vitest run packages/adapters/codex/test/reasoning-content.spec.ts packages/adapters/codex/test/reasoning.spec.ts packages/protocol/test/codex-reasoning.spec.ts --maxWorkers=1
pnpm test:browser browser-tests/codex-reasoning-content.spec.ts
pnpm exec tsx scripts/verify-codex-reasoning-replay.ts --capture /private/existing-native-body.json --report /private/new-body-replay.json
pnpm exec tsx scripts/verify-native-codex-reasoning-body.ts --binary /absolute/path/to/codex --report /private/new-native-body.json
```

The verifier registers the native/input identity before submission, uses the
official CLI and production Web/SQLite/Chromium with one controlled local model
response, then compares original summary, content, indices and refresh. It does
not overwrite existing reports or call a paid Provider. This is actual native
execution with a controlled model; live models that do not return plaintext
content are not claimed as tested. Current Provider, full native recovery and
target-platform acceptance remain separate under #50/#65/#42.

The replay command reuses only the original transport RPC envelopes through the
production handler, manager, SQLite and browser. It compares native item/turn
identity, original summary and body parts, terminal status and refresh without
launching the CLI or submitting model input. The report retains the original
capture hash and outcome; replay does not establish current Provider availability.
