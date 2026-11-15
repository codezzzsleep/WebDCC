# Codex 0.167.0–0.169.0 compatibility

WebDCC keeps its original 0.167.0 request/schema baseline and accepts the
reviewed 0.167.0, 0.168.0 and 0.169.0 releases. Older releases, future versions,
unknown versions and prereleases are rejected before launching a session.
Extending this list requires protocol review and native behavior verification.

The 0.169.0 response schema is the unmodified output of
`codex app-server generate-json-schema`. Its SHA-256 is
`96ad5012f080b182a7ecfe2a0179ef04a8f9be80ff5e680f28afb37d9b4cf995`.
The native inventory records this file, its hash and the runtime version list.
Outgoing requests retain the earlier strict contract; incoming results and
reverse requests use the compatible export. The experimental question-mode
definitions used by this client are unchanged in 0.169.0.

Compared with the 0.167.0 baseline, the 0.169.0 stable method catalog removes
no client requests, server requests or notifications. The reviewed changes
include an optional `model/list.modelProvider`, optional agent-message
moderation, an additional error category and the `input_audio.file_id` output
form. The 0.168.0 official schema was also checked against the newer catalog.
This compatibility work does not claim every newly introduced upstream feature
has a structured WebDCC interface.

Runtime process records, model-source labels, native catalog responses and
terminal targets report the actual executable version. Native history written
by a compatible earlier release remains observable, while CLI takeover still
requires matching executable/version evidence, history/settings reconciliation
and verified release of the prior writer.

## Validation on 2026-11-15

- Full source checks: typecheck, lint, native inventory, 580 unit tests,
  30 Chromium tests and production build passed.
- Actual installed 0.169.0 CLI with the production adapters and Chromium:
  all seven native question/default-mode/cancellation scenarios passed across
  Codex, Claude and DSH. Models for these scenarios were isolated loopback mocks.
- Codex goal view/set/pause/resume/clear, exact image/document bytes, a 4005
  character objective, editing after refresh and same-session CLI roundtrip
  passed. The latter verified the kernel writer lock, prior process exit,
  CLI message import/deduplication, repeated-return process identity and
  rejection of an external writer.
- Native `command/exec` duplex, Unicode, terminal resize/exit and explicit
  read-only sandbox passed without a model prompt. Streamed reasoning matched
  the direct native reference and persisted through the Web UI.
- One isolated request through the existing real Provider using `gpt-6.1-sol`
  returned the exact expected answer under read-only access, with no tool calls.
  Credentials and full provider data are excluded from public evidence.

Reproduce the native checks with an installed compatible CLI:

```bash
pnpm check:source
pnpm exec tsx scripts/verify-native-questions.ts --binary /absolute/path/to/codex --report /private/questions.json
pnpm exec tsx scripts/probe-native-slash.ts --agent codex --binary /absolute/path/to/codex --browser --sequence --fast --attachments --takeover --report /private/slash.json
pnpm exec tsx scripts/verify-native-process.ts --binary /absolute/path/to/codex
pnpm exec tsx scripts/verify-native-reasoning.ts --binary /absolute/path/to/codex --report /private/reasoning.json
```

The 0.167.0 fixtures and golden expectations were retained. Previously open
full native-parity and L1 acceptance gaps are not closed by this compatibility
change. Service deployment and database rollback require separate operational
evidence and a complete pre-upgrade data backup.
