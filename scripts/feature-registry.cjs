#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const FEATURE_SCHEMA_VERSION = 1;
const FEATURE_API_VERSION = 1;
const FEATURE_KINDS = new Set(["core", "contribution", "local"]);
const FEATURE_IMPLEMENTATIONS = new Set(["builtin", "module"]);

function stripBom(value) {
  return String(value || "").replace(/^\uFEFF/, "");
}

function readJson(filePath) {
  return JSON.parse(stripBom(fs.readFileSync(filePath, "utf8")));
}

function expandEnvironmentPath(value) {
  return String(value || "")
    .replace(/%([^%]+)%/g, (match, name) => process.env[name] || match)
    .replace(/^~(?=[\\/]|$)/, os.homedir());
}

function compareVersion(leftValue, rightValue) {
  const left = String(leftValue || "0").split(".").map((part) => Number(part) || 0);
  const right = String(rightValue || "0").split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] || 0) - (right[index] || 0);
    if (delta) return delta;
  }
  return 0;
}

function isInside(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function resolveInside(parentPath, relativePath, label = "path") {
  const value = String(relativePath || "");
  if (!value || path.isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative path.`);
  }
  const resolved = path.resolve(parentPath, value);
  if (!isInside(parentPath, resolved)) {
    throw new Error(`${label} escapes its allowed root: ${relativePath}`);
  }
  return resolved;
}

function walkFiles(rootPath) {
  if (!fs.existsSync(rootPath)) return [];
  const files = [];
  const visit = (directory) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if ([".git", "node_modules", "build", "dist"].includes(entry.name)) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  };
  visit(rootPath);
  return files;
}

function hashDirectory(rootPath) {
  const hash = crypto.createHash("sha256");
  for (const filePath of walkFiles(rootPath)) {
    const relativePath = path.relative(rootPath, filePath).replace(/\\/g, "/");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(fs.readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function manifestPaths(rootPath) {
  return walkFiles(rootPath).filter((filePath) => path.basename(filePath).toLowerCase() === "feature.json");
}

function normalizeStringArray(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function validateManifest(raw, manifestPath, expectedKind = null) {
  const location = path.dirname(manifestPath);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${manifestPath}: manifest must be an object.`);
  if (raw.schemaVersion !== FEATURE_SCHEMA_VERSION) throw new Error(`${manifestPath}: unsupported schemaVersion.`);
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(String(raw.id || ""))) {
    throw new Error(`${manifestPath}: id must be a namespaced lowercase identifier.`);
  }
  if (!FEATURE_KINDS.has(raw.kind)) throw new Error(`${manifestPath}: kind must be core, contribution, or local.`);
  if (expectedKind && raw.kind !== expectedKind) throw new Error(`${manifestPath}: kind must match its ${expectedKind} root.`);
  if (!FEATURE_IMPLEMENTATIONS.has(raw.implementation)) throw new Error(`${manifestPath}: invalid implementation.`);
  if (!String(raw.name || "").trim() || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(raw.version || ""))) {
    throw new Error(`${manifestPath}: name and semantic version are required.`);
  }
  if (raw.kind !== "core" && raw.enabledByDefault === true) {
    throw new Error(`${manifestPath}: only core modules may be enabled by default.`);
  }
  if (raw.implementation === "module") resolveInside(location, raw.entry || "", "entry");
  if (raw.implementation === "builtin" && raw.entry) throw new Error(`${manifestPath}: builtin features cannot declare entry.`);
  if (raw.distribution?.upstreamArtifacts !== "forbidden") {
    throw new Error(`${manifestPath}: distribution.upstreamArtifacts must be \"forbidden\".`);
  }
  const verification = raw.verification == null ? [] : raw.verification;
  if (!Array.isArray(verification)) throw new Error(`${manifestPath}: verification must be an array.`);
  for (const [index, check] of verification.entries()) {
    if (!check || typeof check !== "object" || typeof check.path !== "string" || typeof check.includes !== "string") {
      throw new Error(`${manifestPath}: verification[${index}] requires path and includes strings.`);
    }
    resolveInside(location, check.path, `verification[${index}].path`);
  }
  const manifest = {
    ...raw,
    dependencies: normalizeStringArray(raw.dependencies, `${manifestPath}: dependencies`),
    conflicts: normalizeStringArray(raw.conflicts, `${manifestPath}: conflicts`),
    permissions: normalizeStringArray(raw.permissions, `${manifestPath}: permissions`),
    legacyFeatureIds: normalizeStringArray(raw.legacyFeatureIds, `${manifestPath}: legacyFeatureIds`),
    verification,
  };
  return {
    id: manifest.id,
    kind: manifest.kind,
    manifest,
    manifestPath,
    rootPath: location,
    sourceHash: hashDirectory(location),
  };
}

