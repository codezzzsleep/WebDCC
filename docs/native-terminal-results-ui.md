# Showing retained native terminal results

The authenticated session GET endpoint `native-terminal-results` and an isolated
time-line component show original native completed, failed and interrupted
reports whose matching Web terminal publication is missing. The original public
turn, nullable native turn, owner/generation/Host, usage, native bodies and every
source assignment remain in the response and expandable original record.
This does not complete the Web turn, settle an input receipt, allocate an event
sequence or retry an input. It does not interpret native interrupted as a user
interrupt or infer that a writer exited.

The reader uses #348's verified original assignment and legacy witness contract
inside one Store read transaction. It does not create an owner or call an
Adapter. Equal results merge their source envelopes; only an actual committed
terminal with matching original scope, status and output bytes suppresses an
identical retained copy. Different native opaque content remains available.
Contradictory results and mismatching native/Web terminals are explicit.

Reads cover at most 5,000 summaries and 2 MiB. A missing suffix may contain a
contradiction, so budget-limited reads return no result prefix and mark partial
coverage. Corrupt, missing, restricted and unsupported source stays explicit.
A recorded conversation reset excludes earlier actual public turns; unknown
conversation membership cannot be guessed from receipt time or current state.

The component retains request and session/conversation identity fences and
aborts superseded reads. Refresh and newly uncertain Web input states trigger a
fresh read; stream deltas do not trigger extra GET requests. Ordinary browser
refresh checks use actual HTTP and WebSocket responses. A separate controlled
fetch race delays one actual HTTP body while ignoring Abort to test the request
identity fence; it does not change official native behavior or prove network
cancellation semantics.

Verification uses controlled FakeAdapter native mappings with actual manager
callbacks/completion timers, SQLite failure, Node SIGKILL, database reopen,
HTTP/WS and source Chromium refresh. Official Agent, Provider and target-platform
acceptance remain separate; no native prompt, tool, permission or behavior is
changed. #347's immutable completion snapshot remains a separate delivery.
Full history, interaction and child-native reconstruction still remain in #47.
