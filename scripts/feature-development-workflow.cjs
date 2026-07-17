#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const {
  scaffoldFeature,
  validateManifest,
  validateModuleLayout,
} = require("./feature-registry.cjs");

const METADATA_SCHEMA_VERSION = 2;
const EVIDENCE_SCHEMA_VERSION = 1;
const METADATA_DIRECTORY = ".feature-workflows";
const FEATURE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROTECTED_BRANCHES = new Set(["main", "master"]);
const MILESTONES = [
  { key: "scaffold", cli: "scaffold", label: "scaffold" },
  { key: "firstSuccessfulPatch", cli: "first-successful-patch", label: "first successful patch" },
  { key: "packedVerification", cli: "packed-verification", label: "packed verification" },
  { key: "runtimeUiValidation", cli: "runtime-ui-validation", label: "runtime/UI validation" },
  { key: "docs", cli: "docs", label: "documentation" },
];
const MILESTONE_BY_NAME = new Map(MILESTONES.flatMap((entry) => [[entry.key, entry], [entry.cli, entry]]));
const TERMINAL_MILESTONE_STATES = new Set(["complete", "not-applicable"]);
const FORBIDDEN_EXTENSIONS = new Set([
  ".asar",
  ".exe",
  ".dll",
  ".node",
  ".msi",
  ".msix",
  ".appx",
  ".appxbundle",
  ".cab",
  ".sfx",
  ".7z",
  ".rar",
  ".db",
  ".sqlite",
  ".sqlite3",
]);
const FORBIDDEN_PATH_PARTS = [
  "app.asar",
  "app.asar.extracted",
  "windowsapps",
  "codex-patched-app",
  "codex-portable-packages",
  "electron-user-data",
  "codex-chat-backups",
  "codex-import-backups",
  "build-output",
];
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const SECRET_PATTERNS = [
  /\b(?:sk|csk|sk-ant)-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/,
  /\bAIza[A-Za-z0-9_-]{20,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\b\s*[:=]\s*["']?[A-Za-z0-9_./+-]{20,}["']?/i,
];

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.encoding || "utf8",
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_EDITOR: "true",
      GH_PROMPT_DISABLED: "1",
      ...(options.env || {}),
    },
  });
  if (result.error) {
    fail(`Could not run ${command}: ${result.error.message}`);
  }
  const allowedStatuses = options.allowedStatuses || [0];
  if (!allowedStatuses.includes(result.status)) {
    const detail = String(result.stderr || result.stdout || "").trim();
    fail(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : "."}`);
  }
  return result;
}

function git(cwd, args, options = {}) {
  return run("git", args, { ...options, cwd });
}

function gitText(cwd, args, options = {}) {
  return String(git(cwd, args, options).stdout || "").trim();
}

function normalizeMode(value) {
  if (value === "local") return "local";
  if (value === "contribution" || value === "contrib") return "contribution";
  fail("--mode must be local or contribution.");
}

function validateFeatureId(value, label = "--feature") {
  const feature = String(value || "");
  if (feature.length > 120 || !FEATURE_ID_PATTERN.test(feature)) {
    fail(`${label} must be a namespaced lowercase feature id.`);
  }
  return feature;
}

function validateSlug(value) {
  const slug = String(value || "");
  if (slug.length > 80 || !SLUG_PATTERN.test(slug)) {
    fail("--slug must contain lowercase letters, digits, and single hyphens only.");
  }
  return slug;
}

function defaultSlug(feature) {
  return validateSlug(feature.split(".").at(-1));
}

function validateCodexVersion(value) {
  const version = String(value || "").trim();
  if (version.length > 80 || !/^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    fail("--codex-version must be an exact numeric Codex version.");
  }
  return version;
}

function validateSha256(value, label) {
  const hash = String(value || "").trim();
  if (!SHA256_PATTERN.test(hash)) fail(`${label} must be an exact 64-character SHA-256 hex digest.`);
  return hash.toLowerCase();
}

function createCodexIdentity({ codexVersion, sourceAsarSha256, sourceCliSha256 }) {
  return {
    version: validateCodexVersion(codexVersion),
    sourceAsarSha256: validateSha256(sourceAsarSha256, "--source-asar-sha256"),
    sourceCliSha256: validateSha256(sourceCliSha256, "--source-cli-sha256"),
  };
}

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function hashFile(filePath) {
  return hashBuffer(fs.readFileSync(filePath));
}

function validateAdapter(value) {
  const adapter = String(value || "").trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z._@:/+-]{0,127}$/.test(adapter)) {
    fail(`Invalid adapter identifier: ${value}`);
  }
  return adapter;
}

function uniqueAdapters(values = []) {
  return [...new Set(values.map(validateAdapter))].sort((left, right) => left.localeCompare(right));
}

function validateGitRef(value, label = "ref") {
  const ref = String(value || "").trim();
  const hasForbiddenCharacter = [...ref].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 32 || code === 127 || "~^:?*[\\".includes(character);
  });
  if (
    !ref ||
    ref.length > 1024 ||
    ref.startsWith("-") ||
    hasForbiddenCharacter ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.includes("//") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.endsWith(".lock")
  ) {
    fail(`Invalid ${label}: ${value}`);
  }
  return ref;
}

function branchFor(mode, slug) {
  return `${mode === "local" ? "local" : "contrib"}/${slug}`;
}

function branchParts(branch) {
  const match = /^(local|contrib)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(String(branch || ""));
  if (!match) fail(`Workflow branch must be local/<slug> or contrib/<slug>; found ${branch || "detached HEAD"}.`);
  return { prefix: match[1], slug: match[2] };
}

function normalizePathForComparison(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(parentPath, childPath) {
  const parent = normalizePathForComparison(parentPath);
  const child = normalizePathForComparison(childPath);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function resolveInside(parentPath, relativePath, label) {
  if (!relativePath || path.isAbsolute(relativePath)) fail(`${label} must be a relative path.`);
  const resolved = path.resolve(parentPath, relativePath);
  if (!isInside(parentPath, resolved)) fail(`${label} escapes the workflow worktree.`);
  return resolved;
}

function repoRoot(inputPath = process.cwd()) {
  return path.resolve(gitText(path.resolve(inputPath), ["rev-parse", "--show-toplevel"]));
}

function currentBranch(root) {
  const result = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowedStatuses: [0, 1] });
  if (result.status !== 0) fail("Feature workflows require a named branch, not detached HEAD.");
  return String(result.stdout || "").trim();
}

function assertUnprotectedBranch(branch) {
  if (PROTECTED_BRANCHES.has(branch)) {
    fail(`Refusing to mutate protected branch ${branch}; use a dedicated workflow worktree.`);
  }
}

function assertClean(root, label = "worktree") {
  const status = gitText(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) fail(`The ${label} must be clean before this operation.`);
}

function resolveCommit(root, ref) {
  return gitText(root, ["rev-parse", "--verify", `${validateGitRef(ref)}^{commit}`]);
}

function localBranchExists(root, branch) {
  return git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowedStatuses: [0, 1] }).status === 0;
}

function defaultWorktreePath(root, branch) {
  const { prefix, slug } = branchParts(branch);
  return path.join(path.dirname(root), `${path.basename(root)}-${prefix}-${slug}`);
}

function validateNewWorktreePath(root, requestedPath, branch) {
  const target = path.resolve(requestedPath || defaultWorktreePath(root, branch));
  if (isInside(root, target)) fail("The dedicated worktree must be outside the source worktree.");
  if (fs.existsSync(target)) fail(`Worktree path already exists: ${target}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const realRoot = fs.realpathSync(root);
  const realTarget = path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
  if (isInside(realRoot, realTarget)) fail("The dedicated worktree resolves inside the source worktree.");
  return target;
}

