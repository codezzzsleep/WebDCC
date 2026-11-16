# Codex native Markdown plans

The official Codex `ThreadItem` plan contains `id` and Markdown `text`.
It is a document, distinct from the structured checklist in
`turn/plan/updated`. WebDCC displays the document in the turn timeline and
keeps the existing checklist in the task panel.

`item/started`, `item/plan/delta` and `item/completed` share the original
item key and native turn identity. A delta without a preceding start opens
the item once. A late start preserves streamed text. The completed item's
text replaces the draft, including when the final text is empty or differs
from the concatenated deltas. The official `PlanDeltaNotification` contract
explicitly calls deltas experimental and warns that concatenation may differ
from the completed plan content.

After native completion, late deltas, starts and duplicate completion remain
in the native evidence path without reopening the document. The production
handler and replay translator share the same plan stream handler. The replay
entry preserves frames with no visible projection as internal transport
observations; these do not create extra plan cards.

When the native turn ends before the plan item completes, WebDCC retains the
draft with `incomplete: true`. This records missing final evidence and displays
“计划未完成”. A later genuine completed item can replace that draft. Completing
a plan document does not complete its checklist, its goal, or another turn.
Child-thread documents remain outside the parent's plan stream.

The optional `EventData.plan.text` and `incomplete` fields preserve existing
`items` consumers. Markdown events do not clear a structured checklist.
Historical rows which already retained an original native `plan.text` can
display it without a database migration. Markdown uses the existing renderer;
raw HTML is not executed in the application origin.

The reviewed request baseline remains Codex 0.167.0. This work uses the
unmodified compatible 0.169.0 schema and installed official 0.169.0 binary,
without native upgrades or changes to native prompts, tools or permissions.
Schema hashes and compatible versions are documented in
[Codex compatibility](./codex-compatibility.md).

Reproduce the scoped checks:

```bash
pnpm exec vitest run packages/adapters/codex/test/plan.spec.ts packages/protocol/test/plans.spec.ts --maxWorkers=1 --minWorkers=1
pnpm exec vitest run --config vitest.browser.config.ts browser-tests/codex-plans.spec.ts
pnpm exec tsx scripts/verify-native-codex-plan.ts --binary /absolute/path/to/codex --report /private/native-plan.json
```

The browser regression runs production HTTP, WebSocket, SQLite and Chromium
with controlled native shapes. It verifies streamed content, refresh/reconnect,
authoritative final text, interrupted drafts, same-key turn isolation, checklist
compatibility, raw envelope identity and HTML handling.

The native script starts the unchanged official CLI in a private test profile
and uses a local Responses fixture with native Plan mode. It records the job
identity before native startup/input, original model protocol, native deltas
and completed item, binary/source/configuration fingerprints, browser recovery
and cleanup failures. This is actual native execution with a controlled model
response. It is not a live paid Provider call or captured real-model replay.
Failed or untriggered runs keep their reports and must not be counted as passed.

This delivery covers the Markdown plan sub-scope of #50 and related Codex #65.
It does not establish full native parity, service-crash recovery, latest model
behavior, current Provider availability, or target-platform acceptance.
Independent source acceptance, Issue closure and deployment remain separate.
