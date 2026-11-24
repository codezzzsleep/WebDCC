# November 24 audit repairs

Source implementation, source acceptance and deployment are separate. Issues
#374, #368, #376, #375, #358, #364 and #369 track this batch. The original audit
failures remain retained outside the repository.

Provider vault and session routing rules are described in
[provider-storage-safety.md](provider-storage-safety.md). Key rotation imports
an address/key-distinct copy, preserving the existing source row and session
routes. Source tracking records only fingerprints, row identities and observed
model defaults in schema-16 settings. It supports change notices and explicit
update/ignore; scans preserve names and custom model settings. Explicit update
copies current native address/key and merges models, while retaining custom
labels/levels. Existing browser choices take precedence. An unavailable fresh
scan cannot apply a cached credential. Native configuration files are never
written. Shared address/key imports retain each Harness's observed default.

Hot and immutable-completion recovery use SQL metadata witnesses rather than
loading all semantic data/native bodies. Reset boundaries, turn completion,
publication identity and semantic-envelope comparisons retain their original
meaning. Semantic witness lists are bounded; truncation is an explicit partial
result and cannot select a misleading output prefix. The reader stays inside a
read transaction and never activates an adapter. In the same isolated
2,000-message/8,240,000-byte reproduction, historical body parses fell from
2,000 to zero; one heap-delta measurement fell from 15,927,352 to 67,320 bytes.
These are isolated server measurements, not a claim about browser crashes.

Claude native `assistant.aborted` is retained on text/thinking and unknown tool
input. A newly truncated tool is not shown as executing. A later canonical
input can verify the same original tool identity; an already verified tool is
not downgraded by a truncated delivery. Old stored abort envelopes provide
read-only partial labels in the timeline and child panel. Block incompleteness,
query/turn outcome and task outcome remain separate.

Gate reports require matching OS, architecture, Node and actual native version
maps, including repeated passes. Missing/malformed/unknown environment fields
cannot pass. This gate uses exact environments; it does not imply acceptance
of a broader version range.

Strict Claude trajectory replay obtains query ID from an independently captured
runtime-start lifecycle record, and generation from recorded lifecycle metadata
or a native permission-channel witness. It does not take identity from the
expected output, rewrite IDs or weaken comparison. Missing/conflicting context
stays failed. New lifecycle captures include generation explicitly. The existing
173-frame real Claude capture replays exactly, with zero new model requests;
its original output-format failure remains failed. Replay does not establish
current Provider availability or latest model behavior.

Validation includes corrupted vaults, write/SQL failure, concurrent writers,
real SIGKILL between file and SQL commit, credential restart, routing refusal,
source rotation and explicit choices; bounded recovery and original recovery
cases; native SDK transport with a controlled peer; and actual source HTTP/WS/
SQLite/Chromium for Provider changes and incomplete-output recovery. Controlled
SDK envelopes/peers are not official CLI or live model acceptance. Actual native
Codex 0.172 `config/read` against an isolated dummy profile verifies rotation
without submitting a model request. Target-platform three-Agent verification
must be bound separately to the delivered release.
