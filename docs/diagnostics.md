# Optional diagnostics

Full interaction/model transport diagnostics are off by default. Enable them explicitly with `WDCC_TRACE=1` at server startup; every other value keeps them off. Necessary session events remain in SQLite.

Diagnostic recording may add observer transport hooks and model endpoint proxies. Those belong to diagnostic mode and do not count as baseline native behavior. Test hooks always disable automatic recording; controlled trace tests can use explicit side-channel sinks.

Secret-aware interaction storage, comprehensive redaction and retention quotas remain NP-14 acceptance work. Turning diagnostics off is a corrective default, not a claim that all persisted events are already scrubbed.
