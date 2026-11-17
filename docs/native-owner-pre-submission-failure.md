# Owner acquisition failures before native submission

Refs #323, #45 (NP-03), #46, #42. Concurrent acquisition's transaction
mode is tracked separately by #321 / PR #322.

A new runtime must acquire its durable owner before binding or calling its
adapter. If that acquisition fails, the current request is known not to
have been submitted. The manager attaches the existing `not-submitted`
admission marker while preserving the original error and error code.
Database failures then produce failed command receipts, with no invented
turn, input queue row or native completion.

The failed receipt remains stable when the same command ID is retried.
After the database fault is resolved, the user can submit a new command ID.
The old receipt and payload remain retained across database reopening.

The marker covers only acquisition of a new runtime. Existing runtime
ownership checks, adapter binding, create/resume/send and their failures
remain outside that catch. Unknown native outcomes still remain uncertain
and cannot be resent automatically. A live owner conflict still follows
the existing conflict contract, without releasing or advancing its owner.

Directed checks use real SQLite transaction failures, the production HTTP
command handler, database reopening and controlled FakeAdapters for all
three Agent IDs. Checks distinguish zero native method calls before the
failure from errors after resume or send starts. They do not establish
official native writer, provider or target-platform acceptance.
