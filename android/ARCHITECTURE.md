# Native mobile interaction model

The UI is driven by `AppState` in `MobileViewModel`. Screens do not construct requests or infer successful mutations from taps.

| State | User action | Result |
|---|---|---|
| Unbound | Paste a complete launch URL | Validate the entire token, exchange it for a host-only login cookie, verify the workspace API, save the encrypted cookie |
| New task | Submit text with project and configuration | Keep the draft through session creation; then create one durable outbox row and show the thread |
| Running | Submit follow-up text | Show a distinct pending / queued row and let the backend schedule it |
| Waiting | Approve or answer | Preserve the selection while the command is in flight; wait for the resolved event |
| Offline | Submit in an existing thread | Save to the local outbox; send after reconnect, with a stable command ID |
| Failed delivery | Retry | Reuse the command ID after uncertain delivery; use a new ID after an explicit rejection |
| Review | Tap a changed file / code line | Open native diff; stage a visible review comment in the composer |
| Navigate back | Close sheet / viewer / thread | Preserve per-thread scroll state and per-project / per-thread draft |

`Models.kt` ports the upstream reducer's authoritative answer rules. Persisted event seq and hot streaming item keys have separate responsibilities. A final event removes the hot item with the same key. Approval and question resolution use logical request IDs, not transient item keys.

`MobileApi` owns authenticated transport; `ConnectionVault` owns encrypted auth; `LocalStore` atomically persists per-server drafts, task summaries, a bounded history cache and outbox. UI requests are scoped to the active connection epoch so an old server response cannot populate a new server's screen.

`MainActivity` handles lifecycle and Android share intents. `Screens`, `Sheets`, `Viewer` and `RichText` are native Compose surfaces. There is no embedded browser.

## Appearance and reasoning settings

Appearance is an independent device preference. `ThemeMode.SYSTEM` is the default; Compose resolves the current Android night configuration at composition time. One palette drives native surfaces, Markdown, diffs and system bars.

Reasoning strength belongs to the selected Agent and model. The client reads declared model capabilities before using the upstream Codex / Claude fallback lists. DSH capabilities are read from its model configuration. New tasks pass `reasoningEffort`; existing tasks wait for `set-reasoning-effort` acknowledgement. Successful choices are remembered per Agent and server, while model changes normalize unsupported levels to a supported default.
