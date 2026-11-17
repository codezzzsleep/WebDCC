# Isolating native output publication failures

A WebDCC SQLite publication failure must not escape through an Agent callback
as a native execution error. The callback and deferred completion action now
handle `SQLITE_*` failures at the common manager boundary. Other exceptions keep
their existing Adapter error path. Native prompts, tools, permissions, payloads
and status fields are unchanged.

An affected current runtime loses Web observation. Its pending input is settled
as uncertain using the existing guarded journal transaction, its old completion
timer/action is cancelled, and the existing managed owner fence is applied.
The fence records an uncertain owner and requests the ordinary Adapter disposal;
it does not certify that a native process stopped. A platform warning uses the
existing `runtime-unobserved` contract. Queued inputs, attachments, original
envelopes, native identities and confirmed terminal inputs remain intact.

Writes for an old generation or another Adapter do not own the current writer,
including when the raw evidence insertion itself fails. An obsolete completion
action also checks its captured public turn before changing anything. These
guards preserve current work when a late callback has the same Web session ID.

When SQLite remains unwritable, the in-memory fence blocks new sends. The
manager cannot claim to have persisted uncertain state or a warning if those
writes failed; the retained failure evidence records that narrower scope. A
service restart and native reconciliation remain separate recovery stages.

This fix isolates platform database failures. It does not rebuild missing
semantic completions from raw envelopes or complete native/target acceptance.
Those consumers remain tracked in #47. The versioned context and retained-hot
PRs #342/#344 are independent deliveries. Any snapshot/UI recovery of a fenced
runtime must distinguish lost observation from the last native reported status.

Evidence uses controlled `fake-1.0.0` mappings with actual SQLite triggers,
transactions, late admission promises, Node SIGKILL and database reopening.
Failed regression attempts and unread/unrecorded raw scope stay in the private
evidence index. No official business, live Provider or paid model call was made.
