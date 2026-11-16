# Current Codex native interface

Related defect: #117. Commands such as `/agents`, `/ps` and `/stop` are
available during a native turn, so routing them exclusively through an idle
CLI takeover prevents users from reaching them.

For reviewed Codex 0.168.0/0.169.0 releases whose actual help advertises Unix
hosting, WebDCC starts the original app-server on a private Unix WebSocket.
The structured adapter and an official remote TUI connect to that same
process. The existing native writer, thread, turn, provider and permissions
remain authoritative. Older supported versions keep their existing stdio
connection and show the live interface as unavailable.

Choose **打开当前原生界面** in the native CLI panel, fill the requested command
and press Enter in the terminal. The TUI runs the command with its own native
semantics. **关闭原生界面** stops the TUI connection; the original app-server
and current work continue. **关闭并清除日志** also removes the view's optional
temporary output log. Refreshing or switching WebDCC sessions reconnects to
the existing view rather than starting another native process or resending
input.

The TUI uses an ephemeral authenticated loopback relay to the private Unix
socket. Browser clients cannot supply a binary, argv, environment or working
directory. The original native resume response must acknowledge the requested
thread before user input is enabled. When the TUI selects another native
Agent, its identity changes only after a matching native response; the source
WebDCC session and writer do not change. Owner/generation changes invalidate
the peer. Each peer's protocol is recorded on `rpc-peer:<view-id>` separately
from the structured client's `rpc` channel and is not dispatched through the
parent adapter handler.

Reproducible source regressions:

```sh
pnpm exec vitest run packages/adapters/codex/test/rpc.spec.ts packages/adapters/codex/test/rpc-unix.spec.ts packages/server/test/native-peer.spec.ts
pnpm exec vitest run --config vitest.browser.config.ts browser-tests/native-peer.spec.ts
pnpm check:source
```

The peer fixture uses a real PTY/WebSocket and scripted CLI/RPC behavior. It
checks identity acknowledgements, owner fencing, failed recording, confirmed
exit, authenticated routing, browser input, refresh, session switching and log
cleanup. It does not represent a native Agent or live provider.

The separate local Codex 0.169.0/Chromium run executes `/ps` and `/stop` against
an empty native background-terminal list and opens the native Agent command
center while one local fixture model response is held. It checks that the
parent owner, runtime, native thread and active turn survive refresh and view
closure. This is actual native protocol/UI behavior with a controlled model,
not live-provider validation. Real child Agents, nonempty background jobs,
applicable auto-review retry, all side operations, multi-client interaction
and public-platform acceptance remain independent acceptance work. Failed or
untriggered earlier attempts remain in the evidence ledger. This PR neither
merges nor deploys the application or declares the full #117 scope accepted.

The source gate also exposed #204: the existing upload recovery test treated
its queued-state button as proof that the planned chunk-1 offline cut had
occurred. The test now waits for the actual route abort, records the original
upload ID and confirmed chunk-0 ACK, and checks that the same upload resumes
only its two missing chunks. The original zero-repeat, byte/hash, sent image
and refresh assertions remain. This changes test synchronization and evidence,
with the upload implementation and native behavior unchanged.