function toPosix(relativePath) {
  return relativePath.replace(/\\/g, "/");
}

function metadataRelativePath(branch) {
  const { prefix, slug } = branchParts(branch);
  return `${METADATA_DIRECTORY}/${prefix}-${slug}.json`;
}

function initialMilestones(now, codexVersion, testedAdapters, note = null) {
  const milestones = {};
  for (const milestone of MILESTONES) {
    milestones[milestone.key] = {
      state: milestone.key === "scaffold" ? "complete" : "pending",
      completedAt: milestone.key === "scaffold" ? now : null,
      codexVersion: milestone.key === "scaffold" ? codexVersion : null,
      testedAdapters: milestone.key === "scaffold" ? [...testedAdapters] : [],
      note: milestone.key === "scaffold" ? note : null,
      evidence: null,
    };
  }
  return milestones;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function validateMetadata(metadata, metadataPath) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) fail(`${metadataPath}: metadata must be an object.`);
  if (metadata.schemaVersion !== METADATA_SCHEMA_VERSION) fail(`${metadataPath}: unsupported schemaVersion.`);
  validateFeatureId(metadata.feature, `${metadataPath}: feature`);
  const mode = normalizeMode(metadata.mode);
  validateCodexVersion(metadata.codexVersion);
  if (!metadata.codexIdentity || typeof metadata.codexIdentity !== "object" || Array.isArray(metadata.codexIdentity)) {
    fail(`${metadataPath}: codex identity is required.`);
  }
  const identity = createCodexIdentity({
    codexVersion: metadata.codexIdentity.version,
    sourceAsarSha256: metadata.codexIdentity.sourceAsarSha256,
    sourceCliSha256: metadata.codexIdentity.sourceCliSha256,
  });
  if (identity.version !== metadata.codexVersion) fail(`${metadataPath}: codex version and identity disagree.`);
  const parts = branchParts(metadata.branch);
  if ((mode === "local" ? "local" : "contrib") !== parts.prefix) fail(`${metadataPath}: mode and branch disagree.`);
  if (!metadata.baseline || typeof metadata.baseline !== "object") fail(`${metadataPath}: baseline is required.`);
  validateGitRef(metadata.baseline.ref, `${metadataPath}: baseline.ref`);
  if (!/^[0-9a-f]{40,64}$/i.test(String(metadata.baseline.commit || ""))) fail(`${metadataPath}: baseline.commit is invalid.`);
  if (metadata.baselineCommit !== metadata.baseline.commit) fail(`${metadataPath}: baselineCommit must equal baseline.commit.`);
  if (!metadata.featureRoot || path.isAbsolute(metadata.featureRoot)) fail(`${metadataPath}: featureRoot must be relative.`);
  uniqueAdapters(metadata.testedAdapters || []);
  if (!metadata.milestones || typeof metadata.milestones !== "object") fail(`${metadataPath}: milestones are required.`);
  let pendingSeen = false;
  for (const milestone of MILESTONES) {
    const state = metadata.milestones[milestone.key]?.state;
    if (!new Set(["pending", "complete", "not-applicable"]).has(state)) {
      fail(`${metadataPath}: invalid ${milestone.key} milestone state.`);
    }
    if (state === "not-applicable" && milestone.key !== "runtimeUiValidation") {
      fail(`${metadataPath}: only runtimeUiValidation may be not-applicable.`);
    }
    const record = metadata.milestones[milestone.key];
    if (state === "pending" && (record.completedAt != null || record.evidence != null)) {
      fail(`${metadataPath}: pending ${milestone.key} cannot contain completion evidence.`);
    }
    if (state !== "pending" && !record.completedAt) fail(`${metadataPath}: ${milestone.key} requires completedAt.`);
    if (state === "not-applicable" && !validateNote(record.note)) {
      fail(`${metadataPath}: not-applicable ${milestone.key} requires a reason.`);
    }
    if (state === "complete" && milestone.key !== "scaffold" && !record.evidence) {
      fail(`${metadataPath}: complete ${milestone.key} requires recorded evidence.`);
    }
    if (state === "complete" && milestone.key !== "scaffold") validateRecordedEvidence(record.evidence, milestone.key, metadataPath);
    if (state === "pending") pendingSeen = true;
    else if (pendingSeen) fail(`${metadataPath}: milestones must be completed in order.`);
  }
  if (metadata.milestones.scaffold.state !== "complete") fail(`${metadataPath}: scaffold must be complete.`);
  return metadata;
}

function validateRecordedEvidence(evidence, milestoneKey, metadataPath) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || evidence.result?.ok !== true) {
    fail(`${metadataPath}: ${milestoneKey} evidence must record a successful structured result.`);
  }
  if (milestoneKey === "firstSuccessfulPatch") {
    if (evidence.kind !== "feature-tests" || !Array.isArray(evidence.files) || !evidence.files.length || evidence.result.exitCode !== 0 || !SHA256_PATTERN.test(evidence.result.outputSha256 || "")) {
      fail(`${metadataPath}: firstSuccessfulPatch evidence must record a successful feature test run.`);
    }
    return;
  }
  if (milestoneKey === "docs") {
    if (evidence.kind !== "module-docs" || evidence.path !== "README.md" || !SHA256_PATTERN.test(evidence.sha256 || "")) {
      fail(`${metadataPath}: docs evidence must record validated README.md SHA-256.`);
    }
    return;
  }
  const expectedKind = milestoneKey === "packedVerification" ? "packed-verification" : "runtime-ui-validation";
  if (evidence.kind !== expectedKind || !SHA256_PATTERN.test(evidence.sha256 || "") || !Array.isArray(evidence.checks) || !evidence.checks.length) {
    fail(`${metadataPath}: ${milestoneKey} evidence must record a structured evidence file and SHA-256.`);
  }
  validateEvidenceRelativePath(evidence.path);
}

