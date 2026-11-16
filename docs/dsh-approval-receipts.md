# DSH approval receipts

An approval keeps three distinct native identities: the tool `callId` when supplied, the durable `approval/asked.id`, and the forwarded waterfall `eventId`. Re-delivering the same event preserves its durable association. A native `approval/decided` closes that exact durable request with `allowed-once`, `rejected`, `cancelled` or `unavailable`.

The audit and waterfall arrive through independent streams. A late `approval/asked` binds a single unambiguous pending call; multiple matches remain unbound. A forwarding cancel retires only the transport delivery. It keeps the pending request and unknown UI until the durable decision arrives, and cannot manufacture `cancelled` or discard a later native rejection.

WebDCC records the selected option before returning it through `$events/result`. The void HTTP ACK means submitted, awaiting the durable decision. After the await it checks the original runtime, Host/client, mux generation and pending object. A completed or superseded delivery's idempotent no-op cannot change the current interaction to sent or overwrite its native terminal state.

If the durable decision arrives before the HTTP ACK, the UI retains the actual native outcome and the local command stays uncertain. The official audit record has only `id` and `outcome`; it does not identify the answering Client. The same option cannot supply that missing provenance. When a current ACK precedes the decision, only the matching original option completes the local command. A different native decision stays uncertain. The DSH UI states the native result without inventing which interface supplied it; `unavailable` explicitly grants no permission.

Original failure, late ACK, current native decision and acceptance remain separate evidence. This change adds no automatic retry and never sends an old choice to a new approval. Subsequent explicit recovery must use the official same-event idempotency boundary and retain the original choice and identities.

The source regression uses production adapter/HTTP/journal and actual Chromium/WebSocket with controlled native envelopes. The official fixed service and Gateway contract were read unchanged at `0.2.2-rc.1` / `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`. Native, Provider, real multi-client and target-platform acceptance are not established by those fixtures; paid tasks and failed/untriggered evidence are retained separately. Refs #278, #53, #52, #48 (DSH), #42.
