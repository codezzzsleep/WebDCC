# Claude accepted configuration recovery

Claude thinking, structured output schema and file checkpoint settings are
startup options. WebDCC records a complete accepted snapshot after the owned
query's native initialization succeeds. It restores those options when the user
reconnects that native session after query disposal or dispatcher restart.

The snapshot carries the query and native session identities, SDK/CLI versions,
requested model, a workspace/profile/Provider scope fingerprint, the original
options fingerprint and acceptance time. It does not contain credentials,
prompts, tool or permission overrides. Model, effort and permissions continue to
use their existing session/native control paths.

The restorable options are `thinking`, `outputFormat` and
`enableFileCheckpointing`. A complete empty snapshot clears older overrides;
false is preserved. `resumeSessionAt` is a one-shot operation and is never
replayed. Returning from a verified native CLI writer inherits native settings
and bypasses stored SDK overrides.

`GET /api/sessions/:id/native/claude-configuration` is an authenticated, Claude-only
read of the last accepted record. It returns `accepted`, `none` or `unavailable`
without creating a query or submitting an action. The UI labels this historical
observation separately from a currently initialized query. Connecting remains an
explicit operation. Startup acceptance and `modelEffect: not-observed` are kept
separate from the outcome of a generated answer.

Recovery rejects a changed native session, requested model, workspace, profile,
Provider endpoint or locked native version before starting a query. Output
schemas use the existing secret redactor; IDs, versions, typed thinking values
and booleans remain intact. If redaction changes the options fingerprint, the
record is unavailable and automatic restoration is refused. A malformed newer
record does not resurrect an older schema.

The existing query lifetime signal fences configuration projection. Retired
queries and repeated old init deliveries cannot publish over a newer query. A
failed replacement retains the previously accepted configuration through its
owned rollback. Restoration waits for native initialization again, and a late
success cannot accept settings or close a replacement query.

Source verification covers API reconnect, two SQLite connections and a reopened
dispatcher, rollback, clears, context boundaries and redaction. A source
HTTP/WebSocket/Chromium flow verifies historical reads before connection, one
explicit restored query, reload, a new socket generation, session switching and
a fresh tab while preserving the original structured result identity. SDK
messages and control promises in these source tests are controlled. Transient
read-only catalog queries are counted separately from session writers.

The locked SDK remains 0.3.322 and CLI 2.1.322. Previously captured official
startup mappings and structured output trajectories are reused only within their
original evidence scope. Source tests do not prove current Provider/model
behavior or a target-platform deployment. Native hooks, prompts, tools and
permissions are unchanged. Independent source acceptance and deployment belong
to the existing windows.

See `web_review/claude-configuration-20261116.summary.json` for exact source and
evidence hashes, retained negative results and validation limits. Refs #78, #51,
#49, #42.