function locateMetadata(root, branch) {
  const expectedRelativePath = metadataRelativePath(branch);
  const expectedPath = path.join(root, expectedRelativePath);
  if (fs.existsSync(expectedPath)) {
    return { metadata: validateMetadata(readJson(expectedPath), expectedRelativePath), metadataPath: expectedPath, metadataRelativePath: expectedRelativePath };
  }
  const directory = path.join(root, METADATA_DIRECTORY);
  if (!fs.existsSync(directory)) fail(`No workflow metadata exists for ${branch}.`);
  const matches = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(directory, entry.name);
    const value = validateMetadata(readJson(filePath), toPosix(path.relative(root, filePath)));
    if (value.branch === branch) matches.push({ metadata: value, metadataPath: filePath, metadataRelativePath: toPosix(path.relative(root, filePath)) });
  }
  if (matches.length !== 1) fail(`Expected exactly one workflow metadata record for ${branch}; found ${matches.length}.`);
  return matches[0];
}

function workflowContext(inputPath = process.cwd()) {
  const root = repoRoot(inputPath);
  const branch = currentBranch(root);
  assertUnprotectedBranch(branch);
  const parts = branchParts(branch);
  const located = locateMetadata(root, branch);
  const metadata = located.metadata;
  if (metadata.branch !== branch) fail(`Workflow metadata targets ${metadata.branch}, not ${branch}.`);
  const expectedPrefix = metadata.mode === "local" ? "local" : "contrib";
  if (parts.prefix !== expectedPrefix) fail("Workflow mode does not match the current branch.");
  const baselineCommit = resolveCommit(root, metadata.baseline.commit);
  if (baselineCommit.toLowerCase() !== metadata.baseline.commit.toLowerCase()) fail("Workflow baseline commit is not canonical.");
  if (git(root, ["merge-base", "--is-ancestor", baselineCommit, "HEAD"], { allowedStatuses: [0, 1] }).status !== 0) {
    fail("Workflow baseline is not an ancestor of the current branch.");
  }
  const featureRoot = resolveInside(root, metadata.featureRoot, "featureRoot");
  const manifestPath = path.join(featureRoot, "feature.json");
  if (!fs.existsSync(manifestPath)) fail(`Feature manifest is missing: ${metadata.featureRoot}/feature.json`);
  const manifest = readJson(manifestPath);
  if (manifest.id !== metadata.feature || manifest.kind !== metadata.mode) {
    fail("Feature manifest id/kind does not match workflow metadata.");
  }
  const record = validateModuleLayout(validateManifest(manifest, manifestPath, metadata.mode));
  const context = { root, branch, parts, featureRoot, manifestPath, manifest: record.manifest, ...located };
  assertFeatureSupportsVersion(context, metadata.codexVersion);
  assertRecordedEvidenceFiles(context);
  return context;
}

function assertFeatureSupportsVersion(context, codexVersion) {
  const versions = context.manifest.supports?.codexVersions;
  if (!Array.isArray(versions) || !versions.includes(codexVersion)) {
    fail(`Feature manifest does not declare Codex ${codexVersion} in supports.codexVersions.`);
  }
  const adapterPath = path.join(context.featureRoot, "adapters", `${codexVersion}.cjs`);
  if (!fs.existsSync(adapterPath) || !fs.statSync(adapterPath).isFile()) {
    fail(`Feature adapter is missing for Codex ${codexVersion}: adapters/${codexVersion}.cjs`);
  }
}

function stagedSourcePaths(root) {
  const output = git(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]).stdout || "";
  return output.split("\0").filter(Boolean);
}

function portableContentViolations(relativePath, buffer) {
  const violations = [];
  const normalized = toPosix(relativePath).toLowerCase();
  const extension = path.extname(normalized);
  if (FORBIDDEN_EXTENSIONS.has(extension)) violations.push(`${relativePath}: forbidden binary/data extension ${extension}`);
  if (FORBIDDEN_PATH_PARTS.some((part) => normalized.includes(part))) violations.push(`${relativePath}: generated or private application data path`);
  if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) violations.push(`${relativePath}: Windows executable payload`);
  const image = /\.(?:png|jpe?g|webp)$/i.test(extension);
  if (buffer.length > 5 * 1024 * 1024 && !image) violations.push(`${relativePath}: unexpected source file larger than 5 MiB`);
  if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) return violations;
  const text = buffer.toString("utf8");
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) violations.push(`${relativePath}: credential or private-key pattern`);
  if (/(?:\b[A-Za-z]:[\\/](?:Users|home)[\\/]|\/(?:Users|home)\/)[^\r\n"'` ]+/i.test(text)) {
    violations.push(`${relativePath}: user-specific absolute path`);
  }
  if (
    /\b(?:const|let|var)\s+\w*(?:Before|Original)\w*\s*=\s*[`"'][^\n]{600,}/.test(text) ||
    /\b(?:const|let|var)\s+\w*(?:Before|Original)\w*\s*=\s*[`"'][^\n]{120,}function\s/.test(text) ||
    /(?:webpackBootstrap|sourceMappingURL=data:application\/json|electron\/main\/bootstrap)/i.test(text)
  ) {
    violations.push(`${relativePath}: copied or extracted upstream-source content`);
  }
  return violations;
}

function assertPortableSourceOnly(root, relativePaths = stagedSourcePaths(root), checkStagedWhitespace = true) {
  const violations = [];
  for (const relativePath of relativePaths) {
    const filePath = resolveInside(root, relativePath, "staged path");
    if (!fs.existsSync(filePath)) continue;
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) {
      violations.push(`${relativePath}: staged symlinks, directories, and gitlinks are not allowed`);
      continue;
    }
    const buffer = fs.readFileSync(filePath);
    violations.push(...portableContentViolations(relativePath, buffer));
  }
  if (checkStagedWhitespace) {
    const whitespace = git(root, ["diff", "--cached", "--check"], { allowedStatuses: [0, 1, 2] });
    if (whitespace.status !== 0) violations.push(String(whitespace.stdout || whitespace.stderr || "staged whitespace errors").trim());
  }
  if (violations.length) fail(`Source-only validation failed:\n- ${violations.join("\n- ")}`);
}

