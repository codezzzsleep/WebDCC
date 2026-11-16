# Codex native goal readback

Native goal updates and clears invalidate pending goal snapshots with a process
local observation counter. `nativeState` retries the read-only thread/goal query
up to three times when an accepted goal notification arrives during the read.
Continuous changes or a read failure return an explicit unconfirmed result;
they do not publish an obsolete goal or retry a goal mutation/model input.

CLI history return also captures the observation counter before `goal/get`.
A newer goal update/clear retains its live projection, while the old read remains
in the raw native ledger. A changed or closed runtime cannot project that result.
The native thread, goal timestamps, status, budget, statistics and request IDs
keep their existing meaning. No database, public queue or owner fields change.

```bash
pnpm exec vitest run packages/adapters/codex/test/goal-read.spec.ts --maxWorkers=1
pnpm test:browser browser-tests/codex-goal-read.spec.ts
```

The regressions use controlled deferred RPC responses and the production handler,
manager, SQLite and source UI. Existing official native captures are evidence of
the native DTO/transport contract, not proof that this exact race occurred in a
live Provider session. Native goal state stays separate from turn completion.
Missing/null token budget is native Keep rather than a fabricated budget clear;
the original queue notification supplies a thread ID without an edit API.
