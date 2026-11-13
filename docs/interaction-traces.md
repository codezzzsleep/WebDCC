# Real interaction traces

WebDCC records new live interactions by default. Set `WDCC_TRACE=0` to disable
the observer. Records live under `<WDCC_DATA_DIR>/traces` with directory mode
0700 and JSONL files mode 0600. They contain user/model content and remain
private; authentication is required for both summary and download endpoints.

The session menu offers **下载真实交互轨迹**. `GET /api/sessions/:id/trace`
returns coverage counters and incomplete-recording errors; `?format=jsonl`
downloads the correlated records. Historical sessions from before recording
was enabled have no retrospectively invented raw/model evidence.

| Source | Evidence |
| --- | --- |
| `web` | Original commands, attachment IDs, accepted/failed acknowledgements and turn input |
| `native` | Codex RPC; Claude SDK input/messages/permission callbacks; DSH RPC requests, results and mux frames |
| `model-http` | Actual request bodies, response headers/chunk times, raw byte counts/hashes, completed/failed/cancelled transport |
| `file` | Upload resolution; user file reads/saves with versions; independent before/after disk hashes for native file tools |
| `mapped` | Events emitted by the production Handler |

Each server-side record has `runId`, `seq`, `at`, `source`, `channel`, and its
available `sessionId`, Agent, workspace, native session and turn context.
Model request IDs join request/header/chunk/terminal records. Workspace user
file operations are shared evidence and carry workspace ownership, rather
than guessing which concurrent Agent owns an edit.

Request bodies and terminal response chunks use base64. Immediate chunk
observations contain byte counts and hashes; terminal records contain the
complete stream split at the original chunk boundaries. Credentials are
removed from headers and masked in stored payloads, including secrets split
across stream chunks. Hashes describe original transport bytes and therefore
can differ from the stored redacted bytes. Forwarding happens as bytes arrive;
recording does not delay the stream until completion.

Codex and Claude API Providers use a session-owned loopback forwarding route.
Native OAuth routes with opaque endpoints remain native-only, and that
coverage limit is recorded. DSH uses a native fetch observer and its official
`llm-pi-ai/request-headers` hook. Spawn mode loads it automatically. For an
independently managed/attached DSH, load the built
`native-http-recorder.cjs` through `NODE_OPTIONS=--require <module>`, set
`WDCC_TRACE_DIR`, and insert that module using a launcher `--patch` overlay.
Launcher flags must precede the web application's flags. An external host
without that observer provides native RPC evidence only.

Usage retains native input/output, cache read/write, reasoning, SDK per-model
totals and reported costs. Claude's input excludes cache buckets; Codex's
cached input is a subset of native input. Avoid summing those two conventions
the same way. SDK dollar totals are SDK/list-price estimates, not a gateway
invoice. `tok/s` uses locally observed generation time and is shown as an
estimate. Raw usage remains available for reconciliation.

L1 and L2 replay call the same production notification, SDK and mux handlers.
The legacy Translator exports are compatibility wrappers around those same
handlers. Native file/tool blocks have independent assertions against the
captured input, rather than only regenerating baselines. Live acceptance is
explicit (`scripts/accept-real-trajectories.ts --live`), uses isolated native
homes and a private configuration file, uploads through Composer, compares
actual image bytes in model requests and verifies real filesystem results.
Models that declare no image input must return an explicit rejection; their
text/file workflow is checked separately. No recording bypasses native model
capability validation.

File hashes are bounded to regular files up to 8 MiB and workspace paths.
Uncaptured/outside-workspace tool paths are explicitly recorded as coverage
limits. Shell commands can modify arbitrary files, so their effects require
an independent acceptance oracle; tool success text alone is insufficient.
