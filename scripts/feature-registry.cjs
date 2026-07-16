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
const FEATURE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;
const CODEX_EXACT_VERSION_PATTERN = /^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/;
const CODEX_FAMILY_VERSION_PATTERN = /^\d+\.\d+\.x$/;
const CODEX_VERSION_PATTERN = /^(?:\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?|\d+\.\d+\.x)$/;
const FEATURE_RECEIPT_SCHEMA_VERSION = 1;
const FEATURE_RECEIPT_DIRECTORY = "codex-patch-studio/features";
const ADAPTER_VM_TIMEOUT_MS = 5000;
const MAX_ADAPTER_BRIDGE_REQUESTS = 256;
const FORBIDDEN_MODULE_EXTENSIONS = new Set([
  ".asar",
  ".appx",
  ".appxbundle",
  ".cab",
  ".db",
  ".dll",
  ".exe",
  ".msi",
  ".msix",
  ".node",
  ".rar",
  ".sfx",
  ".sqlite",
  ".sqlite3",
  ".7z",
]);
const FORBIDDEN_MODULE_PATH_PARTS = new Set([
  "app.asar.extracted",
  "build-output",
  "codex-chat-backups",
  "codex-import-backups",
  "codex-patched-app",
  "codex-portable-packages",
  "dist",
  "electron-user-data",
  "node_modules",
  "windowsapps",
]);

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

function walkFiles(rootPath, options = {}) {
  if (!fs.existsSync(rootPath)) return [];
  const excludeDevelopmentDirectories = options.excludeDevelopmentDirectories !== false;
  const files = [];
  const visit = (directory) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      if (excludeDevelopmentDirectories && ["node_modules", "build", "dist"].includes(entry.name)) continue;
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
  for (const filePath of walkFiles(rootPath, { excludeDevelopmentDirectories: false })) {
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

function matchesCodexVersionSelector(selectorValue, versionValue) {
  const selector = String(selectorValue || "").toLowerCase();
  const version = String(versionValue || "").toLowerCase();
  if (CODEX_FAMILY_VERSION_PATTERN.test(selector)) {
    return version.startsWith(`${selector.slice(0, -1)}`) && CODEX_EXACT_VERSION_PATTERN.test(version);
  }
  return selector === version;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requireDeclared(raw, keys, manifestPath) {
  for (const key of keys) {
    if (!hasOwn(raw, key)) throw new Error(`${manifestPath}: module manifests must declare ${key}.`);
  }
}

function validateRelativePattern(value, label) {
  const normalized = String(value || "").replace(/\\/g, "/");
  if (!normalized || path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`${label} must be a non-empty relative path and cannot escape its allowed root.`);
  }
  return normalized.replace(/^\.\//, "");
}

function normalizeCodexVersions(raw, manifestPath, required) {
  const declared = raw.supports?.codexVersions ?? raw.supportedCodexVersions;
  if (declared == null && !required) return [];
  const versions = normalizeStringArray(declared, `${manifestPath}: supports.codexVersions`);
  if (Array.isArray(declared) && versions.length !== declared.length) {
    throw new Error(`${manifestPath}: supports.codexVersions cannot contain duplicate versions.`);
  }
  if (required && versions.length === 0) {
    throw new Error(`${manifestPath}: module manifests must declare at least one supported Codex version.`);
  }
  for (const version of versions) {
    if (!CODEX_VERSION_PATTERN.test(version)) {
      throw new Error(`${manifestPath}: unsupported Codex version selector ${version}; use an exact numeric version or a major.minor.x family.`);
    }
  }
  return versions;
}

function normalizeCardinality(value, label, { required = true, defaultMaximum = null } = {}) {
  if (value == null) {
    if (required) throw new Error(`${label} is required.`);
    return { minimum: 1, maximum: defaultMaximum };
  }
  if (Number.isInteger(value)) {
    if (value < 1) throw new Error(`${label} must require at least one match.`);
    return { minimum: value, maximum: value };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an integer or object.`);
  if (hasOwn(value, "exact")) {
    if (!Number.isInteger(value.exact) || value.exact < 1) throw new Error(`${label}.exact must be a positive integer.`);
    return { minimum: value.exact, maximum: value.exact };
  }
  const minimum = value.minimum ?? value.min;
  const maximum = hasOwn(value, "maximum") ? value.maximum : hasOwn(value, "max") ? value.max : null;
  if (!Number.isInteger(minimum) || minimum < 1) throw new Error(`${label}.minimum must be a positive integer.`);
  if (maximum != null && (!Number.isInteger(maximum) || maximum < minimum)) {
    throw new Error(`${label}.maximum must be null or an integer greater than or equal to minimum.`);
  }
  return { minimum, maximum };
}

function normalizeStructuralAnchors(value, manifestPath, required) {
  if (!Array.isArray(value)) throw new Error(`${manifestPath}: structuralAnchors must be an array.`);
  if (required && value.length === 0) {
    throw new Error(`${manifestPath}: module manifests must declare at least one structural anchor.`);
  }
  const ids = new Set();
  return value.map((anchor, index) => {
    const label = `${manifestPath}: structuralAnchors[${index}]`;
    if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) throw new Error(`${label} must be an object.`);
    const id = typeof anchor.id === "string" ? anchor.id.trim() : "";
    const includesValue = anchor.includes ?? anchor.marker;
    const includes = typeof includesValue === "string" ? includesValue : "";
    if (!id || !includes) throw new Error(`${label} requires non-empty id and includes strings.`);
    if (ids.has(id)) throw new Error(`${manifestPath}: duplicate structural anchor id ${id}.`);
    ids.add(id);
    let normalizedPath = null;
    let files = null;
    if (anchor.path != null && anchor.files != null) throw new Error(`${label} must declare path or files, not both.`);
    if (anchor.path != null) {
      if (typeof anchor.path !== "string") throw new Error(`${label}.path must be a string.`);
      normalizedPath = validateRelativePattern(anchor.path, `${label}.path`);
    } else if (anchor.files && typeof anchor.files === "object" && !Array.isArray(anchor.files)) {
      const under = validateRelativePattern(anchor.files.under || ".", `${label}.files.under`);
      const pathIncludes = String(anchor.files.pathIncludes || "");
      const suffix = String(anchor.files.suffix || "");
      if (!pathIncludes && !suffix) throw new Error(`${label}.files requires pathIncludes or suffix.`);
      files = { under, pathIncludes, suffix };
    } else {
      throw new Error(`${label} requires path or files.`);
    }
    return {
      ...anchor,
      id,
      includes,
      path: normalizedPath,
      files,
      cardinality: normalizeCardinality(anchor.cardinality, `${label}.cardinality`),
    };
  });
}

function normalizeVerification(value, manifestPath, required) {
  if (value == null && !required) return [];
  if (!Array.isArray(value)) throw new Error(`${manifestPath}: verification must be an array.`);
  if (required && value.length === 0) {
    throw new Error(`${manifestPath}: module manifests must declare at least one verification marker.`);
  }
  const ids = new Set();
  return value.map((check, index) => {
    const label = `${manifestPath}: verification[${index}]`;
    if (!check || typeof check !== "object" || typeof check.path !== "string" || typeof check.includes !== "string" || !check.includes) {
      throw new Error(`${label} requires non-empty path and includes strings.`);
    }
    if (check.id != null && (typeof check.id !== "string" || !check.id.trim())) throw new Error(`${label}.id must be a non-empty string.`);
    if (check.id && ids.has(check.id)) throw new Error(`${manifestPath}: duplicate verification marker id ${check.id}.`);
    if (check.id) ids.add(check.id);
    return {
      ...check,
      path: validateRelativePattern(check.path, `${label}.path`),
      cardinality: normalizeCardinality(check.cardinality, `${label}.cardinality`, { required: false, defaultMaximum: 1 }),
    };
  });
}

function normalizeLocalPorts(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const seen = new Set();
  return value.map((item, index) => {
    const itemLabel = `${label}[${index}]`;
    const port = Number.isInteger(item) ? item : item?.port;
    const protocol = Number.isInteger(item) ? "tcp" : String(item?.protocol || "tcp").toLowerCase();
    const host = Number.isInteger(item) ? "127.0.0.1" : String(item?.host || "127.0.0.1").toLowerCase();
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${itemLabel}.port must be an integer from 1 to 65535.`);
    if (!new Set(["tcp", "udp"]).has(protocol)) throw new Error(`${itemLabel}.protocol must be tcp or udp.`);
    if (!new Set(["127.0.0.1", "localhost", "::1"]).has(host)) throw new Error(`${itemLabel}.host must be loopback.`);
    const key = `${protocol}:${port}`;
    if (seen.has(key)) throw new Error(`${label} declares ${key} more than once.`);
    seen.add(key);
    return Number.isInteger(item) ? { port, protocol, host } : { ...item, port, protocol, host };
  });
}

function normalizeRuntime(raw, manifestPath, required) {
  if (required && (!raw.runtime || typeof raw.runtime !== "object" || Array.isArray(raw.runtime))) {
    throw new Error(`${manifestPath}: module manifests must declare runtime.`);
  }
  const runtime = raw.runtime && typeof raw.runtime === "object" && !Array.isArray(raw.runtime) ? raw.runtime : {};
  if (required && (!hasOwn(runtime, "permissions") || !hasOwn(runtime, "localPorts"))) {
    throw new Error(`${manifestPath}: runtime must declare permissions and localPorts.`);
  }
  return {
    ...runtime,
    permissions: normalizeStringArray(runtime.permissions ?? raw.permissions, `${manifestPath}: runtime.permissions`),
    localPorts: normalizeLocalPorts(runtime.localPorts ?? [], `${manifestPath}: runtime.localPorts`),
  };
}

function normalizeNativeEntries(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const ids = new Set();
  return value.map((item, index) => {
    const entry = typeof item === "string" ? { id: item } : item;
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !id) throw new Error(`${label}[${index}] requires a non-empty id.`);
    if (ids.has(id)) throw new Error(`${label} declares ${id} more than once.`);
    ids.add(id);
    for (const key of ["label", "route"]) {
      if (entry[key] != null && (typeof entry[key] !== "string" || !entry[key].trim())) {
        throw new Error(`${label}[${index}].${key} must be a non-empty string when present.`);
      }
    }
    return { ...entry, id };
  });
}

