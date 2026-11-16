# Completion identity across native binding

Refs #291, #47 (NP-05), #42. The semantic projector remains version 1; the
stable completion identity uses the explicit `native-completion-scope-1`
key namespace. Native inputs, adapters, ownership and the database schema
remain unchanged.

Previously, immutable completion keys used the runtime's native ID. A callback
emitted before `create` returned could therefore use an empty ID, even when
the original frame already supplied its native session ID. Replaying that
same frame after binding produced another public event. Conversely, different
observed scopes could collide while the runtime ID remained empty.

Completion identity now uses the native scope already persisted in the
envelope, together with the Agent and existing session/turn/item/sequence/data
identity. Missing or empty scope retains the existing runtime path and does
not acquire a confirmed-scope alias.

An old runtime key can establish a stable alias only when its mapping belongs
to the same session, Agent and observed native scope and references an actual
committed public event. The original key, envelope, raw data and event remain.
Uncommitted mappings still permit recovery; a failed alias write does not
claim a successful projection. Old unprovable scopes are not guessed from a
later binding. Existing historical duplicates are preserved for separate
rebuild/repair work.

Directed regressions retain pre-fix failures and cover ten identical
observations across binding, distinct scopes, old empty/missing/bound runtime
keys, real SQLite reopening, missing event associations, transaction failure,
Agent separation, unknown/empty scope and callbacks inside the actual manager
create path. Chromium verifies the same public event and both observations
through the existing HTTP inspector after reload.

Evidence uses controlled FakeAdapter/SDK-shaped frames and actual local
storage, HTTP and Chromium. No new official Agent or provider calls are made.
The official before-create-return trigger and full target behavior remain
independent acceptance work. This does not complete NP-05's versioned raw
projection reconstruction or historical actor backfill.
