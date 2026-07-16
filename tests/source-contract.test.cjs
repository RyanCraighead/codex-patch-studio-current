const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const { findEmbeddedUpstreamAnchors } = require("../scripts/check-source-only.cjs");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("successor defaults to the current installed Codex build", () => {
  const config = JSON.parse(read("config/patcher.json"));
  const builder = read("scripts/build-patched-codex-app.cjs");
  assert.equal(config.sourceMode, "current-installed");
  assert.equal(config.autoRebuildOnLaunch, false);
  assert.equal(config.updatePolicy, "notify");
  assert.equal(config.updatePolicyConfigured, false);
  assert.match(builder, /source = findInstalledCodexAppDir\(\)/);
  assert.match(builder, /sourceMode = "current-installed"/);
  assert.doesNotMatch(builder, /--legacy-pinned|legacyPinned|findPinnedKnownGoodSource/);
  assert.match(builder, /__codexPatchStudioHistoryHydration/);
});

test("portable package preserves update-baseline metadata", () => {
  const packager = read("scripts/package-patched-codex-single-exe.ps1");
  assert.match(packager, /sourceAsarSha256 = \[string\]\$config\.sourceAsarSha256/);
  assert.match(packager, /sourceDesktopExeSha256 = \[string\]\$config\.sourceDesktopExeSha256/);
  assert.match(packager, /patcherSource = \$patcherSource/);
  assert.match(packager, /patcherSource = \$manifest\.patcherSource/);
  assert.match(packager, /Join-Path \$payloadRoot "scripts\\patcher-fingerprint\.cjs"/);
  assert.match(packager, /featureModules = \$config\.featureModules/);
  assert.match(packager, /featureModules = \$manifest\.featureModules/);
});

test("runtime verifiers support lazy all-chats mode", () => {
  const runtimeVerifier = read("scripts/verify-runtime-services.cjs");
  const uiVerifier = read("scripts/verify-current-ui.cjs");
  assert.match(runtimeVerifier, /waitForCatalogShim/);
  assert.match(runtimeVerifier, /catalogShimEnabled/);
  assert.match(uiVerifier, /waitForCatalogShim/);
  assert.match(uiVerifier, /codex-all-chats-shim/);
  assert.match(uiVerifier, /catalogShimEnabled/);
  assert.match(uiVerifier, /runtimeSourceSha256/);
  assert.match(uiVerifier, /__codexNativeNavigate\('\/'\)/);
  assert.match(uiVerifier, /Main view remained on a settings route/);
});

