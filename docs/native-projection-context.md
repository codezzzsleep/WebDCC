# Recorded native projection contexts

Raw mappings can omit a native turn ID even when the live Manager has assigned
them to a Web turn. Without that actual assignment, a later reconstruction
cannot recover the original public identity from timestamps or a single input.

`Store.projectionContexts` records version1 context immediately after the
Manager's actual turn assignment and before publishing a hot update, delta,
or semantic event. Context uses the private existing `app_settings` namespace
`native-projection-context:<mapping-envelope-id>`; database schema is unchanged.
It retains the complete source metadata, original owner/generation/Web Host
identity, public turn ID (including null), late and ended observations, and the
pre-update hot item's presence, kind, and closed marker. An unknown explicit
native turn gets a null assignment and an explicit ignored reason.

The context does not duplicate native bodies, configuration, or secret inputs.
Those remain in the original envelope under its existing retention policy.
Versioned JSON digests bind the context and recorded source value. An identical
record call is idempotent; a different or damaged context is refused without
rewriting the first context or source. Reads report missing, unavailable,
unsupported, or unverified evidence explicitly. They do not infer a new Web ID
or certify the native operation's result.

Context recording checks current writer identity and the original accepted
mapping inside an IMMEDIATE transaction. A context SQL failure leaves raw
retained and the native pump unchanged. The Manager records one recovery
warning for that owner generation; it does not create a successful receipt,
terminate the Agent to make reconstruction pass, or silently claim complete
recovery. Old generations and other Adapter instances remain subject to the
existing raw-only fences before context recording.

This is the provenance required for subsequent full turn, hot, interaction,
and snapshot reconstruction. It does not itself restore hot items into a
reconnected UI; that consumer remains under #47. Original native IDs may be
null, and missing or older context remains explicit. Source acceptance,
official Native/Provider validation, and deployment remain separate.

Verification covers three controlled Agent identities, anonymous mappings,
actual before-publication hooks, null and unknown native scope, closed and
late items, actual SQLite trigger abort, ten idempotent calls and conflicting
context refusal, original raw preservation, restricted bodies, schema/JSON/
identity/digest corruption, and real Node SIGKILL followed by SQLite reopen.
These checks do not invoke official Agents, paid models, or deployment.
