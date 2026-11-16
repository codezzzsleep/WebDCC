# Versioned command digest

Refs #295, #45 (NP-03), #42. This change applies to command-journal identities.
Existing queue, native-action and projection uses of `payloadHash` retain their
format and behavior. The database schema and `CommandRecord` string contract
are unchanged.

The old command digest sorted every object with the process's default
`localeCompare`. Real en-US and sv-SE Node processes produced different hashes
for the same command containing Unicode answer keys. Reopening the same
SQLite database could therefore reject an identical command as conflicting.

New commands store `sha256-json-v2:<hex>` in the existing digest field. JSON
keys use a deterministic order independent of Intl locale; array order and
ordinary JSON serialization remain significant. Sensitive answers retain the
existing omitted payload marker while their digests remain comparable.

Existing bare SHA256 digests retain their original bytes. Matching the old
digest proves identity directly. When locale differences prevent that match,
a complete persisted command can prove equality or a content conflict using
the new deterministic comparison. A redacted marker, missing digest/payload
or unknown digest version provides insufficient evidence. Those requests
return explicit uncertainty before executing or rewriting the original
state, result or payload. Legacy sensitive identities that still match their
old digest remain usable.

Verification uses actual isolated Node locales and SQLite reopening for new,
legacy complete, redacted and unknown-version commands. HTTP and WebSocket
regression submits the same command 100 times through each transport and
checks one FakeAdapter execution, identical receipts and changed-content 409.
Existing SIGKILL queue/attachment recovery and question regressions are reused
in the directed gate. Original failures remain in the author's evidence ledger.

These are controlled commands/FakeAdapter tests with actual local storage and
transports. No official Agent business task or provider call is added. Other
shared hash consumers' locale behavior, unprovable legacy sensitive identities,
independent source acceptance and target deployment remain separate scopes.
