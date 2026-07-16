#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");

function fail(message) {
  throw new Error(message);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    let count;
    do {
      count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count) hash.update(buffer.subarray(0, count));
    } while (count);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function installedVersion() {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "(Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty Version).ToString()",
    ],
    { encoding: "utf8", windowsHide: true }
  );
  if (result.status !== 0) fail(result.stderr || "Could not detect installed Codex version.");
  return String(result.stdout || "").trim();
}

const launcherPath = path.join(root, "codex-launcher.local.json");
if (!fs.existsSync(launcherPath)) fail(`Missing launcher config: ${launcherPath}`);
const launcher = readJson(launcherPath);
const manifestPath = path.join(launcher.cloneRoot, "patch-manifest.json");
if (!fs.existsSync(manifestPath)) fail(`Missing patch manifest: ${manifestPath}`);
const manifest = readJson(manifestPath);

const installed = installedVersion();
if (launcher.sourceVersion !== installed) {
  fail(`Patched version ${launcher.sourceVersion} does not match installed Codex ${installed}.`);
}
for (const filePath of [launcher.codexExe, launcher.appAsar, launcher.originalAppAsarBackup]) {
  if (!filePath || !fs.existsSync(filePath)) fail(`Missing patched build file: ${filePath}`);
}
if (sha256(launcher.sourceAsarPath) !== launcher.sourceAsarSha256) {
  fail("Installed source app.asar no longer matches the build manifest.");
}
if (sha256(launcher.appAsar) === sha256(launcher.originalAppAsarBackup)) {
  fail("Patched app.asar is byte-identical to its original backup.");
}

const requiredVerification = [
  "containsReasoningSummaryConversionPatch",
  "containsNativeOrchestrator",
  "containsProviderSettings",
  "containsAutoRouterSettings",
  "containsPromptToolsSettings",
  "containsPersonasSettings",
  "containsSwarmSettings",
  "containsDefaultPromptCatalog",
  "containsImportSettings",
  "containsPatcherSettings",
  "containsFeatureDevelopmentSettings",
  "containsLocalConnectSources",
  "containsProviderModelCatalogPatch",
  "containsNativeSettingsSections",
  "containsNativeNavigationBridge",
  "containsPreloadOutboundInterceptor",
  "containsRemoteControlMainProcessPatch",
];
if (launcher.features?.chatLimit === true) {
  requiredVerification.unshift("containsHistoryHydrationDiagnostic");
  requiredVerification.unshift("containsChatLimitPatch");
}
for (const key of requiredVerification) {
  if (manifest.packedVerification?.[key] !== true) fail(`Packed verification failed: ${key}`);
}

if (launcher.features?.catalogShim === true) {
  if (launcher.catalogShim?.enabled !== true) fail("Catalog shim is selected but not enabled in the launcher.");
  if (!launcher.catalogShim.upstreamCli || !fs.existsSync(launcher.catalogShim.upstreamCli)) {
    fail(`Catalog shim upstream app-server is missing: ${launcher.catalogShim?.upstreamCli || "unset"}`);
  }
  if (sha256(launcher.catalogShim.upstreamCli) !== launcher.sourceAppServerCliSha256) {
    fail("Catalog shim upstream app-server hash does not match the build manifest.");
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      installedVersion: installed,
      sourceMode: launcher.sourceMode,
      sourceHashMatched: true,
      cloneRoot: launcher.cloneRoot,
      catalogShim: launcher.catalogShim,
      verifiedFeatures: requiredVerification,
    },
    null,
    2
  )}\n`
);
