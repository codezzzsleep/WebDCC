# Native target reservation while opening

Refs #315, #46 (NP-04), #45 (NP-03), #42.

When a verified released Web session opens a different native session, its
new owner generation reserves the requested NativeID immediately. For
example, reopening from `old-native` to `new-native` stores `new-native`
while the owner is still `opening`. Another Web session targeting the same
Host, Agent and NativeID is rejected before its adapter starts resuming.
An unknown or empty target stores `NULL`, without retaining the old target
or inventing a native identity.

The target update belongs to the existing SQLite acquisition transaction
alongside owner, generation and process reset. A unique constraint or
trigger failure rolls back that complete acquisition. Other connections
and a reopened database see the committed reservation. No schema or native
protocol changes are needed.

Lease expiration still does not prove that a native writer stopped.
Reacquisition still requires verified release; an abandoned opening owner
becomes `uncertain` on server recovery. Its persisted target remains
reserved, and recovery does not fabricate native completion or authorize
blind replay. Old owner generations still cannot update the new instance.

Directed checks use the actual manager and SQLite, a gated FakeAdapter
resume, real transaction failures, database reopening and SIGKILL of a
local Node process while opening. The fixture's release flag is controlled
input, not official native writer exit evidence. An unknown target cannot
reserve a NativeID until the native interface supplies it. These checks do
not establish external Host/profile arbitration or all three Agents'
target-platform and provider acceptance.