function configuredRoots(repoRoot, config = {}) {
  const roots = [
    { path: path.join(repoRoot, "features", "core"), kind: "core" },
    { path: path.join(repoRoot, "features", "community"), kind: "contribution" },
  ];
  for (const value of Array.isArray(config.featureRoots) ? config.featureRoots : []) {
    if (typeof value === "string") roots.push({ path: expandEnvironmentPath(value), kind: "contribution" });
    else if (value && typeof value === "object") roots.push({ path: expandEnvironmentPath(value.path), kind: value.kind || "contribution" });
  }
  roots.push({
    path: expandEnvironmentPath(config.localFeatureRoot || "%USERPROFILE%\\.codex-patch-studio-current\\features"),
    kind: "local",
  });
  return roots.map((entry) => ({ ...entry, path: path.resolve(entry.path) }));
}

function discoverFeatureModules(repoRoot, config = {}) {
  const records = [];
  const byId = new Map();
  for (const root of configuredRoots(repoRoot, config)) {
    if (!FEATURE_KINDS.has(root.kind)) throw new Error(`Invalid feature root kind: ${root.kind}`);
    for (const manifestPath of manifestPaths(root.path)) {
      const record = validateManifest(readJson(manifestPath), manifestPath, root.kind);
      if (byId.has(record.id)) {
        throw new Error(`Duplicate feature id ${record.id}: ${byId.get(record.id).manifestPath} and ${manifestPath}`);
      }
      byId.set(record.id, record);
      records.push(record);
    }
  }
  records.sort((a, b) => a.id.localeCompare(b.id));
  return { records, byId, roots: configuredRoots(repoRoot, config) };
}

function configuredSelection(value) {
  if (Array.isArray(value)) return new Map(value.map((id) => [String(id), true]));
  if (value && typeof value === "object") return new Map(Object.entries(value).map(([id, enabled]) => [id, enabled !== false]));
  return new Map();
}

function compatibleWith(record, sourceVersion) {
  const minimum = record.manifest.supports?.minimumCodexVersion;
  const maximum = record.manifest.supports?.maximumCodexVersion;
  if (minimum && compareVersion(sourceVersion, minimum) < 0) return false;
  if (maximum && compareVersion(sourceVersion, maximum) > 0) return false;
  return true;
}

