# JSON identity for repeated native history

Refs #317, #47 (NP-05), #52, #42.

A history page may repeat a previously imported NativeID/sequence with a
different JSON object property order. These are the same JSON value. The
repeat contributes no second semantic event, and new records in that page
can still commit. Previously, comparing serialized strings rejected the
repeat and rolled back the complete page, including its new messages.

Exact retained strings still use the existing fast path. Other repeats
compare the two parsed JSON values using Node's built-in deep comparison.
Object property order is immaterial; array order, field values and field
presence remain significant. Unicode keys are not normalized. Malformed
saved JSON remains an explicit collision. A real content collision still
rolls back the entire import transaction.

The original source bytes, NativeID/sequence, turn/item identity and schema
are retained. This changes duplicate comparison only; it does not rebuild
old projections, alter native messages or replay native actions.

Directed checks use controlled history records through the actual store
and manager, separate real Node serializers, SQLite reopening and full
page rollback. Existing history stages, input echoes, turn isolation and
native writer history checks cover compatibility. These inputs are not
new official native transport or provider trajectories. Full versioned
projection rebuilding and target-platform acceptance remain separate.