function assertRepositorySourceOnly(root) {
  assertPortableSourceOnly(root);
  const guard = path.join(root, "scripts", "check-source-only.cjs");
  if (fs.existsSync(guard)) run(process.execPath, [guard], { cwd: root });
}

function assertPublicationSourceOnly(context) {
  const commits = gitText(context.root, ["rev-list", "--reverse", `${context.metadata.baseline.commit}..HEAD`]).split(/\r?\n/).filter(Boolean);
  const violations = [];
  for (const commit of commits) {
    const output = git(context.root, ["diff-tree", "--root", "--no-commit-id", "-r", "--no-renames", "--diff-filter=AM", "--raw", "-z", commit]).stdout || "";
    const fields = output.split("\0");
    for (let index = 0; index < fields.length - 1; index += 2) {
      const header = fields[index];
      const relativePath = fields[index + 1];
      const match = /^:\d+ \d+ [0-9a-f]{40,64} ([0-9a-f]{40,64}) [AM]$/i.exec(header || "");
      if (!match || !relativePath) continue;
      const blob = git(context.root, ["cat-file", "blob", match[1]], { encoding: "buffer" }).stdout || Buffer.alloc(0);
      for (const violation of portableContentViolations(relativePath, blob)) {
        violations.push(`${commit.slice(0, 12)}:${violation}`);
      }
    }
  }
  if (violations.length) fail(`Publication source-only validation failed:\n- ${violations.join("\n- ")}`);
  const guard = path.join(context.root, "scripts", "check-source-only.cjs");
  if (fs.existsSync(guard)) run(process.execPath, [guard], { cwd: context.root });
}

function stageWorkflowChanges(context) {
  git(context.root, ["add", "--all", "--", "."]);
  if (context.metadata.mode === "local") {
    git(context.root, ["add", "--force", "--all", "--", context.metadata.featureRoot, context.metadataRelativePath]);
  }
}

