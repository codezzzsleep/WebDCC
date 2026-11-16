# Optional diagnostics

Full interaction/model transport diagnostics are off by default. Enable them explicitly with `WDCC_TRACE=1` at server startup; every other value keeps them off. Test hooks disable automatic recording. Necessary session events remain in SQLite.

Diagnostic mode may add observer transport hooks and model endpoint proxies. These changes belong to diagnostic mode and do not count as baseline native behavior. The recorder never provides the bytes used to forward native inputs or outputs. Model requests stream to the provider with backpressure, and response bytes stream back without waiting for recording.

## Recorded values

Model HTTP bodies are masked before Base64 encoding and writing. The common policy removes registered credential values, sensitive header values and Cookie fragments, nested credential fields, escaped JSON credential strings, opaque encrypted content, bearer tokens, key prefixes and credential URL parameters. Request and response chunks are joined within the capture limit before masking, so a credential split between HTTP chunks is removed. Native protocol and Web/file records use recursive field redaction.

`sha256` on model diagnostic bodies and chunks describes the **redacted bytes**, with `digestScope: redacted`; it cannot prove that unmasked native bytes were recorded. `bytes` and chunk timing describe observed transport sizes and times. Independent workspace file hashes continue to describe the actual file contents. Controlled native tests must compare original transport bytes independently of diagnostic digests.

The controlled model observer passes already masked byte records to `recordModel`. Reapplying text substitutions to Base64 could corrupt it, so generic native/Web records and model byte records use separate recording entry points.

## Capture and write limits

| Setting | Default | Applies to |
|---|---:|---|
| `WDCC_TRACE_MAX_CAPTURE_BYTES` | 8 MiB | Each model request or response body |
| `WDCC_TRACE_MAX_CAPTURE_CHUNKS` | 4,096 | Each captured body |
| `WDCC_TRACE_MAX_FILE_BYTES` | 64 MiB | Each diagnostic JSONL file |
| `WDCC_TRACE_MAX_QUEUED_BYTES` | 32 MiB | Each writer's pending serialized records |
| `WDCC_TRACE_MAX_DIRECTORY_BYTES` | 512 MiB | Regular diagnostic files in each recording directory |
| `WDCC_TRACE_RETENTION_MS` | 7 days | Diagnostic file cleanup |

When body capture overflows, the entire captured body is omitted and `coverage.truncated` is set. Counts and native transport continue. Omitting the whole body avoids storing a cut credential prefix as complete evidence. Queue and file limits record an incomplete summary; a small coverage marker survives a server restart when its directory remains writable. Native preload write failures use a sibling coverage marker and bounded error reporting.

Cooperating writers use `flock` and one stable `.wdcc-diagnostic-writer.lock` file per directory. An owned helper checks the current size and performs append or replacement under that lock, including exact UTF-8 byte limits. Helpers serve queued writes and exit when the queue finishes; a parent exit closes their input and releases the kernel lock after the current write finishes.

Diagnostic targets must be regular files. The helper opens without following a final symlink and with nonblocking flags, verifies the actual descriptor before truncation or writing, and closes it after the operation. FIFO, socket and device targets report incomplete recording; they do not create a permanently waiting writer. An oversized replacement leaves the existing content intact. Path changes during the write are reported as incomplete evidence.

Optional diagnostic writes require the `flock` executable. A missing utility or a lock held beyond the one-second wait reports incomplete recording while native forwarding continues. The empty lock file contains no payload; keep its pathname while writers may be active. The same lock coordinates file and directory limits across cooperating processes.

The directory budget counts current regular-file lengths, including existing files, context records and per-session coverage markers. Append and replacement use their actual growth; restarting a writer does not reset consumed space. A full directory rejects new growth without creating empty recording files or deleting old content. Per-session failure records are bounded to 64 KiB and count against the directory budget, independently of the JSONL file limit.

One reserved `.wdcc-diagnostic-quota.json` file has an additional fixed 4 KiB allowance. It keeps a directory-wide incomplete signal and quota-rejection count when ordinary coverage cannot fit. Its reads and writes use bounded, verified regular-file descriptors; unavailable metadata stays explicit. This internal path cannot be used as a normal recording destination. A directory that already exceeds the configured budget is not automatically reduced. The budget governs cooperating writers and logical file bytes in that directory, rather than external file mutations or totals across different directories.

Retention cleanup runs at recorder initialization and at most once an hour when records arrive. It removes only expired regular diagnostic files in the trace directory, preserving unrelated files. It is not an idle background deletion timer.

Capture and pending-write limits still apply per observer/writer. A global active-capture budget, totals across different directories and a complete retention/export policy remain implementation and acceptance work. Existing recording content is not rewritten or migrated to satisfy a smaller budget.

## Failures and remaining scope

An unavailable diagnostic directory disables optional recording while the server continues. A failed model observer route setup preserves the original Provider and launch inputs; coverage reports the failure. Malformed percent encoding in a target URL username or password is rejected at this setup boundary, before a request handler can fail. Valid encoded credentials keep the native Basic Auth value; password echoes are masked using both encoded and decoded values. Recording failures never authorize blind retries of uncertain model execution.

The recording summary remains incomplete for omitted payloads, failed writes and missing terminal records. A green source test does not establish complete native coverage.

SQLite events, command/queue payloads, IndexedDB outbox, secret user-dialog fields, cross-frame native protocol fragments and old recording exports still need the full NP-06/14 sensitive-data policy. The HTTP and observer fixes do not claim that every persisted input is scrubbed.
