#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { requiredPackedVerification } = require("./packed-verification-contract.cjs");

const root = path.resolve(__dirname, "..");

function fail(message) {
  throw new Error(message);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
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

function installedVersion({ required = true } = {}) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "(Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty Version).ToString()",
    ],
    { encoding: "utf8", windowsHide: true }
  );
  const version = String(result.stdout || "").trim();
  if (result.status !== 0 || !version) {
    if (required) fail(result.stderr || "Could not detect installed Codex version.");
    return null;
  }
  return version;
}

const launcherPath = path.resolve(
  process.env.CODEX_PATCHED_LAUNCHER_CONFIG || path.join(root, "codex-launcher.local.json"),
);
if (!fs.existsSync(launcherPath)) fail(`Missing launcher config: ${launcherPath}`);
const launcher = readJson(launcherPath);
const manifestPath = path.join(launcher.cloneRoot, "patch-manifest.json");
if (!fs.existsSync(manifestPath)) fail(`Missing patch manifest: ${manifestPath}`);
const manifest = readJson(manifestPath);

const bundledSnapshot =
  launcher.mode === "bundled-self-extracting" || launcher.sourceMode === "bundled-snapshot";
const installed = installedVersion({ required: !bundledSnapshot });
if (!bundledSnapshot && launcher.sourceVersion !== installed) {
  fail(`Patched version ${launcher.sourceVersion} does not match installed Codex ${installed}.`);
}
for (const filePath of [launcher.codexExe, launcher.appAsar]) {
  if (!filePath || !fs.existsSync(filePath)) fail(`Missing patched build file: ${filePath}`);
}
if (sha256(launcher.codexExe) !== String(launcher.sourceDesktopExeSha256 || "").toLowerCase()) {
  fail("Patched desktop executable hash does not match the build manifest.");
}
if (bundledSnapshot) {
  const expectedPatchedAsarHash = String(launcher.patchedAppAsarSha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedPatchedAsarHash)) {
    fail("Portable launcher is missing patchedAppAsarSha256.");
  }
  if (sha256(launcher.appAsar) !== expectedPatchedAsarHash) {
    fail("Portable patched app.asar hash does not match the bundle manifest.");
  }
  if (String(manifest.patchedAppAsarSha256 || "").toLowerCase() !== expectedPatchedAsarHash) {
    fail("Portable patch manifest changed the patched app.asar hash.");
  }
} else {
  if (!launcher.originalAppAsarBackup || !fs.existsSync(launcher.originalAppAsarBackup)) {
    fail(`Missing patched build file: ${launcher.originalAppAsarBackup}`);
  }
  if (!launcher.sourceAsarPath || sha256(launcher.sourceAsarPath) !== launcher.sourceAsarSha256) {
    fail("Installed source app.asar no longer matches the build manifest.");
  }
  if (sha256(launcher.appAsar) === sha256(launcher.originalAppAsarBackup)) {
    fail("Patched app.asar is byte-identical to its original backup.");
  }
}

const requiredVerification = requiredPackedVerification(launcher.features);
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
      bundledSnapshot,
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