function resolveFeatureModules(catalog, options = {}) {
  const selections = configuredSelection(options.featureModules);
  for (const id of options.enabledIds || []) selections.set(id, true);
  for (const id of options.disabledIds || []) selections.set(id, false);
  const enabled = new Set();
  const disabled = new Set([...selections].filter(([, value]) => !value).map(([id]) => id));

  for (const record of catalog.records) {
    let selected = selections.has(record.id) ? selections.get(record.id) : record.manifest.enabledByDefault === true;
    if (record.manifest.implementation === "module" && options.includeExternalModules === false) selected = false;
    if (record.manifest.implementation === "builtin" && record.manifest.legacyFeatureIds.length) {
      selected = record.manifest.legacyFeatureIds.some((id) => options.builtinFeatures?.[id] === true);
    }
    if (selected) enabled.add(record.id);
  }

  const addDependencies = (id, chain = []) => {
    const record = catalog.byId.get(id);
    if (!record) throw new Error(`Unknown enabled feature: ${id}`);
    if (chain.includes(id)) throw new Error(`Feature dependency cycle: ${[...chain, id].join(" -> ")}`);
    for (const dependencyId of record.manifest.dependencies) {
      if (!catalog.byId.has(dependencyId)) throw new Error(`${id} depends on missing feature ${dependencyId}.`);
      if (disabled.has(dependencyId)) throw new Error(`${id} depends on explicitly disabled feature ${dependencyId}.`);
      enabled.add(dependencyId);
      addDependencies(dependencyId, [...chain, id]);
    }
  };
  for (const id of [...enabled]) addDependencies(id);

  const sourceVersion = options.sourceVersion || "0";
  for (const id of enabled) {
    const record = catalog.byId.get(id);
    if (!compatibleWith(record, sourceVersion)) throw new Error(`${id} does not support Codex ${sourceVersion}.`);
    for (const conflictId of record.manifest.conflicts) {
      if (enabled.has(conflictId)) throw new Error(`${id} conflicts with enabled feature ${conflictId}.`);
    }
  }

  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Feature dependency cycle includes ${id}.`);
    visiting.add(id);
    const record = catalog.byId.get(id);
    for (const dependencyId of record.manifest.dependencies) if (enabled.has(dependencyId)) visit(dependencyId);
    visiting.delete(id);
    visited.add(id);
    ordered.push(record);
  };
  for (const id of [...enabled].sort()) visit(id);
  return { ordered, enabledIds: ordered.map((record) => record.id) };
}

function publicFeatureRecord(record, enabled = false) {
  return {
    id: record.id,
    name: record.manifest.name,
    description: record.manifest.description || "",
    version: record.manifest.version,
    kind: record.kind,
    implementation: record.manifest.implementation,
    enabled,
    enabledByDefault: record.manifest.enabledByDefault === true,
    dependencies: record.manifest.dependencies,
    conflicts: record.manifest.conflicts,
    sourceHash: record.sourceHash,
  };
}

function loadFeatureEntry(record) {
  const entryPath = resolveInside(record.rootPath, record.manifest.entry, "entry");
  const source = fs.readFileSync(entryPath, "utf8");
  const exported = {};
  const sandbox = {
    module: { exports: exported },
    exports: exported,
    console: Object.freeze({ log() {}, warn() {}, error() {} }),
  };
  const context = vm.createContext(sandbox, {
    name: `codex-patch-feature:${record.id}`,
    codeGeneration: { strings: false, wasm: false },
  });
  new vm.Script(`"use strict";\n${source}\n`, { filename: entryPath }).runInContext(context, { timeout: 5000 });
  const api = sandbox.module.exports;
  if (!api || api.apiVersion !== FEATURE_API_VERSION) throw new Error(`${record.id}: entry must export apiVersion ${FEATURE_API_VERSION}.`);
  return api;
}

function createPatchContext(record, extractDir, phase, options = {}) {
  const readOnly = phase === "packed";
  const resolveExtract = (relativePath, label) => resolveInside(extractDir, relativePath, label);
  const resolvePayload = (relativePath, label) => resolveInside(record.rootPath, relativePath, label);
  return Object.freeze({
    featureId: record.id,
    phase,
    sourceVersion: String(options.sourceVersion || ""),
    options: Object.freeze({ ...(options.moduleOptions || {}) }),
    readText(relativePath) {
      return fs.readFileSync(resolveExtract(relativePath, "readText path"), "utf8");
    },
    writeText(relativePath, content) {
      if (readOnly) throw new Error(`${record.id}: packed verification is read-only.`);
      const filePath = resolveExtract(relativePath, "writeText path");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, String(content), "utf8");
    },
    replaceExactly(relativePath, from, to) {
      if (readOnly) throw new Error(`${record.id}: packed verification is read-only.`);
      const filePath = resolveExtract(relativePath, "replaceExactly path");
      const text = fs.readFileSync(filePath, "utf8");
      const count = text.split(String(from)).length - 1;
      if (count !== 1) throw new Error(`${record.id}: expected one replacement target in ${relativePath}, found ${count}.`);
      fs.writeFileSync(filePath, text.replace(String(from), String(to)), "utf8");
      return count;
    },
    findFiles(query = {}) {
      const under = query.under ? resolveExtract(query.under, "findFiles under") : path.resolve(extractDir);
      const includes = String(query.includes || "");
      const suffix = String(query.suffix || "");
      return walkFiles(under)
        .map((filePath) => path.relative(extractDir, filePath).replace(/\\/g, "/"))
        .filter((relativePath) => (!includes || relativePath.includes(includes)) && (!suffix || relativePath.endsWith(suffix)));
    },
    copyPayload(sourceRelativePath, destinationRelativePath) {
      if (readOnly) throw new Error(`${record.id}: packed verification is read-only.`);
      const sourcePath = resolvePayload(sourceRelativePath, "payload path");
      const destinationPath = resolveExtract(destinationRelativePath, "payload destination");
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath);
    },
  });
}

function runStaticVerification(record, extractDir) {
  const results = [];
  for (const check of record.manifest.verification) {
    const filePath = resolveInside(extractDir, check.path, "verification path");
    if (!fs.existsSync(filePath)) throw new Error(`${record.id}: verification file is missing: ${check.path}`);
    const matched = fs.readFileSync(filePath, "utf8").includes(check.includes);
    if (!matched) throw new Error(`${record.id}: verification marker is missing from ${check.path}.`);
    results.push({ path: check.path, matched: true });
  }
  return results;
}

function assertSynchronous(value, label) {
  if (value && typeof value.then === "function") throw new Error(`${label} must be synchronous.`);
  return value;
}

function applyFeatureModules(resolved, extractDir, options = {}) {
  const results = [];
  for (const record of resolved.ordered) {
    if (record.manifest.implementation !== "module") continue;
    const api = loadFeatureEntry(record);
    if (typeof api.apply !== "function") throw new Error(`${record.id}: module must export apply(context).`);
    const context = createPatchContext(record, extractDir, "unpacked", options);
    const result = assertSynchronous(api.apply(context), `${record.id} apply`);
    if (typeof api.verify === "function") assertSynchronous(api.verify(context, "unpacked"), `${record.id} verify`);
    results.push({ id: record.id, version: record.manifest.version, sourceHash: record.sourceHash, result: result ?? null, verification: runStaticVerification(record, extractDir) });
  }
  return results;
}

function verifyFeatureModules(resolved, extractDir, options = {}) {
  const results = [];
  for (const record of resolved.ordered) {
    if (record.manifest.implementation !== "module") continue;
    const api = loadFeatureEntry(record);
    const context = createPatchContext(record, extractDir, "packed", options);
    const result = typeof api.verify === "function" ? assertSynchronous(api.verify(context, "packed"), `${record.id} verify`) : null;
    results.push({ id: record.id, result: result ?? null, verification: runStaticVerification(record, extractDir) });
  }
  return results;
}

function catalogFingerprint(catalog) {
  const hash = crypto.createHash("sha256");
  for (const record of catalog.records) {
    hash.update(record.id);
    hash.update("\0");
    hash.update(record.sourceHash);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function scaffoldFeature({ repoRoot, id, kind = "local", targetRoot = null }) {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(String(id || ""))) throw new Error("--id must be a namespaced lowercase identifier.");
  if (!FEATURE_KINDS.has(kind) || kind === "core") throw new Error("Scaffolding supports local or contribution modules.");
  const root = targetRoot
    ? path.resolve(expandEnvironmentPath(targetRoot))
    : kind === "local"
      ? path.resolve(expandEnvironmentPath("%USERPROFILE%\\.codex-patch-studio-current\\features"))
      : path.join(repoRoot, "features", "community");
  const featureRoot = resolveInside(root, id.replace(/\./g, "-"), "feature directory");
  if (fs.existsSync(featureRoot)) throw new Error(`Feature directory already exists: ${featureRoot}`);
  fs.mkdirSync(featureRoot, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    id,
    name: id.split(/[.-]/).map((part) => part[0].toUpperCase() + part.slice(1)).join(" "),
    description: "Describe the local Codex patch feature.",
    version: "0.1.0",
    kind,
    implementation: "module",
    entry: "module.cjs",
    enabledByDefault: false,
    dependencies: [],
    conflicts: [],
    permissions: ["patch:asar"],
    supports: { minimumCodexVersion: null, maximumCodexVersion: null },
    verification: [],
    distribution: { upstreamArtifacts: "forbidden" },
  };
  fs.writeFileSync(path.join(featureRoot, "feature.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(featureRoot, "module.cjs"),
    `module.exports = {\n  apiVersion: 1,\n  apply(context) {\n    // Use only the context helpers. Never include copied Codex source or binaries.\n    return { changed: false };\n  },\n  verify(context, phase) {\n    return { phase, ok: true };\n  },\n};\n`,
    "utf8"
  );
  return featureRoot;
}

function loadRepoConfig(repoRoot) {
  const basePath = path.join(repoRoot, "config", "patcher.json");
  const localPath = path.join(repoRoot, "config", "patcher.local.json");
  return { ...(fs.existsSync(basePath) ? readJson(basePath) : {}), ...(fs.existsSync(localPath) ? readJson(localPath) : {}) };
}

function cli(argv) {
  const repoRoot = path.resolve(__dirname, "..");
  const command = argv[0] || "list";
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : null;
  };
  if (command === "scaffold") {
    const featureRoot = scaffoldFeature({ repoRoot, id: value("--id"), kind: value("--kind") || "local", targetRoot: value("--root") });
    process.stdout.write(`${JSON.stringify({ ok: true, featureRoot })}\n`);
    return;
  }
  const config = loadRepoConfig(repoRoot);
  const catalog = discoverFeatureModules(repoRoot, config);
  if (command === "validate" || command === "list") {
    const result = { ok: true, fingerprint: catalogFingerprint(catalog), modules: catalog.records.map((record) => publicFeatureRecord(record)) };
    process.stdout.write(`${JSON.stringify(result, null, argv.includes("--json") ? 0 : 2)}\n`);
    return;
  }
  throw new Error(`Unknown feature registry command: ${command}`);
}

module.exports = {
  FEATURE_API_VERSION,
  applyFeatureModules,
  catalogFingerprint,
  compareVersion,
  configuredRoots,
  createPatchContext,
  discoverFeatureModules,
  publicFeatureRecord,
  resolveFeatureModules,
  resolveInside,
  scaffoldFeature,
  validateManifest,
  verifyFeatureModules,
};

if (require.main === module) {
  try {
    cli(process.argv.slice(2));
  } catch (error) {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  }
}
