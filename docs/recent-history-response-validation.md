# Recent history response validation

Refs #47 (NP-05), #42. This scope covers `hydrateSession`'s recent HTTP page;
#285 separately owns committed older pagination. Existing cache transactions,
coverage tracking and WebSocket replay are reused.

Previously, a recent response was considered complete based only on adjacent
sequence numbers and its last sequence. Foreign-session events and zero or
negative sequences could pass that test. Even pages failing the continuity
test were published into the requested session and persisted. Non-array
`events` or null records could reject session loading instead of subscribing
for recovery. A foreign page could also overwrite a valid live event received
while the HTTP request was pending.

A recent page now joins the projection and cache only if it contains 1–200
object records belonging to the requested session, with positive safe integer
sequences forming a unique continuous range ending at the requested server
sequence. Invalid pages preserve existing cached coverage and live events.
The session subscribes from that committed cursor using the existing replay
path. It can recover on a second open, reconnection or reload without sending
an input or repeating a native action.

This validation concerns page identity and sequence coverage. Opaque unknown
and internal bodies, null turn IDs and native IDs remain unchanged. Valid
pages still use the existing cache commit and bounded-window coverage rules.

Directed regressions preserve original malformed/foreign observations and
cover invalid structure, duplicate/order/range/size errors, live interleaving,
committed cache retention and subsequent recovery. Chromium uses controlled
invalid HTTP responses followed by actual source WebSocket replay, IndexedDB
commit and reload. No official Agent or provider call is added.

Source verification is separate from independent source acceptance and target
deployment. This does not complete NP-05's historical actor backfill or
versioned raw projection rebuilding.
