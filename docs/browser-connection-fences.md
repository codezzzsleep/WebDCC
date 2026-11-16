# Browser connection ownership

Only the current, running WebSocket can open the browser sync boundary, deliver
frames, refresh heartbeat time, close the connection or schedule recovery.
Replacing a connecting socket releases its socket and timers before the new
instance becomes current. Stopping clears ownership before closing, so already
queued callbacks cannot reopen or update the stopped connection.

Reconnect timers also retain their own identity. An obsolete timer cannot replace
a new connection. Current close still uses the existing backoff and preserves
the client ID, feed cursor and subscription array. This browser lifecycle does
not create, resume or stop an official native writer.

Issue #260 verifies controlled late open/message/close/error and heartbeat
ordering. Actual source Chromium observes standard WebSocket CONNECTING state,
triggers a focus burst, and compares live server connections. Original code left
21 sockets; the fenced code leaves one, with unchanged native owner/generation,
zero native resumes and no page errors. An initial ordinary-reconnect test did
not trigger the race; its passing result and a corrected reporting error remain
separate from the triggered evidence. Official provider and target-platform
acceptance remain independent.
