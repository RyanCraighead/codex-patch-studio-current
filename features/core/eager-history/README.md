# Legacy Eager History Hydration

`core.eager-history` optionally applies the legacy large-window history hydration patch. It conflicts with `core.history` and remains disabled by default because large catalogs can cause severe renderer lag.

## Compatibility

The adapter targets Codex `26.707.x` exactly and delegates patching and packed verification to the centrally owned core step.

This module is source-only. Do not add extracted Codex source, application artifacts, user data, or credentials.
