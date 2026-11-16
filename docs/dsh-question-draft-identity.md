# DSH question draft identity

Cached questions can render before the Session feed supplies its Agent identity. The DSH wait controller then restores `editing` or `waiting`, while a form initialized without that identity keeps empty selected/custom values. Re-loading the same page may avoid the order and conceal the failure.

The form now restores its non-secret draft when the stable Session/nativeId/callId/itemId identity becomes available or changes. A new Client or open/continued phase for the same native call does not reset the current editor. Sensitive values retain their existing page-only behavior.

The deterministic Source Timeline/HTTP/Chromium fixture publishes cached question data before Session metadata. It failed with an empty input after a ten-second observable wait, then passed after the fix; the secret negative control and same-call re-delivery also pass. Existing desktop/mobile native-shaped timed question checks remain separate controlled transport tests. No native Host, Agent or Provider is run by the draft fixture, and those tests do not prove current Provider or target-platform availability.

Native remains `0.2.2-rc.1` / `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`; no official prompt, tool, permission, protocol or version is changed. The initial integration failure, matching-head recheck, dependency-resolution fixture failure and exact deterministic failure remain retained in the private evidence ledger. Refs #294, #53, #52, #61 (DSH), #42.
