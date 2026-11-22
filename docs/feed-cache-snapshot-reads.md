# Feed cache snapshot reads

Startup reads cached sessions, the feed continuation sequence and its marker
in one readonly IndexedDB transaction over `sessions` and `meta`. It uses the
same committed snapshot for the UI and WebSocket hello. A separate connection
may commit newer metadata while startup is in progress; the client then
receives those feed records after its older, matching continuation token.

Atomic writes alone cannot provide this guarantee when the reader loads
sessions and metadata in separate transactions. A successful session read
followed by a newer marker would advertise coverage absent from the UI.
The single read waits for transaction completion and observes every request
failure. Failed reads start metadata replay from zero. Existing legacy and
marker validation still applies to the returned snapshot.

The read does not write metadata or change inputs, receipts, ownership,
permissions or native behavior. It requires no schema upgrade. Local checks
cover a controlled AppStore interleave, failed reads, the existing feed
checkpoint regressions, and two real IndexedDB connections racing with the
source UI's initial WebSocket hello. Target platform and Provider acceptance
remain separate.
