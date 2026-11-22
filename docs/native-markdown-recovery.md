# Markdown recovery and redaction evidence

Native capture in schema v16 records `payload_redacted` in the same INSERT as
the envelope. It compares the sanitized value with the received value, without
persisting unsanitized content or its digest. The optional `payloadRedacted`
envelope field exposes this capture evidence. Native input, output, prompts,
tools, permissions and execution are unchanged.

An explicitly unchanged payload can contain Markdown emphasis such as
`***重点***` or a `***` divider. Immutable projection recovery restores its
original saved content and identity after semantic publication fails. Changed
payloads remain unavailable even when their byte masks resemble valid Markdown,
including after a restart loses the observer's in-memory secret list. Existing
restricted, omitted, incomplete and missing-source checks still apply.

Migration leaves the new field NULL for existing envelopes and preserves all
their original columns. Historical asterisk content with unknown redaction
provenance remains unavailable: a reader cannot reconstruct discarded bytes or
certify that an old mask was complete Markdown. Plain legacy content retains
its existing recovery checks. Read-only artifact tools require the current
schema and never migrate their input.

Source tests cover real SQLite publication failure, migration, read-only
recovery and process termination. Chromium tests use controlled Adapter events
for all three Agent types and verify saved Markdown display and refusal after
reload. These are source checks; official native, live provider and deployment
acceptance are separate.
