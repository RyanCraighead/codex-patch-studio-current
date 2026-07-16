const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  applyFeatureModules,
  createPatchContext,
  discoverFeatureModules,
  resolveFeatureModules,
  scaffoldFeature,
  validateManifest,
  verifyFeatureModules,
} = require("../scripts/feature-registry.cjs");

const CODEX_VERSION = "26.700.0.0";
const SECOND_CODEX_VERSION = "26.701.0.0";

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-registry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function moduleManifest(id, overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    name: id,
    description: "Synthetic independent feature module.",
    version: "0.1.0",
    kind: "contribution",
    implementation: "module",
    enabledByDefault: false,
    dependencies: [],
    conflicts: [],
    supports: { codexVersions: [CODEX_VERSION] },
    structuralAnchors: [
      { id: "fixture-anchor", path: "fixture-target.txt", includes: "fixture-before", cardinality: { exact: 1 } },
    ],
    runtime: { permissions: ["patch:asar"], localPorts: [] },
    native: { settings: [], sidebar: [] },
    verification: [
      {
        id: "module-receipt",
        path: `codex-patch-studio/features/${id}.json`,
        includes: `\"id\": \"${id}\"`,
        cardinality: { exact: 1 },
      },
    ],
    distribution: { upstreamArtifacts: "forbidden" },
    ...overrides,
  };
}

function noOpAdapter(version = CODEX_VERSION) {
  return `module.exports={apiVersion:1,codexVersion:${JSON.stringify(version)},apply(){return{changed:false}},verify(context,phase){return{phase}}};`;
}

function writeFeature(root, relativeRoot, manifest, adapters = {}) {
  const featureRoot = path.join(root, relativeRoot);
  fs.mkdirSync(path.join(featureRoot, "adapters"), { recursive: true });
  fs.mkdirSync(path.join(featureRoot, "payload"), { recursive: true });
  fs.mkdirSync(path.join(featureRoot, "tests"), { recursive: true });
  fs.writeFileSync(path.join(featureRoot, "feature.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(featureRoot, "README.md"), `# ${manifest.name}\n`, "utf8");
  fs.writeFileSync(path.join(featureRoot, "payload", ".gitkeep"), "", "utf8");
  fs.writeFileSync(path.join(featureRoot, "tests", "adapter.test.cjs"), `require("node:test")("adapter fixture",()=>{});\n`, "utf8");
  for (const [version, source] of Object.entries(adapters)) {
    fs.writeFileSync(path.join(featureRoot, "adapters", `${version}.cjs`), source, "utf8");
  }
  return featureRoot;
}

function discover(root) {
  return discoverFeatureModules(root, { localFeatureRoot: path.join(root, "local") });
}

function seedStructuralAnchors(extractDir, manifest) {
  for (const anchor of manifest.structuralAnchors) {
    assert.equal(typeof anchor.path, "string", `test fixture ${anchor.id} must use an exact path`);
    assert.doesNotMatch(anchor.path, /[?*]/, `test fixture ${anchor.id} must use an exact path`);
    const filePath = path.join(extractDir, anchor.path);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, anchor.includes, "utf8");
  }
}

test("module manifests and schema require structural anchors and verification markers", (t) => {
  const root = tempRoot(t);
  const manifestPath = path.join(root, "feature.json");
  assert.throws(
    () => validateManifest(moduleManifest("example.no-anchors", { structuralAnchors: [] }), manifestPath, "contribution"),
    /at least one structural anchor/
  );
  assert.throws(
    () => validateManifest(moduleManifest("example.no-verification", { verification: [] }), manifestPath, "contribution"),
    /at least one verification marker/
  );

  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "features", "schema", "feature.schema.json"), "utf8"));
  const moduleRules = schema.allOf[0].then.properties;
  assert.equal(moduleRules.structuralAnchors.minItems, 1);
  assert.equal(moduleRules.verification.minItems, 1);
});

