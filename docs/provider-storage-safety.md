# Provider storage and session routing

Issues #374 and #376. Existing schema 16 and native configurations are unchanged.

Only ENOENT initializes `secrets.json`. Invalid JSON, non-object mappings, unsafe keys, non-string values and IO failures reject startup without overwriting the original or including secret content in diagnostics. Mutations reread the file under a shared writer lock. Writes use a private temporary file, fsync, same-directory rename and directory fsync. Failed writes remove temporary files and leave referenced SQL credentials intact.

In-process writes are serialized across registries. A different process fails with 409 while the exclusive lock exists. After a crash, check that the recorded writer is no longer running and inspect the original vault/SQL before explicitly removing a leftover `secrets.json.lock`. Startup does not automatically steal a lock. Never delete or replace the vault to clear an error.

Credential changes stage a new immutable secret reference before switching SQL. An interruption or SQL failure before the switch leaves the old referenced credential recoverable; unreferenced staged keys are reclaimed on a later mutation. This is a file/SQL commit boundary, not a claim of one cross-storage transaction. Deletion stages import suppression, commits SQL, then reclaims the unreferenced key; a later file failure is reported and may leave an unreachable credential for subsequent reclamation. Referenced credentials are never garbage collected. New launches resolve a fresh atomic vault snapshot, so a second registry/process cannot silently lose a newly switched key reference through a stale cache. Existing running native work keeps its launch configuration.

A Provider referenced by any session, including archived sessions, cannot be deleted (409). The original route, running work and history remain intact. Unused Providers can be deleted. The UI displays server rejection and explains the restriction in its confirmation. This delivery provides the conservative refusal path, without adding a migration flow or silently converting existing sessions to native defaults.
