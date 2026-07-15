#!/usr/bin/env node

"use strict";

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
required(path.join("app", "resources", "app.asar"));
const nodeExecutable = required(path.join("app", "resources", "cua_node", "bin", "node.exe"));
const sqliteExecutable = required(path.join("tools", "sqlite3.exe"));
required(path.join("node_modules", "classic-level", "package.json"));
required(path.join("node_modules", "ws", "package.json"));
required(path.join("scripts", "launch-patched-codex.ps1"));
required(path.join("scripts", "export-augment-webview-state.cjs"));
required(path.join("native-patches", "codex-native-provider-settings.js"));

const sourceManifestPath = required("bundle-source.json");
const sourceManifestText = fs.readFileSync(sourceManifestPath, "utf8").replace(/^\uFEFF/, "");
const sourceManifest = JSON.parse(sourceManifestText);
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
  scannedProviderSecretCount: secrets.length,
  privateRuntimeFilesPresent: false,
  generatedLauncherConfigPresent: fs.existsSync(runtimeLauncherPath),
  verificationMode: runtimeMode ? "initialized-runtime" : "dormant-payload",
  localSourcePathsPresent: /sourceAppDir|sourceConfigPath/.test(sourceManifestText),
}, null, 2)}\n`);
