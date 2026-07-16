# Contribution Review Checklist

- Work is isolated in a dedicated `contrib/<slug>` worktree and `main` is unchanged.
- `.feature-workflows/contrib-<slug>.json` records feature, mode, `codexIdentity` (exact version/source-ASAR/source CLI SHA-256), branch, baseline SHA, tested adapters, and milestone state.
- The manifest is valid, source-only, disabled by default, and scoped to exact version adapters.
- No installed or extracted Codex material is committed.
- No binaries, generated clones, user data, credentials, or local config are staged.
- Structural matching fails for zero or multiple targets.
- Unpacked and packed verification pass.
- Synthetic tests cover failure paths and path traversal.
- `npm run check:source-only` and `npm test` pass.
- Scaffold, first successful patch, packed verification, runtime/UI, and docs checkpoints are committed in order.
- First-patch test output and packed/runtime structured evidence hashes are recorded; runtime/UI is explicitly recorded as not applicable only with a reason.
- The pull request documents rollback and does not include private local modules.
- Push and draft PR creation happened only after an explicit user request, every milestone has a valid checkpoint commit, and `pr` did not perform an implicit push.
