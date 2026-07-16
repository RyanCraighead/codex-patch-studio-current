# Update Lifecycle

## Normal Launch

1. The desktop shortcut starts `scripts/launch-patched-codex.ps1` in a hidden PowerShell process.
2. The configured policy determines whether detection is Off, Notify, or Auto rebuild.
3. `ensure-current-codex-patch.ps1` performs one installed-package check when policy permits it.
4. It compares installed version, package identity, `app.asar` fingerprint, generated executable, and patcher source fingerprint with `codex-launcher.local.json`.
5. When the optional repository channel is enabled, it reads the cache or refreshes it after the configured TTL. A manual **Check Codex + GitHub** runs a one-shot refresh even when automatic channel checks are disabled.
6. When everything matches, it initializes the patched home, starts local bridges, and opens the clone.

## GitHub Compatibility Channel

`update-channel/stable.json` separates three facts that must not be conflated:

1. The Codex package installed on this computer.
2. The local patcher source version and channel revision.
3. The newest source release and exact Codex fingerprints verified by repository automation.

The channel is advisory and disabled by default while this repository is private. Enable it only after `manifestUrl` points to an HTTPS endpoint the machine can fetch. A newer patcher release produces one notification and a release-page link, but source code is never silently replaced. Its deterministic source SHA-256 also identifies same-version local divergence without treating local modifications as a newer release. Local structural and packed verification remains authoritative for rebuilding. If the endpoint is unavailable, the checker uses its last valid atomic cache; without a cache it reports `unknown` and continues local validation. An invalid response never replaces the cache or the last-known-good clone.

Repository automation must run `npm run channel:check`. After adding a fully validated Codex fingerprint, increment `localRevision` in `config/update-channel.json`, run `npm run channel:write`, and publish the resulting source-only manifest only after Windows validation passes.

## Installed Codex Changed

1. A named cross-process mutex prevents overlapping builds.
2. The updater records whether the old configured clone is running but leaves it intact during the build.
3. It copies the installed application into a new immutable, versioned candidate clone.
4. It extracts the source ASAR and applies current structural adapters.
5. JavaScript syntax checks run after each edited asset.
6. The ASAR is repacked, extracted again, and checked for all required features.
7. Only after packed verification succeeds does the launcher config switch to the candidate.
8. If the previous patched clone was running, only its processes are stopped and the verified candidate is relaunched.

## Failure Behavior

The updater fails closed when:

- The installed package cannot be discovered.
- The current version is older than the successor's supported floor.
- A required structural anchor is missing or ambiguous.
- Patched JavaScript fails syntax validation.
- Packed verification does not find every enabled feature.
- Another build owns the patch mutex.

The signed Store package and previous verified clone are read-only throughout this process. A failed patch does not modify stock Codex, the previous clone, or the canonical chat archive.

## Adding A Validated Build

After an updated build passes unit, packed, runtime, UI, and renderer diagnostics, add its version and hashes to `config/compatibility.json`. This records a known validation result but does not change current-version discovery.

Recommended commands:

```powershell
npm run update:current
npm run channel:check
npm test
npm run test:live
$env:CODEX_PATCHED_REMOTE_DEBUGGING_PORT = "9229"
npm run launch:codex
npm run test:runtime
npm run test:ui
node scripts\collect-renderer-diagnostics.cjs 9229
```
