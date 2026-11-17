# Codex native WebSearch item phases

The reviewed 0.169 `webSearch` ThreadItem contains its native ID, query, action
and optional opaque result array. It has no call-status enum. Its actual
`item/started` and `item/completed` notifications supply the item lifecycle.
The adapter preserves those observations as optional
`tool.call.codexItemPhase=started|completed`, mapping them to running/completed.
The original input item, native thread/turn/item identities and raw envelope
remain unchanged. Item completion does not claim search business success.

The same producer serves live processing and replay. The existing Codex tool
status view reads this phase for live and stored cards. Without a phase, an
explicit valid native item `completedAtMs` can establish item completion.
Absent, nullable, invalid or unsupported evidence remains unknown. A parent
turn ending, available results or an earlier normalized `status=completed`
does not establish native search completion. Legacy rows are read without
rewriting their data, and other Agents' ordinary WebSearch tools do not use
the Codex display.

Search, open-page, find-in-page and other native actions retain their original
nullable fields and Unicode text. The extension's results are opaque JSON;
new result types and fields pass through in the input rather than being
coerced or used to infer a successful search. MCP, dynamic and collab calls
keep their explicit native status rules.

```bash
pnpm exec vitest run packages/adapters/codex/test/web-search.spec.ts packages/protocol/test/codex-web-search.spec.ts packages/adapters/codex/test/native-tool-status.spec.ts packages/protocol/test/codex-tool-call.spec.ts packages/adapters/codex/test/collab-call-status.spec.ts packages/protocol/test/codex-collab.spec.ts --maxWorkers=1 --minWorkers=1
pnpm test:browser browser-tests/codex-web-search.spec.ts browser-tests/codex-native-tool-status.spec.ts
```

Issue #349 was reproduced with four legal started notifications under the
unmodified reviewed 0.169 schema. All four previously became completed;
four completed-notification controls were correct. Source checks cover
the four actions, timestamp evidence and its limits, same item IDs in old/new
turns, original results and metadata, legacy rows and other Agents. Source
Chromium/HTTP/WebSocket/SQLite verifies live progress, native completion,
raw/mapping links and recovery on a fresh connection.

These are controlled native-shape source checks. Actual native WebSearch,
current Provider behavior and target-platform acceptance are not captured by
this work, and no paid/native/model task is submitted to force the scenario.
The official 0.169 binary and compatibility schema are unchanged; schema
SHA-256 is `96ad5012f080b182a7ecfe2a0179ef04a8f9be80ff5e680f28afb37d9b4cf995`.
The original 0.167 outgoing contract remains fixed. The shared manager,
database, command journal, queue and owner/generation contracts are unchanged.
