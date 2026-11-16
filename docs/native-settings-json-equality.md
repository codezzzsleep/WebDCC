# Native settings JSON equality

Refs #302, #54 (NP-12), #42.

Native settings readback previously compared `JSON.stringify` output. A Host
could accept the requested change and return equivalent model objects with
their keys in a different order, yet WebDCC reported an unconfirmed write.
The same comparison could send a redundant mutation for an unchanged effort
map, advancing the native revision despite identical configuration values.

The settings service now compares parsed JSON values. Object property order
does not affect equality; array positions, field presence, scalar types,
nulls and nested values still do. This comparison applies to no-op planning
and write confirmation. New-provider native defaults retain their existing
partial-match contract.

Native RPCs, revision checks, Host targeting, credential references, and
unknown-field preservation remain under the existing service contract. A
different returned value stays unconfirmed, and no failure writes a local
configuration file or triggers an automatic retry.

Directed verification uses actual local HTTP with the controlled settings
Host fixture. It covers reordered model/effort keys, an unchanged effort map
without a mutation, and number, type, missing-field, null, added-field and
array-order differences. Original failed readback evidence is retained.

These are settings-contract regressions, not new official DSH or provider
calls. Named-profile file editing, cross-namespace atomicity and complete
native/target-platform acceptance remain separate scopes.
