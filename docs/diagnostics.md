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
| `WDCC_TRACE_MAX_CAPTURE_CHUNKS` | 4,096 | Each captured body and queued chunk events for each native HTTP response |
| `WDCC_TRACE_MAX_ACTIVE_CAPTURE_BYTES` | 64 MiB | Retained raw request/response chunks across all captures in one JavaScript process |
| `WDCC_TRACE_MAX_FILE_BYTES` | 64 MiB | Each diagnostic JSONL file |
| `WDCC_TRACE_MAX_QUEUED_BYTES` | 32 MiB | Each writer's pending serialized records |
| `WDCC_TRACE_MAX_ACTIVE_QUEUED_BYTES` | 64 MiB | Pending serialized strings across diagnostic writers in one JavaScript process |
| `WDCC_TRACE_MAX_DIRECTORY_BYTES` | 512 MiB | Regular diagnostic files in each recording directory |
| `WDCC_TRACE_RETENTION_MS` | 7 days | Diagnostic file cleanup |

All captures in one process share a reservation pool, including independent module copies in a preload bundle. Storage is reserved before copying native chunks; body overflow, capture failure, stream completion, cancellation and request abort release reservations. A completed native request releases its raw chunks before context lookup or diagnostic writes; slow record observers do not retain the raw buffers. A zero active budget observes sizes while omitting nonempty bodies. Configuring a pool below its current usage is rejected. Each native process has its own pool.

Native HTTP chunk metadata also respects the response's chunk limit while request/context I/O is pending. Extra chunks do not queue another diagnostic event. Terminal coverage retains all observed `responseBytes` and `responseChunks`, and `omittedChunkEvents` reports how many metadata events were omitted. Native streaming continues. This bounds metadata jobs for one response; pending contexts and total jobs across simultaneous requests still require separate bounds.

When body capture overflows, the entire captured body is omitted and `coverage.truncated` is set. Counts and native transport continue. Model terminal coverage identifies `requestLimitReason` and `responseLimitReason` as `body-bytes`, `body-chunks`, `active-buffer-budget` or `capture-failed` when applicable. Omitting the whole body avoids storing a cut credential prefix as complete evidence. Queue and file limits record an incomplete summary; a small coverage marker survives a server restart when its directory remains writable. Native preload write failures use a sibling coverage marker and bounded error reporting.

Cooperating writers use `flock` and one stable `.wdcc-diagnostic-writer.lock` file per directory. An owned helper checks the current size and performs append or replacement under that lock, including exact UTF-8 byte limits. Helpers serve queued writes and exit when the queue finishes; a parent exit closes their input and releases the kernel lock after the current write finishes.

Diagnostic targets must be regular files. The helper opens without following a final symlink and with nonblocking flags, verifies the actual descriptor before truncation or writing, and closes it after the operation. FIFO, socket and device targets report incomplete recording; they do not create a permanently waiting writer. An oversized replacement leaves the existing content intact. Path changes during the write are reported as incomplete evidence.

Optional diagnostic writes require the `flock` executable. A missing utility or a lock held beyond the one-second wait reports incomplete recording while native forwarding continues. The empty lock file contains no payload; keep its pathname while writers may be active. The same lock coordinates file and directory limits across cooperating processes.

The directory budget counts current regular-file lengths, including existing files, context records and per-session coverage markers. Append and replacement use their actual growth; restarting a writer does not reset consumed space. A full directory rejects new growth without creating empty recording files or deleting old content. Per-session failure records are bounded to 64 KiB and count against the directory budget, independently of the JSONL file limit.

One reserved `.wdcc-diagnostic-quota.json` file has an additional fixed 4 KiB allowance. It keeps a directory-wide incomplete signal and quota-rejection count when ordinary coverage cannot fit. Its reads and writes use bounded, verified regular-file descriptors; unavailable metadata stays explicit. This internal path cannot be used as a normal recording destination. A directory that already exceeds the configured budget is not automatically reduced. The budget governs cooperating writers and logical file bytes in that directory, rather than external file mutations or totals across different directories.

Recording downloads and summaries also open verified ordinary descriptors without following final symlinks or waiting on FIFO peers. JSONL reads for sessions, native models, workspaces and DSH Host context use the configured file-byte limit; coverage reads have a separate 64 KiB bound. Files that grow beyond the bound and invalid UTF-8 are rejected. Existing source files remain intact. Unreadable or invalid coverage marks the summary incomplete. A failed recording read reports incomplete counters; JSONL download returns a JSON 503 error without an attachment header. Optional absent files and valid causal ordering remain compatible. This bounds file payload reads, while aggregate concurrent memory, ordinary filesystem stalls and the full export/retention policy remain separate work.

Retention cleanup runs at recorder initialization and at most once an hour when records arrive. It shares the writer's directory queue and OS lock, then checks modification times and removes expired regular diagnostic files while holding that lock. Fresh records, unrelated files, directories, symlinks and the lock file remain. This coordinates cooperating writers in one recording directory; external file mutations remain outside that guarantee. Lock failure is bounded: initialization disables unavailable optional diagnostics, and activity-triggered cleanup marks the summary incomplete. Recording can resume after the lock owner exits. It is not an idle background deletion timer.

Diagnostic writers share a serialized queue reservation pool across instances and independent module copies. Reservations are released after success or failure. The per-writer limit remains separate; an explicit lower shared limit is rejected while pending strings exceed it. Shared queue overflow omits the record and records a directory omission marker, including with a zero ordinary queue budget. A separate fixed 4 KiB pending message allowance bounds these marker requests, and the existing 4 KiB disk reserve bounds the marker file. Previous quota errors are retained. An unavailable marker or exhausted marker queue is reported as missing coverage. This budget measures writer-held strings; model observer callbacks holding structured records, temporary JSON/Base64/transport copies and totals across processes remain outside it.

The active budget bounds retained raw chunks in one process. It does not bound JavaScript VM memory, native transport queues, temporary redaction/JSON/Base64 copies or RAM summed across child processes. File and serialized queue limits have separate accounting. Totals across processes or different directories and a complete retention/export policy remain acceptance work. Existing recording content is not rewritten or migrated to satisfy a smaller budget.

Native HTTP attribution contexts use ordinary file descriptors opened without following a final symlink or waiting on a FIFO. Reads stop at 64 KiB plus one byte to detect overflow, including file growth after the size check. Invalid JSON or UTF-8, special files and unavailable or oversized contexts are omitted. Model bytes continue, records include `contextError`, and the recording summary reports incomplete attribution. Rejected special-file contexts no longer keep a completed model call waiting for a peer. This bounds the context payload size; total pending reads, stalled ordinary filesystem I/O and other diagnostic readers remain part of the full scope.

## Failures and remaining scope

An unavailable diagnostic directory disables optional recording while the server continues. A failed model observer route setup preserves the original Provider and launch inputs; coverage reports the failure. Malformed percent encoding in a target URL username or password is rejected at this setup boundary, before a request handler can fail. Valid encoded credentials keep the native Basic Auth value; password echoes are masked using both encoded and decoded values. Recording failures never authorize blind retries of uncertain model execution.

The recording summary waits for pending writes before copying their incomplete state and errors. The first response includes failures observed during that wait even if coverage could not be saved; a recording read failure also preserves those errors. The summary remains incomplete for omitted payloads, failed writes and missing terminal records. A green source test does not establish complete native coverage.

SQLite events, command/queue payloads, IndexedDB outbox, secret user-dialog fields, cross-frame native protocol fragments and old recording exports still need the full NP-06/14 sensitive-data policy. The HTTP and observer fixes do not claim that every persisted input is scrubbed.
