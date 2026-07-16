# Contributing

Codex Patch Studio accepts source-only framework changes, compatibility adapters, tests, documentation, and feature modules. It does not accept redistributed Codex application material.

## Start Isolated

Use the executable workflow from a clean committed baseline:

```powershell
node scripts\feature-development-workflow.cjs start `
  --mode contribution `
  --feature <publisher>.<slug> `
  --slug <slug> `
  --codex-version <installed-version> `
  --source-asar-sha256 <64-hex-sha256> `
  --source-cli-sha256 <64-hex-sha256>
```

The command creates `contrib/<slug>` in a dedicated sibling worktree, scaffolds through the feature registry, records the baseline commit and `codexIdentity` (exact Codex version/source-ASAR/source CLI fingerprints) under `.feature-workflows/`, runs the source-only guard, and commits the scaffold checkpoint. It never changes `main`, pushes, or opens a pull request. Do not mix personal modules or local configuration into a contribution branch.

Follow [docs/FEATURE-WORKFLOWS.md](docs/FEATURE-WORKFLOWS.md) for status, milestone checkpoints, local-to-contribution conversion, and explicit publication commands.

## Source Boundary

Do not commit or attach:

- Executables, DLLs, Node native binaries, ASARs, archives, generated clones, or Store package files.
- Extracted/minified Codex bundles, complete upstream functions, normalized AST dumps, or proprietary fixtures.
- Chat databases, rollouts, exports, backups, authentication, provider keys, logs, or Electron profiles.
- `config/patcher.local.json`, `codex-launcher.local.json`, or private local modules.

Use structural probes, short interoperability markers, hashes, counts, synthetic fixtures, and your own replacement code. Run `npm run check:source-only` before every push.

## Feature Modules

Contribution modules live under `features/community`, are disabled by default, and declare `distribution.upstreamArtifacts: "forbidden"`. Follow `docs/FEATURE-DEVELOPMENT.md` and use the `codex-patcher-contribute` repository skill.

Adapters must fail closed when a target is absent or ambiguous. All paths remain inside the temporary extraction root. First-patch checkpointing runs module tests. Packed verification requires a committed structured patch-manifest evidence JSON tied to the feature, exact version, and source-ASAR fingerprint; runtime/UI requires structured evidence or an explicit N/A reason; docs checkpointing validates the module README.

## Required Checks

```powershell
npm ci
npm run features:validate
npm run check:source-only
npm test
```

Run `npm run test:live` for patch-output changes. Run runtime and UI tests for renderer, bridge, provider, launch, settings, or orchestration changes.

## Pull Requests

After all required checkpoint evidence is committed and `status` reports `readyForReview: true`, publish only when explicitly requested:

```powershell
node scripts\feature-development-workflow.cjs push --remote origin
node scripts\feature-development-workflow.cjs pr --base main
```

`push` and `pr` reject local workflows and reject incomplete/missing-evidence milestones. `pr` requires an already-pushed upstream and opens a draft; it does not push implicitly. Its generated body includes compatibility fingerprints, evidence hashes/results, declared permissions/ports, tests, and checkpoint commits. Publication scans every blob introduced since baseline, including deleted or renamed historical content, for artifacts, copied/extracted Codex source, private paths, private keys, and secrets. Do not upload generated application artifacts. Use `pr --ready` only after required checks pass and workflow status reports `readyForReview: true`.
