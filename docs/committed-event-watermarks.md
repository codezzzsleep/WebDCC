# Committed event watermarks

Receiving an event updates the live projection immediately. The reconnect
`afterSeq` and synchronization cursor advance only after IndexedDB commits a
continuous range. `serverLastSeq` remains the independently observed server
boundary; an in-memory event does not certify cache persistence.

`CachedEventCoverage` merges committed ranges separately for each session.
Out-of-order writes retain lower gaps, and closing a gap advances only through
committed events. A verified, fully cached recent history window can establish
a bounded starting point; older history outside that window remains separate
and cannot certify an old interaction without its existing per-ID lookup.

Failed live batches retain their original events for a later event or replay,
without a polling retry loop. A repeated explicit open reads history again when
the committed cursor trails the server, even if the failed page is still visible
in memory. Committing the missing range reevaluates interaction synchronization
and the durable outbox.

Event writes and recent-window metadata remain one IndexedDB transaction.
`cache.putEvents` awaits each request and the transaction; failure aborts and
settles the started requests before returning the original error. Aborted
requests do not escape as unhandled rejections.

The #47 regression covers pending/failed cache writes, concurrent writes
finishing out of order, multiple sessions and repeated hydration. Actual source
Chromium verification aborts IndexedDB, disconnects WebSocket, observes
subscriptions `0 → 0 → 2`, and compares the exact cached/server event records
after replay and reload. Existing interaction-gap and stream-identity browser
checks remain included. These local controlled checks do not claim current
provider or complete target-platform native acceptance.
