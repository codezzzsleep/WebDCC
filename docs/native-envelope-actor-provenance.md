# Explicit actor scope in native envelopes

Refs #47 (NP-05), #42. This change populates existing diagnostic identity
columns from explicit fields in incoming native envelopes. It does not change
the protocol schema, adapter behavior or session ownership.

The previous common extractor omitted Codex `params.thread.id` from
`thread/started` and could label a child opening with the parent connection's
native ID. Codex `params.threadId` and DSH mux waterfall `value.agentId` did not
populate `actorId`. The same generic `params.threadId` extractor also applied
Codex-shaped fields to other Agents.

The new small extractor keeps Agent scope separate from Web ownership:

- Codex thread-scoped request/notification `params.threadId`, and the nested
  thread ID in `thread/started`, supply the explicit thread scope. A returned
  `result.thread.id` retains native identity but does not prove an actor.
- The DSH Gateway's `RemoteEventInvocationFrame` declares the waterfall's
  `agentId` as its Agent scope. Other mux payloads, cancellations and RPC
  arguments do not supply that proof.
- Existing explicit `actorId`, `agent_id` and `parent_tool_use_id` metadata
  remains available. A Claude parent tool ID or subagent retry subject does
  not manufacture a missing actor ID.

The extractor unwraps the existing transport/adapter wrapper once. It does not
recursively search tool payloads for identity. Collaboration receiver IDs and
`item.agentThreadId` identify subjects and cannot replace the envelope's
scope. Empty or non-string identifiers do not certify identity. Web/Host
session scope, owner, generation, stale disposition, raw payload policy and
semantic projection deduplication remain independent.

Directed tests retain pre-fix observations and verify the corrected metadata,
cross-Agent and subject negative cases, typed request IDs, the public HTTP
inspector and disk database reopening. Chromium checks the unchanged global
inspector's record detail after reload and its existing safe raw rendering.
These are controlled source fixtures and actual local storage/HTTP/browser
checks; they make no new official native or provider calls.

Only newly recorded envelopes receive the added metadata. Existing rows and
raw evidence are preserved. Full actor provenance for native formats that do
not provide it, historical backfill and versioned raw projection rebuilding
remain separate NP-05 work. Source acceptance and target deployment belong to
the existing independent review and deployment windows.
