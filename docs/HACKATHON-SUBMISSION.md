# OpenAI Build Week Submission Draft

## Project

**Name:** Codex Patch Studio

**Tagline:** Turn your installed Codex desktop app into a version-aware, locally verified developer platform.

**Primary track:** Developer Tools

**Repository:** https://github.com/RyanCraighead/codex-patch-studio-current

The repository is private. Before final submission, share it with `testing@devpost.com` and `build-week-event@openai.com`, or make a judging-safe public repository available.

## Description

### Inspiration

Codex is already a capable coding environment, but advanced users often need workflows that do not fit into a single project or a fixed provider setup. I wanted a safe way to experiment with Codex desktop itself without overwriting the signed Store installation, losing chat history, mixing provider credentials, or rebuilding every customization by hand after an update.

### What it does

Codex Patch Studio turns the currently installed Windows Codex app into a separate, user-controlled development platform. It discovers and fingerprints the installed Store build, creates a new local clone, applies selected source-only feature modules, verifies the unpacked and repacked result, and switches the launcher only after every check passes.

The patched instance can run beside stock Codex. It keeps its own configuration, Electron profile, caches, and local services while sharing the user's canonical chat sessions and index by default.

The current feature set includes:

- a lazy catalog shim that exposes thousands of existing chats without eagerly loading full conversation bodies;
- native settings for providers, model routing, prompt tools, personas, orchestrations, imports, patch management, and feature development;
- OpenAI, DeepSeek, Z.ai GLM, Qwen/DashScope, Cerebras, Ollama, LM Studio, and custom-provider controls;
- multi-project orchestration chats and project-specific child chats;
- import and repair workflows for Augment, Kiro, Roo Code, and Cline history;
- an extensible feature-module system with version-family adapters, dependency/conflict checks, restricted execution, and packed verification;
- Off, Notify, and Auto rebuild policies for installed Codex updates, with a last-known-good fallback.

### Why it fits Developer Tools

This is infrastructure for developers who use Codex as an everyday workspace. It combines version-aware patching, local interoperability, model/provider configuration, agent orchestration, chat migration, and verification into one reproducible workflow. The project is designed to fail closed when an application update changes a structural anchor instead of silently producing a broken build.

### How we built it

The patcher is implemented with Node.js and PowerShell on Windows 11. Source-only feature manifests describe compatibility, anchors, dependencies, conflicts, local ports, permissions, and verification markers. The builder copies the user's own installed Codex package into a new immutable candidate directory, runs the selected module operations, checks JavaScript syntax and structural receipts, repacks the app, and validates the packed output before changing launcher metadata.

Codex accelerated the work by helping inspect application behavior, compare successive installed builds, model the native chat and settings flows, implement isolated patch modules, reproduce failures, and turn each discovery into an automated contract test. The important design decisions were encoded as fail-closed checks rather than left as manual reverse-engineering notes.

The repository intentionally contains no Codex executables, ASAR archives, extracted proprietary bundles, generated clones, user chats, credentials, or provider keys. Every user builds locally from their own installed Codex copy.

### Challenges we ran into

The hardest problem was preserving native behavior across app updates. Minified renderer filenames and implementation details can change, so a simple text replacement is not reliable enough. The final design uses version-family adapters, structural anchor cardinality checks, immutable candidate builds, host-generated verification receipts, and a last-known-good launcher.

Another challenge was making stock and patched Codex coexist. They need separate configuration and Electron state, but users still expect the same projects and chats. The launcher now isolates patched state while linking the canonical sessions and chat database intentionally.

### Accomplishments that we're proud of

- Stock Codex is never edited in place.
- A failed candidate cannot replace the last verified clone.
- Stock and patched Codex can run simultaneously with independent provider configuration.
- The lightweight chat catalog supports up to 10,000 threads while keeping full bodies lazy.
- The complete source-only test suite currently contains 112 passing tests.
- A local self-extracting package can be built without publishing the user's installed Codex material.
- The feature framework supports core, reviewable contribution, and private local modules.

### What's next

- Expand tested adapters as new Codex version families ship.
- Add more independently packaged community feature modules.
- Improve judge-friendly demo packaging without crossing the source-distribution boundary.
- Add automated compatibility reporting from Windows CI runners.
- Continue reducing startup overhead for very large chat archives.

## Built With

Codex, GPT-5.6, Node.js, JavaScript, PowerShell, Electron, WebSocket, SQLite, Windows 11, Git, GitHub Actions

## Submission Fields

| Field | Value | Status |
| --- | --- | --- |
| Category | Developer Tools | Ready |
| Project name | Codex Patch Studio | Ready |
| Tagline | Turn your installed Codex desktop app into a version-aware, locally verified developer platform. | Ready |
| Description | Use the description above | Ready |
| Repository | https://github.com/RyanCraighead/codex-patch-studio-current | Private; share with judge emails |
| Demo video | Public YouTube video under three minutes with audio | Missing |
| `/feedback` Codex Session ID | Session where most core functionality was built | Missing |
| Testing instructions | Follow README `Install And First Run`; Windows 11 and an installed Store Codex copy are required | Ready |

## Three-Minute Demo Outline

1. **0:00-0:20 - Problem:** Codex updates, advanced workflows, and large chat histories are difficult to customize safely.
2. **0:20-0:45 - Setup:** Show the source-only repository, `npm run setup`, and the generated desktop shortcut.
3. **0:45-1:10 - Coexistence:** Open stock and patched Codex side by side; show separate provider configuration and shared chats.
4. **1:10-1:50 - Product:** Show Providers, Orchestrations, Imports, Patcher, and Feature Development settings.
5. **1:50-2:20 - Safety:** Show a version check, immutable candidate build, tests, and last-known-good selection.
6. **2:20-2:45 - Codex/GPT-5.6:** Explain how Codex drove investigation, implementation, and contract-test creation.
7. **2:45-3:00 - Close:** Codex Patch Studio makes the desktop app extensible without modifying the signed installation.

## Final Submission Checklist

- [ ] Solve Devpost CAPTCHA and create the draft.
- [ ] Paste the fields above into Devpost.
- [ ] Record and upload the public demo video.
- [ ] Add the `/feedback` Codex Session ID.
- [ ] Share the private repository with both judging email addresses.
- [ ] Verify the selected Developer Tools category.
- [ ] Review every claim against the current build.
- [ ] Submit before July 21, 2026 at 8:00 PM EDT.
