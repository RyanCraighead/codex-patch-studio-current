const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const rootDir = path.resolve(__dirname, "..");
const builderPath = path.join(rootDir, "scripts", "build-patched-codex-app.cjs");

function loadNativeSettingsInternals() {
  const source = fs.readFileSync(builderPath, "utf8").replace(/^#!.*\r?\n/, "");
  const invocationPattern = /try \{\r?\n\s*withBuildLockSync\(rootDir, main\);\r?\n\} catch \(error\) \{[\s\S]*$/;
  assert.match(source, invocationPattern, "builder entry point changed; update the focused test harness");
  const instrumented = source.replace(
    invocationPattern,
    `globalThis.__nativeSettingsTestInternals = {
      NATIVE_SETTINGS_GROUP_ROUTES,
      NATIVE_SETTINGS_ROUTE_DEFINITIONS,
      ALL_NATIVE_SETTINGS_ROUTE_IDS,
      createNativeSettingsPlan,
      filterNativeSettingsIconMap,
      inspectNativeSettingsComposition,
      writeNativeSettingsRouteModules,
    };`
  );
  const sandbox = {
    Buffer,
    __dirname: path.dirname(builderPath),
    __filename: builderPath,
    clearTimeout,
    console,
    process,
    require: createRequire(builderPath),
    setTimeout,
  };
  vm.runInNewContext(instrumented, sandbox, { filename: builderPath, timeout: 5000 });
  return sandbox.__nativeSettingsTestInternals;
}

const internals = loadNativeSettingsInternals();
const routeDefinitions = internals.NATIVE_SETTINGS_ROUTE_DEFINITIONS;
const allRouteIds = [...internals.ALL_NATIVE_SETTINGS_ROUTE_IDS];

const compositionCases = [
  {
    name: "provider-only",
    groups: { providers: true },
    routes: ["providers", "auto-router", "prompt-tools", "personas", "swarm"],
  },
  { name: "imports-only", groups: { imports: true }, routes: ["imports"] },
  { name: "patcher-only", groups: { patcher: true }, routes: ["patcher", "feature-development"] },
  {
    name: "all-enabled",
    groups: { providers: true, orchestrations: true, imports: true, patcher: true },
    routes: allRouteIds,
  },
];

function normalize(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeCompositionFixture(enabledRouteIds) {
  const routeModuleExists = Object.fromEntries(allRouteIds.map((routeId) => [routeId, false]));
  const parts = {
    settingsSectionsText: "",
    settingsSharedText: "",
    settingsPageText: "",
    appMainText: "",
    routeModuleExists,
  };
  for (const routeId of enabledRouteIds) {
    const route = routeDefinitions[routeId];
    parts.settingsSectionsText += `{slug:\`${routeId}\`},`;
    parts.settingsSharedText += `${route.objectKey}:{defaultMessage:\`${route.label}\`},`;
    parts.settingsPageText += `${route.objectKey}:e=>(0,R.jsxs)(\`svg\`,{}),`;
    parts.appMainText += `${route.objectKey}:lazy(()=>import(\`./${route.moduleFile}\`)),`;
    parts.routeModuleExists[routeId] = true;
  }
  return parts;
}

test("native settings plans contain only routes owned by enabled groups", () => {
  for (const scenario of compositionCases) {
    const plan = internals.createNativeSettingsPlan(scenario.groups);
    assert.deepEqual(normalize(plan.routeIds), scenario.routes, scenario.name);
    for (const disabledRouteId of allRouteIds.filter((routeId) => !scenario.routes.includes(routeId))) {
      assert.equal(plan.sectionEntries.includes(`slug:\`${disabledRouteId}\``), false, scenario.name);
      assert.equal(plan.labelEntries.includes(`settings.nav.${disabledRouteId}`), false, scenario.name);
    }
  }
});

test("packed composition verification accepts provider-only, imports-only, patcher-only, and all-enabled layouts", () => {
  for (const scenario of compositionCases) {
    const result = internals.inspectNativeSettingsComposition(makeCompositionFixture(scenario.routes), scenario.groups);
    assert.equal(result.ok, true, scenario.name);
    assert.deepEqual(normalize(result.enabledRouteIds), scenario.routes, scenario.name);
    assert.deepEqual(normalize(result.missingEnabledRoutes), [], scenario.name);
    assert.deepEqual(normalize(result.unexpectedDisabledRoutes), [], scenario.name);
  }
});

test("packed composition verification fails closed for missing enabled and leaked disabled routes", () => {
  const missingModule = makeCompositionFixture(["imports"]);
  missingModule.routeModuleExists.imports = false;
  const missingResult = internals.inspectNativeSettingsComposition(missingModule, { imports: true });
  assert.equal(missingResult.ok, false);
  assert.deepEqual(normalize(missingResult.missingEnabledRoutes), ["imports"]);

  const leakedRoute = makeCompositionFixture(["imports"]);
  leakedRoute.settingsSectionsText += "{slug:`patcher`},";
  const leakedResult = internals.inspectNativeSettingsComposition(leakedRoute, { imports: true });
  assert.equal(leakedResult.ok, false);
  assert.deepEqual(normalize(leakedResult.unexpectedDisabledRoutes), ["patcher"]);
});

test("route module generation writes no files for disabled routes", (t) => {
  for (const scenario of compositionCases) {
    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), `codex-native-settings-${scenario.name}-`));
    t.after(() => fs.rmSync(extractDir, { recursive: true, force: true }));
    const assetsDir = path.join(extractDir, "webview", "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, "jsx-runtime-test.js"), "export const t=()=>({jsx(){}});", "utf8");

    const result = internals.writeNativeSettingsRouteModules(extractDir, scenario.routes);
    const generatedModuleFiles = fs.readdirSync(assetsDir)
      .filter((name) => name.startsWith("codex-native-") && name.endsWith("-settings-page.js"))
      .sort();
    const expectedModuleFiles = scenario.routes.map((routeId) => routeDefinitions[routeId].moduleFile).sort();
    assert.deepEqual(generatedModuleFiles, expectedModuleFiles, scenario.name);
    assert.equal(Object.keys(result).length, scenario.routes.length, scenario.name);
  }
});

test("icon-map filtering retains stock entries and enabled route icons only", () => {
  const fullMap = [
    "agent:a",
    "providers:e=>(0,R.jsxs)(`svg`,{children:[1,2]})",
    '"auto-router":e=>(0,R.jsxs)(`svg`,{})',
    '"prompt-tools":e=>(0,R.jsxs)(`svg`,{})',
    "personas:e=>(0,R.jsxs)(`svg`,{})",
    "swarm:e=>(0,R.jsxs)(`svg`,{})",
    "orchestrations:e=>(0,R.jsxs)(`svg`,{})",
    "imports:e=>(0,R.jsxs)(`svg`,{})",
    "patcher:e=>(0,R.jsxs)(`svg`,{})",
    '"feature-development":e=>(0,R.jsxs)(`svg`,{})',
    '"git-settings":g',
  ].join(",");
  const filtered = internals.filterNativeSettingsIconMap(fullMap, ["imports"]);
  assert.equal(filtered, "agent:a,imports:e=>(0,R.jsxs)(`svg`,{}),\"git-settings\":g");
});
