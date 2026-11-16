# DSH question outcomes and reply acceptance

A foreground `$events/result` returns a void Gateway receipt, including when its event has ended or its Client no longer owns that delivery. A matching `tool/result` or `userQuestions.settled` batch identifies the native call's actual answer. It does not identify the replying Client.

`native-resolved` therefore preserves the native answered terminal state and original call/item/event identities while leaving the local command unconfirmed. The card says “原生已回答”. A matching batch cannot turn a void no-op, transport error, `false` or `REPLY_QUEUED` into local acceptance. Native cancellation and unknown outcomes keep their existing separate states.

The continued `userQuestions/answer` method has a business boolean. An actual `true` received for the same runtime, Host epoch, generation and original call proves that this attempt was queued. A matching native terminal result can then confirm that local answer. A late true receipt from an older generation cannot claim a newer settlement. If the terminal arrives first, the interaction index only upgrades the same continued call and command, after that current receipt is verified.

The regression uses actual production HTTP, SQLite, mux and Chromium with controlled native envelopes/transport; the native Gateway's unchanged library proof is reused by verified hashes. The captured native legacy question replay retains its exact IDs, answer bytes and sequence. These scopes are separate from actual current Host, live Provider or target-platform acceptance. No native code, prompt, tool, permission, schema, version or paid task is changed or resubmitted. Source setup and malformed-test-input failures remain preserved.

Refs #312, #53, #52, #48 (DSH), #42. Original question-group answer retry and the full Host/activeAttempt/workspace matrix remain separate delivery scopes.
