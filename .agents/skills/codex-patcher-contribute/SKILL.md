---
name: codex-patcher-contribute
description: Implement and submit a source-only Codex Patch Studio contribution. Use when the user wants to contribute a feature module, update a version adapter, fix the patch framework, create a branch or worktree, prepare a pull request, or respond to patcher review feedback.
---

# Contribute To Codex Patch Studio

Produce reviewable source-only contributions with isolated Git history and reproducible validation evidence.

## Workflow

1. Read `CONTRIBUTING.md`, `SECURITY.md`, and `docs/FEATURE-DEVELOPMENT.md`.
2. Confirm the repository has a clean committed baseline. Create a dedicated worktree on `codex/<type>-<slug>`; never develop a contribution directly on `main`.
3. For a module, scaffold with:
   `node scripts/feature-registry.cjs scaffold --kind contribution --id <publisher>.<slug>`
4. Keep the change narrowly owned. Module code must use the restricted context API and be disabled by default.
5. Do not commit or quote Codex binaries, ASARs, extracted bundles, complete upstream functions, normalized AST dumps, user data, credentials, logs, or generated application clones. Structural probes and short interoperability markers are allowed.
6. Add synthetic tests for discovery, compatibility, dependency ordering, match cardinality, idempotence, and packed verification as applicable.
7. Run:
   - `npm run features:validate`
   - `npm run check:source-only`
   - `npm test`
   - `npm run test:live` when the change touches patch output
   - `npm run test:runtime` and `npm run test:ui` for user-facing/runtime changes
8. Capture evidence as hashes, counts, versions, screenshots of the patched UI, and pass/fail results. Never attach extracted proprietary files.
9. Commit intentionally, push the contribution branch, and open a draft pull request using the repository template. Mark ready only after required checks pass.

## Review Standard

- Zero or multiple adapter matches fail closed.
- Builds target a new immutable clone and switch only after verification.
- Existing core flags and native UI behavior remain backward compatible.
- Local/private modules and configuration are excluded from the pull request.
- The pull request explains compatibility scope, rollback, test evidence, and source provenance.

Read [references/review-checklist.md](references/review-checklist.md) before opening the pull request.
