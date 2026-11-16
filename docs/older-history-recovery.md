# Older event history recovery

Refs #47 (NP-05), #42. This change builds on #255's committed event coverage;
it does not change native inputs, adapters, protocol IDs or the server schema.

Previously, `AppStore.loadOlder` published an HTTP page before its IndexedDB
write completed. A pending or failed transaction therefore advanced the next
`before` value and a concurrent scroll could create duplicate requests and
transactions. A browser reopening a large, fully cached conversation loaded
only its newest 500 events and could not read the remaining cache offline.

`OlderEventHistory` shares one pending load per session. It first reads up to
200 already committed events immediately before the displayed continuous
range. A detached cache range cannot certify the missing interval; only its
adjacent continuous suffix is published. Otherwise the existing history API
is queried with the same `before` and limit. A server page must belong to the
requested session, contain unique consecutive positive sequence numbers and
end at `before - 1`.

HTTP pages are published and added to committed coverage only after the cache
transaction completes. Network, validation or write failure retains the
original missing range and exposes a retry button at the top of the timeline.
Scroll events do not automatically retry an error. Cache read failure falls
back to HTTP, while both cursor request and transaction rejection are observed.
Loading older events preserves live events, interaction authority and unread
state. The existing subscription watermark remains separate from older gaps.

Verification uses controlled StoredEvent fixtures, actual local HTTP/WebSocket
services and Chromium/IndexedDB. Directed regressions cover concurrent loads,
pending and failed writes, malformed/foreign pages, detached cache ranges,
independent sessions and live events arriving while a page is pending. Browser
regressions abort real read/write transactions, retry from the original
boundary, reload the database and recover cached history offline. Original
failure evidence is retained in the author's private task ledger; final
results and fingerprints are attached to the PR.

This scope makes no new official Agent, provider or paid model calls. It does
not establish full NP-05 acceptance, current provider availability or target
deployment acceptance. Complete actor provenance and versioned raw projection
rebuilding remain separate work.