function commitWorkflowCheckpoint(context, subject, milestoneKey) {
  stageWorkflowChanges(context);
  assertRepositorySourceOnly(context.root);
  const noChanges = git(context.root, ["diff", "--cached", "--quiet"], { allowedStatuses: [0, 1] }).status === 0;
  if (noChanges) fail("There are no source or metadata changes to checkpoint.");
  git(context.root, [
    "-c",
    `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "commit",
    "--no-verify",
    "--no-gpg-sign",
    "-m",
    subject,
    "-m",
    `Codex-Feature-Milestone: ${milestoneKey}`,
  ]);
  return gitText(context.root, ["rev-parse", "HEAD"]);
}

function createMetadata({ feature, mode, codex, branch, baselineRef, baselineCommit, featureRoot, testedAdapters, convertedFrom = null }) {
  const now = new Date().toISOString();
  const conversionNote = convertedFrom ? `Converted from ${convertedFrom.feature} at ${convertedFrom.commit}.` : null;
  return {
    schemaVersion: METADATA_SCHEMA_VERSION,
    feature,
    mode,
    codexVersion: codex.version,
    codexIdentity: codex,
    branch,
    baseline: { ref: baselineRef, commit: baselineCommit },
    baselineCommit,
    featureRoot,
    testedAdapters: [...testedAdapters],
    milestones: initialMilestones(now, codex.version, testedAdapters, conversionNote),
    convertedFrom,
    createdAt: now,
    updatedAt: now,
  };
}

function startWorkflow(options = {}) {
  const sourceRoot = repoRoot(options.repo || process.cwd());
  assertClean(sourceRoot, "source worktree");
  const mode = normalizeMode(options.mode);
  const feature = validateFeatureId(options.feature);
  if (mode === "local" && !feature.startsWith("local.")) fail("Local feature ids must use the local. namespace.");
  if (mode === "contribution" && (feature.startsWith("local.") || feature.startsWith("core."))) {
    fail("Contribution feature ids cannot use the local. or core. namespace.");
  }
  const slug = validateSlug(options.slug || defaultSlug(feature));
  const branch = branchFor(mode, slug);
  if (localBranchExists(sourceRoot, branch)) fail(`Branch already exists: ${branch}`);
  const baselineRef = validateGitRef(options.baseline || "main", "baseline ref");
  const baselineCommit = resolveCommit(sourceRoot, baselineRef);
  const target = validateNewWorktreePath(sourceRoot, options.worktree, branch);
  const codex = createCodexIdentity(options);
  const codexVersion = codex.version;
  const testedAdapters = uniqueAdapters(options.adapters || []);

  git(sourceRoot, ["worktree", "add", "--no-track", "-b", branch, target, baselineCommit]);
  try {
    const kind = mode === "local" ? "local" : "contribution";
    const scaffoldRoot = mode === "local" ? path.join(target, "features", "local") : null;
    const featureRoot = scaffoldFeature({ repoRoot: target, id: feature, kind, targetRoot: scaffoldRoot, codexVersion });
    const relativeFeatureRoot = toPosix(path.relative(target, featureRoot));
    const relativeMetadataPath = metadataRelativePath(branch);
    const metadata = createMetadata({
      feature,
      mode,
      codex,
      branch,
      baselineRef,
      baselineCommit,
      featureRoot: relativeFeatureRoot,
      testedAdapters,
    });
    const metadataPath = path.join(target, relativeMetadataPath);
    writeJsonAtomic(metadataPath, metadata);
    const context = {
      root: target,
      branch,
      featureRoot,
      metadata,
      metadataPath,
      metadataRelativePath: relativeMetadataPath,
    };
    commitWorkflowCheckpoint(context, `chore(${feature}): checkpoint scaffold`, "scaffold");
    return { ...statusWorkflow({ worktree: target }), worktree: target };
  } catch (error) {
    error.message = `${error.message}\nThe new ${branch} worktree was retained at ${target} for inspection.`;
    throw error;
  }
}

function milestoneCommits(context) {
  const commits = new Map();
  const output = gitText(context.root, ["log", "--format=%H%x1f%B%x1e", `${context.metadata.baseline.commit}..HEAD`]);
  for (const record of output.split("\x1e")) {
    const separator = record.indexOf("\x1f");
    if (separator < 0) continue;
    const commit = record.slice(0, separator).trim();
    const body = record.slice(separator + 1);
    const match = /^Codex-Feature-Milestone:\s*(\w+)\s*$/m.exec(body);
    const milestone = MILESTONE_BY_NAME.get(match?.[1]);
    if (!milestone || commits.has(milestone.key)) continue;
    const metadataAtCommit = git(context.root, ["show", `${commit}:${context.metadataRelativePath}`], { allowedStatuses: [0, 128] });
    if (metadataAtCommit.status !== 0) continue;
    try {
      const snapshot = validateMetadata(JSON.parse(String(metadataAtCommit.stdout || "").replace(/^\uFEFF/, "")), context.metadataRelativePath);
      if (TERMINAL_MILESTONE_STATES.has(snapshot.milestones[milestone.key].state)) commits.set(milestone.key, commit);
    } catch {
      // A trailer alone is not a checkpoint; ignore commits without valid recorded metadata.
    }
  }
  return commits;
}

function statusWorkflow(options = {}) {
  const context = workflowContext(options.worktree || process.cwd());
  const metadata = context.metadata;
  const milestones = {};
  const checkpointCommits = milestoneCommits(context);
  for (const milestone of MILESTONES) {
    milestones[milestone.key] = {
      ...metadata.milestones[milestone.key],
      checkpointCommit: checkpointCommits.get(milestone.key) || null,
    };
  }
  const next = MILESTONES.find((milestone) => metadata.milestones[milestone.key].state === "pending") || null;
  return {
    ok: true,
    worktree: context.root,
    feature: metadata.feature,
    mode: metadata.mode,
    codexVersion: metadata.codexVersion,
    codexIdentity: metadata.codexIdentity,
    branch: context.branch,
    baseline: metadata.baseline,
    featureRoot: metadata.featureRoot,
    metadataPath: context.metadataRelativePath,
    testedAdapters: [...metadata.testedAdapters],
    milestones,
    nextMilestone: next?.cli || null,
    hasRequiredCheckpoints: MILESTONES.every((milestone) => Boolean(checkpointCommits.get(milestone.key))),
    readyForReview: MILESTONES.every((milestone) => TERMINAL_MILESTONE_STATES.has(metadata.milestones[milestone.key].state))
      && MILESTONES.every((milestone) => Boolean(checkpointCommits.get(milestone.key))),
    clean: !gitText(context.root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    head: gitText(context.root, ["rev-parse", "HEAD"]),
    commitsSinceBaseline: Number(gitText(context.root, ["rev-list", "--count", `${metadata.baseline.commit}..HEAD`])) || 0,
  };
}

function checkpointSubject(feature, milestone) {
  if (milestone.key === "firstSuccessfulPatch") return `feat(${feature}): checkpoint first successful patch`;
  if (milestone.key === "docs") return `docs(${feature}): checkpoint documentation`;
  return `test(${feature}): checkpoint ${milestone.label}`;
}

function validateNote(value) {
  if (value == null) return null;
  const note = String(value).trim();
  if (!note || note.length > 500 || /[\0\r\n]/.test(note)) fail("--note must be a single line containing 1 to 500 characters.");
  return note;
}

function walkFeatureTests(root) {
  const testsRoot = path.join(root, "tests");
  if (!fs.existsSync(testsRoot)) fail("Feature tests directory is missing.");
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else if (entry.isFile() && /\.test\.cjs$/i.test(entry.name)) files.push(filePath);
    }
  };
  visit(testsRoot);
  if (!files.length) fail("Feature tests must contain at least one .test.cjs file.");
  return files;
}

function runFeatureTests(context) {
  const files = walkFeatureTests(context.featureRoot);
  const relativeFiles = files.map((filePath) => toPosix(path.relative(context.featureRoot, filePath)));
  const result = run(process.execPath, ["--test", ...relativeFiles], { cwd: context.featureRoot, allowedStatuses: [0, 1] });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.status !== 0) fail(`Feature tests failed for ${context.metadata.feature}: ${output.trim() || "node --test returned a non-zero exit code."}`);
  return {
    kind: "feature-tests",
    command: `node --test ${relativeFiles.join(" ")}`,
    files: relativeFiles,
    result: { ok: true, exitCode: 0, outputSha256: hashBuffer(Buffer.from(output, "utf8")) },
  };
}

function validateEvidenceRelativePath(value) {
  const relativePath = toPosix(String(value || "").trim());
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split("/").includes("..") || !relativePath.endsWith(".json")) {
    fail("--evidence must be a relative .json path inside the feature module.");
  }
  return relativePath.replace(/^\.\//, "");
}

function readStructuredEvidence(context, evidencePath, kind, identity) {
  const relativePath = validateEvidenceRelativePath(evidencePath);
  const filePath = resolveInside(context.featureRoot, relativePath, "evidence path");
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) fail(`Evidence file is missing: ${relativePath}`);
  let evidence;
  try {
    evidence = readJson(filePath);
  } catch (error) {
    fail(`Evidence file is not valid JSON: ${relativePath}: ${error.message}`);
  }
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) fail(`Evidence file must be an object: ${relativePath}`);
  if (
    evidence.schemaVersion !== EVIDENCE_SCHEMA_VERSION ||
    evidence.kind !== kind ||
    evidence.feature !== context.metadata.feature ||
    evidence.codexVersion !== identity.version ||
    evidence.sourceAsarSha256 !== identity.sourceAsarSha256 ||
    evidence.sourceCliSha256 !== identity.sourceCliSha256 ||
    !evidence.result || evidence.result.ok !== true
  ) {
    fail(`Evidence file does not match the workflow identity or a successful ${kind} result: ${relativePath}`);
  }
  if (!Array.isArray(evidence.checks) || evidence.checks.length === 0 || evidence.checks.some((check) => !check || typeof check.id !== "string" || !check.id.trim() || check.ok !== true)) {
    fail(`Evidence file requires one or more successful structured checks: ${relativePath}`);
  }
  if (kind === "packed-verification") {
    const manifest = evidence.patchManifest;
    if (
      !manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
      manifest.feature !== context.metadata.feature ||
      manifest.codexVersion !== identity.version ||
      manifest.sourceAsarSha256 !== identity.sourceAsarSha256
    ) {
      fail(`Packed evidence must contain a patchManifest tied to the feature, Codex version, and source ASAR hash: ${relativePath}`);
    }
  }
  return { kind, path: relativePath, sha256: hashFile(filePath), result: evidence.result, checks: evidence.checks };
}

function validateModuleDocumentation(context) {
  const record = validateModuleLayout(validateManifest(readJson(context.manifestPath), context.manifestPath, context.metadata.mode));
  const readmePath = path.join(context.featureRoot, "README.md");
  const readme = fs.readFileSync(readmePath, "utf8");
  for (const heading of ["Compatibility", "Development"]) {
    if (!new RegExp(`^##\\s+${heading}\\s*$`, "m").test(readme)) fail(`README.md must contain a ## ${heading} section.`);
  }
  return { kind: "module-docs", path: "README.md", sha256: hashFile(readmePath), result: { ok: true, moduleSourceHash: record.sourceHash } };
}

function assertRecordedEvidenceFiles(context) {
  for (const milestone of MILESTONES) {
    const record = context.metadata.milestones[milestone.key];
    if (record.state !== "complete" || !record.evidence) continue;
    if (milestone.key === "firstSuccessfulPatch") continue;
    if (milestone.key === "docs") {
      const current = validateModuleDocumentation(context);
      if (current.sha256 !== record.evidence.sha256) fail("Documentation evidence no longer matches README.md.");
      continue;
    }
    const filePath = resolveInside(context.featureRoot, record.evidence.path, `${milestone.key} evidence path`);
    if (!fs.existsSync(filePath) || hashFile(filePath) !== record.evidence.sha256) {
      fail(`${milestone.key} evidence file is missing or its SHA-256 no longer matches recorded metadata.`);
    }
    const current = readStructuredEvidence(context, record.evidence.path, record.evidence.kind, context.metadata.codexIdentity);
    if (current.sha256 !== record.evidence.sha256) fail(`${milestone.key} evidence SHA-256 does not match recorded metadata.`);
  }
}

function checkpointWorkflow(options = {}) {
  const context = workflowContext(options.worktree || process.cwd());
  const previousMetadata = JSON.parse(JSON.stringify(context.metadata));
  const milestone = MILESTONE_BY_NAME.get(String(options.milestone || ""));
  if (!milestone || milestone.key === "scaffold") {
    fail("--milestone must be first-successful-patch, packed-verification, runtime-ui-validation, or docs.");
  }
  const current = context.metadata.milestones[milestone.key];
  if (current.state !== "pending") fail(`${milestone.cli} is already ${current.state}.`);
  const index = MILESTONES.findIndex((entry) => entry.key === milestone.key);
  for (const previous of MILESTONES.slice(0, index)) {
    if (!TERMINAL_MILESTONE_STATES.has(context.metadata.milestones[previous.key].state)) {
      fail(`Complete ${previous.cli} before ${milestone.cli}.`);
    }
  }
  if (
    milestone.key === "firstSuccessfulPatch"
    && !gitText(context.root, ["status", "--porcelain=v1", "--untracked-files=all"])
  ) {
    fail("first-successful-patch requires source or test changes beyond the scaffold.");
  }
  const notApplicable = Boolean(options.notApplicable);
  if (notApplicable && milestone.key !== "runtimeUiValidation") {
    fail("--not-applicable is supported only for runtime-ui-validation.");
  }
  const codexVersion = options.codexVersion ? validateCodexVersion(options.codexVersion) : context.metadata.codexVersion;
  let codex = context.metadata.codexIdentity;
  const fingerprintProvided = options.sourceAsarSha256 != null || options.sourceCliSha256 != null;
  if (codexVersion !== context.metadata.codexVersion || fingerprintProvided) {
    if (!options.sourceAsarSha256 || !options.sourceCliSha256) {
      fail("Changing or restating the Codex identity requires both --source-asar-sha256 and --source-cli-sha256.");
    }
    codex = createCodexIdentity({
      codexVersion,
      sourceAsarSha256: options.sourceAsarSha256,
      sourceCliSha256: options.sourceCliSha256,
    });
  }
  assertFeatureSupportsVersion(context, codexVersion);
  const testedAdapters = uniqueAdapters([...(context.metadata.testedAdapters || []), ...(options.adapters || [])]);
  const note = validateNote(options.note);
  if (notApplicable && !note) fail("--not-applicable requires --note.");
  if (!notApplicable && milestone.key === "packedVerification" && !options.evidence) {
    fail("packed-verification requires --evidence <relative patch-manifest JSON>.");
  }
  if (!notApplicable && milestone.key === "runtimeUiValidation" && !options.evidence) {
    fail("runtime-ui-validation requires --evidence <relative JSON> unless --not-applicable is used with a reason.");
  }
  let evidence = null;
  if (milestone.key === "firstSuccessfulPatch") evidence = runFeatureTests(context);
  else if (milestone.key === "packedVerification") evidence = readStructuredEvidence(context, options.evidence, "packed-verification", codex);
  else if (milestone.key === "runtimeUiValidation" && !notApplicable) evidence = readStructuredEvidence(context, options.evidence, "runtime-ui-validation", codex);
  else if (milestone.key === "docs") evidence = validateModuleDocumentation(context);
  const now = new Date().toISOString();
  context.metadata.codexVersion = codexVersion;
  context.metadata.codexIdentity = codex;
  context.metadata.testedAdapters = testedAdapters;
  context.metadata.milestones[milestone.key] = {
    state: notApplicable ? "not-applicable" : "complete",
    completedAt: now,
    codexVersion,
    testedAdapters: [...testedAdapters],
    note,
    evidence,
  };
  context.metadata.updatedAt = now;
  writeJsonAtomic(context.metadataPath, context.metadata);
  try {
    commitWorkflowCheckpoint(context, checkpointSubject(context.metadata.feature, milestone), milestone.key);
  } catch (error) {
    writeJsonAtomic(context.metadataPath, previousMetadata);
    git(context.root, ["add", "--force", "--", context.metadataRelativePath]);
    throw error;
  }
  return statusWorkflow({ worktree: context.root });
}

function synchronizeDirectoryContents(source, target) {
  const sourceNames = new Set(fs.readdirSync(source));
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (sourceNames.has(entry.name)) continue;
    const targetPath = path.join(target, entry.name);
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink()) fail(`Contribution scaffold cannot contain symlinks: ${entry.name}`);
    fs.rmSync(targetPath, { recursive: stat.isDirectory(), force: false });
  }
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".git") fail("Feature source cannot contain nested Git metadata.");
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    const stat = fs.lstatSync(sourcePath);
    if (stat.isSymbolicLink()) fail(`Feature source cannot contain symlinks: ${entry.name}`);
    if (stat.isDirectory()) {
      fs.mkdirSync(targetPath, { recursive: true });
      synchronizeDirectoryContents(sourcePath, targetPath);
    } else if (stat.isFile()) {
      fs.copyFileSync(sourcePath, targetPath);
      fs.chmodSync(targetPath, stat.mode);
    } else {
      fail(`Unsupported feature source entry: ${entry.name}`);
    }
  }
}

