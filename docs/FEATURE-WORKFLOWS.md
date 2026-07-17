# Feature Git Workflows

`scripts/feature-development-workflow.cjs` is the executable Git lifecycle for private local features and reviewable contributions. It creates a dedicated worktree, calls the feature registry scaffold, records durable validation metadata, and makes milestone commits without changing `main` or publishing anything.

## Preconditions

- Start from a clean Git worktree with a committed baseline such as `main`.
- Configure a Git author before starting; commits are noninteractive and unsigned.
- Use the exact installed Codex version. The registry creates one fail-closed adapter for that version.
- Record the SHA-256 of the installed source ASAR and app-server CLI. These are required compatibility fingerprints, not paths or copies of application files.
- Keep all implementation and fixtures source-only. Never add extracted bundles, complete upstream functions, binaries, generated clones, credentials, user data, or logs.

The default worktree is a sibling of the source checkout. Pass `--worktree <path>` when a specific location is required. Every command prints JSON suitable for automation.

## Start A Local Feature

```powershell
node scripts\feature-development-workflow.cjs start `
  --mode local `
  --feature local.my-feature `
  --slug my-feature `
  --codex-version 26.715.1000.0 `
  --source-asar-sha256 <64-hex-sha256> `
  --source-cli-sha256 <64-hex-sha256>
```

This creates `local/my-feature`, scaffolds under the branch-local `features/local` directory, writes `.feature-workflows/local-my-feature.json`, runs source-only validation, and commits the scaffold checkpoint. `features/local` remains ignored on other branches; the workflow force-adds only the local feature on its dedicated branch.

To load the module during development, point the ignored `config/patcher.local.json` `localFeatureRoot` at the returned worktree's `features/local` directory. Ask before changing shared user configuration. Do not add a remote or push a local branch unless the user explicitly requests that remote action.

## Start A Contribution

```powershell
node scripts\feature-development-workflow.cjs start `
  --mode contribution `
  --feature example.my-feature `
  --slug my-feature `
  --codex-version 26.715.1000.0 `
  --source-asar-sha256 <64-hex-sha256> `
  --source-cli-sha256 <64-hex-sha256>
```

This creates `contrib/my-feature`, scaffolds the module under `features/community`, and commits the scaffold plus `.feature-workflows/contrib-my-feature.json`. The source worktree and its checked-out baseline remain unchanged.

Use `--baseline <ref>`, `--repo <path>`, and `--worktree <path>` when the defaults are not appropriate. Repeat `--adapter <id>` to record adapters already tested at scaffold time.

## Status And Checkpoints

Inspect the current state from anywhere inside the feature worktree:

```powershell
node scripts\feature-development-workflow.cjs status
```

Complete milestones in order. Each command stages the current worktree, runs the portable and repository source-only guards, updates metadata, and creates a commit with a `Codex-Feature-Milestone` trailer.

```powershell
node scripts\feature-development-workflow.cjs checkpoint --milestone first-successful-patch --adapter renderer@26.715
node scripts\feature-development-workflow.cjs checkpoint --milestone packed-verification --evidence evidence\packed.json --adapter packed@26.715
node scripts\feature-development-workflow.cjs checkpoint --milestone runtime-ui-validation --evidence evidence\runtime-ui.json --adapter settings-ui@26.715
node scripts\feature-development-workflow.cjs checkpoint --milestone docs
```

The first patch checkpoint runs every `tests/**/*.test.cjs` file in the module with `node --test` and records the command, files, exit code, and output hash. `packed-verification` requires an existing module-relative JSON evidence file. It must declare `schemaVersion: 1`, `kind: "packed-verification"`, the feature ID, exact Codex version, source-ASAR hash, source CLI hash, a successful `result`, successful structured `checks`, and a `patchManifest` tied to the feature/version/source-ASAR hash. The workflow stores that file's SHA-256.

`runtime-ui-validation` requires the analogous `kind: "runtime-ui-validation"` JSON evidence and stores its SHA-256. Use `--not-applicable --note <reason>` only when there is genuinely no runtime or UI surface. The docs checkpoint re-validates the module manifest/layout and `README.md` sections, then records the README SHA-256. `--note` is a short reason, never evidence by itself.

Use `--codex-version <version> --source-asar-sha256 <hash> --source-cli-sha256 <hash>` together when validation moves to another exact binary, after adding that version to `supports.codexVersions` and creating its matching `adapters/<version>.cjs`. Repeat `--adapter` to merge tested adapter IDs into the persistent record.

For a change with no runtime or UI surface, record an explicit not-applicable checkpoint:

```powershell
node scripts\feature-development-workflow.cjs checkpoint `
  --milestone runtime-ui-validation `
  --not-applicable `
  --note "No runtime or UI behavior changed."
```

The milestone sequence is scaffold, first successful patch, packed verification, runtime/UI validation, and docs. Failed source-only validation restores the previous metadata state so the checkpoint can be retried after the source is corrected.

## Convert Local Work To A Contribution

Run conversion from a clean local feature worktree:

```powershell
node scripts\feature-development-workflow.cjs convert `
  --feature example.my-feature `
  --target-worktree ..\codex-patch-studio-contrib-my-feature
```

Conversion creates a fresh `contrib/<slug>` worktree from the recorded baseline, scaffolds through the registry, copies the authored local module, changes the manifest ID and kind, records `convertedFrom`, and commits a new scaffold checkpoint. The local branch and worktree are unchanged. Validation milestones reset to pending; tested adapter IDs are retained as prior evidence and must be revalidated on the contribution branch.

## Explicit Publication

No start, checkpoint, status, or conversion command contacts a remote. Publication requires separate explicit commands:

```powershell
node scripts\feature-development-workflow.cjs push --remote origin
node scripts\feature-development-workflow.cjs pr --base main
```

`push` and `pr` are contribution-only. Each refuses to run unless every milestone is terminal, has a valid committed checkpoint after the immutable baseline, and retains its recorded evidence. `push` uses a normal non-force upstream push. `pr` requires the current contribution branch to have an upstream and opens a draft with `gh`; it never pushes implicitly. Its generated body includes the compatibility fingerprints, evidence hashes/results, permissions, ports, test command, and checkpoint commits. Use `pr --ready` only after `status` reports `readyForReview: true`.

Before either publication command, the workflow scans every blob introduced by every commit since the recorded baseline, including blobs later deleted or renamed. It rejects binaries, extracted/copied Codex material, private absolute paths, private keys, and API/token patterns. Removing a bad file in a later commit does not make the branch publishable; create a clean branch from a safe baseline instead.

## Metadata

Each workflow record under `.feature-workflows/` contains:

- Feature ID and mode.
- `codexIdentity` with exact Codex version plus source-ASAR and source CLI SHA-256 fingerprints.
- Dedicated branch name.
- Baseline ref, immutable commit SHA, and mirrored `baselineCommit` binding.
- Relative feature root.
- Sorted tested adapter IDs.
- State, timestamp, Codex version, adapters, and structured test/evidence result for every milestone; `status` resolves each checkpoint commit from its committed trailer and metadata snapshot.
- Local source provenance after conversion.

The metadata is committed source-only evidence. Do not put absolute user paths, source excerpts, credentials, logs, or generated artifact locations in it.
