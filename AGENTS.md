# Repository Agent Rules

- Never commit or publish Codex application files, extracted bundles, generated clones, user data, credentials, or complete upstream functions.
- Run `npm run check:source-only` and `npm test` before committing.
- Use a dedicated `codex/` worktree for contribution work when a committed baseline exists.
- Keep private modules under the configured local feature root and out of this repository.
- Patch only temporary extracted clones and fail closed on missing or ambiguous anchors.
- Preserve the last verified clone until a new candidate passes packed verification.
