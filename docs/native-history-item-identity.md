# Item identities during native history import

History imports suppress a start when the same item has a completion in the
batch, and suppress a native user echo that already matches a local prewrite.
Those comparisons must use the native turn and item kind as well as item key.
A completion in a different turn cannot prove that a new command finished;
one confirmed echo cannot account for another turn's external user message.

The batch identity is the tuple `(nativeTurnId, itemKey, kind)`. An explicitly
absent native turn remains absent; the importer does not invent an actor or
turn to distinguish records. The tuples are encoded as JSON, so key contents
cannot cross tuple boundaries. Session/native identity is already checked
for the whole import. Public turn binding, input receipts and source records
retain their existing transaction and identity contracts.

The fix changes the completion and echo sets only. Same-scope start/completion
and confirmed local echoes still coalesce, repeated native sequence imports
still produce no new event, and items already observed live remain governed
by their public turn/item/kind identity. It adds no schema migration or native
protocol field.

Issue #268 records nine failing controlled cases before the change. Source
regressions cover cross-turn keys, different kinds, external user messages,
absent native turns, same-scope completion, second SQLite connections,
database reopen and rollback of raw records and turn bindings on event write
failure. An actual source HTTP/Chromium check verifies the external message
and unfinished command before and after reload, with no duplicate import.

The input records are controlled `NativeHistoryRecord` values and
`FakeAdapter` (`fake-1.0.0`) history delivery. SQLite, manager, HTTP and the
rendered browser are actual local implementations. New official-native,
provider, paid-model and production calls are zero. This is not full native
or target-platform acceptance. Remaining NP-05 work includes durable older
history gaps, full actor provenance and versioned projection reconstruction;
partial history items completed in a later batch require a separate audit.

Evidence hashes are in
`web_review/native-history-item-identity-20261116.summary.json`. Independent
acceptance, merge, Issue closure and deployment belong to the existing owners.