test("discovers, applies, and packed-verifies an exact-version source-only module", (t) => {
  const root = tempRoot(t);
  const manifest = moduleManifest("example.feature", {
    structuralAnchors: [
      {
        id: "example-target",
        path: "webview/test.txt",
        includes: "before-marker",
        cardinality: { exact: 1 },
      },
    ],
    verification: [
      { id: "patched-target", path: "webview/test.txt", includes: "after-marker", cardinality: 1 },
      { id: "payload-copy", path: "webview/message.txt", includes: "authored payload", cardinality: 1 },
    ],
  });
  const adapter = `module.exports={apiVersion:1,codexVersion:${JSON.stringify(CODEX_VERSION)},apply(context){const matches=context.getAnchorMatches("example-target");context.replaceAnchor("example-target","after-marker");context.copyPayload("message.txt","webview/message.txt");return{changed:true,path:matches[0].path}},verify(context,phase){if(!context.readText("webview/test.txt").includes("after-marker"))throw new Error("missing");return{phase}}};`;
  const featureRoot = writeFeature(root, "features/community/example", manifest, { [CODEX_VERSION]: adapter });
  fs.writeFileSync(path.join(featureRoot, "payload", "message.txt"), "authored payload", "utf8");

  const catalog = discover(root);
  const resolved = resolveFeatureModules(catalog, {
    sourceVersion: CODEX_VERSION,
    featureModules: { "example.feature": true },
    builtinFeatures: {},
  });
  const extractDir = path.join(root, "extract");
  fs.mkdirSync(path.join(extractDir, "webview"), { recursive: true });
  fs.writeFileSync(path.join(extractDir, "webview", "test.txt"), "prefix before-marker suffix", "utf8");

  const applied = applyFeatureModules(resolved, extractDir);
  assert.equal(applied[0].result.changed, true);
  assert.equal(applied[0].result.path, "webview/test.txt");
  assert.equal(applied[0].anchors[0].count, 1);
  assert.equal(applied[0].adapter, `adapters/${CODEX_VERSION}.cjs`);
  assert.deepEqual(applied[0].changedPaths, [
    "codex-patch-studio/features/example.feature.json",
    "webview/message.txt",
    "webview/test.txt",
  ]);
  assert.equal(applied[0].receipt.id, "example.feature");
  assert.equal(applied[0].receipt.sourceHash, catalog.byId.get("example.feature").sourceHash);
  assert.deepEqual(applied[0].receipt.anchors, [
    { id: "example-target", count: 1, matches: [{ path: "webview/test.txt", count: 1 }] },
  ]);
  const receiptPath = path.join(extractDir, applied[0].receipt.path);
  assert.deepEqual(JSON.parse(fs.readFileSync(receiptPath, "utf8")), {
    schemaVersion: 1,
    id: "example.feature",
    version: "0.1.0",
    adapter: `adapters/${CODEX_VERSION}.cjs`,
    sourceHash: catalog.byId.get("example.feature").sourceHash,
    anchors: [{ id: "example-target", count: 1, matches: [{ path: "webview/test.txt", count: 1 }] }],
  });
  const verified = verifyFeatureModules(resolved, extractDir);
  assert.equal(verified[0].result.phase, "packed");
  assert.equal(verified[0].receipt.sourceHash, applied[0].receipt.sourceHash);
  assert.equal(verified[0].verification.length, 2);
});

test("wildcard structural anchors can target Codex files inside .vite/build", (t) => {
  const root = tempRoot(t);
  const manifest = moduleManifest("example.vite-build", {
    structuralAnchors: [
      {
        id: "main-process-marker",
        path: ".vite/build/main-*.js",
        includes: "fixture-main-process-anchor",
        cardinality: { exact: 1 },
      },
    ],
  });
  writeFeature(root, "features/community/vite-build", manifest, { [CODEX_VERSION]: noOpAdapter() });
  const resolved = resolveFeatureModules(discover(root), {
    sourceVersion: CODEX_VERSION,
    featureModules: { "example.vite-build": true },
  });
  const extractDir = path.join(root, "extract");
  const buildDir = path.join(extractDir, ".vite", "build");
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, "main-fixture.js"), "fixture-main-process-anchor", "utf8");

  const applied = applyFeatureModules(resolved, extractDir);
  assert.deepEqual(applied[0].anchors, [
    {
      id: "main-process-marker",
      count: 1,
      matches: [{ path: ".vite/build/main-fixture.js", count: 1 }],
    },
  ]);
});

