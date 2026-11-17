# Claude dialog ownership

SDK 0.3.322 transports `dialogKind` and its payload/result opaquely. WebDCC
declares only kinds with a trusted, verified host request/result contract. The
production default currently declares none; the SDK exports no per-kind schema
catalog from which a renderer could safely be invented.

An undeclared, invalid or no-longer-owned dialog request is refused immediately.
The SDK writes an error response with the original request ID; the native control
contract discards an undeclared client's error and leaves settlement to a capable
client, the native deadline or withdrawal. WebDCC does not return a user
`cancelled` or `completed` settlement, and does not use `null` to imply an
out-of-band answer it never sent.

The locked SDK documentation has a retained conflict: `UserDialogRequest`
contains an older unknown-kind cancellation comment, while
`SDKControlRequestUserDialogRequest` forbids undeclared clients from cancelling.
The actual SDK invokes `onUserDialog` without filtering declared kinds and writes
its non-null result. Returning cancelled therefore really settles a dialog.

Genuine user completion/cancellation of a declared kind keeps its request ID,
tool invocation identity and validated result. Submission stays separate from
native terminal confirmation. Refusals retain a bounded, read-only list in the
Claude native control panel, including kind, request ID, tool ID and reason;
the original observation is also persisted. Refresh/reconnect/session switch
reads those records without retrying the request or declaring a renderer.

Verification distinguishes controlled SDK envelopes and source browser tests
from execution of the unmodified official SDK against a controlled Node protocol
peer. That peer is not the official CLI and implements only the fixture wire
contract; its advertised CLI version does not prove a real dialog type, current
Provider, target deployment or multi-client business outcome. The SDK transport
recordings preserve the original negative cancellation and later error response,
plus genuine declared fixture responses. No user/model/Provider requests are
submitted. Native prompts, tools, permissions and SDK artifacts are unchanged.

See `web_review/claude-dialog-20261117.summary.json` for source/evidence hashes,
retained failures and unaccepted scope. Refs #318, #84, #51, #42.
