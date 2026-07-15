# Contributing

Codex Patch Studio accepts source-only framework changes, compatibility adapters, tests, documentation, and feature modules. It does not accept redistributed Codex application material.

## Start Isolated

Create a dedicated branch and worktree from a clean committed `main`:

```powershell
git worktree add ..\codex-patch-studio-<slug> -b codex/<type>-<slug> main
```

Do not mix personal modules or local configuration into a contribution branch.

## Source Boundary

Do not commit or attach:

- Executables, DLLs, Node native binaries, ASARs, archives, generated clones, or Store package files.
- Extracted/minified Codex bundles, complete upstream functions, normalized AST dumps, or proprietary fixtures.
- Chat databases, rollouts, exports, backups, authentication, provider keys, logs, or Electron profiles.
- `config/patcher.local.json`, `codex-launcher.local.json`, or private local modules.

Use structural probes, short interoperability markers, hashes, counts, synthetic fixtures, and your own replacement code. Run `npm run check:source-only` before every push.

## Feature Modules

Contribution modules live under `features/community`, are disabled by default, and declare `distribution.upstreamArtifacts: "forbidden"`. Follow `docs/FEATURE-DEVELOPMENT.md` and use the `codex-patcher-contribute` repository skill.

Adapters must fail closed when a target is absent or ambiguous. All paths remain inside the temporary extraction root. Unpacked and packed verification are required.

## Required Checks

```powershell
npm ci
npm run features:validate
npm run check:source-only
npm test
```

Run `npm run test:live` for patch-output changes. Run runtime and UI tests for renderer, bridge, provider, launch, settings, or orchestration changes.

## Pull Requests

Open a draft pull request first. Describe compatibility scope, implementation boundary, rollback, source provenance, and validation evidence. Do not upload generated application artifacts. A change is ready for review only after required checks pass.