test("packed verification requires the exact host-generated feature receipt", (t) => {
  const root = tempRoot(t);
  const manifest = moduleManifest("example.receipt", { runtime: { permissions: [], localPorts: [] } });
  writeFeature(root, "features/community/receipt", manifest, { [CODEX_VERSION]: noOpAdapter() });
  const resolved = resolveFeatureModules(discover(root), {
    sourceVersion: CODEX_VERSION,
    featureModules: { "example.receipt": true },
  });
  const extractDir = path.join(root, "extract");
  fs.mkdirSync(extractDir);
  seedStructuralAnchors(extractDir, manifest);

  assert.throws(
    () => verifyFeatureModules(resolved, extractDir),
    /packed verification requires feature receipt/
  );
  const applied = applyFeatureModules(resolved, extractDir);
  const receiptPath = path.join(extractDir, applied[0].receipt.path);
  const exactReceipt = fs.readFileSync(receiptPath, "utf8");
  assert.throws(
    () => applyFeatureModules(resolved, extractDir),
    /feature receipt already exists before apply/
  );
  const tampered = JSON.parse(exactReceipt);
  tampered.sourceHash = "0".repeat(64);
  fs.writeFileSync(receiptPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
  assert.throws(
    () => verifyFeatureModules(resolved, extractDir),
    /receipt does not exactly match the current catalog record/
  );

  fs.writeFileSync(receiptPath, exactReceipt, "utf8");
  assert.equal(verifyFeatureModules(resolved, extractDir)[0].receipt.sourceHash, applied[0].sourceHash);
  fs.unlinkSync(receiptPath);
  assert.throws(
    () => verifyFeatureModules(resolved, extractDir),
    /packed verification requires feature receipt/
  );
});

test("false adapter verification results fail unpacked and packed phases", (t) => {
  const cases = [
    { suffix: "false-unpacked", phase: "unpacked", failure: "false" },
    { suffix: "object-unpacked", phase: "unpacked", failure: "{ok:false}" },
    { suffix: "false-packed", phase: "packed", failure: "false" },
    { suffix: "object-packed", phase: "packed", failure: "{ok:false}" },
  ];
  for (const testCase of cases) {
    const root = tempRoot(t);
    const id = `example.${testCase.suffix}`;
    const manifest = moduleManifest(id);
    const adapter = `module.exports={apiVersion:1,codexVersion:${JSON.stringify(CODEX_VERSION)},apply(){return{changed:false}},verify(context,phase){if(phase===${JSON.stringify(testCase.phase)})return ${testCase.failure};return{ok:true,phase}}};`;
    writeFeature(root, `features/community/${testCase.suffix}`, manifest, { [CODEX_VERSION]: adapter });
    const resolved = resolveFeatureModules(discover(root), {
      sourceVersion: CODEX_VERSION,
      featureModules: { [id]: true },
    });
    const extractDir = path.join(root, "extract");
    fs.mkdirSync(extractDir);
    seedStructuralAnchors(extractDir, manifest);
    if (testCase.phase === "unpacked") {
      assert.throws(
        () => applyFeatureModules(resolved, extractDir),
        new RegExp(`${testCase.suffix.replace(/[.-]/g, "\\$&")} verify \\(unpacked\\) reported failure`)
      );
      assert.equal(fs.existsSync(path.join(extractDir, "codex-patch-studio", "features", `${id}.json`)), false);
    } else {
      applyFeatureModules(resolved, extractDir);
      assert.throws(
        () => verifyFeatureModules(resolved, extractDir),
        new RegExp(`${testCase.suffix.replace(/[.-]/g, "\\$&")} verify \\(packed\\) reported failure`)
      );
    }
  }
});

test("local and contribution adapters cannot escape through host-realm callables", (t) => {
  const adapter = `
function escaped(callback){try{callback();return true}catch{return false}}
function report(context){return{
  processType:typeof process,
  requireType:typeof require,
  globalConstructorType:typeof globalThis.constructor,
  globalPrototypeIsNull:Object.getPrototypeOf(globalThis)===null,
  contextProcess:escaped(()=>context.readText.constructor("return process")()),
  contextRequire:escaped(()=>context.findFiles.constructor("return require")()),
  optionsProcess:escaped(()=>context.options.constructor.constructor("return process")()),
  moduleProcess:escaped(()=>module.constructor.constructor("return process")()),
  globalProcess:escaped(()=>globalThis.constructor.constructor("return process")()),
}}
module.exports={apiVersion:1,codexVersion:${JSON.stringify(CODEX_VERSION)},apply(context){return report(context)},verify(context,phase){return{ok:true,phase,...report(context)}}};`;
  for (const kind of ["contribution", "local"]) {
    const root = tempRoot(t);
    const id = `example.vm-boundary-${kind}`;
    const manifest = moduleManifest(id, { kind });
    const featureRoot = kind === "local" ? "local/vm-boundary" : "features/community/vm-boundary";
    writeFeature(root, featureRoot, manifest, { [CODEX_VERSION]: adapter });
    const resolved = resolveFeatureModules(discover(root), {
      sourceVersion: CODEX_VERSION,
      featureModules: { [id]: true },
    });
    const extractDir = path.join(root, "extract");
    fs.mkdirSync(extractDir);
    seedStructuralAnchors(extractDir, manifest);

    const reports = [
      applyFeatureModules(resolved, extractDir)[0].result,
      verifyFeatureModules(resolved, extractDir)[0].result,
    ];
    for (const report of reports) {
      assert.equal(report.processType, "undefined", `${kind} adapter reached process`);
      assert.equal(report.requireType, "undefined", `${kind} adapter reached require`);
      assert.equal(report.globalConstructorType, "undefined");
      assert.equal(report.globalPrototypeIsNull, true);
      for (const key of ["contextProcess", "contextRequire", "optionsProcess", "moduleProcess", "globalProcess"]) {
        assert.equal(report[key], false, `${kind} ${key} reached the outer realm`);
      }
    }
  }
});

test("context mutations reject changed-path collisions across modules", (t) => {
  const root = tempRoot(t);
  const first = moduleManifest("example.path-first");
  const second = moduleManifest("example.path-second");
  const adapter = (value) => `module.exports={apiVersion:1,codexVersion:${JSON.stringify(CODEX_VERSION)},apply(context){context.writeText("shared.txt",${JSON.stringify(value)});return{changed:true}},verify(){return{ok:true}}};`;
  writeFeature(root, "features/community/path-first", first, { [CODEX_VERSION]: adapter("first") });
  writeFeature(root, "features/community/path-second", second, { [CODEX_VERSION]: adapter("second") });
  const resolved = resolveFeatureModules(discover(root), {
    sourceVersion: CODEX_VERSION,
    featureModules: { "example.path-first": true, "example.path-second": true },
  });
  const extractDir = path.join(root, "extract");
  fs.mkdirSync(extractDir);
  seedStructuralAnchors(extractDir, first);

  assert.throws(
    () => applyFeatureModules(resolved, extractDir),
    /example\.path-second: changed path shared\.txt is already owned by example\.path-first/
  );
  assert.equal(fs.readFileSync(path.join(extractDir, "shared.txt"), "utf8"), "first");
  assert.equal(fs.existsSync(path.join(extractDir, "codex-patch-studio", "features", "example.path-first.json")), true);
  assert.equal(fs.existsSync(path.join(extractDir, "codex-patch-studio", "features", "example.path-second.json")), false);
});

test("selects only the adapter for the resolved Codex version", (t) => {
  const root = tempRoot(t);
  const manifest = moduleManifest("example.multi-version", {
    supports: { codexVersions: [CODEX_VERSION, SECOND_CODEX_VERSION] },
  });
  const adapter = (version, selected) => `module.exports={apiVersion:1,codexVersion:${JSON.stringify(version)},apply(context){context.writeText("selected.txt",${JSON.stringify(selected)});return{selected:${JSON.stringify(selected)}}},verify(){return{ok:true}}};`;
  writeFeature(root, "features/community/multi", manifest, {
    [CODEX_VERSION]: adapter(CODEX_VERSION, "first"),
    [SECOND_CODEX_VERSION]: adapter(SECOND_CODEX_VERSION, "second"),
  });
  const catalog = discover(root);
  const resolved = resolveFeatureModules(catalog, {
    sourceVersion: SECOND_CODEX_VERSION,
    featureModules: { "example.multi-version": true },
  });
  const extractDir = path.join(root, "extract");
  fs.mkdirSync(extractDir);
  seedStructuralAnchors(extractDir, manifest);
  assert.equal(applyFeatureModules(resolved, extractDir)[0].result.selected, "second");
  assert.equal(fs.readFileSync(path.join(extractDir, "selected.txt"), "utf8"), "second");
  assert.throws(
    () => resolveFeatureModules(catalog, { sourceVersion: "26.999.0.0", featureModules: { "example.multi-version": true } }),
    /does not support Codex/
  );
});

test("selects one tested major.minor.x family adapter and rejects overlapping selectors", (t) => {
  const root = tempRoot(t);
  const family = "26.700.x";
  const manifest = moduleManifest("example.family", {
    supports: { codexVersions: [family] },
  });
  const adapter = `module.exports={apiVersion:1,codexVersion:${JSON.stringify(family)},apply(){return{selected:${JSON.stringify(family)}}},verify(){return{ok:true}}};`;
  const featureRoot = writeFeature(root, "features/community/family", manifest, { [family]: adapter });
  const resolved = resolveFeatureModules(discover(root), {
    sourceVersion: "26.700.1234.0",
    featureModules: { "example.family": true },
  });
  const extractDir = path.join(root, "extract");
  fs.mkdirSync(extractDir);
  seedStructuralAnchors(extractDir, manifest);
  assert.equal(applyFeatureModules(resolved, extractDir)[0].result.selected, family);

  const overlapManifest = JSON.parse(fs.readFileSync(path.join(featureRoot, "feature.json"), "utf8"));
  overlapManifest.supports.codexVersions.push("26.700.1234.0");
  fs.writeFileSync(path.join(featureRoot, "feature.json"), `${JSON.stringify(overlapManifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(featureRoot, "adapters", "26.700.1234.0.cjs"), noOpAdapter("26.700.1234.0"), "utf8");
  const overlapping = resolveFeatureModules(discover(root), {
    sourceVersion: "26.700.1234.0",
    featureModules: { "example.family": true },
  });
  assert.throws(() => applyFeatureModules(overlapping, extractDir), /expected exactly one adapter.*found 2/);
});

test("core adapters drive named privileged builder operations with an authenticated feature id", (t) => {
  const root = tempRoot(t);
  const manifest = moduleManifest("core.synthetic", { kind: "core", enabledByDefault: true });
  const adapter = `module.exports={apiVersion:1,codexVersion:${JSON.stringify(CODEX_VERSION)},apply(context){return context.runCoreOperation("synthetic.patch")},verify(context,phase){return context.verifyCoreFeature(phase)}};`;
  writeFeature(root, "features/core/synthetic", manifest, { [CODEX_VERSION]: adapter });
  const resolved = resolveFeatureModules(discover(root), {
    sourceVersion: CODEX_VERSION,
    includeExternalModules: false,
  });
  const extractDir = path.join(root, "extract");
  fs.mkdirSync(extractDir);
  seedStructuralAnchors(extractDir, manifest);
  const calls = [];
  const applied = applyFeatureModules(resolved, extractDir, {
    runCoreOperation(id, operationId, detail) {
      calls.push(["apply", id, operationId, detail.phase]);
      return { privileged: operationId };
    },
    verifyCoreFeature(id, detail) {
      calls.push(["verify-unpacked", id, detail.phase]);
      return { verified: id, phase: detail.phase };
    },
  });
  const verified = verifyFeatureModules(resolved, extractDir, {
    verifyCoreFeature(id, detail) {
      calls.push(["verify", id, detail.phase]);
      return { verified: id, phase: detail.phase };
    },
  });
  assert.deepEqual(applied[0].result, { privileged: "synthetic.patch" });
  assert.deepEqual(verified[0].result, { verified: "core.synthetic", phase: "packed" });
  assert.deepEqual(calls, [
    ["apply", "core.synthetic", "synthetic.patch", "unpacked"],
    ["verify-unpacked", "core.synthetic", "unpacked"],
    ["verify", "core.synthetic", "packed"],
  ]);
});

test("contribution modules and cross-feature core adapters cannot invoke core steps", (t) => {
  const root = tempRoot(t);
  const contribution = moduleManifest("example.privilege-attempt");
  const contributionAdapter = `module.exports={apiVersion:1,codexVersion:${JSON.stringify(CODEX_VERSION)},apply(context){return context.runCoreStep("core.history")},verify(){return{ok:true}}};`;
  writeFeature(root, "features/community/privilege-attempt", contribution, { [CODEX_VERSION]: contributionAdapter });
  const contributionResolved = resolveFeatureModules(discover(root), {
    sourceVersion: CODEX_VERSION,
    featureModules: { "example.privilege-attempt": true },
  });
  const extractDir = path.join(root, "extract-contribution");
  fs.mkdirSync(extractDir);
  seedStructuralAnchors(extractDir, contribution);
  assert.throws(
    () => applyFeatureModules(contributionResolved, extractDir, { runCoreOperation() { return {}; } }),
    /only core modules can invoke core patch steps/
  );

  const coreRoot = tempRoot(t);
  const core = moduleManifest("core.one", { kind: "core", enabledByDefault: true });
  const coreAdapter = `module.exports={apiVersion:1,codexVersion:${JSON.stringify(CODEX_VERSION)},apply(context){return context.runCoreOperation("core.two.patch")},verify(){return{ok:true}}};`;
  writeFeature(coreRoot, "features/core/one", core, { [CODEX_VERSION]: coreAdapter });
  const coreResolved = resolveFeatureModules(discover(coreRoot), { sourceVersion: CODEX_VERSION });
  const coreExtractDir = path.join(coreRoot, "extract-core");
  fs.mkdirSync(coreExtractDir);
  seedStructuralAnchors(coreExtractDir, core);
  assert.throws(
    () => applyFeatureModules(coreResolved, coreExtractDir, {
      runCoreOperation(featureId, operationId) {
        throw new Error(`${featureId}: ${operationId} is owned by core.two.`);
      },
    }),
    /core\.one: core\.two\.patch is owned by core\.two/
  );
});

test("fails before adapter execution when structural anchor cardinality is ambiguous", (t) => {
  const root = tempRoot(t);
  const manifest = moduleManifest("example.cardinality", {
    structuralAnchors: [
      { id: "single-target", path: "webview/*.js", includes: "target-marker", cardinality: { minimum: 1, maximum: 1 } },
    ],
  });
  const adapter = `module.exports={apiVersion:1,codexVersion:${JSON.stringify(CODEX_VERSION)},apply(context){context.writeText("adapter-ran.txt","yes")},verify(){return{ok:true}}};`;
  writeFeature(root, "features/community/cardinality", manifest, { [CODEX_VERSION]: adapter });
  const resolved = resolveFeatureModules(discover(root), {
    sourceVersion: CODEX_VERSION,
    featureModules: { "example.cardinality": true },
  });
  const extractDir = path.join(root, "extract");
  fs.mkdirSync(path.join(extractDir, "webview"), { recursive: true });
  fs.writeFileSync(path.join(extractDir, "webview", "one.js"), "target-marker", "utf8");
  fs.writeFileSync(path.join(extractDir, "webview", "two.js"), "target-marker", "utf8");
  assert.throws(() => applyFeatureModules(resolved, extractDir), /expected 1 match\(es\), found 2/);
  assert.equal(fs.existsSync(path.join(extractDir, "adapter-ran.txt")), false);
});

test("orders dependencies and rejects feature conflicts", (t) => {
  const root = tempRoot(t);
  const base = moduleManifest("example.base");
  const child = moduleManifest("example.child", { dependencies: ["example.base"] });
  const incompatible = moduleManifest("example.incompatible", { conflicts: ["example.child"] });
  writeFeature(root, "features/community/base", base, { [CODEX_VERSION]: noOpAdapter() });
  writeFeature(root, "features/community/child", child, { [CODEX_VERSION]: noOpAdapter() });
  writeFeature(root, "features/community/incompatible", incompatible, { [CODEX_VERSION]: noOpAdapter() });
  const catalog = discover(root);
  const resolved = resolveFeatureModules(catalog, {
    sourceVersion: CODEX_VERSION,
    featureModules: { "example.child": true },
  });
  assert.deepEqual(resolved.enabledIds, ["example.base", "example.child"]);
  assert.throws(
    () => resolveFeatureModules(catalog, {
      sourceVersion: CODEX_VERSION,
      featureModules: { "example.child": true, "example.incompatible": true },
    }),
    /conflicts with enabled feature/
  );
});

test("rejects enabled modules that collide on loopback ports or native additions", (t) => {
  const root = tempRoot(t);
  const first = moduleManifest("example.first", {
    runtime: { permissions: ["patch:asar"], localPorts: [{ name: "service", port: 48001 }] },
    native: { settings: [{ id: "example-settings", label: "Example" }], sidebar: [] },
  });
  const second = moduleManifest("example.second", {
    runtime: { permissions: ["patch:asar"], localPorts: [48001] },
    native: { settings: [], sidebar: [] },
  });
  writeFeature(root, "features/community/first", first, { [CODEX_VERSION]: noOpAdapter() });
  writeFeature(root, "features/community/second", second, { [CODEX_VERSION]: noOpAdapter() });
  const catalog = discover(root);
  assert.throws(
    () => resolveFeatureModules(catalog, {
      sourceVersion: CODEX_VERSION,
      featureModules: { "example.first": true, "example.second": true },
    }),
    /both declare local port tcp:48001/
  );

  catalog.byId.get("example.second").manifest.runtime.localPorts = [];
  catalog.byId.get("example.second").manifest.native.settings = [{ id: "example-settings" }];
  assert.throws(
    () => resolveFeatureModules(catalog, {
      sourceVersion: CODEX_VERSION,
      featureModules: { "example.first": true, "example.second": true },
    }),
    /both declare native settings id example-settings/
  );
});

test("rejects duplicate ids, incomplete layouts, and distributable payloads", (t) => {
  const root = tempRoot(t);
  writeFeature(root, "features/community/one", moduleManifest("example.duplicate"), { [CODEX_VERSION]: noOpAdapter() });
  writeFeature(root, "features/community/two", moduleManifest("example.duplicate"), { [CODEX_VERSION]: noOpAdapter() });
  assert.throws(() => discover(root), /Duplicate feature id/);

  const missingRoot = tempRoot(t);
  writeFeature(missingRoot, "features/community/missing", moduleManifest("example.missing-adapter"));
  assert.throws(() => discover(missingRoot), /missing adapter for Codex/);

  const binaryRoot = tempRoot(t);
  const featureRoot = writeFeature(binaryRoot, "features/community/binary", moduleManifest("example.binary"), {
    [CODEX_VERSION]: noOpAdapter(),
  });
  fs.writeFileSync(path.join(featureRoot, "payload", "copied.exe"), "not really an executable", "utf8");
  assert.throws(() => discover(binaryRoot), /source-only modules cannot contain \.exe files/);
});

test("rejects manifest and patch-context path traversal", (t) => {
  const root = tempRoot(t);
  const featureRoot = path.join(root, "feature");
  fs.mkdirSync(path.join(featureRoot, "payload"), { recursive: true });
  fs.writeFileSync(path.join(featureRoot, "payload", "inside.txt"), "safe", "utf8");
  const unsafe = moduleManifest("example.unsafe", {
    structuralAnchors: [{ id: "unsafe", path: "../outside.js", includes: "marker", cardinality: 1 }],
  });
  assert.throws(
    () => validateManifest(unsafe, path.join(featureRoot, "feature.json"), "contribution"),
    /cannot escape its allowed root/
  );

  const record = validateManifest(moduleManifest("example.safe"), path.join(featureRoot, "feature.json"), "contribution");
  const extractDir = path.join(root, "extract");
  fs.mkdirSync(extractDir);
  const context = createPatchContext(record, extractDir, "unpacked");
  assert.throws(() => context.writeText("../outside.txt", "bad"), /escapes/);
  assert.throws(() => context.copyPayload("../README.md", "copied.txt"), /escapes/);
});

test("patch contexts enforce read and mutation permissions and reserve receipt paths", (t) => {
  const root = tempRoot(t);
  const featureRoot = path.join(root, "feature");
  fs.mkdirSync(path.join(featureRoot, "payload"), { recursive: true });
  fs.writeFileSync(path.join(featureRoot, "payload", "inside.txt"), "payload", "utf8");
  const extractDir = path.join(root, "extract");
  fs.mkdirSync(extractDir);
  fs.writeFileSync(path.join(extractDir, "fixture-target.txt"), "fixture-before", "utf8");

  const readOnlyManifest = moduleManifest("example.read-only", {
    runtime: { permissions: ["read:asar"], localPorts: [] },
  });
  const readOnlyRecord = validateManifest(readOnlyManifest, path.join(featureRoot, "feature.json"), "contribution");
  const readOnly = createPatchContext(readOnlyRecord, extractDir, "unpacked");
  assert.equal(readOnly.readText("fixture-target.txt"), "fixture-before");
  assert.deepEqual(readOnly.findFiles({ suffix: ".txt" }), ["fixture-target.txt"]);
  assert.deepEqual(readOnly.getAnchorMatches("fixture-anchor"), [{ path: "fixture-target.txt", count: 1 }]);
  assert.throws(() => readOnly.writeText("new.txt", "no"), /writeText requires runtime permission patch:asar/);
  assert.throws(() => readOnly.replaceExactly("fixture-target.txt", "before", "after"), /replaceExactly requires runtime permission patch:asar/);
  assert.throws(() => readOnly.replaceAnchor("fixture-anchor", "after"), /replaceAnchor requires runtime permission patch:asar/);
  assert.throws(() => readOnly.copyPayload("inside.txt", "copied.txt"), /copyPayload requires runtime permission patch:asar/);

  const deniedRecord = validateManifest(
    moduleManifest("example.no-asar-access", { runtime: { permissions: [], localPorts: [] } }),
    path.join(featureRoot, "feature.json"),
    "contribution"
  );
  const denied = createPatchContext(deniedRecord, extractDir, "unpacked");
  assert.throws(() => denied.readText("fixture-target.txt"), /readText requires runtime permission read:asar or patch:asar/);
  assert.throws(() => denied.findFiles(), /findFiles requires runtime permission read:asar or patch:asar/);
  assert.throws(() => denied.getAnchorMatches("fixture-anchor"), /getAnchorMatches requires runtime permission read:asar or patch:asar/);

  const patchRecord = validateManifest(moduleManifest("example.patch-access"), path.join(featureRoot, "feature.json"), "contribution");
  const patchContext = createPatchContext(patchRecord, extractDir, "unpacked");
  assert.equal(patchContext.readText("fixture-target.txt"), "fixture-before");
  assert.throws(
    () => patchContext.writeText("codex-patch-studio/features/example.patch-access.json", "forged"),
    /cannot modify host-managed feature receipts/
  );
});

test("scaffold creates a complete, discoverable module with a runnable starter test", (t) => {
  const root = tempRoot(t);
  const featureRoot = scaffoldFeature({
    repoRoot: root,
    targetRoot: path.join(root, "features", "community"),
    kind: "contribution",
    id: "example.scaffold",
    codexVersion: CODEX_VERSION,
  });
  for (const relativePath of [
    "feature.json",
    "README.md",
    `adapters/${CODEX_VERSION}.cjs`,
    "payload/.gitkeep",
    "tests/adapter.test.cjs",
  ]) {
    assert.equal(fs.existsSync(path.join(featureRoot, relativePath)), true, `missing ${relativePath}`);
  }
  assert.equal(fs.existsSync(path.join(featureRoot, "module.cjs")), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(featureRoot, "feature.json"), "utf8"));
  assert.deepEqual(manifest.supports.codexVersions, [CODEX_VERSION]);
  assert.deepEqual(manifest.structuralAnchors, [
    {
      id: "replace-before-enabling",
      path: "REPLACE-ME/upstream-file.js",
      includes: "REPLACE_WITH_EXACT_UPSTREAM_ANCHOR",
      cardinality: { exact: 1 },
    },
  ]);
  assert.deepEqual(manifest.verification, [
    {
      id: "module-receipt",
      path: "codex-patch-studio/features/example.scaffold.json",
      includes: `\"id\": \"example.scaffold\"`,
      cardinality: { exact: 1 },
    },
  ]);
  assert.deepEqual(manifest.runtime.localPorts, []);
  assert.deepEqual(manifest.native, { settings: [], sidebar: [] });
  const catalog = discover(root);
  assert.equal(catalog.byId.has("example.scaffold"), true);
  const resolved = resolveFeatureModules(catalog, {
    sourceVersion: CODEX_VERSION,
    featureModules: { "example.scaffold": true },
  });
  const extractDir = path.join(root, "extract");
  fs.mkdirSync(extractDir);
  assert.throws(
    () => applyFeatureModules(resolved, extractDir),
    /structural anchor replace-before-enabling expected 1 match\(es\), found 0/
  );

  const result = spawnSync(process.execPath, ["--test", path.join(featureRoot, "tests", "adapter.test.cjs")], {
    cwd: featureRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
