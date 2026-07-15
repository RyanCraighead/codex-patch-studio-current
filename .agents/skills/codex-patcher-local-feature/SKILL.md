---
name: codex-patcher-local-feature
description: Create or modify a private Codex Patch Studio feature for personal use. Use when the user wants a local patch, custom setting, private provider integration, experimental feature, or self-modification that should be Git-tracked but not submitted upstream.
---

# Codex Patcher Local Feature

Build personal feature modules without placing them in the public patcher repository or copying Codex application code.

## Workflow

1. Locate the Codex Patch Studio repository and read `docs/FEATURE-DEVELOPMENT.md`.
2. Determine scope:
   - For an ordinary patch module, use `%USERPROFILE%\.codex-patch-studio-current\features`.
   - For framework changes, create a dedicated `codex/local-<slug>` worktree from a clean committed baseline.
3. Keep local modules in their own local Git repository. Initialize it if needed, create `local/<slug>`, and do not add a remote unless the user explicitly asks.
4. Scaffold with:
   `node scripts/feature-registry.cjs scaffold --kind local --id local.<slug>`
5. Implement through the restricted module context only. Do not read installed files directly from module code, use `require`, access `process`, or include copied/minified Codex source.
6. Add synthetic tests. Never commit extracted ASAR contents, application binaries, chat databases, credentials, logs, or generated clones.
7. Validate from the patcher repository:
   - `npm run features:validate`
   - `npm run check:source-only`
   - `npm test`
8. If the installed Codex build is available, run the verified packed build. Record only version, hashes, match counts, and pass/fail evidence.
9. Commit coherent checkpoints to the local feature repository. Do not push or open a pull request by default.

## Safety

- Preserve the last verified clone. Never edit the Microsoft Store installation or an active clone in place.
- Treat zero or multiple structural matches as a hard failure.
- Keep the feature disabled until its unpacked and packed verification passes.
- Ask before changing shared user config, installing dependencies, or publishing anything.

Read [references/checklist.md](references/checklist.md) before the final validation pass.