function normalizeNative(raw, manifestPath, required) {
  if (required && (!raw.native || typeof raw.native !== "object" || Array.isArray(raw.native))) {
    throw new Error(`${manifestPath}: module manifests must declare native.`);
  }
  const native = raw.native && typeof raw.native === "object" && !Array.isArray(raw.native) ? raw.native : {};
  if (required && (!hasOwn(native, "settings") || !hasOwn(native, "sidebar"))) {
    throw new Error(`${manifestPath}: native must declare settings and sidebar.`);
  }
  return {
    ...native,
    settings: normalizeNativeEntries(native.settings ?? [], `${manifestPath}: native.settings`),
    sidebar: normalizeNativeEntries(native.sidebar ?? [], `${manifestPath}: native.sidebar`),
  };
}

function validateManifest(raw, manifestPath, expectedKind = null) {
  const location = path.dirname(manifestPath);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${manifestPath}: manifest must be an object.`);
  if (raw.schemaVersion !== FEATURE_SCHEMA_VERSION) throw new Error(`${manifestPath}: unsupported schemaVersion.`);
  if (!FEATURE_ID_PATTERN.test(String(raw.id || ""))) {
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
  if (typeof raw.enabledByDefault !== "boolean") throw new Error(`${manifestPath}: enabledByDefault must be a boolean.`);

  const isModule = raw.implementation === "module";
  if (isModule) {
    if (raw.entry != null) resolveInside(location, raw.entry, "entry");
    requireDeclared(
      raw,
      ["description", "dependencies", "conflicts", "supports", "structuralAnchors", "runtime", "native", "verification"],
      manifestPath
    );
    if (!String(raw.description || "").trim()) throw new Error(`${manifestPath}: module description must be non-empty.`);
    if (raw.entry != null) throw new Error(`${manifestPath}: module entry is obsolete; use adapters/<version>.cjs.`);
    if (raw.permissions != null) throw new Error(`${manifestPath}: module permissions belong under runtime.permissions.`);
  }
  if (!isModule && raw.entry) throw new Error(`${manifestPath}: builtin features cannot declare entry.`);
  if (raw.distribution?.upstreamArtifacts !== "forbidden") {
    throw new Error(`${manifestPath}: distribution.upstreamArtifacts must be \"forbidden\".`);
  }
  const dependencies = normalizeStringArray(raw.dependencies, `${manifestPath}: dependencies`);
  const conflicts = normalizeStringArray(raw.conflicts, `${manifestPath}: conflicts`);
  for (const [label, ids] of [["dependencies", dependencies], ["conflicts", conflicts]]) {
    for (const id of ids) {
      if (!FEATURE_ID_PATTERN.test(id)) throw new Error(`${manifestPath}: ${label} contains invalid feature id ${id}.`);
      if (id === raw.id) throw new Error(`${manifestPath}: ${label} cannot contain the feature's own id.`);
    }
  }

  const supportedCodexVersions = normalizeCodexVersions(raw, manifestPath, isModule);
  const supports = {
    ...(raw.supports && typeof raw.supports === "object" && !Array.isArray(raw.supports) ? raw.supports : {}),
    codexVersions: supportedCodexVersions,
  };
  for (const key of ["minimumCodexVersion", "maximumCodexVersion"]) {
    if (supports[key] != null && !CODEX_VERSION_PATTERN.test(String(supports[key]))) {
      throw new Error(`${manifestPath}: supports.${key} must be null or a numeric Codex version.`);
    }
  }
  const structuralAnchors = normalizeStructuralAnchors(raw.structuralAnchors ?? [], manifestPath, isModule);
  const verification = normalizeVerification(raw.verification, manifestPath, isModule);
  const runtime = normalizeRuntime(raw, manifestPath, isModule);
  const native = normalizeNative(raw, manifestPath, isModule);
  for (const version of supportedCodexVersions) {
    resolveInside(location, `adapters/${version}.cjs`, `adapter for Codex ${version}`);
  }
  const manifest = {
    ...raw,
    dependencies,
    conflicts,
    supports,
    supportedCodexVersions,
    structuralAnchors,
    runtime,
    native,
    permissions: runtime.permissions,
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

function adapterRelativePath(version) {
  if (!CODEX_VERSION_PATTERN.test(String(version || ""))) throw new Error(`Invalid Codex adapter version: ${version}`);
  return `adapters/${version}.cjs`;
}

function assertModulePath(record, relativePath, expectedType, label) {
  const targetPath = resolveInside(record.rootPath, relativePath, label);
  if (!fs.existsSync(targetPath)) throw new Error(`${record.id}: missing ${label}: ${relativePath}`);
  const rootRealPath = fs.realpathSync(record.rootPath);
  const targetRealPath = fs.realpathSync(targetPath);
  if (!isInside(rootRealPath, targetRealPath)) throw new Error(`${record.id}: ${label} escapes the module root.`);
  const stats = fs.statSync(targetRealPath);
  if ((expectedType === "file" && !stats.isFile()) || (expectedType === "directory" && !stats.isDirectory())) {
    throw new Error(`${record.id}: ${label} must be a ${expectedType}.`);
  }
  return targetPath;
}

function validateSourceOnlyModuleTree(record) {
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const entryPath = path.join(directory, entry.name);
      const relativePath = path.relative(record.rootPath, entryPath).replace(/\\/g, "/");
      const normalizedParts = relativePath.toLowerCase().split("/");
      if (entry.isSymbolicLink()) throw new Error(`${record.id}: symbolic links are not allowed in feature modules: ${relativePath}`);
      if (normalizedParts.some((part) => FORBIDDEN_MODULE_PATH_PARTS.has(part))) {
        throw new Error(`${record.id}: generated or distributable path is forbidden: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (FORBIDDEN_MODULE_EXTENSIONS.has(extension)) {
        throw new Error(`${record.id}: source-only modules cannot contain ${extension} files: ${relativePath}`);
      }
      const buffer = fs.readFileSync(entryPath);
      if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
        throw new Error(`${record.id}: source-only modules cannot contain Windows executable payloads: ${relativePath}`);
      }
      if (buffer.length > 5 * 1024 * 1024 && !new Set([".png", ".jpg", ".jpeg", ".webp"]).has(extension)) {
        throw new Error(`${record.id}: unexpected source file larger than 5 MiB: ${relativePath}`);
      }
      const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
      if (!sample.includes(0)) {
        const text = buffer.toString("utf8");
        if (
          /\b(?:const|let|var)\s+\w*(?:Before|Original)\w*\s*=\s*[`"'][^\n]{600,}/.test(text)
          || /\b(?:const|let|var)\s+\w*(?:Before|Original)\w*\s*=\s*[`"'][^\n]{120,}function\s/.test(text)
        ) {
          throw new Error(`${record.id}: large embedded upstream-source anchor is forbidden: ${relativePath}`);
        }
      }
    }
  };
  visit(record.rootPath);
}

function validateModuleLayout(record) {
  if (record.manifest.implementation !== "module") return record;
  validateSourceOnlyModuleTree(record);
  const readmePath = assertModulePath(record, "README.md", "file", "README");
  if (!fs.readFileSync(readmePath, "utf8").trim()) throw new Error(`${record.id}: README.md must not be empty.`);
  assertModulePath(record, "adapters", "directory", "adapters directory");
  assertModulePath(record, "payload", "directory", "payload directory");
  const testsPath = assertModulePath(record, "tests", "directory", "tests directory");
  const tests = walkFiles(testsPath).filter((filePath) => /\.test\.cjs$/i.test(filePath));
  if (tests.length === 0) throw new Error(`${record.id}: tests must contain at least one .test.cjs file.`);
  for (const testPath of tests) {
    try {
      new vm.Script(fs.readFileSync(testPath, "utf8"), { filename: testPath });
    } catch (error) {
      throw new Error(`${record.id}: test ${path.relative(record.rootPath, testPath)} is not valid JavaScript: ${error.message}`);
    }
  }
  for (const version of record.manifest.supportedCodexVersions) {
    const relativePath = adapterRelativePath(version);
    const adapterPath = assertModulePath(record, relativePath, "file", `adapter for Codex ${version}`);
    const source = fs.readFileSync(adapterPath, "utf8");
    try {
      new vm.Script(`"use strict";\n${source}\n`, { filename: adapterPath });
    } catch (error) {
      throw new Error(`${record.id}: adapter for Codex ${version} is not valid JavaScript: ${error.message}`);
    }
  }
  return record;
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
      const record = validateModuleLayout(validateManifest(readJson(manifestPath), manifestPath, root.kind));
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
  const selectors = record.manifest.supportedCodexVersions || [];
  if (selectors.length > 0) return selectors.some((selector) => matchesCodexVersionSelector(selector, sourceVersion));
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
    if (record.manifest.implementation === "module" && record.kind !== "core" && options.includeExternalModules === false) selected = false;
    if (record.manifest.implementation === "builtin" && record.manifest.legacyFeatureIds.length) {
      selected = record.manifest.legacyFeatureIds.some((id) => options.builtinFeatures?.[id] === true);
    }
    if (selected) enabled.add(record.id);
  }
  for (const [id, selected] of selections) {
    if (selected && !catalog.byId.has(id)) throw new Error(`Unknown enabled feature: ${id}`);
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

  const localPorts = new Map();
  const nativeIds = { settings: new Map(), sidebar: new Map() };
  for (const id of [...enabled].sort()) {
    const record = catalog.byId.get(id);
    for (const declaration of record.manifest.runtime.localPorts) {
      const key = `${declaration.protocol}:${declaration.port}`;
      if (localPorts.has(key)) throw new Error(`${id} and ${localPorts.get(key)} both declare local port ${key}.`);
      localPorts.set(key, id);
    }
    for (const area of ["settings", "sidebar"]) {
      for (const addition of record.manifest.native[area]) {
        if (nativeIds[area].has(addition.id)) {
          throw new Error(`${id} and ${nativeIds[area].get(addition.id)} both declare native ${area} id ${addition.id}.`);
        }
        nativeIds[area].set(addition.id, id);
      }
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
  return { ordered, enabledIds: ordered.map((record) => record.id), sourceVersion };
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
    supportedCodexVersions: record.manifest.supportedCodexVersions,
    structuralAnchors: record.manifest.structuralAnchors.map((anchor) => ({ id: anchor.id, cardinality: anchor.cardinality })),
    runtime: record.manifest.runtime,
    native: record.manifest.native,
    sourceHash: record.sourceHash,
  };
}

function selectFeatureAdapter(record, sourceVersion) {
  const version = String(sourceVersion || "");
  const matches = record.manifest.supportedCodexVersions.filter((candidate) => matchesCodexVersionSelector(candidate, version));
  if (matches.length !== 1) {
    throw new Error(`${record.id}: expected exactly one adapter for Codex ${version || "<unknown>"}, found ${matches.length}.`);
  }
  const relativePath = adapterRelativePath(matches[0]);
  const adapterPath = assertModulePath(record, relativePath, "file", `adapter for Codex ${matches[0]}`);
  return { version: matches[0], relativePath, adapterPath };
}

function createIsolatedAdapterRealm(record, adapter, source) {
  const contextTarget = vm.constants?.DONT_CONTEXTIFY || undefined;
  const context = vm.createContext(contextTarget, {
    name: `codex-patch-feature:${record.id}:${adapter.version}`,
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: "afterEvaluate",
  });
  new vm.Script(
    `"use strict";\n` +
      `globalThis.module = { exports: {} };\n` +
      `globalThis.exports = globalThis.module.exports;\n` +
      `globalThis.console = Object.freeze({ log() {}, warn() {}, error() {} });\n` +
      `const __cpsJsonStringify = JSON.stringify.bind(JSON);\n` +
      `Object.freeze(__cpsJsonStringify);\n` +
      `Object.setPrototypeOf(globalThis, null);\n` +
      `Object.defineProperty(globalThis, "constructor", { value: undefined, writable: false, configurable: false });\n`,
    { filename: `${adapter.adapterPath}:bootstrap` }
  ).runInContext(context, { timeout: ADAPTER_VM_TIMEOUT_MS });
  new vm.Script(`"use strict";\n${source}\n`, { filename: adapter.adapterPath })
    .runInContext(context, { timeout: ADAPTER_VM_TIMEOUT_MS });
  return context;
}

function isolatedAdapterMetadata(context, adapterPath) {
  const metadataText = new vm.Script(
    `(() => {\n` +
      `  const api = globalThis.module && globalThis.module.exports;\n` +
      `  return __cpsJsonStringify({\n` +
      `    present: Boolean(api),\n` +
      `    apiVersion: api && api.apiVersion,\n` +
      `    codexVersion: api && api.codexVersion,\n` +
      `    applyType: typeof (api && api.apply),\n` +
      `    verifyType: typeof (api && api.verify),\n` +
      `  });\n` +
      `})()`,
    { filename: `${adapterPath}:metadata` }
  ).runInContext(context, { timeout: ADAPTER_VM_TIMEOUT_MS });
  if (typeof metadataText !== "string") throw new Error(`${adapterPath}: adapter metadata was not serializable.`);
  return JSON.parse(metadataText);
}

function loadFeatureEntry(record, sourceVersion, selectedAdapter = null) {
  const adapter = selectedAdapter || selectFeatureAdapter(record, sourceVersion);
  if (record.kind === "core") {
    const resolvedAdapterPath = require.resolve(adapter.adapterPath);
    delete require.cache[resolvedAdapterPath];
    const api = require(resolvedAdapterPath);
    const metadata = {
      present: Boolean(api),
      apiVersion: api && api.apiVersion,
      codexVersion: api && api.codexVersion,
      applyType: typeof (api && api.apply),
      verifyType: typeof (api && api.verify),
    };
    if (!metadata.present || metadata.apiVersion !== FEATURE_API_VERSION) {
      throw new Error(`${record.id}: adapter ${adapter.relativePath} must export apiVersion ${FEATURE_API_VERSION}.`);
    }
    if (metadata.codexVersion != null && metadata.codexVersion !== adapter.version) {
      throw new Error(`${record.id}: adapter ${adapter.relativePath} exports mismatched codexVersion ${metadata.codexVersion}.`);
    }
    return { api, adapter, metadata, trusted: true };
  }
  const source = fs.readFileSync(adapter.adapterPath, "utf8");
  const context = createIsolatedAdapterRealm(record, adapter, source);
  const metadata = isolatedAdapterMetadata(context, adapter.adapterPath);
  if (!metadata.present || metadata.apiVersion !== FEATURE_API_VERSION) {
    throw new Error(`${record.id}: adapter ${adapter.relativePath} must export apiVersion ${FEATURE_API_VERSION}.`);
  }
  if (metadata.codexVersion != null && metadata.codexVersion !== adapter.version) {
    throw new Error(`${record.id}: adapter ${adapter.relativePath} exports mismatched codexVersion ${metadata.codexVersion}.`);
  }
  return { adapter, metadata, source, trusted: false };
}

function scriptJson(value, label) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${label} must be JSON-serializable: ${error.message}`);
  }
  if (serialized == null) serialized = "null";
  return serialized.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function isolatedInvocationScript(record, methodName, phase, options, responses) {
  const input = {
    featureId: record.id,
    methodName,
    phase,
    sourceVersion: String(options.sourceVersion || ""),
    options: options.moduleOptions || {},
    permissions: record.manifest.runtime.permissions,
    responses,
  };
  return `(() => {\n` +
    `  "use strict";\n` +
    `  const input = ${scriptJson(input, `${record.id} adapter input`)};\n` +
    `  const operations = [];\n` +
    `  const overlays = { __proto__: null };\n` +
    `  const sentinel = Object.freeze({});\n` +
    `  let missing = null;\n` +
    `  const appendOperation = (operation) => { operations[operations.length] = operation; };\n` +
    `  const sameArgs = (left, right) => {\n` +
    `    if (!left || !right || left.length !== right.length) return false;\n` +
    `    for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;\n` +
    `    return true;\n` +
    `  };\n` +
    `  const request = (kind, args) => {\n` +
    `    for (let index = 0; index < input.responses.length; index += 1) {\n` +
    `      const response = input.responses[index];\n` +
    `      if (response.kind === kind && sameArgs(response.args, args)) return response.value;\n` +
    `    }\n` +
    `    if (!missing) missing = { kind, args };\n` +
    `    throw sentinel;\n` +
    `  };\n` +
    `  const hasPermission = (permission) => {\n` +
    `    for (let index = 0; index < input.permissions.length; index += 1) {\n` +
    `      if (input.permissions[index] === permission) return true;\n` +
    `    }\n` +
    `    return false;\n` +
    `  };\n` +
    `  const assertReadable = (operation) => {\n` +
    `    if (!hasPermission("patch:asar") && !hasPermission("read:asar")) {\n` +
    `      throw new Error(input.featureId + ": " + operation + " requires runtime permission read:asar or patch:asar.");\n` +
    `    }\n` +
    `  };\n` +
    `  const assertWritable = (operation) => {\n` +
    `    if (input.phase === "packed") throw new Error(input.featureId + ": packed verification is read-only.");\n` +
    `    if (!hasPermission("patch:asar")) {\n` +
    `      throw new Error(input.featureId + ": " + operation + " requires runtime permission patch:asar.");\n` +
    `    }\n` +
    `  };\n` +
    `  const normalizePath = (value) => String(value).replace(/\\\\/g, "/");\n` +
    `  const readText = (relativePath) => {\n` +
    `    assertReadable("readText");\n` +
    `    const normalized = normalizePath(relativePath);\n` +
    `    if (normalized in overlays) return overlays[normalized];\n` +
    `    return String(request("readText", [normalized]));\n` +
    `  };\n` +
    `  const context = Object.freeze({\n` +
    `    featureId: input.featureId,\n` +
    `    phase: input.phase,\n` +
    `    sourceVersion: input.sourceVersion,\n` +
    `    options: Object.freeze(input.options),\n` +
    `    readText,\n` +
    `    writeText(relativePath, content) {\n` +
    `      assertWritable("writeText");\n` +
    `      const normalized = normalizePath(relativePath);\n` +
    `      const text = String(content);\n` +
    `      overlays[normalized] = text;\n` +
    `      appendOperation({ type: "writeText", args: [normalized, text] });\n` +
    `    },\n` +
    `    replaceExactly(relativePath, from, to) {\n` +
    `      assertWritable("replaceExactly");\n` +
    `      const normalized = normalizePath(relativePath);\n` +
    `      const before = String(from);\n` +
    `      const after = String(to);\n` +
    `      const text = readText(normalized);\n` +
    `      const count = text.split(before).length - 1;\n` +
    `      if (count !== 1) throw new Error(input.featureId + ": expected one replacement target in " + normalized + ", found " + count + ".");\n` +
    `      overlays[normalized] = text.replace(before, after);\n` +
    `      appendOperation({ type: "replaceExactly", args: [normalized, before, after] });\n` +
    `      return count;\n` +
    `    },\n` +
    `    getAnchorMatches(anchorId) {\n` +
    `      assertReadable("getAnchorMatches");\n` +
    `      const detail = request("anchor", [String(anchorId)]);\n` +
    `      return Object.freeze(detail.matches.map((match) => Object.freeze({ path: match.path, count: match.count })));\n` +
    `    },\n` +
    `    replaceAnchor(anchorId, replacement) {\n` +
    `      assertWritable("replaceAnchor");\n` +
    `      const id = String(anchorId);\n` +
    `      const after = String(replacement);\n` +
    `      const detail = request("anchor", [id]);\n` +
    `      for (let index = 0; index < detail.matches.length; index += 1) {\n` +
    `        const match = detail.matches[index];\n` +
    `        const text = readText(match.path);\n` +
    `        overlays[normalizePath(match.path)] = text.split(detail.includes).join(after);\n` +
    `      }\n` +
    `      appendOperation({ type: "replaceAnchor", args: [id, after] });\n` +
    `      return detail.count;\n` +
    `    },\n` +
    `    findFiles(query = {}) {\n` +
    `      assertReadable("findFiles");\n` +
    `      const args = [normalizePath(query.under || ""), String(query.includes || ""), String(query.suffix || "")];\n` +
    `      const files = request("findFiles", args);\n` +
    `      return Object.freeze(files.slice());\n` +
    `    },\n` +
    `    copyPayload(sourceRelativePath, destinationRelativePath) {\n` +
    `      assertWritable("copyPayload");\n` +
    `      const source = normalizePath(sourceRelativePath);\n` +
    `      const destination = normalizePath(destinationRelativePath);\n` +
    `      overlays[destination] = String(request("payloadText", [source]));\n` +
    `      appendOperation({ type: "copyPayload", args: [source, destination] });\n` +
    `    },\n` +
    `    runCoreOperation() { throw new Error(input.featureId + ": only core modules can invoke core patch operations."); },\n` +
    `    verifyCoreFeature() { throw new Error(input.featureId + ": only core modules can verify core features."); },\n` +
    `    runCoreStep() { throw new Error(input.featureId + ": only core modules can invoke core patch steps."); },\n` +
    `    verifyCoreStep() { throw new Error(input.featureId + ": only core modules can verify core patch steps."); },\n` +
    `  });\n` +
    `  try {\n` +
    `    const api = globalThis.module && globalThis.module.exports;\n` +
    `    const result = input.methodName === "apply" ? api.apply(context) : api.verify(context, input.phase);\n` +
    `    if (result && typeof result.then === "function") throw new Error(input.featureId + " " + input.methodName + " must be synchronous.");\n` +
    `    if (missing) return __cpsJsonStringify({ status: "request", request: missing });\n` +
    `    return __cpsJsonStringify({ status: "ok", result: result === undefined ? null : result, operations });\n` +
    `  } catch (error) {\n` +
    `    if (missing) return __cpsJsonStringify({ status: "request", request: missing });\n` +
    `    const name = error && error.name ? String(error.name) : "Error";\n` +
    `    const message = error && error.message ? String(error.message) : String(error);\n` +
    `    return __cpsJsonStringify({ status: "error", name, message });\n` +
    `  }\n` +
    `})()`;
}

function resolveIsolatedAdapterRequest(record, hostContext, request) {
  if (!request || !Array.isArray(request.args) || typeof request.kind !== "string") {
    throw new Error(`${record.id}: adapter emitted an invalid host request.`);
  }
  if (request.kind === "readText" && request.args.length === 1) return hostContext.readText(request.args[0]);
  if (request.kind === "findFiles" && request.args.length === 3) {
    return hostContext.findFiles({ under: request.args[0], includes: request.args[1], suffix: request.args[2] });
  }
  if (request.kind === "anchor" && request.args.length === 1) {
    const anchorId = String(request.args[0]);
    const anchor = record.manifest.structuralAnchors.find((candidate) => candidate.id === anchorId);
    if (!anchor) throw new Error(`${record.id}: unknown structural anchor ${anchorId}.`);
    const matches = hostContext.getAnchorMatches(anchorId);
    return { includes: anchor.includes, count: matches.reduce((sum, match) => sum + match.count, 0), matches };
  }
  if (request.kind === "payloadText" && request.args.length === 1) {
    assertRuntimePermission(record, "copyPayload", ["patch:asar"]);
    const payloadRoot = path.join(record.rootPath, "payload");
    const sourcePath = resolveWithinExistingRoot(payloadRoot, request.args[0], "payload path");
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      throw new Error(`${record.id}: payload file is missing: ${request.args[0]}`);
    }
    return fs.readFileSync(sourcePath, "utf8");
  }
  throw new Error(`${record.id}: adapter emitted unsupported host request ${request.kind}.`);
}

function applyIsolatedAdapterOperations(record, hostContext, operations) {
  if (!Array.isArray(operations)) throw new Error(`${record.id}: adapter operations must be an array.`);
  for (const operation of operations) {
    if (!operation || typeof operation.type !== "string" || !Array.isArray(operation.args)) {
      throw new Error(`${record.id}: adapter emitted an invalid mutation operation.`);
    }
    switch (operation.type) {
      case "writeText":
        if (operation.args.length !== 2) break;
        hostContext.writeText(operation.args[0], operation.args[1]);
        continue;
      case "replaceExactly":
        if (operation.args.length !== 3) break;
        hostContext.replaceExactly(operation.args[0], operation.args[1], operation.args[2]);
        continue;
      case "replaceAnchor":
        if (operation.args.length !== 2) break;
        hostContext.replaceAnchor(operation.args[0], operation.args[1]);
        continue;
      case "copyPayload":
        if (operation.args.length !== 2) break;
        hostContext.copyPayload(operation.args[0], operation.args[1]);
        continue;
      default:
        throw new Error(`${record.id}: adapter emitted unsupported mutation operation ${operation.type}.`);
    }
    throw new Error(`${record.id}: adapter emitted invalid arguments for ${operation.type}.`);
  }
}

function invokeIsolatedAdapter(record, entry, methodName, hostContext, phase, options) {
  const responses = [];
  for (let requestCount = 0; requestCount <= MAX_ADAPTER_BRIDGE_REQUESTS; requestCount += 1) {
    const realm = createIsolatedAdapterRealm(record, entry.adapter, entry.source);
    const outputText = new vm.Script(
      isolatedInvocationScript(record, methodName, phase, options, responses),
      { filename: `${entry.adapter.adapterPath}:${methodName}` }
    ).runInContext(realm, { timeout: ADAPTER_VM_TIMEOUT_MS });
    if (typeof outputText !== "string") throw new Error(`${record.id}: isolated adapter returned an invalid response.`);
    const output = JSON.parse(outputText);
    if (output.status === "request") {
      if (requestCount === MAX_ADAPTER_BRIDGE_REQUESTS) {
        throw new Error(`${record.id}: adapter exceeded ${MAX_ADAPTER_BRIDGE_REQUESTS} host data requests.`);
      }
      const value = resolveIsolatedAdapterRequest(record, hostContext, output.request);
      responses.push({ kind: output.request.kind, args: output.request.args, value });
      continue;
    }
    if (output.status === "error") {
      throw new Error(`${record.id}: ${methodName} failed in isolated adapter: ${output.name}: ${output.message}`);
    }
    if (output.status !== "ok") throw new Error(`${record.id}: isolated adapter returned unknown status ${output.status}.`);
    applyIsolatedAdapterOperations(record, hostContext, output.operations);
    return output.result;
  }
  throw new Error(`${record.id}: adapter host request loop did not terminate.`);
}

function resolveWithinExistingRoot(rootPath, relativePath, label) {
  const resolved = resolveInside(rootPath, relativePath, label);
  let existingPath = resolved;
  while (!fs.existsSync(existingPath)) {
    const parentPath = path.dirname(existingPath);
    if (parentPath === existingPath) break;
    existingPath = parentPath;
  }
  if (fs.existsSync(rootPath) && fs.existsSync(existingPath)) {
    const rootRealPath = fs.realpathSync(rootPath);
    const existingRealPath = fs.realpathSync(existingPath);
    if (!isInside(rootRealPath, existingRealPath)) throw new Error(`${label} escapes its allowed root through a symbolic link.`);
  }
  return resolved;
}

function globToRegExp(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      const followedBySlash = pattern[index + 2] === "/";
      source += followedBySlash ? "(?:.*/)?" : ".*";
      index += followedBySlash ? 2 : 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

function markerCandidateFiles(extractDir, descriptor) {
  if (descriptor.path) {
    if (!/[?*]/.test(descriptor.path)) {
      const filePath = resolveWithinExistingRoot(extractDir, descriptor.path, "marker path");
      return fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? [filePath] : [];
    }
    const pattern = globToRegExp(descriptor.path);
    const wildcardIndex = descriptor.path.search(/[?*]/);
    const prefix = descriptor.path.slice(0, wildcardIndex);
    const separatorIndex = prefix.lastIndexOf("/");
    const relativeSearchRoot = separatorIndex >= 0 ? prefix.slice(0, separatorIndex) : ".";
    const searchRoot = relativeSearchRoot === "."
      ? path.resolve(extractDir)
      : resolveWithinExistingRoot(extractDir, relativeSearchRoot, "marker glob root");
    if (!fs.existsSync(searchRoot) || !fs.statSync(searchRoot).isDirectory()) return [];
    return walkFiles(searchRoot, { excludeDevelopmentDirectories: false })
      .filter((filePath) => pattern.test(path.relative(extractDir, filePath).replace(/\\/g, "/")));
  }
  const under = resolveWithinExistingRoot(extractDir, descriptor.files.under, "anchor files.under");
  if (!fs.existsSync(under) || !fs.statSync(under).isDirectory()) return [];
  return walkFiles(under, { excludeDevelopmentDirectories: false }).filter((filePath) => {
    const relativePath = path.relative(extractDir, filePath).replace(/\\/g, "/");
    return (!descriptor.files.pathIncludes || relativePath.includes(descriptor.files.pathIncludes))
      && (!descriptor.files.suffix || relativePath.endsWith(descriptor.files.suffix));
  });
}

function countOccurrences(text, marker) {
  return text.split(marker).length - 1;
}

function evaluateMarker(record, extractDir, descriptor, label) {
  const matches = [];
  let count = 0;
  for (const filePath of markerCandidateFiles(extractDir, descriptor)) {
    const fileCount = countOccurrences(fs.readFileSync(filePath, "utf8"), descriptor.includes);
    if (fileCount === 0) continue;
    count += fileCount;
    matches.push({ path: path.relative(extractDir, filePath).replace(/\\/g, "/"), count: fileCount });
  }
  const { minimum, maximum } = descriptor.cardinality;
  if (count < minimum || (maximum != null && count > maximum)) {
    const expected = maximum == null ? `at least ${minimum}` : minimum === maximum ? String(minimum) : `${minimum}-${maximum}`;
    throw new Error(`${record.id}: ${label} expected ${expected} match(es), found ${count}.`);
  }
  return { count, matches };
}

function runStructuralAnchorChecks(record, extractDir) {
  return record.manifest.structuralAnchors.map((anchor) => ({
    id: anchor.id,
    ...evaluateMarker(record, extractDir, anchor, `structural anchor ${anchor.id}`),
  }));
}

function assertRuntimePermission(record, operation, allowedPermissions) {
  const permissions = record.manifest.runtime?.permissions || [];
  if (allowedPermissions.some((permission) => permissions.includes(permission))) return;
  throw new Error(`${record.id}: ${operation} requires runtime permission ${allowedPermissions.join(" or ")}.`);
}

function extractRelativePath(extractDir, filePath) {
  return path.relative(extractDir, filePath).replace(/\\/g, "/");
}

function canonicalPathThroughExistingAncestor(filePath) {
  const resolved = path.resolve(filePath);
  let existingPath = resolved;
  while (!fs.existsSync(existingPath)) {
    const parentPath = path.dirname(existingPath);
    if (parentPath === existingPath) return resolved;
    existingPath = parentPath;
  }
  return path.resolve(fs.realpathSync(existingPath), path.relative(existingPath, resolved));
}

function assertAdapterMutablePath(record, extractDir, filePath, operation) {
  const relativePath = extractRelativePath(extractDir, filePath);
  const normalized = relativePath.toLowerCase();
  const canonicalFilePath = canonicalPathThroughExistingAncestor(filePath);
  const canonicalReceiptDirectory = canonicalPathThroughExistingAncestor(path.join(extractDir, FEATURE_RECEIPT_DIRECTORY));
  if (
    normalized === FEATURE_RECEIPT_DIRECTORY
    || normalized.startsWith(`${FEATURE_RECEIPT_DIRECTORY}/`)
    || isInside(canonicalReceiptDirectory, canonicalFilePath)
  ) {
    throw new Error(`${record.id}: ${operation} cannot modify host-managed feature receipts.`);
  }
  return relativePath;
}

function claimChangedPath(record, extractDir, filePath, changedPathOwners, changedPaths) {
  const relativePath = extractRelativePath(extractDir, filePath);
  const canonicalPath = canonicalPathThroughExistingAncestor(filePath);
  const ownershipKey = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
  const currentOwner = changedPathOwners.get(ownershipKey);
  if (currentOwner && currentOwner !== record.id) {
    throw new Error(`${record.id}: changed path ${relativePath} is already owned by ${currentOwner}.`);
  }
  changedPathOwners.set(ownershipKey, record.id);
  changedPaths.add(relativePath);
  return relativePath;
}

function createPatchContext(record, extractDir, phase, options = {}) {
  const readOnly = phase === "packed";
  const resolveExtract = (relativePath, label) => resolveWithinExistingRoot(extractDir, relativePath, label);
  const payloadRoot = path.join(record.rootPath, "payload");
  const resolvePayload = (relativePath, label) => resolveWithinExistingRoot(payloadRoot, relativePath, label);
  const runCoreOperation = typeof options.runCoreOperation === "function" ? options.runCoreOperation : null;
  const verifyCoreFeature = typeof options.verifyCoreFeature === "function" ? options.verifyCoreFeature : null;
  const changedPathOwners = options.changedPathOwners instanceof Map ? options.changedPathOwners : new Map();
  const changedPaths = options.changedPaths instanceof Set ? options.changedPaths : new Set();
  const assertReadable = (operation) => assertRuntimePermission(record, operation, ["read:asar", "patch:asar"]);
  const assertWritable = (operation) => {
    if (readOnly) throw new Error(`${record.id}: packed verification is read-only.`);
    assertRuntimePermission(record, operation, ["patch:asar"]);
  };
  return Object.freeze({
    featureId: record.id,
    phase,
    sourceVersion: String(options.sourceVersion || ""),
    options: Object.freeze({ ...(options.moduleOptions || {}) }),
    readText(relativePath) {
      assertReadable("readText");
      return fs.readFileSync(resolveExtract(relativePath, "readText path"), "utf8");
    },
    writeText(relativePath, content) {
      assertWritable("writeText");
      const filePath = resolveExtract(relativePath, "writeText path");
      assertAdapterMutablePath(record, extractDir, filePath, "writeText");
      claimChangedPath(record, extractDir, filePath, changedPathOwners, changedPaths);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, String(content), "utf8");
    },
    replaceExactly(relativePath, from, to) {
      assertWritable("replaceExactly");
      const filePath = resolveExtract(relativePath, "replaceExactly path");
      assertAdapterMutablePath(record, extractDir, filePath, "replaceExactly");
      const text = fs.readFileSync(filePath, "utf8");
      const count = text.split(String(from)).length - 1;
      if (count !== 1) throw new Error(`${record.id}: expected one replacement target in ${relativePath}, found ${count}.`);
      claimChangedPath(record, extractDir, filePath, changedPathOwners, changedPaths);
      fs.writeFileSync(filePath, text.replace(String(from), String(to)), "utf8");
      return count;
    },
    getAnchorMatches(anchorId) {
      assertReadable("getAnchorMatches");
      const anchor = record.manifest.structuralAnchors.find((candidate) => candidate.id === anchorId);
      if (!anchor) throw new Error(`${record.id}: unknown structural anchor ${anchorId}.`);
      const result = evaluateMarker(record, extractDir, anchor, `structural anchor ${anchor.id}`);
      return Object.freeze(result.matches.map((match) => Object.freeze({ ...match })));
    },
    replaceAnchor(anchorId, replacement) {
      assertWritable("replaceAnchor");
      const anchor = record.manifest.structuralAnchors.find((candidate) => candidate.id === anchorId);
      if (!anchor) throw new Error(`${record.id}: unknown structural anchor ${anchorId}.`);
      const result = evaluateMarker(record, extractDir, anchor, `structural anchor ${anchor.id}`);
      for (const match of result.matches) {
        const filePath = resolveExtract(match.path, "replaceAnchor path");
        assertAdapterMutablePath(record, extractDir, filePath, "replaceAnchor");
        claimChangedPath(record, extractDir, filePath, changedPathOwners, changedPaths);
        const text = fs.readFileSync(filePath, "utf8");
        fs.writeFileSync(filePath, text.split(anchor.includes).join(String(replacement)), "utf8");
      }
      return result.count;
    },
    findFiles(query = {}) {
      assertReadable("findFiles");
      const under = query.under ? resolveExtract(query.under, "findFiles under") : path.resolve(extractDir);
      const includes = String(query.includes || "");
      const suffix = String(query.suffix || "");
      if (!fs.existsSync(under) || !fs.statSync(under).isDirectory()) return [];
      return walkFiles(under, { excludeDevelopmentDirectories: false })
        .map((filePath) => path.relative(extractDir, filePath).replace(/\\/g, "/"))
        .filter((relativePath) => (!includes || relativePath.includes(includes)) && (!suffix || relativePath.endsWith(suffix)));
    },
    copyPayload(sourceRelativePath, destinationRelativePath) {
      assertWritable("copyPayload");
      const sourcePath = resolvePayload(sourceRelativePath, "payload path");
      if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
        throw new Error(`${record.id}: payload file is missing: ${sourceRelativePath}`);
      }
      const destinationPath = resolveExtract(destinationRelativePath, "payload destination");
      assertAdapterMutablePath(record, extractDir, destinationPath, "copyPayload");
      claimChangedPath(record, extractDir, destinationPath, changedPathOwners, changedPaths);
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath);
    },
    runCoreOperation(operationId) {
      if (readOnly) throw new Error(`${record.id}: core patch operations cannot run during packed verification.`);
      if (record.kind !== "core") throw new Error(`${record.id}: only core modules can invoke core patch operations.`);
      const normalizedOperationId = String(operationId || "").trim();
      if (!normalizedOperationId) throw new Error(`${record.id}: core patch operation id is required.`);
      if (!runCoreOperation) throw new Error(`${record.id}: no core patch-operation runner was provided by the builder.`);
      return runCoreOperation(record.id, normalizedOperationId, Object.freeze({
        phase,
        sourceVersion: String(options.sourceVersion || ""),
      }));
    },
    verifyCoreFeature(requestedPhase = phase) {
      if (record.kind !== "core") throw new Error(`${record.id}: only core modules can verify core features.`);
      const normalizedPhase = String(requestedPhase || phase);
      if (!verifyCoreFeature) {
        return Object.freeze({ ok: true, deferred: true, featureId: record.id, phase: normalizedPhase });
      }
      return verifyCoreFeature(record.id, Object.freeze({
        phase: normalizedPhase,
        sourceVersion: String(options.sourceVersion || ""),
      }));
    },
    runCoreStep() {
      throw new Error(`${record.id}: runCoreStep is no longer supported; use runCoreOperation.`);
    },
    verifyCoreStep() {
      throw new Error(`${record.id}: verifyCoreStep is no longer supported; use verifyCoreFeature.`);
    },
  });
}

