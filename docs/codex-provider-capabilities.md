# Codex Provider model capabilities

A configured Provider can list model IDs without storing model capabilities.
The model-options endpoint reads the official Codex catalog using the same
resolved Provider configuration used to create a session. It returns only IDs
registered for that Provider and matches native entries by exact model ID.
Provider identity must match its runtime configuration before discovery starts.

Native model entries supply reasoning levels, default effort and input
modalities. Explicit Provider reasoning levels, including an empty list, keep
precedence; configured model labels remain unchanged. A missing native entry
or failed discovery leaves capabilities unknown rather than assigning levels
from another Provider or a fixed list. Each request reads the current Provider
configuration, so changed endpoints/catalog paths are not served old choices.

Discovery starts a temporary native catalog observer and closes it after the
read. Credentials only enter its launch environment; they are not returned as
model options or persisted as derived capabilities. Existing Provider rows need
no migration. Native session prompts, tools, permissions and effort forwarding
are unchanged.

Regression coverage includes old Provider rows without modelDetails, distinct
native capabilities for the same ID under different Providers, explicit
metadata and discovery failure, refreshed configuration, new/existing session
selection and preference recovery. Actual official Codex 0.172.0 was also used
for selected-Provider discovery and controlled loopback high/ultra user turns.
Controlled model responses do not establish live provider availability; existing
real trajectories remain separate reusable evidence.
