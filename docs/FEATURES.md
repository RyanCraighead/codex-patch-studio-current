# Feature Inventory

## Native Codex UI

- Eight native settings routes integrated into the current settings navigation: Providers, Auto Router, Prompt Tools, Personas, Orchestrations, Swarm, Imports, and Patcher.
- Native route modules use the current Codex settings shell, spacing, controls, scroll behavior, and navigation lifecycle.
- Custom icons are injected through the current settings icon map.
- Runtime visibility toggles can hide or show patch surfaces without rebuilding.
- Build toggles control which structural patch modules are included in the next clone.

## Chat Loading And Storage

- The default all-chats shim exposes up to 10,000 lightweight thread summaries through a tokenized loopback app-server endpoint.
- The shim follows native app-server cursors in 100-item pages and returns one merged startup catalog to the renderer.
- Native project groups consume lightweight summaries; full conversation bodies remain lazy until a chat is opened.
- The legacy eager 1,000-chat renderer patch remains an optional, disabled module for compatibility testing.
- Shim health records catalog count, page count, duration, active connections, and the pinned upstream CLI hash.
- Provider filters use all configured providers so third-party chats do not disappear from native project groups.
- Patched sessions and `state_5.sqlite` reference the stock archive so both applications see the same chat history.

## Providers And Models

- OpenAI defaults remain available when third-party providers are configured.
- Provider presets: DeepSeek, Z.ai GLM, Alibaba Qwen/DashScope, Cerebras, Ollama, LM Studio, and custom OpenAI-compatible providers.
- Provider API-key field writes the named key to the Windows user environment.
- Provider health, key presence, proxy state, active configuration, and discovered-model source are shown in settings.
- Model discovery reads provider model APIs and merges discovered models with maintained fallbacks.
- Visible-model filtering controls which models appear in the composer model picker.
- All/None controls handle large model catalogs such as Qwen compactly.
- Model selection switches both model and provider for the next turn.
- Provider-specific reasoning choices are displayed per model.
- Local Responses-to-Chat proxies translate Codex Responses API traffic for providers that expose Chat Completions semantics.
- Proxy conversion preserves tool call ordering and provider reasoning/thinking fields across follow-up requests.

## Routing, Prompts, And Personas

- Auto Model Router can be enabled or disabled to avoid an extra routing request.
- Users select the router model and the set of models eligible for automatic selection.
- Router prompt editor and dry-run panel show the model choice without starting a chat turn.
- Review model selection is independent from the active chat model.
- Review prompt viewer, editor, reset, and test panel expose the review template.
- Built-in default prompts are extracted into a local catalog for inspection.
- Default prompt modifiers add user instructions without replacing the built-in prompt blindly.
- Personas include reusable instructions, context triggers, defaults, and turn-time injection.

## Orchestration And Subagents

- Orchestration chats are standalone controller threads rather than threads tied to one project folder.
- The sidebar places Orchestrations above Pinned and renders child chats using native chat-like rows.
- One orchestration can select multiple project workspaces and create one native child thread per target.
- Parent metadata records child thread IDs, project paths, titles, models, and status.
- Child rows can be opened independently like normal Codex chats.
- Swarm settings expose preferred subagent models and hierarchical agent behavior.
- Agent templates cover DeepSeek, Z.ai GLM, Qwen/DashScope, and Cerebras models.

## Imports And Repairs

- Source scanners export Augment, Kiro, Roo Code, and Cline histories.
- Import previews preserve users, assistant messages, tool cards, file-change cards, thought summaries, and available checkpoint diffs.
- Duplicate detection uses source export and conversation identity before scheduling imports.
- Import Selected, Import Project, and Import All use the same validated scheduler.
- Repair actions re-index valid existing Codex rollouts without creating duplicate conversations.
- Close-time jobs stop Codex, apply state/database/session fixes, run diagnostics, and relaunch in the background.
- Import and repair jobs expose progress, preflight output, importer logs, scheduler logs, and job history.

## Build And Update Lifecycle

- Discovers the newest installed `OpenAI.Codex` package automatically.
- Supports an explicit manual source directory for development, but no legacy pinned source.
- Fingerprints source `app.asar`, desktop executable, patch source, and compatibility metadata.
- Applies patch modules using exact structural anchors and validates JavaScript syntax after edits.
- Re-extracts the packed ASAR and verifies every required marker before accepting a build.
- Supports Off, Notify, and Auto rebuild update policies with one-shot checks.
- Builds into a new immutable clone and switches only after packed verification.
- Uses a cross-process mutex and patch-manager singleton to prevent overlapping builds.
- Leaves the signed stock Codex process tree running.
- Relaunches a stopped patched clone automatically after a successful rebuild.
- Creates a desktop shortcut that repeats the current-version check on every launch.

## Verification

- Unit source-contract tests.
- Native payload syntax tests.
- Installed-version and source-hash verification.
- Packed ASAR feature verification.
- Runtime service, provider, storage, preload, and lazy catalog-shim verification.
- CDP navigation and screenshots for native settings pages.
- Renderer exception and console collection.
- Source-only provenance, credential, binary, and copied-anchor guard.
- Feature registry traversal, conflict, compatibility, and packed-verification tests.
