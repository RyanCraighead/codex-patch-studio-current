# Architecture

## Components

```text
Installed OpenAI.Codex package (read-only)
                |
                v
Current package discovery and fingerprints
                |
                v
ASAR extract -> built-in adapters + selected source modules -> syntax checks
                |
                v
ASAR repack -> clean extraction -> packed verification
                |
                v
Versioned patched app clone + isolated Electron profile
                |
       +--------+---------+
       |                  |
       v                  v
Patched CODEX_HOME     Shared chat/session archive
       |                  |
       v                  v
Provider config        Stock and patched UI see chats
```

## Source Selection

The default and supported production source is the newest installed `OpenAI.Codex` package for the current Windows user. A manual app directory is available for patch development. This repository deliberately has no pinned legacy source mode.

`config/compatibility.json` records exact hashes for builds that passed verification. A new installed version may still build when structural anchors match; the registry records confidence and provenance, not a source pin.

## Patch Modules

The builder extracts `app.asar` and locates current assets by structural signatures rather than fixed hashed filenames. Patch responsibilities include:

- Lazy all-chat catalog routing and all-provider visibility.
- Preload outbound message interception without mutating Electron's frozen bridge object.
- Current composer provider/model catalog and provider switching.
- Native settings section registration, icon mapping, order, visibility, and route modules.
- Native Providers, Orchestrations, Imports, and Patcher payload injection.
- Auto Router, Prompt Tools, Personas, and Swarm route payloads.
- Remote-control feature availability.
- Reasoning summary normalization.

Core feature manifests catalogue the proven built-in adapters. Contribution and private local modules are discovered by `scripts/feature-registry.cjs`, dependency-ordered, compatibility-checked, and disabled until selected. They execute in a restricted VM through path-safe helpers instead of direct Node or filesystem access.

Each replacement requires an exact anchor count. Missing or duplicate anchors abort the build. After repacking, the builder extracts the new ASAR and checks built-in markers plus every selected module again.

## Runtime Isolation

The patched clone uses four distinct roots:

- App clone: configured build output root.
- Electron profile: separate from the signed app profile.
- Patched Codex home: `%USERPROFILE%\.codex-patch-studio-current`.
- Canonical chat data: `%USERPROFILE%\.codex`.

`config.toml`, caches, process manager state, and provider settings stay in the patched home. Session directories are junctioned to the canonical stock archive. SQLite state files are NTFS hard links to the canonical database. This provides shared chat visibility without shared model/provider configuration.

## Local Bridges

- Import manager on port 4577 scans exports, deduplicates source chats, and schedules close-time imports and repairs.
- Patch manager on port 4590 previews, builds, updates, configures modules, and launches patch jobs.
- Provider proxies on ports 47731 through 47734 adapt provider protocols to the Responses API shape Codex expects.
- The all-chats shim on port 47851 proxies the pinned local `codex app-server`, follows native cursors, and expands only lightweight `thread/list` startup requests.

The bridges listen only on loopback. HTTP settings bridges expose the CORS headers required by the `app://` renderer; the catalog shim uses a random per-launch WebSocket path.

## Coexistence

Process selection always uses executable paths. A rebuild is produced beside the active clone. After verification, it stops `ChatGPT.exe`, `Codex.exe`, and the embedded `codex.exe` only when their paths are under the previous configured clone root. Processes under `C:\Program Files\WindowsApps\OpenAI.Codex_*` are not stopped. Separate Electron profiles permit stock and patched Codex to run concurrently.
