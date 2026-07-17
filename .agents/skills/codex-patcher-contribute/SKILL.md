---
name: codex-patcher-contribute
description: Implement and submit a source-only Codex Patch Studio contribution. Use when the user wants to contribute a feature module, update a version adapter, fix the patch framework, create a branch or worktree, prepare a pull request, or respond to patcher review feedback.
---

# Contribute To Codex Patch Studio

Produce reviewable source-only contributions with isolated Git history and reproducible validation evidence.

## Workflow

1. Read `CONTRIBUTING.md`, `SECURITY.md`, `docs/FEATURE-WORKFLOWS.md`, and `docs/FEATURE-DEVELOPMENT.md`.
2. Confirm the source worktree is clean with a committed baseline, determine the exact version/source-ASAR/source CLI SHA-256 values, then invoke:
   `node scripts/feature-development-workflow.cjs start --mode contribution --feature <publisher>.<slug> --slug <slug> --codex-version <version> --source-asar-sha256 <64-hex-sha256> --source-cli-sha256 <64-hex-sha256>`
3. Continue only in the returned `contrib/<slug>` worktree. Never develop a contribution directly on `main`. The workflow has already scaffolded through the registry and committed persistent baseline/compatibility metadata.
4. For existing private work, invoke `convert --feature <publisher>.<slug>` from its clean `local/<slug>` worktree instead of copying it manually.
5. Keep the change narrowly owned. Adapter code must use the restricted context API, declare an exact Codex version, fail closed on structural cardinality, and remain disabled by default.
6. Do not commit or quote Codex binaries, ASARs, extracted bundles, complete upstream functions, normalized AST dumps, user data, credentials, logs, or generated application clones. Structural probes and short interoperability markers are allowed.
7. Add synthetic tests for discovery, compatibility, dependency ordering, match cardinality, idempotence, and packed verification as applicable.
8. Use workflow `checkpoint` commands in order for first successful patch, packed verification, runtime/UI validation, and docs. The first checkpoint runs module tests; packed/runtime checkpoints require structured module-relative evidence JSON with matching fingerprints (runtime/UI may be N/A only with a reason); docs validates the module README. Each checkpoint runs source-only validation and commits current source plus metadata.
9. Run `npm run features:validate`, `npm run check:source-only`, and `npm test`. Also run `npm run test:live` for patch-output changes and runtime/UI tests for user-facing behavior.
10. Capture evidence as hashes, counts, versions, tested adapter IDs, screenshots of the patched UI, and pass/fail results. Never attach extracted proprietary files.
11. Run workflow `status`. Only when the user explicitly requests publication, run `push`, then `pr`; both require terminal milestones, evidence, and valid checkpoint commits. The PR command never pushes implicitly and defaults to a draft. Use `pr --ready` only after all required checks pass.

## Review Standard

- Zero or multiple adapter matches fail closed.
- Builds target a new immutable clone and switch only after verification.
- Existing core flags and native UI behavior remain backward compatible.
- Local/private modules and configuration are excluded from the pull request.
- The pull request explains compatibility scope, rollback, test evidence, and source provenance.
- The branch is `contrib/<slug>` and its workflow metadata points to the immutable baseline used for the contribution.

Read [references/review-checklist.md](references/review-checklist.md) before opening the pull request.
