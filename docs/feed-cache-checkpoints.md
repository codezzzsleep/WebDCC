# Durable feed checkpoints

The browser commits complete received session snapshots, the feed continuation
sequence and a version 1 checkpoint marker in one IndexedDB transaction.
Session metadata remains visible in memory immediately. WebSocket hello uses
the committed checkpoint, independently from the last received feed sequence.
A failed session write cannot certify metadata which will disappear on restart.

FeedCheckpoint serializes writes. If a transaction fails, its affected sessions
remain pending; newer complete state for the same session can replace that
snapshot while every other failed session remains included. A later received
patch can repair the unit. A lone failure does not create a retry loop.
The token follows delivered feed records rather than artificial contiguous
numeric IDs: deleting a session may remove its older feed records.

The atomic marker prevents trusting a legacy cursor written by the previous
separate transactions. Missing, unsupported, mismatched or invalid markers,
and positive cursors without cached sessions, restart metadata replay from
zero while retaining the previously cached UI. The replay does not resend
inputs, change command receipts or create a native owner. Existing Agent
fields, native IDs and permissions are copied without changing their behavior.
No SQLite or IndexedDB schema upgrade is required.

Verification includes actual IndexedDB transaction aborts, real WebSocket feed
messages, SIGKILL of the Chromium process created for the test, persistent
profile reopen and metadata recovery for all three controlled FakeAdapter
Agents. Reauthentication uses the existing test auth; credentials are not
included in exported metadata evidence. Controlled promise regressions cover
pending commits, multiple sessions, failures, newer state, duplicate replay,
source sequence gaps and legacy checkpoint validation. These are local source
checks and do not establish live Provider or target deployment acceptance.
