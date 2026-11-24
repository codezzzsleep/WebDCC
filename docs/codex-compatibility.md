# Codex 0.167.0–0.169.0 and 0.172.0 compatibility

WebDCC keeps its original 0.167.0 request/schema baseline and accepts the
reviewed 0.167.0, 0.168.0, 0.169.0 and 0.172.0 releases. Other releases,
unknown versions and prereleases are rejected before launching a session.
Extending this list requires protocol review and native behavior verification.

The 0.169.0 response schema is the unmodified output of
`codex app-server generate-json-schema`. Its SHA-256 is
`96ad5012f080b182a7ecfe2a0179ef04a8f9be80ff5e680f28afb37d9b4cf995`.
The native inventory records this file, its hash and the runtime version list.
Outgoing requests retain the earlier strict contract; incoming results and
reverse requests use the export selected by the actual executable version.
The experimental question-mode
definitions used by this client are unchanged in 0.169.0.

Compared with the 0.167.0 baseline, the 0.169.0 stable method catalog removes
no client requests, server requests or notifications. The reviewed changes
include an optional `model/list.modelProvider`, optional agent-message
moderation, an additional error category and the `input_audio.file_id` output
form. The 0.168.0 official schema was also checked against the newer catalog.
This compatibility work does not claim every newly introduced upstream feature
has a structured WebDCC interface.

## 0.172.0 protocol review

The unmodified installed official 0.172.0 stable schema is retained separately
as `compatibility-0.172.0.schemas.json`, SHA-256
`88f541c50da39797a301e606fc3b40ec6fa4f97926fb89bfdda2336780333a61`.
The existing frozen schema and 0.169.0 compatibility export are retained.
The native inventory binds both incoming contracts and the exact runtime list;
0.170.0 and 0.171.0 have not been admitted by this review.

No existing stable client requests, reverse requests or notifications were
removed. The additions are `modelProvider/default/set` and
`thread/search/partial`. MCP responses and elicitation requests add an optional
`environmentId`; model discovery adds Daybreak availability. The moderation
display changes from an `action` object to a versioned `show`/`hide`/`block`
union, and Project responses drop `position`. These changes require a separate
incoming validator rather than treating the new export as an old-version
contract. Validators are cached by contract and method, including temporary
catalog/observation processes; outgoing requests remain pinned. The existing
experimental collaboration-mode definitions are unchanged in the actual
0.172.0 export.

The adapter probes the actual help for the official Unix transport on 0.172.0,
preserving the existing native CLI peer path. Probe metadata publishes the exact
supported versions, so the browser does not describe the frozen request schema
as the only installable runtime. Compatibility checks do not establish account
availability, full upstream feature parity or deployment acceptance.

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
