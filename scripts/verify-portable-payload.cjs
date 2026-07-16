#!/usr/bin/env node

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const arguments_ = process.argv.slice(2);
const runtimeMode = arguments_.includes("--runtime");
const rootArgument = arguments_.find((value) => value !== "--runtime");
const payloadRoot = path.resolve(rootArgument || "");
if (!rootArgument || !fs.existsSync(payloadRoot)) {
  throw new Error(
    "Usage: node scripts/verify-portable-payload.cjs [--runtime] <extracted-payload-root>",
  );
}

function required(relativePath) {
  const filePath = path.join(payloadRoot, relativePath);
  if (!fs.existsSync(filePath)) throw new Error(`Portable payload is missing ${relativePath}`);
  return filePath;
}

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  const handle = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    while (true) {
      const count = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest("hex");
}

function filesUnder(root) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  }
  return files;
}

function scanFileForSecrets(filePath, secrets) {
  const handle = fs.openSync(filePath, "r");
  const maxSecretLength = Math.max(...secrets.map((entry) => entry.value.length));
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let carry = Buffer.alloc(0);
  try {
    while (true) {
      const count = fs.readSync(handle, chunk, 0, chunk.length, null);
      if (!count) return [];
      const current = Buffer.concat([carry, chunk.subarray(0, count)]);
      const hits = secrets.filter((entry) => current.indexOf(entry.buffer) >= 0).map((entry) => entry.name);
      if (hits.length) return hits;
      const carryLength = Math.min(Math.max(0, maxSecretLength - 1), current.length);
      carry = Buffer.from(current.subarray(current.length - carryLength));
    }
  } finally {
    fs.closeSync(handle);
  }
}

const desktopExecutable = required(path.join("app", "ChatGPT.exe"));
const appAsar = required(path.join("app", "resources", "app.asar"));
const nodeExecutable = required(path.join("app", "resources", "cua_node", "bin", "node.exe"));
const sqliteExecutable = required(path.join("tools", "sqlite3.exe"));
required(path.join("node_modules", "classic-level", "package.json"));
required(path.join("node_modules", "ws", "package.json"));
required(path.join("scripts", "launch-patched-codex.ps1"));
required(path.join("scripts", "codex-update-policy.psm1"));
required(path.join("scripts", "atomic-json.cjs"));
required(path.join("scripts", "build-lock.cjs"));
required(path.join("scripts", "feature-development-workflow.cjs"));
required(path.join("scripts", "run-tests.cjs"));
required(path.join("scripts", "check-source-only.cjs"));
required(path.join("scripts", "verify-portable-payload.cjs"));
required(path.join("scripts", "verify-current-patched-build.cjs"));
required(path.join("scripts", "verify-runtime-services.cjs"));
required(path.join("scripts", "verify-current-ui.cjs"));
required(path.join("scripts", "resolve-listening-process.cjs"));
required(path.join("scripts", "export-augment-webview-state.cjs"));
required(path.join("features", "core", "provider-suite", "payload", "codex-native-provider-settings.js"));

const sourceManifestPath = required("bundle-source.json");
const sourceManifestText = fs.readFileSync(sourceManifestPath, "utf8").replace(/^\uFEFF/, "");
const sourceManifest = JSON.parse(sourceManifestText);
if (typeof sourceManifest.portableElectronProfile !== "boolean") {
  throw new Error("Portable source manifest portableElectronProfile must be true or false");
}
if (!/^[a-f0-9]{64}$/i.test(String(sourceManifest.patchedAppAsarSha256 || ""))) {
  throw new Error("Portable source manifest is missing patchedAppAsarSha256");
}
const patchedAppAsarSha256 = sha256(appAsar);
if (patchedAppAsarSha256.toLowerCase() !== sourceManifest.patchedAppAsarSha256.toLowerCase()) {
  throw new Error("Portable patched app.asar hash does not match the source manifest");
}
for (const forbiddenField of ["sourceAppDir", "sourceConfigPath"]) {
  if (Object.hasOwn(sourceManifest, forbiddenField)) {
    throw new Error(`Portable source manifest leaks ${forbiddenField}`);
  }
}

const forbiddenNames = new Set([
  ".env",
  "auth.json",
  "config.toml",
  "state_5.sqlite",
  "state_5.sqlite-shm",
  "state_5.sqlite-wal",
]);
if (!runtimeMode) forbiddenNames.add("codex-launcher.local.json");
const payloadFiles = filesUnder(payloadRoot);
const forbiddenFiles = payloadFiles
  .filter((filePath) => forbiddenNames.has(path.basename(filePath).toLowerCase()))
  .map((filePath) => path.relative(payloadRoot, filePath));
