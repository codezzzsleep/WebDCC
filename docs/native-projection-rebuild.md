# Rebuild immutable native items from retained raw mappings

Refs #47 (NP-05), #42.

Raw mapping capture commits before its live semantic projection. If that
projection fails or the server exits in between, the retained native result
can be read without asking the Agent to repeat work. This command produces
an independent, versioned JSON artifact from the retained source:

```sh
pnpm exec tsx scripts/rebuild-native-projection.ts \
  --database /path/to/webdcc.sqlite \
  --output /private/path/items.json \
  --session WEB_SESSION_ID
```

The database must already use the supported schema (currently 15). The
reader opens it with `readonly` and `query_only`; it does not run migrations,
recover owners or update live events, queues, receipts or native state.
The output is atomically replaced with mode 0600. The database and its
SQLite journals cannot be chosen as the output path. The check resolves the
source database and the existing output parent directory, so directory aliases
and a linked source database cannot bypass this restriction (Issue #332).

Artifact format and projection version 1 cover immutable `item.complete`
mappings: assistant messages, reasoning, completed file reads and terminal
command/tool/file-change data. Native session, turn, item, request, actor,
parent and observation identities remain in the item and its original
envelope references. Opaque Agent data and native fields remain retained.
The projection ID uses the existing versioned JSON digest and native
completion identity, plus recorded actor/parent/Host scope. Repeated
observations contribute one item and retain every origin, including
observations in a new owner generation.

Every selected raw record has a result. Transport, metadata, turns,
interactions and other mappings remain `raw-only` or `unsupported`.
Unaccepted or incomplete source identities remain `unverified`. Sensitive,
omitted, masked, oversize, malformed or unavailable data remains
`unavailable`; an unsupported source schema is not guessed. These records
remain in the artifact with their reason, and `complete` stays false.
An empty range also does not certify completed reconstruction.

`--after` and `--limit` select stored raw envelope IDs, with a maximum of
500 records. `next` is the last recorded source ID; it is not a continuous
native-event watermark. The JSON output has a 2 MiB budget. A record that
cannot fit has an explicit size-limit result, and any remaining range is
reported by `hasMore`. Projection IDs remain stable across windows. A
larger window or budget cannot restore bytes that were never retained.

This artifact reconstructs item data; it is not a replacement of all live
conversation projections or proof of native execution, writer release or
provider availability. Full turn, hot-state, interaction and snapshot
rebuilding remains under #47. No adapter is created or invoked by this
command.

Verification covers real SQLite semantic-transaction failure, a real Node
SIGKILL after raw commit, read-only reopening, stable private CLI output,
original table/file equality, native scope separation, ten observations,
unavailable sources and output limits. An existing official Codex 0.169.0
capture with four controlled-model responses supplies compatible raw
envelopes for offline item replay. Its unsupported/unverified records and
missing exported database restriction state remain explicit; that replay
does not establish current live-provider or target-platform acceptance.
