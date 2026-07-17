---
name: codex-patcher-local-feature
description: Create or modify a private Codex Patch Studio feature for personal use. Use when the user wants a local patch, custom setting, private provider integration, experimental feature, or self-modification that should be Git-tracked but not submitted upstream.
---

# Codex Patcher Local Feature

Build personal source-only feature modules on local-only Git branches without changing `main` or publishing by default.

## Workflow

1. Locate Codex Patch Studio and read `docs/FEATURE-WORKFLOWS.md`, `docs/FEATURE-DEVELOPMENT.md`, and `SECURITY.md`.
2. Determine the exact installed Codex version, source-ASAR SHA-256, app-server CLI SHA-256, and a namespaced ID such as `local.<slug>`.
3. From a clean committed baseline, invoke the executable workflow:
   `node scripts/feature-development-workflow.cjs start --mode local --feature local.<slug> --slug <slug> --codex-version <version> --source-asar-sha256 <64-hex-sha256> --source-cli-sha256 <64-hex-sha256>`
4. Continue only in the returned `local/<slug>` worktree. The command has already scaffolded a versioned adapter through the feature registry and committed the scaffold checkpoint.
5. If runtime discovery is needed, ask before pointing ignored local config at the worktree's `features/local` directory. Never commit local config.
6. Implement through restricted context helpers. Do not read installed files directly from module code, use `require` or `process` in an adapter, or include copied/minified Codex source.
7. Add synthetic tests. Never commit extracted ASAR contents, application binaries, chat databases, credentials, logs, or generated clones.
8. Use `checkpoint` for `first-successful-patch`, `packed-verification`, `runtime-ui-validation`, and `docs`, in that order. The first checkpoint runs module tests. Packed and runtime/UI checkpoints require module-relative structured evidence JSON with the exact feature/version/fingerprints and store its SHA-256; runtime/UI may be N/A only with `--not-applicable --note <reason>`. The docs checkpoint validates the module README.
9. Run `status` and the repository validation commands before finishing, and do not add a remote, push, or open a pull request unless the user explicitly requests that action.
10. When the user decides to upstream the feature, use `convert --feature <publisher>.<slug>` so a fresh `contrib/<slug>` worktree is created from the recorded baseline.

## Safety

- Preserve the last verified clone. Never edit the Microsoft Store installation or an active clone in place.
- Treat zero or multiple structural matches as a hard failure.
- Keep the feature disabled until its unpacked and packed verification passes.
- Ask before changing shared user config, installing dependencies, or publishing anything.
- Local mode never pushes or opens a PR. `start`, `checkpoint`, and `convert` are local operations; use `convert` before any contribution publication workflow.

Read [references/checklist.md](references/checklist.md) before the final validation pass.