if (forbiddenFiles.length) {
  throw new Error(`Portable payload contains private runtime files: ${forbiddenFiles.join(", ")}`);
}

const runtimeLauncherPath = path.join(payloadRoot, "codex-launcher.local.json");
if (runtimeMode) {
  const runtimeLauncher = JSON.parse(
    fs.readFileSync(required("codex-launcher.local.json"), "utf8").replace(/^\uFEFF/, ""),
  );
  const normalizedRoot = path.resolve(payloadRoot);
  if (runtimeLauncher.mode !== "bundled-self-extracting") {
    throw new Error("Initialized portable runtime has an unexpected launcher mode.");
  }
  if (path.resolve(String(runtimeLauncher.cloneRoot || "")) !== normalizedRoot) {
    throw new Error("Initialized portable runtime launcher does not target its own extracted root.");
  }
  if (!path.resolve(String(runtimeLauncher.codexExe || "")).startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error("Initialized portable runtime launcher points outside its extracted root.");
  }
  if (typeof runtimeLauncher.portableElectronProfile !== "boolean") {
    throw new Error("Initialized portable runtime launcher has no explicit Electron profile mode.");
  }
  if (runtimeLauncher.portableElectronProfile !== sourceManifest.portableElectronProfile) {
    throw new Error("Initialized portable runtime launcher changed the packaged Electron profile mode.");
  }
  if (runtimeLauncher.patchedAppAsarSha256 !== sourceManifest.patchedAppAsarSha256) {
    throw new Error("Initialized portable runtime launcher changed the patched app.asar hash.");
  }
  const electronUserDataPath = path.resolve(String(runtimeLauncher.electronUserDataPath || ""));
  const expectedElectronUserDataPath = sourceManifest.portableElectronProfile
    ? path.resolve(String(runtimeLauncher.profileRoot || ""), "electron-user-data")
    : path.resolve(
      String(process.env.LOCALAPPDATA || ""),
      "CodexPatchStudioCurrent",
      "electron-user-data",
    );
  if (electronUserDataPath.toLowerCase() !== expectedElectronUserDataPath.toLowerCase()) {
    throw new Error("Initialized portable runtime launcher selected the wrong Electron profile path.");
  }
}

const secretNames = [
  "DEEPSEEK_API_KEY",
  "ZAI_API_KEY",
  "DASHSCOPE_API_KEY",
  "CEREBRAS_API_KEY",
  "OPENAI_API_KEY",
];
const secrets = secretNames
  .map((name) => ({ name, value: String(process.env[name] || "") }))
  .filter((entry) => entry.value.length >= 16)
  .map((entry) => ({ ...entry, buffer: Buffer.from(entry.value, "utf8") }));
const secretHits = [];
if (secrets.length) {
  for (const filePath of payloadFiles) {
    const hits = scanFileForSecrets(filePath, secrets);
    if (hits.length) secretHits.push({ file: path.relative(payloadRoot, filePath), variables: hits });
  }
}
if (secretHits.length) {
  throw new Error(`Portable payload contains provider credential values: ${JSON.stringify(secretHits)}`);
}

const nodeCheck = spawnSync(nodeExecutable, [
  "--no-warnings",
  "-e",
  "require('node:sqlite');require('classic-level');require('ws');process.stdout.write(process.version)",
], { cwd: payloadRoot, encoding: "utf8", windowsHide: true });
if (nodeCheck.status !== 0) {
  throw new Error(`Bundled Node dependency check failed: ${nodeCheck.stderr || nodeCheck.stdout}`);
}
const sqliteCheck = spawnSync(sqliteExecutable, ["-version"], {
  cwd: payloadRoot,
  encoding: "utf8",
  windowsHide: true,
});
if (sqliteCheck.status !== 0 || !/^\d+\.\d+/.test(sqliteCheck.stdout.trim())) {
  throw new Error(`Bundled SQLite check failed: ${sqliteCheck.stderr || sqliteCheck.stdout}`);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  sourceVersion: sourceManifest.sourceVersion,
  desktopExecutable: path.relative(payloadRoot, desktopExecutable),
  payloadFileCount: payloadFiles.length,
  bundledNodeVersion: nodeCheck.stdout.trim(),
  bundledSqliteVersion: sqliteCheck.stdout.trim().split(/\s+/)[0],
  patchedAppAsarSha256,
  scannedProviderSecretCount: secrets.length,
  privateRuntimeFilesPresent: false,
  generatedLauncherConfigPresent: fs.existsSync(runtimeLauncherPath),
  verificationMode: runtimeMode ? "initialized-runtime" : "dormant-payload",
  portableElectronProfile: sourceManifest.portableElectronProfile,
  localSourcePathsPresent: /sourceAppDir|sourceConfigPath/.test(sourceManifestText),
}, null, 2)}\n`);
