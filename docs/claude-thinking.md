# Claude thinking options

The session's native controls accept the tagged `ThinkingConfig` exported by
Claude Agent SDK 0.3.322. Submitting a change replaces an idle query and waits for
its native initialization. A running turn, background task or pending interaction
continues to block replacement.

| Requested value | Pinned SDK startup mapping |
| --- | --- |
| `{"type":"adaptive"}` | `--thinking=adaptive` |
| `{"type":"enabled"}` | `--thinking=adaptive`; the exported budget is optional |
| `{"type":"enabled","budgetTokens":1024}` | `--max-thinking-tokens=1024` |
| `{"type":"disabled"}` | `--thinking=disabled` |
| `null` | Remove the WebDCC override and inherit native settings |

Adaptive and enabled variants allow `display: "summarized" | "omitted"`.
Disabled allows only `type`; adaptive does not allow a fixed budget. A provided
budget must be a safe integer of at least 1024. Invalid combinations are rejected
before closing the current query. Enabled without a budget uses the same declared
adaptive-model boundary as an explicit adaptive request.

The native catalog preserves the requested object separately from `sdkMode`.
`thinkingMapping.modelEffect` remains `not-observed`: native startup acceptance
and a returned control call do not prove the thinking behavior of a generated
answer. The UI explains this when selecting the operation. No deprecated
`maxThinkingTokens` control or native SDK modification is introduced.

Verification uses three distinct scopes:

- Directed source tests validate tagged inputs, model boundaries, query options
  and compatibility with task, output and lifecycle behavior.
- A source HTTP/SQLite/Chromium test submits enabled without a budget, observes
  the accepted mapping, rejects an invalid budget without replacing the query,
  then reloads the current live configuration. Its SDK is controlled.
- Run `7a5280a5-b78c-4be3-89c2-323484b3de40` used the unmodified official SDK and
  CLI 2.1.322 to initialize all five rows and inspect the owned processes' actual
  startup arguments. It submitted no user prompts, model requests or live
  Provider requests and left no tracked processes. Its original source
  fingerprint is retained in the evidence summary; subsequent test-only changes
  do not count as a new native run.

The summary in `web_review/claude-thinking-20261116.summary.json` binds source,
native artifacts, evidence hashes and retained failures. Full independent source
acceptance, model effects and target-platform acceptance are separate. Advanced
configuration restoration after dispatcher restart is a remaining #78 scope.

Refs #78, #51, #42.
