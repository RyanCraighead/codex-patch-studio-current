const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { discoverFeatureModules, resolveFeatureModules } = require("../scripts/feature-registry.cjs");

const root = path.resolve(__dirname, "..");
const coreRoot = path.join(root, "features", "core");
const codexVersion = "26.707.x";
const features = [
  { directory: "eager-history", id: "core.eager-history" },
  { directory: "force-main-window", id: "core.force-main-window" },
  { directory: "history", id: "core.history" },
  { directory: "imports", id: "core.imports" },
  { directory: "orchestrations", id: "core.orchestrations" },
  { directory: "patcher-ui", id: "core.patcher-ui" },
  { directory: "provider-suite", id: "core.provider-suite" },
  { directory: "reasoning-compat", id: "core.reasoning-compat" },
  { directory: "remote-control", id: "core.remote-control" },
  { directory: "settings-shell", id: "core.settings-shell" },
];

function featurePath(feature, ...parts) {
  return path.join(coreRoot, feature.directory, ...parts);
}

function readManifest(feature) {
  return JSON.parse(fs.readFileSync(featurePath(feature, "feature.json"), "utf8"));
}

test("the core catalog contains exactly ten independent modules", () => {
  const directories = fs.readdirSync(coreRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(coreRoot, entry.name, "feature.json")))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(directories, features.map((feature) => feature.directory).sort());
  for (const feature of features) assert.notEqual(readManifest(feature).implementation, "builtin");
});

for (const feature of features) {
  test(`${feature.id} has a complete family-adapter module layout`, () => {
    const manifest = readManifest(feature);
    const adapterPath = featurePath(feature, "adapters", `${codexVersion}.cjs`);
    const implementationPath = featurePath(feature, "implementation.cjs");
    const readmePath = featurePath(feature, "README.md");
    const localTestPath = featurePath(feature, "tests", `${feature.directory}.test.cjs`);

    assert.equal(manifest.id, feature.id);
    assert.equal(manifest.kind, "core");
    assert.equal(manifest.implementation, "module");
    assert.deepEqual(manifest.supports, { codexVersions: [codexVersion] });
    assert.equal(Object.hasOwn(manifest, "entry"), false);
    assert.equal(Object.hasOwn(manifest, "permissions"), false);
    assert.ok(Array.isArray(manifest.dependencies));
    assert.ok(Array.isArray(manifest.conflicts));
    assert.ok(Array.isArray(manifest.structuralAnchors) && manifest.structuralAnchors.length > 0);
    assert.ok(Array.isArray(manifest.verification) && manifest.verification.length > 0);
    assert.ok(
      manifest.verification.some((marker) => marker.path === `codex-patch-studio/features/${feature.id}.json`),
      `${feature.id} must verify its packed host receipt`
    );
    assert.ok(Array.isArray(manifest.runtime.permissions) && manifest.runtime.permissions.length > 0);
    assert.ok(Array.isArray(manifest.runtime.localPorts));
    assert.ok(Array.isArray(manifest.native.settings));
    assert.ok(Array.isArray(manifest.native.sidebar));
    assert.deepEqual(manifest.distribution, { upstreamArtifacts: "forbidden" });

    assert.equal(fs.existsSync(adapterPath), true);
    assert.equal(fs.existsSync(implementationPath), true);
    const payloadPath = featurePath(feature, "payload");
    assert.equal(fs.existsSync(payloadPath), true);
    assert.ok(fs.readdirSync(payloadPath).length > 0);
    assert.equal(fs.existsSync(localTestPath), true);
    const readme = fs.readFileSync(readmePath, "utf8");
    assert.ok(readme.includes(feature.id));
    assert.ok(readme.includes(codexVersion));
    assert.match(readme, /source-only/i);

    const adapter = require(adapterPath);
    const implementation = require(implementationPath);
    assert.equal(adapter.apiVersion, 1);
    assert.equal(adapter.codexVersion, codexVersion);
    assert.equal(typeof adapter.apply, "function");
    assert.equal(typeof adapter.verify, "function");

    const verifyResult = Object.freeze({ step: "verify" });
    const calls = [];
    const context = {
      runCoreOperation(operationId) {
        calls.push(["apply", operationId]);
        return Object.freeze({ operationId });
      },
      verifyCoreFeature(phase) {
        calls.push(["verify", phase]);
        return verifyResult;
      },
    };
    const applyResult = adapter.apply(context);
    assert.equal(typeof applyResult, "object");
    assert.equal(adapter.verify(context, "packed"), verifyResult);
    assert.deepEqual(
      calls,
      [...implementation.operations.map((operationId) => ["apply", operationId]), ["verify", "packed"]]
    );
    assert.equal(Object.isFrozen(implementation.operations), true);
  });
}

test("core module dependencies, ports, and native ids are collision-free", () => {
  const featureIds = new Set(features.map((feature) => feature.id));
  const ports = new Map();
  const nativeIds = new Map();

  for (const feature of features) {
    const manifest = readManifest(feature);
    for (const referencedId of [...manifest.dependencies, ...manifest.conflicts]) {
      assert.equal(featureIds.has(referencedId), true, `${feature.id} references unknown feature ${referencedId}`);
    }
    for (const declaration of manifest.runtime.localPorts) {
      const port = Number.isInteger(declaration) ? declaration : declaration.port;
      const protocol = Number.isInteger(declaration) ? "tcp" : declaration.protocol || "tcp";
      const key = `${protocol}:${port}`;
      assert.equal(ports.has(key), false, `${feature.id} collides with ${ports.get(key)} on ${key}`);
      ports.set(key, feature.id);
    }
    for (const area of ["settings", "sidebar"]) {
      for (const addition of manifest.native[area]) {
        const id = typeof addition === "string" ? addition : addition.id;
        assert.equal(nativeIds.has(id), false, `${feature.id} collides with ${nativeIds.get(id)} on native id ${id}`);
        nativeIds.set(id, feature.id);
      }
    }
  }
});

test("builder records explicit core verification evidence for unpacked and packed phases", () => {
  const builder = fs.readFileSync(path.join(root, "scripts", "build-patched-codex-app.cjs"), "utf8");
  assert.match(builder, /function createCoreFeatureVerificationEvidence\(featureId, detail = \{\}\)/);
  assert.match(builder, /verification: "manifest-markers-and-host-receipt"/);
  assert.match(
    builder,
    /verifyFeatureModules\(options\.resolvedFeatureModules, verifyDir, \{[\s\S]*?verifyCoreFeature: createCoreFeatureVerificationEvidence/,
  );
  assert.match(
    builder,
    /applyFeatureModules\(resolvedFeatureModules, extractDir, \{[\s\S]*?verifyCoreFeature: createCoreFeatureVerificationEvidence/,
  );
});

test("core family adapters accept later 26.707 builds and reject a new Store family", () => {
  const catalog = discoverFeatureModules(root, {});
  const currentFamily = resolveFeatureModules(catalog, {
    sourceVersion: "26.707.9999.0",
    includeExternalModules: false,
  });
  assert.ok(currentFamily.enabledIds.includes("core.history"));
  assert.ok(currentFamily.enabledIds.includes("core.settings-shell"));
  assert.throws(
    () => resolveFeatureModules(catalog, { sourceVersion: "26.708.1.0", includeExternalModules: false }),
    /does not support Codex 26\.708\.1\.0/
  );
});
