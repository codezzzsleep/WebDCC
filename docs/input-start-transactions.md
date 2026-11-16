# Input admission before native submission

`InputAdmissionStore` owns two SQLite immediate transactions for ordinary
inputs. Reception persists the queued input, command mapping and queue feed.
Starting it persists `dispatching`, the native request UUID, user/start events,
queue feed and first title metadata together, under the current owner fence.
The manager publishes the committed records before invoking native submission.

The diagnostic turn context is prepared before starting the transaction, with
the owner and active turn checked again afterward. Runtime turn state is set
only when the start transaction commits. A failed start therefore leaves the
accepted input queued, records its preparation error and keeps the runtime idle.
The existing explicit queue retry revalidates and dispatches that same input.
Failure of the reception transaction leaves no accepted queue row.

Errors proven to precede native submission carry the existing
`nativeAdmission: not-submitted` identity. The dispatcher records a known
failure while retaining accepted blocked queue state. Native outcomes genuinely
unknown still use `uncertain`. A committed dispatch killed before an acceptance
response retains its native UUID and uncertainty, and is never blindly replayed.

Issue #256 covers queue/user/start/dispatch/title feed failures and recovery.
Local verification injects actual SQLite failures, observes a second database
connection, retries through HTTP, and kills an actual child with SIGKILL after
dispatch persistence. Source Chromium shows a blocked input, retries its original
identity once and retains the same message after reload. Native adapters,
prompts, tools, permissions and protocol identities remain unchanged; controlled
local evidence does not certify official providers or target deployments.
