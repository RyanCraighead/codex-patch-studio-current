#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { catalogFingerprint, discoverFeatureModules } = require("./feature-registry.cjs");

const SOURCE_PATHS = [
  "config/compatibility.json",
  "config/patcher.json",
  "features/core/imports/payload/codex-native-import-settings.js",
  "features/core/orchestrations/payload/codex-native-orchestrator.js",
  "features/core/patcher-ui/payload/codex-native-patcher-settings.js",
  "features/core/provider-suite/payload/codex-native-provider-settings.js",
  "scripts/build-patched-codex-app.cjs",
  "scripts/feature-registry.cjs",
  "scripts/codex-launcher.ps1",
  "scripts/codex-update-policy.psm1",
  "scripts/ensure-current-codex-patch.ps1",
  "scripts/codex-all-chats-shim.cjs",
  "scripts/codex-responses-chat-proxy.cjs",
  "scripts/initialize-patched-codex-home.ps1",
  "scripts/launch-patched-codex.ps1",
  "scripts/start-codex-all-chats-shim.ps1",
  "scripts/start-codex-import-manager.ps1",
  "scripts/start-codex-patch-manager.ps1",
  "scripts/start-codex-provider-proxies.ps1",
  "scripts/verify-current-patched-build.cjs",
  "scripts/verify-runtime-services.cjs",
  "scripts/verify-current-ui.cjs",
  "scripts/resolve-listening-process.cjs",
  "viewer/jsonl-reader.cjs",
  "viewer/server.cjs",
  "codex-viewer/server.cjs",
];

function patcherFingerprint(rootDir) {
  const hash = crypto.createHash("sha256");
  const files = [];
  for (const relativePath of SOURCE_PATHS) {
    const filePath = path.join(rootDir, relativePath);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath);
    hash.update(relativePath.replace(/\\/g, "/"));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
    files.push(relativePath);
  }
  const readJson = (filePath) => {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  };
  const config = {
    ...readJson(path.join(rootDir, "config", "patcher.json")),
    ...readJson(path.join(rootDir, "config", "patcher.local.json")),
  };
  const featureCatalog = discoverFeatureModules(rootDir, config);
  const featureFingerprint = catalogFingerprint(featureCatalog);
  hash.update("feature-catalog\0");
  hash.update(featureFingerprint);
  hash.update("\0");
  files.push(...featureCatalog.records.map((record) => `feature:${record.id}`));
  return { sha256: hash.digest("hex"), files, featureFingerprint };
}

module.exports = { SOURCE_PATHS, patcherFingerprint };

if (require.main === module) {
  const rootDir = path.resolve(__dirname, "..");
  process.stdout.write(`${JSON.stringify(patcherFingerprint(rootDir))}\n`);
}
