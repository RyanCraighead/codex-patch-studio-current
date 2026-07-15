# Local Feature Checklist

- The module lives under the configured local feature root, not `features/community`.
- Its Git repository has no remote unless the user requested one.
- `distribution.upstreamArtifacts` is `forbidden`.
- The module is disabled by default and uses only restricted context helpers.
- Tests use synthetic fixtures and contain no extracted Codex source.
- No credentials, user data, binaries, ASARs, logs, or generated clones are staged.
- Registry validation, source-only guard, and unit tests pass.
- Packed verification passes before enabling the module.
