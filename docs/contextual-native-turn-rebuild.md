# Rebuilding native terminal observations from recorded assignments

The read-only turn outcome reader can use a version 1 native projection context
as the original public-turn witness. It verifies the original envelope, schema,
content and context digests, owner, generation and Host. An anonymous native
turn remains `nativeTurnId: null`; it is never given an invented native ID.
The original public turn and execution identity distinguish anonymous turns.

Every contextual outcome includes its actual identity and every source
assignment, with envelope ID, context digest, late and turn-ended flags. Equal
terminal results in the same assigned scope preserve all original envelopes.
Distinct public turns, owners, generations and Hosts stay separate.
Contradictory statuses or usage remain unresolved in the existing conflict
report. Native opaque fields and request/actor/parent identities stay in the
original payloads rather than being reconstructed or discarded.

When context is absent, an identified native turn may still use the original
committed native-public witness. Legacy scope and outcome digests stay unchanged.
A present but corrupt, unsupported or conflicting context cannot fall back to
that legacy path. Session-scoped terminals and null public-turn assignments
remain unsupported. Unknown, restricted or incomplete source and output budgets
retain their existing explicit coverage limits.

Reading a context uses a pure database reader. It never constructs the owner
store, which can insert a Host identity. The database remains read-only and
query-only, without migration, Adapter calls or input retries. Recovered native
statuses are evidence artifacts. They do not allocate semantic sequences,
complete Web turns, change queues or command receipts, infer process exit,
or recreate duration and answer lists.

Verification uses controlled mappings from all three Agents with actual SQLite
INSERT failures, database reopen and Node SIGKILL. Additional callbacks exercise
the actual manager's completion timer before SIGKILL. No official Agent, native
prompt, tool, permission or behavior is changed, and no new paid or Provider
call is involved. Live Provider and target deployment acceptance remain separate.
This increment does not apply terminal artifacts to snapshots or the timeline;
that consumer and full history/interaction/child-native reconstruction remain
in #47. #337 delivered the legacy artifact and #342 the original assignments.
