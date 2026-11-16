# Codex MCP and dynamic tool call lifecycle

The reviewed native MCP and dynamic tool statuses are `inProgress`, `completed`
and `failed`. The adapter maps them to the existing `running`, `completed` and
`failed` public statuses. Missing or unreviewed statuses stay `unknown`.

The original item remains the input and native evidence. Call ID, server/tool,
namespace, caller turn, arguments, result/error, content items, nullable success
and duration values are retained. The call lifecycle does not infer success from
result contents or generate an answer or turn. Live events, history and replay
use the same pure status reader.

The Codex timeline labels each call's native status from that original input.
Older rows with an incorrect normalized `completed` value can therefore display
their original running state after refresh without rewriting the persistent row.
Claude and DSH ordinary tools keep their existing display; collab calls use their
separate four-state contract.

```bash
pnpm exec vitest run packages/adapters/codex/test/native-tool-status.spec.ts --maxWorkers=1
pnpm test:browser browser-tests/codex-native-tool-status.spec.ts
```

These checks use typed, controlled items validated against the unmodified
official 0.169 compatibility schema. They exercise production handlers, SQLite,
HTTP, WebSocket and source Chromium, including Unicode content and old rows.
Actual MCP/dynamic execution and current Provider availability are **NOT_CAPTURED**
by these fixtures. The existing Codex trace corpus did not contain a compatible
MCP/dynamic item, and completed native tasks are not repeated to manufacture it.
Official tools, configuration, prompts, permissions, features and versions are
unchanged. Native target-platform acceptance remains separate.