function defaultFeatureName(feature) {
  return feature.split(/[.-]/).map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
}

function rewriteConvertedFeatureReferences(root, oldFeature, newFeature, oldName, newName) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      rewriteConvertedFeatureReferences(entryPath, oldFeature, newFeature, oldName, newName);
      continue;
    }
    if (!entry.isFile() || !/\.(?:cjs|js|json|md|mjs|txt)$/i.test(entry.name)) continue;
    const buffer = fs.readFileSync(entryPath);
    if (buffer.includes(0)) continue;
    const before = buffer.toString("utf8");
    let after = before.split(oldFeature).join(newFeature);
    if (oldName !== newName) after = after.split(oldName).join(newName);
    if (after !== before) fs.writeFileSync(entryPath, after, "utf8");
  }
}

function convertWorkflow(options = {}) {
  const source = workflowContext(options.worktree || process.cwd());
  if (source.metadata.mode !== "local") fail("Only a local feature workflow can be converted to a contribution.");
  assertClean(source.root, "local feature worktree");
  const feature = validateFeatureId(options.feature, "--feature");
  if (feature.startsWith("local.") || feature.startsWith("core.")) {
    fail("The contribution feature id cannot use the local. or core. namespace.");
  }
  const slug = validateSlug(options.slug || source.parts.slug);
  const branch = branchFor("contribution", slug);
  if (localBranchExists(source.root, branch)) fail(`Branch already exists: ${branch}`);
  const baselineRef = validateGitRef(options.baseline || source.metadata.baseline.ref, "baseline ref");
  const baselineCommit = resolveCommit(source.root, baselineRef);
  const target = validateNewWorktreePath(source.root, options.targetWorktree, branch);
  const sourceCommit = gitText(source.root, ["rev-parse", "HEAD"]);

  git(source.root, ["worktree", "add", "--no-track", "-b", branch, target, baselineCommit]);
  try {
    const featureRoot = scaffoldFeature({
      repoRoot: target,
      id: feature,
      kind: "contribution",
      codexVersion: source.metadata.codexVersion,
    });
    synchronizeDirectoryContents(source.featureRoot, featureRoot);
    const manifestPath = path.join(featureRoot, "feature.json");
    const sourceManifest = readJson(manifestPath);
    const generatedLocalName = defaultFeatureName(source.metadata.feature);
    const contributionName = sourceManifest.name === generatedLocalName ? defaultFeatureName(feature) : sourceManifest.name;
    rewriteConvertedFeatureReferences(
      featureRoot,
      source.metadata.feature,
      feature,
      sourceManifest.name === generatedLocalName ? generatedLocalName : "",
      sourceManifest.name === generatedLocalName ? contributionName : ""
    );
    const manifest = readJson(manifestPath);
    manifest.id = feature;
    manifest.kind = "contribution";
    manifest.name = contributionName;
    writeJsonAtomic(manifestPath, manifest);
    const relativeFeatureRoot = toPosix(path.relative(target, featureRoot));
    const relativeMetadataPath = metadataRelativePath(branch);
    const convertedFrom = { feature: source.metadata.feature, branch: source.branch, commit: sourceCommit };
    const metadata = createMetadata({
      feature,
      mode: "contribution",
      codex: source.metadata.codexIdentity,
      branch,
      baselineRef,
      baselineCommit,
      featureRoot: relativeFeatureRoot,
      testedAdapters: source.metadata.testedAdapters,
      convertedFrom,
    });
    const metadataPath = path.join(target, relativeMetadataPath);
    writeJsonAtomic(metadataPath, metadata);
    const context = {
      root: target,
      branch,
      featureRoot,
      metadata,
      metadataPath,
      metadataRelativePath: relativeMetadataPath,
    };
    commitWorkflowCheckpoint(context, `chore(${feature}): convert local feature to contribution`, "scaffold");
    return { ...statusWorkflow({ worktree: target }), worktree: target };
  } catch (error) {
    error.message = `${error.message}\nThe new ${branch} worktree was retained at ${target} for inspection.`;
    throw error;
  }
}