function runStaticVerification(record, extractDir) {
  return record.manifest.verification.map((check, index) => ({
    path: check.path,
    matched: true,
    ...evaluateMarker(record, extractDir, check, `verification marker ${check.id || index}`),
  }));
}

function featureReceiptRelativePath(record) {
  return `${FEATURE_RECEIPT_DIRECTORY}/${record.id}.json`;
}

function normalizeReceiptAnchorEvidence(anchors) {
  return anchors.map((anchor) => ({
    id: anchor.id,
    count: anchor.count,
    matches: anchor.matches
      .map((match) => ({ path: match.path, count: match.count }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  }));
}

function createFeatureReceipt(record, adapter, anchors) {
  return {
    schemaVersion: FEATURE_RECEIPT_SCHEMA_VERSION,
    id: record.id,
    version: record.manifest.version,
    adapter: adapter.relativePath,
    sourceHash: record.sourceHash,
    anchors: normalizeReceiptAnchorEvidence(anchors),
  };
}

function canonicalReceiptText(receipt) {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

function writeFeatureReceipt(record, extractDir, adapter, anchors, changedPathOwners, changedPaths) {
  const relativePath = featureReceiptRelativePath(record);
  const filePath = resolveWithinExistingRoot(extractDir, relativePath, "feature receipt path");
  if (fs.existsSync(filePath)) throw new Error(`${record.id}: feature receipt already exists before apply: ${relativePath}.`);
  const receipt = createFeatureReceipt(record, adapter, anchors);
  claimChangedPath(record, extractDir, filePath, changedPathOwners, changedPaths);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, canonicalReceiptText(receipt), { encoding: "utf8", flag: "wx" });
  return { filePath, path: relativePath, receipt };
}

function receiptEvidencePathMatches(anchor, relativePath) {
  if (anchor.path) return globToRegExp(anchor.path).test(relativePath);
  const under = anchor.files.under === "." ? "" : `${anchor.files.under.replace(/\/$/, "")}/`;
  return (!under || relativePath.startsWith(under))
    && (!anchor.files.pathIncludes || relativePath.includes(anchor.files.pathIncludes))
    && (!anchor.files.suffix || relativePath.endsWith(anchor.files.suffix));
}

function validateReceiptAnchorEvidence(record, anchors) {
  if (!Array.isArray(anchors) || anchors.length !== record.manifest.structuralAnchors.length) {
    throw new Error(`${record.id}: feature receipt anchor evidence does not match the current manifest.`);
  }
  return record.manifest.structuralAnchors.map((anchor, index) => {
    const evidence = anchors[index];
    if (!evidence || evidence.id !== anchor.id || !Number.isInteger(evidence.count)) {
      throw new Error(`${record.id}: feature receipt has invalid evidence for structural anchor ${anchor.id}.`);
    }
    const { minimum, maximum } = anchor.cardinality;
    if (evidence.count < minimum || (maximum != null && evidence.count > maximum)) {
      throw new Error(`${record.id}: feature receipt evidence for ${anchor.id} violates current cardinality.`);
    }
    if (!Array.isArray(evidence.matches) || evidence.matches.length === 0) {
      throw new Error(`${record.id}: feature receipt evidence for ${anchor.id} must list matched paths.`);
    }
    const seenPaths = new Set();
    let count = 0;
    const matches = evidence.matches.map((match) => {
      if (!match || typeof match.path !== "string" || !Number.isInteger(match.count) || match.count < 1) {
        throw new Error(`${record.id}: feature receipt evidence for ${anchor.id} contains an invalid match.`);
      }
      const relativePath = validateRelativePattern(match.path, `${record.id}: feature receipt anchor path`);
      if (!receiptEvidencePathMatches(anchor, relativePath)) {
        throw new Error(`${record.id}: feature receipt path ${relativePath} does not match structural anchor ${anchor.id}.`);
      }
      if (seenPaths.has(relativePath)) throw new Error(`${record.id}: feature receipt repeats anchor path ${relativePath}.`);
      seenPaths.add(relativePath);
      count += match.count;
      return { path: relativePath, count: match.count };
    });
    if (count !== evidence.count) {
      throw new Error(`${record.id}: feature receipt evidence count for ${anchor.id} is inconsistent.`);
    }
    return { id: anchor.id, count, matches };
  });
}

function validateFeatureReceipt(record, extractDir, adapter) {
  const relativePath = featureReceiptRelativePath(record);
  const filePath = resolveWithinExistingRoot(extractDir, relativePath, "feature receipt path");
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${record.id}: packed verification requires feature receipt ${relativePath}.`);
  }
  const text = fs.readFileSync(filePath, "utf8");
  let receipt;
  try {
    receipt = JSON.parse(stripBom(text));
  } catch (error) {
    throw new Error(`${record.id}: feature receipt is not valid JSON: ${error.message}`);
  }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error(`${record.id}: feature receipt must be an object.`);
  }
  const anchors = validateReceiptAnchorEvidence(record, receipt.anchors);
  const expected = createFeatureReceipt(record, adapter, anchors);
  if (text !== canonicalReceiptText(expected)) {
    throw new Error(`${record.id}: feature receipt does not exactly match the current catalog record.`);
  }
  return { path: relativePath, receipt: expected };
}

function assertSynchronous(value, label) {
  if (value && typeof value.then === "function") throw new Error(`${label} must be synchronous.`);
  return value;
}

function assertAdapterMethod(record, entry, methodName) {
  const type = entry.trusted ? typeof entry.api?.[methodName] : entry.metadata[`${methodName}Type`];
  if (type !== "function") {
    const signature = methodName === "apply" ? "apply(context)" : "verify(context, phase)";
    throw new Error(`${record.id}: module must export ${signature}.`);
  }
}

function invokeFeatureAdapter(record, entry, methodName, context, phase, options) {
  if (!entry.trusted) return invokeIsolatedAdapter(record, entry, methodName, context, phase, options);
  const value = methodName === "apply" ? entry.api.apply(context) : entry.api.verify(context, phase);
  return assertSynchronous(value, `${record.id} ${methodName}`);
}

function assertVerificationSucceeded(value, label) {
  const result = assertSynchronous(value, label);
  if (result === false || (result && typeof result === "object" && result.ok === false)) {
    throw new Error(`${label} reported failure.`);
  }
  return result;
}

function applyFeatureModules(resolved, extractDir, options = {}) {
  const results = [];
  const sourceVersion = String(options.sourceVersion || resolved.sourceVersion || "");
  const changedPathOwners = new Map();
  for (const record of resolved.ordered) {
    if (record.manifest.implementation !== "module") continue;
    const anchors = runStructuralAnchorChecks(record, extractDir);
    const entry = loadFeatureEntry(record, sourceVersion);
    assertAdapterMethod(record, entry, "apply");
    assertAdapterMethod(record, entry, "verify");
    const changedPaths = new Set();
    const contextOptions = { ...options, sourceVersion, changedPathOwners, changedPaths };
    const context = createPatchContext(record, extractDir, "unpacked", contextOptions);
    const result = invokeFeatureAdapter(record, entry, "apply", context, "unpacked", contextOptions);
    const verifyResult = invokeFeatureAdapter(record, entry, "verify", context, "unpacked", contextOptions);
    assertVerificationSucceeded(verifyResult, `${record.id} verify (unpacked)`);
    const receipt = writeFeatureReceipt(record, extractDir, entry.adapter, anchors, changedPathOwners, changedPaths);
    let verification;
    try {
      verification = runStaticVerification(record, extractDir);
    } catch (error) {
      if (fs.existsSync(receipt.filePath)) fs.unlinkSync(receipt.filePath);
      throw error;
    }
    results.push({
      id: record.id,
      version: record.manifest.version,
      adapter: entry.adapter.relativePath,
      sourceHash: record.sourceHash,
      anchors,
      result: result ?? null,
      changedPaths: [...changedPaths].sort(),
      receipt: { path: receipt.path, ...receipt.receipt },
      verification,
    });
  }
  return results;
}

function verifyFeatureModules(resolved, extractDir, options = {}) {
  const results = [];
  const sourceVersion = String(options.sourceVersion || resolved.sourceVersion || "");
  for (const record of resolved.ordered) {
    if (record.manifest.implementation !== "module") continue;
    const adapter = selectFeatureAdapter(record, sourceVersion);
    const receipt = validateFeatureReceipt(record, extractDir, adapter);
    const entry = loadFeatureEntry(record, sourceVersion, adapter);
    assertAdapterMethod(record, entry, "verify");
    const context = createPatchContext(record, extractDir, "packed", { ...options, sourceVersion });
    const value = invokeFeatureAdapter(record, entry, "verify", context, "packed", { ...options, sourceVersion });
    const result = assertVerificationSucceeded(value, `${record.id} verify (packed)`);
    results.push({
      id: record.id,
      adapter: adapter.relativePath,
      result: result ?? null,
      receipt: { path: receipt.path, ...receipt.receipt },
      verification: runStaticVerification(record, extractDir),
    });
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

function scaffoldFeature({ repoRoot, id, kind = "local", targetRoot = null, codexVersion = "0.0.0" }) {
  if (!FEATURE_ID_PATTERN.test(String(id || ""))) throw new Error("--id must be a namespaced lowercase identifier.");
  if (!CODEX_EXACT_VERSION_PATTERN.test(String(codexVersion || ""))) throw new Error("--codex-version must be an exact numeric Codex version.");
  if (!FEATURE_KINDS.has(kind) || kind === "core") throw new Error("Scaffolding supports local or contribution modules.");
  const root = targetRoot
    ? path.resolve(expandEnvironmentPath(targetRoot))
    : kind === "local"
      ? path.resolve(expandEnvironmentPath("%USERPROFILE%\\.codex-patch-studio-current\\features"))
      : path.join(repoRoot, "features", "community");
  const featureRoot = resolveInside(root, id.replace(/\./g, "-"), "feature directory");
  if (fs.existsSync(featureRoot)) throw new Error(`Feature directory already exists: ${featureRoot}`);
  fs.mkdirSync(featureRoot, { recursive: true });
  fs.mkdirSync(path.join(featureRoot, "adapters"));
  fs.mkdirSync(path.join(featureRoot, "payload"));
  fs.mkdirSync(path.join(featureRoot, "tests"));
  const manifest = {
    schemaVersion: 1,
    id,
    name: id.split(/[.-]/).map((part) => part[0].toUpperCase() + part.slice(1)).join(" "),
    description: "Describe this Codex patch feature.",
    version: "0.1.0",
    kind,
    implementation: "module",
    enabledByDefault: false,
    dependencies: [],
    conflicts: [],
    supports: { codexVersions: [codexVersion] },
    structuralAnchors: [
      {
        id: "replace-before-enabling",
        path: "REPLACE-ME/upstream-file.js",
        includes: "REPLACE_WITH_EXACT_UPSTREAM_ANCHOR",
        cardinality: { exact: 1 },
      },
    ],
    runtime: { permissions: ["patch:asar"], localPorts: [] },
    native: { settings: [], sidebar: [] },
    verification: [
      {
        id: "module-receipt",
        path: `${FEATURE_RECEIPT_DIRECTORY}/${id}.json`,
        includes: `\"id\": \"${id}\"`,
        cardinality: { exact: 1 },
      },
    ],
    distribution: { upstreamArtifacts: "forbidden" },
  };
  fs.writeFileSync(path.join(featureRoot, "feature.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(featureRoot, adapterRelativePath(codexVersion)),
    `module.exports = {\n  apiVersion: 1,\n  codexVersion: ${JSON.stringify(codexVersion)},\n  apply(context) {\n    // Use only context helpers and keep all copied files under payload/.\n    return { changed: false, featureId: context.featureId };\n  },\n  verify(context, phase) {\n    return { ok: true, phase, sourceVersion: context.sourceVersion };\n  },\n};\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(featureRoot, "payload", ".gitkeep"), "", "utf8");
  fs.writeFileSync(
    path.join(featureRoot, "tests", "adapter.test.cjs"),
    `const assert = require("node:assert/strict");\nconst test = require("node:test");\n\nconst adapter = require("../adapters/${codexVersion}.cjs");\n\ntest("${id} starter adapter exports the synchronous feature API", () => {\n  const context = Object.freeze({ featureId: ${JSON.stringify(id)}, sourceVersion: ${JSON.stringify(codexVersion)} });\n  assert.equal(adapter.apiVersion, 1);\n  assert.deepEqual(adapter.apply(context), { changed: false, featureId: ${JSON.stringify(id)} });\n  assert.deepEqual(adapter.verify(context, "packed"), { ok: true, phase: "packed", sourceVersion: ${JSON.stringify(codexVersion)} });\n});\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(featureRoot, "README.md"),
    `# ${manifest.name}\n\n${manifest.description}\n\n## Compatibility\n\nThis scaffold is fail-closed on Codex ${codexVersion}. Rename the adapter and update \`supports.codexVersions\` before targeting another installed build.\n\n## Development\n\n- Declare every structural marker and its cardinality in \`feature.json\`.\n- Keep runtime permissions, loopback ports, and native settings/sidebar additions explicit.\n- Put authored files copied into the app under \`payload/\`; never include extracted Codex source or binaries.\n- Add packed verification markers before enabling the module.\n\nRun \`node --test tests/adapter.test.cjs\` from this directory.\n`,
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
    const featureRoot = scaffoldFeature({
      repoRoot,
      id: value("--id"),
      kind: value("--kind") || "local",
      targetRoot: value("--root"),
      codexVersion: value("--codex-version") || "0.0.0",
    });
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
  adapterRelativePath,
  matchesCodexVersionSelector,
  applyFeatureModules,
  catalogFingerprint,
  compareVersion,
  compatibleWith,
  configuredRoots,
  createPatchContext,
  discoverFeatureModules,
  publicFeatureRecord,
  resolveFeatureModules,
  resolveInside,
  runStructuralAnchorChecks,
  scaffoldFeature,
  selectFeatureAdapter,
  validateManifest,
  validateModuleLayout,
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
