# Contribution Review Checklist

- Work is isolated in a dedicated `codex/` worktree and branch.
- The manifest is valid, source-only, disabled by default, and compatibility-scoped.
- No installed or extracted Codex material is committed.
- No binaries, generated clones, user data, credentials, or local config are staged.
- Structural matching fails for zero or multiple targets.
- Unpacked and packed verification pass.
- Synthetic tests cover failure paths and path traversal.
- `npm run check:source-only` and `npm test` pass.
- Live/runtime/UI evidence is included when applicable.
- The pull request documents rollback and does not include private local modules.
