# DSH runtime contracts

WebDCC selects its DSH contract from the authenticated Host bootstrap. The local CLI label cannot identify an attached Host. A runtime upgrade invalidates active bindings; reconnect before submitting new actions. Unsupported versions are refused before submission.

| Published runtime | API methods | Card identity | Plugin events | System messages |
| --- | ---: | --- | --- | --- |
| 0.2.2-rc.1 | 193 | `callId` | `/plugins/events` SSE | Whole messages |
| 0.2.2-rc.5 | 224 | `callId` | `/plugins/events` SSE | Whole messages |
| 0.2.3-alpha.2 | 262 | `cardId` | Authenticated `pluginEvents/follow` mux | Source section updates |

The alpha contract remains marked experimental. Supporting its recorded protocol does not activate an experimental runtime or prove every optional plugin, model, permission, or workflow is available. Capability snapshots retain those verification limits and use the current version's method inventory and contract hash.

The compatibility catalogs come from the actual published npm packages. The exporter retains unary/stream modes, optional wire parameters, JSON schemas, source locations, and the system-message declaration fingerprint. `master` upgrade guides can include changes absent from the latest release; they are insufficient to select a contract. A package's embedded Host commit is recorded independently of a repository tag.

Temporary settings clients and the isolated native Web carrier also select the authenticated Host contract. Settings previews bind the connection, Host manifest, native version, and schema; changes invalidate stale previews. Native card IDs remain native IDs. Delegated `agent-message` content remains separate from human input. Section projection follows native replacement, empty withdrawal, retirement, reset, and compaction rules; attributed notices remain in raw records and are excluded from effective section text. Incomplete or invalid context remains explicit.

Existing logs are preserved. New native RPC captures include the Host fingerprint, runtime version, contract hash, and connection generation. Replay selects the recorded runtime rather than the current local installation. Replay verifies captured behavior; current provider availability requires a live call.

To export another isolated published package:

```sh
pnpm exec tsx scripts/dump-dsh-host-api.ts --packages-root /path/to/node_modules/@deepseek-ai --out /path/to/catalog.json
```

To check the actual Host's API, blank-session operations, and socket recovery without a model request:

```sh
WDCC_DSH_TEST_COMMAND=/path/to/node_modules/.bin/dsh WDCC_DSH_EXPECT_VERSION=0.2.2-rc.5 WDCC_DSH_SMOKE_REPORT=/private/path/report.json pnpm exec tsx packages/adapters/dsh/test/native-host-smoke.ts
```

Source checks, isolated native checks, real provider trajectories, and deployment acceptance are separate. Each deployment still requires all three Agents on the actual target platform. See [the trajectory acceptance workflow](real-trajectory-acceptance.md).
