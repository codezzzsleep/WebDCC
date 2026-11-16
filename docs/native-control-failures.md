# Native control failure ownership

An operation can still be waiting on its native result after the user closes
the old runtime and a directory read activates a new generation. An unavailable
error from the old operation must not close the replacement by session ID.

Each serialized manager control gets an asynchronous operation scope. It binds
the first concrete runtime that passes the owner check, or that the operation
creates for activation. The binding happens during execution, after previous
controls finish. It is never inferred from the runtime found when an error
returns, and a runtime-free observation cannot acquire the identity of a
concurrent activation.

When a control waits for an activation started by another request, it binds
the concrete ready runtime in its own asynchronous scope after that shared
Promise resolves. The original activation result and owner checks are preserved.

`native-runtime-unavailable` keeps its existing error and receipt semantics.
Cleanup runs only if the bound runtime is still the manager's current object,
is not already disposing, and still holds its durable owner/generation fence.
Cleanup belongs to the same queued Promise as the native operation: the next
control waits for native disposal to return before activating or using a writer.
An unavailable current runtime is still closed, including one activated by
the failing operation. Other error codes retain their existing handling.

The change adds no database migration or protocol field. It does not change
Agent prompts, tools, permission selection, native process behavior, input
admission, or DSH foreground question handling. An old error is not a native
terminal result for the new turn; its output and later terminal frame continue
to be observed through the current identity.

The regression covers three controlled Agent identities and model, effort and
permission changes. Before the fix, all nine old-error cases closed the new
runtime. A separate boundary test exposed the next queued control entering
before awaited cleanup returned; that failure is also retained. Tests verify
current-runtime cleanup, execution-time activation, a changed durable owner,
runtime-free reconciliation, unchanged uncertain receipts, SQLite reopen and
continued native output. Actual source HTTP/WebSocket/Chromium checks verify
streaming after the old error and reload before the current native terminal.

Independent merge review also reproduced three shared-activation failures:
waiting controls did not bind the runtime created in the other request's scope,
so an unavailable current runtime remained active. Those failures are retained;
the added regressions check cleanup and the next generation for each controlled
Agent identity without altering the original unavailable error.

The errors and native frames come from `FakeAdapter` (`fake-1.0.0`). SQLite,
HTTP/WebSocket, manager, browser and rendered application are actual local
implementations. New official-native, provider, paid-model and production
calls are zero. These checks do not establish current provider availability
or complete target-platform acceptance. See Issue #266, PR evidence and
`web_review/native-control-failures-20261116.summary.json`; independent review,
source acceptance, merge and deployment belong to the existing owners.