function pushWorkflow(options = {}) {
  const context = workflowContext(options.worktree || process.cwd());
  if (context.metadata.mode !== "contribution") fail("Push is available only for contribution workflows; local workflows never publish.");
  assertClean(context.root, "feature worktree");
  assertPublicationSourceOnly(context);
  const status = statusWorkflow({ worktree: context.root });
  assertPublicationReadiness(status);
  const remote = String(options.remote || "origin");
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) fail("--remote is invalid.");
  const remotes = gitText(context.root, ["remote"]).split(/\r?\n/).filter(Boolean);
  if (!remotes.includes(remote)) fail(`Remote does not exist: ${remote}`);
  git(context.root, [
    "-c",
    `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "push",
    "--no-verify",
    "--set-upstream",
    remote,
    context.branch,
  ]);
  return { ok: true, action: "push", branch: context.branch, remote, head: gitText(context.root, ["rev-parse", "HEAD"]) };
}

function assertPublicationReadiness(status) {
  if (!status.readyForReview || !status.hasRequiredCheckpoints) {
    fail("Publication requires every milestone to be terminal with a valid recorded checkpoint commit and evidence.");
  }
}

function generatedPullRequestBody(status, manifest) {
  const lines = [
    `Feature: ${status.feature}`,
    `Baseline commit: ${status.baseline.commit}`,
    "",
    "Compatibility fingerprints:",
    `- Codex version: ${status.codexIdentity.version}`,
    `- Source ASAR SHA-256: ${status.codexIdentity.sourceAsarSha256}`,
    `- Source CLI SHA-256: ${status.codexIdentity.sourceCliSha256}`,
    `- Tested adapters: ${status.testedAdapters.length ? status.testedAdapters.join(", ") : "none recorded"}`,
    "",
    "Permissions and ports:",
    `- Permissions: ${(manifest.runtime?.permissions || []).join(", ") || "none"}`,
    `- Local ports: ${(manifest.runtime?.localPorts || []).join(", ") || "none"}`,
    "",
    "Milestones:",
  ];
  for (const milestone of MILESTONES) {
    const record = status.milestones[milestone.key];
    const evidence = record.evidence;
    const evidenceHash = evidence?.sha256 || evidence?.result?.outputSha256 || "not applicable";
    const evidenceResult = evidence?.result ? JSON.stringify(evidence.result) : record.note || "none";
    lines.push(`- ${milestone.label}: ${record.state}; checkpoint ${record.checkpointCommit}; evidence SHA-256 ${evidenceHash}; result ${evidenceResult}`);
  }
  lines.push("", "Tests:");
  const tests = status.milestones.firstSuccessfulPatch.evidence;
  lines.push(`- ${tests?.command || "No feature test command recorded"}`);
  lines.push("", "This pull request contains source-only feature code and recorded validation evidence.");
  return lines.join("\n");
}

function pullRequestWorkflow(options = {}) {
  const context = workflowContext(options.worktree || process.cwd());
  if (context.metadata.mode !== "contribution") fail("Pull requests are available only for contribution workflows.");
  assertClean(context.root, "contribution worktree");
  assertPublicationSourceOnly(context);
  const status = statusWorkflow({ worktree: context.root });
  assertPublicationReadiness(status);
  const upstream = git(context.root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { allowedStatuses: [0, 128] });
  if (upstream.status !== 0) fail("Push the contribution branch explicitly before creating a pull request.");
  const base = validateGitRef(options.base || context.metadata.baseline.ref || "main", "base ref");
  const title = String(options.title || `Contribute ${context.metadata.feature}`).trim();
  if (!title || title.length > 200) fail("--title must contain 1 to 200 characters.");
  const generatedBody = generatedPullRequestBody(status, context.manifest);
  const body = options.body == null ? generatedBody : `${generatedBody}\n\nAdditional notes:\n${String(options.body).trim()}`;
  if (!body.trim() || body.length > 10000) fail("--body must contain 1 to 10000 characters.");
  const args = ["pr", "create", "--base", base, "--head", context.branch, "--title", title, "--body", body];
  if (!options.ready) args.push("--draft");
  const result = run("gh", args, { cwd: context.root });
  const output = String(result.stdout || "").trim();
  return { ok: true, action: "pull-request", draft: !options.ready, branch: context.branch, url: output.match(/https?:\/\/\S+/)?.[0] || null, output };
}

function parseArguments(argv) {
  const values = { _: [] };
  const booleans = new Set(["help", "json", "ready", "not-applicable"]);
  const repeatable = new Set(["adapter"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      values._.push(argument);
      continue;
    }
    const separator = argument.indexOf("=");
    const key = argument.slice(2, separator >= 0 ? separator : undefined);
    if (booleans.has(key)) {
      if (separator >= 0) fail(`--${key} does not accept a value.`);
      values[key] = true;
      continue;
    }
    const value = separator >= 0 ? argument.slice(separator + 1) : argv[++index];
    if (value == null || value.startsWith("--")) fail(`--${key} requires a value.`);
    if (repeatable.has(key)) values[key] = [...(values[key] || []), value];
    else if (Object.prototype.hasOwnProperty.call(values, key)) fail(`--${key} may be provided only once.`);
    else values[key] = value;
  }
  return values;
}

function assertOptions(options, allowed) {
  const known = new Set(["_", "json", "help", ...allowed]);
  const unknown = Object.keys(options).filter((key) => !known.has(key));
  if (unknown.length) fail(`Unknown option(s): ${unknown.map((key) => `--${key}`).join(", ")}`);
  if (options._.length) fail(`Unexpected argument(s): ${options._.join(" ")}`);
}

function helpText() {
  return `Codex Patch Studio feature development workflow

Commands:
  start      --mode <local|contribution> --feature <id> --codex-version <version> --source-asar-sha256 <sha256> --source-cli-sha256 <sha256> [--slug <slug>] [--baseline <ref>] [--repo <path>] [--worktree <path>] [--adapter <id>...]
  status     [--worktree <path>]
  checkpoint --milestone <name> [--worktree <path>] [--codex-version <version> --source-asar-sha256 <sha256> --source-cli-sha256 <sha256>] [--adapter <id>...] [--evidence <module-relative.json>] [--note <text>] [--not-applicable]
  convert    --feature <contribution-id> [--worktree <local-path>] [--target-worktree <path>] [--slug <slug>] [--baseline <ref>]
  push       [--worktree <path>] [--remote <name>]
  pr         [--worktree <path>] [--base <branch>] [--title <text>] [--body <text>] [--ready]

Checkpoint names: first-successful-patch, packed-verification, runtime-ui-validation, docs.
start, checkpoint, and convert never push or create pull requests. push and pr are explicit remote operations.
`;
}

function cli(argv = process.argv.slice(2)) {
  const command = argv[0] || "help";
  const options = parseArguments(argv.slice(1));
  if (command === "help" || options.help) {
    process.stdout.write(helpText());
    return null;
  }
  let result;
  if (command === "start") {
    assertOptions(options, ["mode", "feature", "codex-version", "source-asar-sha256", "source-cli-sha256", "slug", "baseline", "repo", "worktree", "adapter"]);
    result = startWorkflow({
      mode: options.mode,
      feature: options.feature,
      codexVersion: options["codex-version"],
      sourceAsarSha256: options["source-asar-sha256"],
      sourceCliSha256: options["source-cli-sha256"],
      slug: options.slug,
      baseline: options.baseline,
      repo: options.repo,
      worktree: options.worktree,
      adapters: options.adapter,
    });
  } else if (command === "status") {
    assertOptions(options, ["worktree"]);
    result = statusWorkflow({ worktree: options.worktree });
  } else if (command === "checkpoint") {
    assertOptions(options, ["milestone", "worktree", "codex-version", "source-asar-sha256", "source-cli-sha256", "adapter", "evidence", "note", "not-applicable"]);
    result = checkpointWorkflow({
      milestone: options.milestone,
      worktree: options.worktree,
      codexVersion: options["codex-version"],
      sourceAsarSha256: options["source-asar-sha256"],
      sourceCliSha256: options["source-cli-sha256"],
      adapters: options.adapter,
      evidence: options.evidence,
      note: options.note,
      notApplicable: options["not-applicable"],
    });
  } else if (command === "convert" || command === "convert-to-contribution") {
    assertOptions(options, ["feature", "worktree", "target-worktree", "slug", "baseline"]);
    result = convertWorkflow({
      feature: options.feature,
      worktree: options.worktree,
      targetWorktree: options["target-worktree"],
      slug: options.slug,
      baseline: options.baseline,
    });
  } else if (command === "push") {
    assertOptions(options, ["worktree", "remote"]);
    result = pushWorkflow({ worktree: options.worktree, remote: options.remote });
  } else if (command === "pr") {
    assertOptions(options, ["worktree", "base", "title", "body", "ready"]);
    result = pullRequestWorkflow({
      worktree: options.worktree,
      base: options.base,
      title: options.title,
      body: options.body,
      ready: options.ready,
    });
  } else {
    fail(`Unknown command: ${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

module.exports = {
  METADATA_DIRECTORY,
  METADATA_SCHEMA_VERSION,
  MILESTONES,
  checkpointWorkflow,
  cli,
  convertWorkflow,
  parseArguments,
  pullRequestWorkflow,
  pushWorkflow,
  startWorkflow,
  statusWorkflow,
};

if (require.main === module) {
  try {
    cli();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message || String(error)}\n`);
    process.exitCode = 1;
  }
}
