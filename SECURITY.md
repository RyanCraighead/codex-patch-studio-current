# Security

## Sensitive Data

Never commit or attach:

- Provider API keys.
- `.env` files.
- `config.toml` from either Codex home.
- Codex authentication data.
- Chat exports, SQLite databases, rollouts, backups, or import logs.
- Electron profiles or browser storage.
- Generated app clones or unpacked Store application files.

The repository `.gitignore` excludes the expected local paths, but run a secret scan before every publication.

## Local Services

Import, patch, provider, and catalog-shim services must bind to loopback only. Do not expose ports 4577, 4590, 47731 through 47734, or 47851 to a LAN or the internet. Provider health responses report only key presence, never key values. The catalog shim uses a random per-launch WebSocket path and verifies the upstream CLI hash before launch.

## Source-Only Distribution

Repository commits, pull requests, issue attachments, and releases must not contain Microsoft/OpenAI application files. This includes executables, ASARs, extracted/minified bundles, complete upstream functions, generated clones, database snapshots, and self-extracting packages.

Run `npm run check:source-only` before every commit and in CI. Locally generated clones remain ignored on the machine that owns the installed Codex package. Validation evidence must use versions, hashes, structural match counts, pass/fail output, and screenshots rather than extracted files.

The only executable build-tool exception is `tools/7z-sfx-as-invoker.sfx`, the 7-Zip installer module with this project's `asInvoker` and long-path-aware manifest. The guard pins its exact path, 141,824-byte size, and SHA-256 `E1E9AA1EB9FE7F331DE76479154AC4BB9998C8919DBC79BEBE4F6EAA795CE312`; any replacement or additional executable fails validation.

## Reporting

Report suspected credential exposure privately. Revoke the affected provider key before cleaning history or logs.