test("runtime and UI verification bind DevTools to the configured desktop clone", () => {
  const resolver = read("scripts/resolve-listening-process.cjs");
  const runtimeVerifier = read("scripts/verify-runtime-services.cjs");
  const uiVerifier = read("scripts/verify-current-ui.cjs");
  assert.match(resolver, /Get-NetTCPConnection/);
  assert.match(resolver, /Get-CimInstance Win32_Process/);
  assert.doesNotMatch(resolver, /Select-Object -First 1/);
  assert.match(resolver, /expectedExecutablePath/);
  assert.match(resolver, /expectedUserDataPath/);
  assert.match(resolver, /hostsForAddress/);
  assert.match(resolver, /windowsHide: true/);
  assert.match(runtimeVerifier, /resolveListeningProcess\(cdpPort, \{/);
  assert.match(runtimeVerifier, /launcher\.codexExe/);
  assert.match(runtimeVerifier, /launcher\.electronUserDataPath/);
  assert.match(runtimeVerifier, /findPageTarget\(desktopProcess\)/);
  assert.match(uiVerifier, /resolveListeningProcess\(port, \{/);
  assert.match(uiVerifier, /launcher\.codexExe/);
  assert.match(uiVerifier, /launcher\.electronUserDataPath/);
  assert.match(uiVerifier, /pageTarget\(desktopProcess\)/);
});

test("Codex rollout indexing is bounded and import health is lightweight", () => {
  const viewer = read("viewer/server.cjs");
  const launcher = read("scripts/start-codex-import-manager.ps1");
  assert.match(viewer, /maxRolloutStatsBytes = 128 \* 1024 \* 1024/);
  assert.match(viewer, /statsSkippedLargeFile = true/);
  assert.match(viewer, /requestUrl\.pathname === "\/api\/health"/);
  assert.match(launcher, /\/api\/health/);
});

test("source-only guard rejects distributable Codex artifacts and copied anchors", () => {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "check-source-only.cjs")], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stdout || result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
});

test("managed runtime bridges reject stale source processes after rebuilds", () => {
  const catalogShim = read("scripts/codex-all-chats-shim.cjs");
  const catalogLauncher = read("scripts/start-codex-all-chats-shim.ps1");
  const importManager = read("viewer/server.cjs");
  const importLauncher = read("scripts/start-codex-import-manager.ps1");
  const providerProxy = read("scripts/codex-responses-chat-proxy.cjs");
  const providerLauncher = read("scripts/start-codex-provider-proxies.ps1");
  const runtimeVerifier = read("scripts/verify-runtime-services.cjs");

  assert.match(catalogShim, /runtimeSourceSha256/);
  assert.match(catalogLauncher, /ExpectedRuntimeSourceHash/);
  assert.match(catalogLauncher, /ExpectedUpstreamCli/);
  assert.match(importManager, /importManagerSourceSha256/);
  assert.match(importLauncher, /Test-ImportManagerReady/);
  assert.match(providerProxy, /proxySourceSha256/);
  assert.match(providerLauncher, /ExpectedProxySourceSha256/);
  assert.match(runtimeVerifier, /Import manager is running stale source code/);
  assert.match(runtimeVerifier, /Patch manager is running stale source code/);
  assert.match(runtimeVerifier, /proxy is running stale source code/);
  assert.match(runtimeVerifier, /catalog shim is running stale source code/);
});

test("source-only guard catches renamed copied minified anchors but permits authored replacements", () => {
  const copied = `const harmlessName = "${"x".repeat(320)}";\nreplaceExactly(source, harmlessName, "authored", "test");`;
  assert.equal(findEmbeddedUpstreamAnchors(copied).length, 1);
  const authored = `const payload = "${"x".repeat(320)}";\nreplaceExactly(source, "short-anchor", payload, "test");`;
  assert.equal(findEmbeddedUpstreamAnchors(authored).length, 0);
});

test("current update workflow is one-shot and preserves the verified clone", () => {
  const builder = read("scripts/build-patched-codex-app.cjs");
  const ensure = read("scripts/ensure-current-codex-patch.ps1");
  const launcher = read("scripts/launch-patched-codex.ps1");
  const patcherUi = read("features/core/patcher-ui/payload/codex-native-patcher-settings.js");
  const server = read("codex-viewer/server.cjs");

  assert.match(builder, /Every build gets a new immutable destination/);
  assert.match(builder, /buildNonce/);
  assert.match(ensure, /Global\\CodexPatchStudioCurrentBuild/);
  assert.match(ensure, /Test-ConfiguredPatchedCodexRunning/);
  assert.match(launcher, /Resolve-CodexUpdatePolicy/);
  assert.match(launcher, /Show-CodexUpdatePrompt/);
  assert.match(patcherUi, /state\.updatePolicy !== "off"/);
  assert.match(patcherUi, /Checks are one-shot at launch/);
  assert.doesNotMatch(server, /spawnSync/);
});

test("feature registry and authoring skills remain installed", () => {
  const registry = read("scripts/feature-registry.cjs");
  assert.match(registry, /codeGeneration: \{ strings: false, wasm: false \}/);
  assert.match(registry, /distribution\.upstreamArtifacts/);
  assert.match(read(".agents/skills/codex-patcher-local-feature/SKILL.md"), /do not add a remote/);
  assert.match(read(".agents/skills/codex-patcher-contribute/SKILL.md"), /source-only/);
});

test("the default test command includes feature-local module tests", () => {
  const packageJson = JSON.parse(read("package.json"));
  const runner = read("scripts/run-tests.cjs");
  assert.equal(packageJson.scripts.test, "node scripts/run-tests.cjs");
  assert.match(runner, /path\.join\(rootDir, "features"\)/);
  assert.match(runner, /entry\.name\.endsWith\("\.test\.cjs"\)/);
});

test("all native feature payloads remain present", () => {
  const provider = read("features/core/provider-suite/payload/codex-native-provider-settings.js");
  const orchestrator = read("features/core/orchestrations/payload/codex-native-orchestrator.js");
  const imports = read("features/core/imports/payload/codex-native-import-settings.js");
  const patcher = read("features/core/patcher-ui/payload/codex-native-patcher-settings.js");

  for (const marker of [
    "DeepSeek",
    "Z.ai",
    "Alibaba Qwen",
    "Cerebras",
    "Ollama",
    "Auto Model Router",
    "Review prompt viewer",
    "Default prompt editor",
    "Persona Routing",
    "Swarm Mode",
  ]) {
    assert.ok(provider.includes(marker), `missing provider feature marker: ${marker}`);
  }
  for (const marker of ["New orchestration", "thread/start", "childThreads"]) {
    assert.ok(orchestrator.includes(marker), `missing orchestration marker: ${marker}`);
  }
  for (const marker of ["Import All", "Fix Selected", "repair-selected"]) {
    assert.ok(imports.includes(marker), `missing import marker: ${marker}`);
  }
  assert.ok(patcher.includes("Current installed Codex"));
});

test("native payload JavaScript parses", () => {
  for (const relativePath of [
    "features/core/provider-suite/payload/codex-native-provider-settings.js",
    "features/core/orchestrations/payload/codex-native-orchestrator.js",
    "features/core/imports/payload/codex-native-import-settings.js",
    "features/core/patcher-ui/payload/codex-native-patcher-settings.js",
    "scripts/build-patched-codex-app.cjs",
    "scripts/codex-responses-chat-proxy.cjs",
    "scripts/export-augment-webview-state.cjs",
    "scripts/resolve-listening-process.cjs",
    "scripts/verify-portable-payload.cjs",
    "scripts/verify-runtime-services.cjs",
  ]) {
    const result = spawnSync(process.execPath, ["--check", path.join(root, relativePath)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${relativePath} failed syntax check:\n${result.stderr || result.stdout}`);
  }
});

test("compatibility contract records structural verification", () => {
  const compatibility = JSON.parse(read("config/compatibility.json"));
  assert.equal(compatibility.strategy, "structural-anchors-with-packed-verification");
  assert.ok(Array.isArray(compatibility.validatedBuilds) && compatibility.validatedBuilds.length >= 1);
  assert.ok(compatibility.requiredFeatures.includes("provider-and-model-picker"));
  assert.ok(compatibility.requiredFeatures.includes("orchestrations"));
  assert.ok(compatibility.requiredFeatures.includes("chat-imports"));
});
