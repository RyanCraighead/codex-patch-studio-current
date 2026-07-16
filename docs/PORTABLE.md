# Distribution Boundary

Codex Patch Studio is distributed as source code only.

The repository, pull requests, issue attachments, and releases must not contain:

- Codex or ChatGPT executables.
- `app.asar`, extracted webview bundles, or complete upstream functions.
- Generated patched clones or self-extracting application packages.
- Chat databases, sessions, exports, credentials, authentication, profiles, or logs.

The patcher creates a local clone from the user's own lawfully installed Codex package. That clone stays on the user's machine and is excluded by `.gitignore` and `npm run check:source-only`.

After a local clone passes setup and validation, `npm run bundle:codex` can create a self-extracting EXE for that user's own machine. The packager embeds a hash-pinned, `asInvoker` 7-Zip installer stub, bundled Node and SQLite runtimes, source-hash metadata, and the locally generated patched app clone.

Payload compression uses a conservative single-thread profile, records each attempt under the temporary package `logs` directory, and runs a separate archive-integrity test before assembling the EXE. If compressed mode fails, the packager retries with a larger store-mode payload rather than emitting a partial archive. The diagnostic logs are excluded from the bundled payload.

The small official 7-Zip SFX stub is the repository's sole binary build-tool exception. Both the packager and source-only guard verify its exact size and SHA-256 before use.

That EXE is still a local interoperability artifact containing upstream application files. It must never be committed, attached, mirrored, or published by this project. Another computer should clone this source repository and run setup against its own installed Codex package.
