const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  applyFeatureModules,
  createPatchContext,
  discoverFeatureModules,
  resolveFeatureModules,
  validateManifest,
  verifyFeatureModules,
} = require("../scripts/feature-registry.cjs");

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-registry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeFeature(root, relativeRoot, manifest, moduleSource = null) {
  const featureRoot = path.join(root, relativeRoot);
  fs.mkdirSync(featureRoot, { recursive: true });
  fs.writeFileSync(path.join(featureRoot, "feature.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (moduleSource) fs.writeFileSync(path.join(featureRoot, "module.cjs"), moduleSource, "utf8");
  return featureRoot;
}

function manifest(id, kind = "contribution") {
  return {
    schemaVersion: 1,
    id,
    name: id,
    description: "Synthetic test module.",
    version: "0.1.0",
    kind,
    implementation: "module",
    entry: "module.cjs",
    enabledByDefault: false,
    dependencies: [],
    conflicts: [],
    permissions: ["patch:asar"],
    supports: { minimumCodexVersion: "1.0.0", maximumCodexVersion: null },
    verification: [{ path: "webview/test.txt", includes: "patched" }],
    distribution: { upstreamArtifacts: "forbidden" },
  };
}

test("discovers, resolves, applies, and packed-verifies a source-only module", (t) => {
  const root = tempRoot(t);
  const moduleSource = `module.exports={apiVersion:1,apply(context){context.writeText("webview/test.txt","patched");return{changed:true}},verify(context,phase){if(!context.readText("webview/test.txt").includes("patched"))throw new Error("missing");return{phase}}};`;
  writeFeature(root, "features/community/example", manifest("example.feature"), moduleSource);
  const catalog = discoverFeatureModules(root, { localFeatureRoot: path.join(root, "local") });
  const resolved = resolveFeatureModules(catalog, {
    sourceVersion: "26.700.0.0",
    featureModules: { "example.feature": true },
    builtinFeatures: {},
  });
  const extractDir = path.join(root, "extract");
  fs.mkdirSync(path.join(extractDir, "webview"), { recursive: true });
  assert.equal(applyFeatureModules(resolved, extractDir, { sourceVersion: "26.700.0.0" })[0].result.changed, true);
  assert.equal(verifyFeatureModules(resolved, extractDir, { sourceVersion: "26.700.0.0" })[0].verification[0].matched, true);
});

test("rejects duplicate feature ids", (t) => {
  const root = tempRoot(t);
  const source = `module.exports={apiVersion:1,apply(){}};`;
  writeFeature(root, "features/community/one", manifest("example.duplicate"), source);
  writeFeature(root, "features/community/two", manifest("example.duplicate"), source);
  assert.throws(() => discoverFeatureModules(root, { localFeatureRoot: path.join(root, "local") }), /Duplicate feature id/);
});

test("rejects manifest and patch path traversal", (t) => {
  const root = tempRoot(t);
  const featureRoot = path.join(root, "feature");
  fs.mkdirSync(featureRoot, { recursive: true });
  const unsafe = { ...manifest("example.unsafe"), entry: "../module.cjs" };
  assert.throws(() => validateManifest(unsafe, path.join(featureRoot, "feature.json"), "contribution"), /escapes/);

  const record = {
    id: "example.safe",
    rootPath: featureRoot,
    manifest: manifest("example.safe"),
  };
  const extractDir = path.join(root, "extract");
  fs.mkdirSync(extractDir);
  const context = createPatchContext(record, extractDir, "unpacked");
  assert.throws(() => context.writeText("../outside.txt", "bad"), /escapes/);
});

test("rejects enabled conflicts and unsupported versions", (t) => {
  const root = tempRoot(t);
  const source = `module.exports={apiVersion:1,apply(){}};`;
  const first = manifest("example.first");
  first.conflicts = ["example.second"];
  const second = manifest("example.second");
  writeFeature(root, "features/community/first", first, source);
  writeFeature(root, "features/community/second", second, source);
  const catalog = discoverFeatureModules(root, { localFeatureRoot: path.join(root, "local") });
  assert.throws(
    () => resolveFeatureModules(catalog, { sourceVersion: "26.700.0.0", featureModules: { "example.first": true, "example.second": true } }),
    /conflicts/
  );
  assert.throws(
    () => resolveFeatureModules(catalog, { sourceVersion: "0.1.0", featureModules: { "example.first": true } }),
    /does not support/
  );
});
