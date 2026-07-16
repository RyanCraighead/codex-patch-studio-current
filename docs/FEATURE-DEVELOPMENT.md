# Feature Development

Independent features are source-only patch modules with an explicit compatibility and ownership contract. Contribution and local modules are disabled until selected and execute through a restricted synchronous API. Trusted built-in modules compose builder-owned primitives through an authenticated operation interface. Every module must pass unpacked and packed verification.

## Module Locations

- Built-in metadata: `features/core/<feature>/feature.json`.
- Reviewable contributions: `features/community/<feature>/feature.json`.
- Private modules: `%USERPROFILE%\.codex-patch-studio-current\features\<feature>\feature.json`.

Only `contribution` and `local` modules are independently configurable. Only `core` features may set `enabledByDefault: true`.

## Required Layout

```text
<feature>/
|-- feature.json
|-- README.md
|-- adapters/
|   `-- <codex-version>.cjs
|-- payload/
|   `-- <authored files copied by the adapter>
`-- tests/
    `-- <name>.test.cjs
```

Every selector in `supports.codexVersions` requires a matching `adapters/<selector>.cjs`. Selectors are exact versions such as `26.707.9981.0` or a tested Store-family selector such as `26.707.x`, which matches numeric `26.707.*` builds. Missing adapters, unsupported versions, and overlapping exact/family matches fail closed. `payload/`, `tests/`, and `README.md` are required even when a starter module does not yet copy a payload.

## Manifest Contract

```json
{
  "schemaVersion": 1,
  "id": "example.my-feature",
  "name": "My Feature",
  "description": "A short user-facing description.",
  "version": "0.1.0",
  "kind": "contribution",
  "implementation": "module",
  "enabledByDefault": false,
  "dependencies": [],
  "conflicts": [],
  "supports": {
    "codexVersions": ["26.700.0.0"]
  },
  "structuralAnchors": [
    {
      "id": "composer-target",
      "path": "webview/assets/*.js",
      "includes": "short structural marker",
      "cardinality": { "exact": 1 }
    }
  ],
  "runtime": {
    "permissions": ["patch:asar"],
    "localPorts": [
      {
        "name": "example-service",
        "port": 48001,
        "protocol": "tcp",
        "host": "127.0.0.1"
      }
    ]
  },
  "native": {
    "settings": [{ "id": "example-settings", "label": "Example", "route": "/settings/example" }],
    "sidebar": [{ "id": "example-sidebar", "label": "Example", "route": "/example" }]
  },
  "verification": [
    {
      "id": "packed-marker",
      "path": "webview/assets/example-feature.js",
      "includes": "example-feature-installed",
      "cardinality": 1
    }
  ],
  "distribution": {
    "upstreamArtifacts": "forbidden"
  }
}
```

Dependencies are enabled and applied before their dependents. Missing dependencies, dependency cycles, explicit disablement of a dependency, and enabled conflicts abort resolution. Enabled modules also cannot claim the same protocol/loopback port or the same native settings/sidebar ID.

Structural anchors are checked before an adapter runs. `path` supports `*`, `**`, and `?`, or an anchor may use `files: { "under", "pathIncludes", "suffix" }`. Cardinality accepts a positive integer, `{ "exact": 1 }`, or minimum/maximum bounds. Verification markers run after apply and again against the clean packed extraction; omitted verification cardinality defaults to exactly one match.

## Version Adapters

An adapter exports API version 1 and identifies the exact build or tested Store family represented by its filename:

```js
module.exports = {
  apiVersion: 1,
  codexVersion: "26.700.0.0",
  apply(context) {
    context.replaceAnchor("composer-target", "example-feature-installed");
    context.copyPayload("example-feature.js", "webview/assets/example-feature.js");
    return { changed: true };
  },
  verify(context, phase) {
    if (!context.readText("webview/assets/example-feature.js").includes("example-feature-installed")) {
      throw new Error("feature marker is missing");
    }
    return { ok: true, phase };
  },
};
```

Both hooks must be synchronous. Contribution and local adapters run in a data-only VM without host callables, `require`, `process`, direct filesystem access, dynamic code generation, or WebAssembly. They receive:

- `readText(relativePath)` and `writeText(relativePath, content)`.
- `replaceExactly(relativePath, from, to)` for a one-match replacement.
- `getAnchorMatches(anchorId)` and `replaceAnchor(anchorId, replacement)` for declared anchors.
- `findFiles({ under, includes, suffix })` for path discovery.
- `copyPayload(payloadRelativePath, extractRelativePath)` for authored files under `payload/` only.

All extracted-app paths stay within the temporary extraction, including through symbolic links. Packed verification is read-only. Built-in `core` adapters are trusted repository code and may load their adjacent authored `implementation.cjs`. Their patch composition uses `runCoreOperation(operationId)` and `verifyCoreFeature(phase)`; the builder authenticates the calling feature ID and rejects unknown operations or operations owned by another feature. Legacy `runCoreStep` access is rejected.

When Codex updates outside a declared family, inspect the new build without copying upstream source into the repository. Add the exact version or a deliberately validated family selector to `supports.codexVersions`, create its adapter, use short interoperability markers with explicit cardinality, and add synthetic tests. Family adapters remain protected by structural and packed verification; never broaden one across a new Store family without evidence.

## Scaffolding

```powershell
node scripts\feature-registry.cjs scaffold --kind local --id local.my-feature --codex-version 26.700.0.0
node scripts\feature-registry.cjs scaffold --kind contribution --id example.my-feature --codex-version 26.700.0.0
```

Without `--codex-version`, scaffolding uses `0.0.0` as a deliberately unsupported placeholder. The scaffold contains the complete layout, a parseable no-op adapter, a runnable starter test, and a module README.

Use `codex-patcher-local-feature` for private modules and `codex-patcher-contribute` for reviewable worktree-based contributions.

## Source-Only Boundary

Modules may contain authored source, tests, documentation, and ordinary visual assets. They cannot contain Codex executables, ASARs, extracted bundles, native binaries, databases, generated app clones, credentials, user data, large copied upstream functions, or symbolic links. `distribution.upstreamArtifacts` must remain `"forbidden"`.

## Validation

```powershell
node --test tests\feature-registry.test.cjs
npm run features:validate
npm run check:source-only
npm test
```

Run `npm run test:live` for patch-output changes and `npm run test:runtime` plus `npm run test:ui` for runtime or user-facing changes. Evidence may include versions, hashes, match counts, logs without source bodies, and screenshots; never publish extracted application material.
