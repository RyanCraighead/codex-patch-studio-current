# Feature Development

## Module Locations

- Built-in metadata: `features/core/<feature>/feature.json`.
- Reviewable contributions: `features/community/<feature>/feature.json`.
- Private modules: `%USERPROFILE%\.codex-patch-studio-current\features\<feature>\feature.json`.

Private modules are intentionally outside the repository. The Patcher settings page discovers all three catalogs but only contribution and local modules can be independently enabled there.

## Manifest Contract

Every module uses schema version 1 and declares:

- Namespaced `id`, display `name`, semantic `version`, and `description`.
- `kind`: `core`, `contribution`, or `local`.
- `implementation`: `builtin` or `module`.
- `entry` for executable source modules.
- `dependencies`, `conflicts`, compatibility range, permissions, and verification markers.
- `distribution.upstreamArtifacts: "forbidden"`.

Only core modules may be enabled by default. Duplicate IDs, missing dependencies, cycles, conflicts, incompatible Codex versions, path traversal, and ambiguous verification fail the build.

## Restricted Module API

Source modules export a synchronous API:

```js
module.exports = {
  apiVersion: 1,
  apply(context) {
    context.replaceExactly("webview/example.js", "structural marker", "replacement");
    return { changed: true };
  },
  verify(context, phase) {
    return { phase, ok: context.readText("webview/example.js").includes("replacement") };
  },
};
```

The module runs in a VM context without `require`, `process`, dynamic code generation, or direct filesystem access. Available helpers are:

- `readText(relativePath)`
- `writeText(relativePath, content)`
- `replaceExactly(relativePath, from, to)`
- `findFiles({ under, includes, suffix })`
- `copyPayload(moduleRelativePath, extractRelativePath)`

All target paths must stay inside the temporary extracted application. Payload paths must stay inside the module. Packed verification is read-only.

## Scaffolding

```powershell
node scripts\feature-registry.cjs scaffold --kind local --id local.my-feature
node scripts\feature-registry.cjs scaffold --kind contribution --id example.my-feature
```

Use the repository skills for the complete workflows:

- `codex-patcher-local-feature` keeps personal work local and Git-tracked without a remote by default.
- `codex-patcher-contribute` creates an isolated worktree, validates provenance, and prepares a reviewable pull request.

## Validation

```powershell
npm run features:validate
npm run check:source-only
npm test
npm run test:live
```

User-facing or runtime changes must also run `npm run test:runtime` and `npm run test:ui`. Validation artifacts may record versions, hashes, match counts, logs without source bodies, and screenshots. Never publish extracted bundles.
