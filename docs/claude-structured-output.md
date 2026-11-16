# Claude structured results

Claude's explicit `output` control passes `{ type: 'json_schema', schema }` to
the next query's `Options.outputFormat`. `schema: null` clears that option.
The existing schema validator rejects invalid JSON Schemas before dispatch.
Query initialization returning successfully is an acceptance of the startup
operation; it does not establish that a model has produced a structured result.

The pinned Agent SDK is `0.3.322`, with Claude Code `2.1.322`. Its
`SDKResultSuccess.structured_output` is an optional `unknown` value. Objects,
arrays, strings, `null`, `false` and `0` remain their native values. Ordinary
`result` text is never parsed into a structured success. SDK error subtypes,
`errors` and `terminal_reason` remain separate from the value, including
`error_max_structured_output_retries` and explicit aborted turns.

The production listener and captured-frame replay both use
`claudeResultOutput`. The additive `structured.output` event preserves these
fields without changing other Agents' events:

| Field | Meaning |
| --- | --- |
| `nativeSessionId`, `nativeResultId` | The native session and result UUID, when supplied. |
| `queryId` | The adapter query instance that received the result. Older rows do not invent this identity. |
| `resultIndex` | The process's result sequence, when supplied; it is not a cross-query run identity. |
| `value` | The actual `structured_output` attachment. Its presence is distinct from a truthy value. |
| `status` | `completed`, `failed`, `interrupted`, or `unknown`. Missing output never establishes completion. |
| `nativeSubtype`, `terminalReason`, `errors`, `rawText` | The original outcome and failure content. |

The output card remains visible beside the ordinary answer. It uses the
existing event persistence and snapshot recovery; it does not depend on a live
query's in-memory result. Later ordinary turns and replacement queries preserve
earlier cards. Older `turn.completed.native` attachments can also be displayed
without rewriting their original rows. A new projection and its terminal
carrier display once. Query instance guards continue to reject messages from a
retired query.

Stored values, raw text and errors use the existing content redaction policy;
native identities and lifecycle enums retain their meaning. Rendering uses
text, and the copy action serializes the actual structured value as JSON.

This change delivers result projection and recovery. Recovery of the effective
advanced configuration after rebuilding a query is a separate Claude V1 stage.
It does not establish current Provider support for every legal JSON Schema or
complete target-platform acceptance.

`scripts/verify-claude-output.ts --out <new-private-directory> --run-id <uuid>`
runs the unchanged official SDK/CLI with a controlled local model and its
native `StructuredOutput` tool. It retains SDK frames, projected events, local
model requests and hashes under a unique identity. These are actual native
execution with a controlled model, not real model or target-platform evidence.
The script refuses to overwrite a previous run.
