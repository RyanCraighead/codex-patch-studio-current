# Local Feature Checklist

- The workflow branch is `local/<slug>` in a dedicated worktree; `main` is unchanged.
- The module lives under the branch-local `features/local` root, not `features/community`.
- `.feature-workflows/local-<slug>.json` records feature, mode, `codexIdentity` (version/source-ASAR/source CLI SHA-256), branch, baseline SHA, tested adapters, and milestone state.
- Its local branch has not been pushed and no remote was added unless the user requested one.
- `distribution.upstreamArtifacts` is `forbidden`.
- The module is disabled by default, has an exact-version adapter, and uses only restricted context helpers.
- Tests use synthetic fixtures and contain no extracted Codex source.
- No credentials, user data, binaries, ASARs, logs, or generated clones are staged.
- Registry validation, source-only guard, and unit tests pass.
- Scaffold, first successful patch, packed verification, runtime/UI, and docs checkpoints are committed in order.
- First-patch evidence records a passing module test run; packed/runtime evidence JSON hashes are recorded before enabling the module; runtime/UI is either validated or explicitly recorded as not applicable with a reason.
- `status` is clean and accurately reports the next milestone or review readiness.
