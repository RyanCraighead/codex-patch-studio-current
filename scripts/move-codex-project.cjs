#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const defaultCodexHome = path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex");

function usage() {
  console.error(`Usage:
  node scripts/move-codex-project.cjs --project <codex-project-path> --to <new-project-path> [options]

Options:
  --codex-home <path>       Codex home directory. Defaults to ~/.codex.
  --apply                   Move the folder and rewrite Codex references. Omit for dry run.
  --no-move-folder          Rewrite Codex references without moving the folder.
  --allow-running           Do not fail if the Codex desktop process is open.
  --json                    Print only JSON.
`);
}

function parseArgs(argv) {
  const options = {
    codexHome: defaultCodexHome,
    apply: false,
    moveFolder: true,
    allowRunning: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project") {
      options.projectPath = argv[++index];
    } else if (arg === "--to") {
      options.newPath = argv[++index];
    } else if (arg === "--codex-home") {
      options.codexHome = argv[++index];
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--no-move-folder") {
      options.moveFolder = false;
    } else if (arg === "--allow-running") {
      options.allowRunning = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.projectPath || !options.newPath) {
    usage();
    process.exit(2);
  }
  options.projectPath = stripLongPath(String(options.projectPath).trim());
  options.newPath = stripLongPath(String(options.newPath).trim());
  options.codexHome = stripLongPath(path.resolve(options.codexHome));
  return options;
}

function exists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function stripLongPath(value) {
  return String(value || "").replace(/^\\\\\?\\/, "");
}

function trimTrailingSeparators(value) {
  let output = String(value || "");
  while (output.length > 3 && /[\\/]$/.test(output)) {
    output = output.slice(0, -1);
  }
  return output;
}

function comparablePath(value) {
  const stripped = trimTrailingSeparators(stripLongPath(value)).replace(/\//g, "\\");
  return process.platform === "win32" ? stripped.toLowerCase() : stripped;
}

function pathStartsWith(candidate, prefix) {
  const candidatePath = comparablePath(candidate);
  const prefixPath = comparablePath(prefix);
  return candidatePath === prefixPath || candidatePath.startsWith(`${prefixPath}\\`);
}

function pathDepth(value) {
  return trimTrailingSeparators(stripLongPath(value)).split(/[\\/]+/).filter(Boolean).length;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slashVariant(value) {
  return stripLongPath(value).replace(/\\/g, "/");
}

function backslashVariant(value) {
  return stripLongPath(value).replace(/\//g, "\\");
}

function replacementVariants(oldPath, newPath) {
  const oldBack = trimTrailingSeparators(backslashVariant(oldPath));
  const oldForward = trimTrailingSeparators(slashVariant(oldPath));
  const newBack = trimTrailingSeparators(backslashVariant(newPath));
  const newForward = trimTrailingSeparators(slashVariant(newPath));
  const variants = [
    { oldValue: `\\\\?\\${oldBack}`, newValue: `\\\\?\\${newBack}` },
    { oldValue: oldBack, newValue: newBack },
  ];
  if (oldForward !== oldBack) {
    variants.push({ oldValue: oldForward, newValue: newForward });
  }
  return variants.sort((a, b) => b.oldValue.length - a.oldValue.length);
}

function replacePathPrefixInString(value, oldPath, newPath) {
  let output = String(value);
  let replacements = 0;
  for (const variant of replacementVariants(oldPath, newPath)) {
    if (!variant.oldValue) {
      continue;
    }
    const pattern = new RegExp(`${escapeRegExp(variant.oldValue)}(?=$|[\\\\/])`, process.platform === "win32" ? "gi" : "g");
    output = output.replace(pattern, () => {
      replacements += 1;
      return variant.newValue;
    });
  }
  return { value: output, replacements };
}

function transformJsonValue(value, oldPath, newPath, stats) {
  if (typeof value === "string") {
    const replaced = replacePathPrefixInString(value, oldPath, newPath);
    stats.stringReplacements += replaced.replacements;
    return replaced.value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => transformJsonValue(item, oldPath, newPath, stats));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      const replacedKey = replacePathPrefixInString(key, oldPath, newPath);
      if (replacedKey.replacements) {
        stats.keyReplacements += replacedKey.replacements;
      }
      out[replacedKey.value] = transformJsonValue(inner, oldPath, newPath, stats);
    }
    return out;
  }
  return value;
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function sqliteJson(dbPath, sql) {
  if (!exists(dbPath)) {
    return [];
  }
  const output = execFileSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return output.trim() ? JSON.parse(output) : [];
}

function sqlString(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function listThreads(codexHome) {
  const dbPath = path.join(codexHome, "state_5.sqlite");
  return sqliteJson(dbPath, "SELECT id, cwd, rollout_path, title, updated_at_ms FROM threads ORDER BY updated_at_ms DESC;");
}

function listMatchingThreads(codexHome, oldPath) {
  return listThreads(codexHome).filter((thread) => pathStartsWith(thread.cwd, oldPath));
}

function walkFiles(dirPath, predicate, out = []) {
  if (!exists(dirPath)) {
    return out;
  }
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const filePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkFiles(filePath, predicate, out);
    } else if (!predicate || predicate(filePath, entry)) {
      out.push(filePath);
    }
  }
  return out;
}

function rolloutMatchesProject(filePath, oldPath) {
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return false;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let entry = null;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if ((entry.type === "session_meta" || entry.type === "turn_context") && pathStartsWith(entry.payload?.cwd, oldPath)) {
      return true;
    }
  }
  return false;
}

function findRollouts(codexHome, oldPath, matchingThreads) {
  const rollouts = new Set();
  for (const thread of matchingThreads) {
    if (thread.rollout_path && exists(thread.rollout_path)) {
      rollouts.add(path.resolve(thread.rollout_path));
    }
  }
  const sessionsDir = path.join(codexHome, "sessions");
  for (const filePath of walkFiles(sessionsDir, (file) => path.basename(file).startsWith("rollout-") && file.endsWith(".jsonl"))) {
    if (rollouts.has(path.resolve(filePath))) {
      continue;
    }
    if (rolloutMatchesProject(filePath, oldPath)) {
      rollouts.add(path.resolve(filePath));
    }
  }
  return [...rollouts].sort();
}

function analyzeRollout(filePath, oldPath, newPath) {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  const outLines = [];
  const stats = {
    path: filePath,
    changed: false,
    parsedLines: 0,
    malformedLines: 0,
    changedLines: 0,
    stringReplacements: 0,
    keyReplacements: 0,
  };

  for (const line of lines) {
    if (!line.trim()) {
      outLines.push(line);
      continue;
    }
    let entry = null;
    try {
      entry = JSON.parse(line);
      stats.parsedLines += 1;
    } catch {
      stats.malformedLines += 1;
      outLines.push(line);
      continue;
    }
    const before = JSON.stringify(entry);
    const entryStats = { stringReplacements: 0, keyReplacements: 0 };
    const transformed = transformJsonValue(entry, oldPath, newPath, entryStats);
    const after = JSON.stringify(transformed);
    if (after !== before) {
      stats.changed = true;
      stats.changedLines += 1;
      stats.stringReplacements += entryStats.stringReplacements;
      stats.keyReplacements += entryStats.keyReplacements;
      outLines.push(after);
    } else {
      outLines.push(line);
    }
  }

  return {
    stats,
    text: outLines.join("\n"),
  };
}

function analyzeGlobalState(codexHome, oldPath, newPath) {
  const filePath = path.join(codexHome, ".codex-global-state.json");
  if (!exists(filePath)) {
    return { exists: false, changed: false, path: filePath, stringReplacements: 0, keyReplacements: 0, text: "" };
  }
  const state = readJsonSafe(filePath);
  if (!state) {
    throw new Error(`Could not parse ${filePath}`);
  }
  const stats = { stringReplacements: 0, keyReplacements: 0 };
  const transformed = transformJsonValue(state, oldPath, newPath, stats);
  const before = JSON.stringify(state);
  const after = JSON.stringify(transformed);
  return {
    exists: true,
    changed: before !== after,
    path: filePath,
    stringReplacements: stats.stringReplacements,
    keyReplacements: stats.keyReplacements,
    text: `${JSON.stringify(transformed, null, 2)}\n`,
  };
}

function buildSqlUpdates(codexHome, oldPath, newPath, matchingThreads) {
  const updates = [];
  for (const thread of matchingThreads) {
    const replacement = replacePathPrefixInString(thread.cwd, oldPath, newPath);
    if (replacement.value !== thread.cwd) {
      updates.push({ id: thread.id, oldCwd: thread.cwd, newCwd: replacement.value, title: thread.title || "" });
    }
  }
  return {
    dbPath: path.join(codexHome, "state_5.sqlite"),
    updates,
  };
}

function isCodexRunning() {
  if (process.platform !== "win32") {
    return false;
  }
  try {
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", "Get-Process -Name Codex -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return Boolean(output.trim());
  } catch {
    return false;
  }
}

function copyFileIfExists(source, target) {
  if (!exists(source)) {
    return false;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return true;
}

function backupState(codexHome, rolloutAnalyses, summary) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(rootDir, "codex-project-move-backups", stamp);
  fs.mkdirSync(backupDir, { recursive: true });

  const stateDb = path.join(codexHome, "state_5.sqlite");
  if (exists(stateDb)) {
    execFileSync("sqlite3", [stateDb, `.backup '${path.join(backupDir, "state_5.sqlite").replace(/'/g, "''")}'`], { stdio: "pipe" });
  }
  copyFileIfExists(path.join(codexHome, ".codex-global-state.json"), path.join(backupDir, ".codex-global-state.json"));
  copyFileIfExists(path.join(codexHome, "session_index.jsonl"), path.join(backupDir, "session_index.jsonl"));

  const sessionsRoot = path.join(codexHome, "sessions");
  for (const analysis of rolloutAnalyses.filter((item) => item.stats.changed)) {
    const relative = path.relative(sessionsRoot, analysis.stats.path);
    const target = relative && !relative.startsWith("..")
      ? path.join(backupDir, "sessions", relative)
      : path.join(backupDir, "rollouts", path.basename(analysis.stats.path));
    copyFileIfExists(analysis.stats.path, target);
  }

  fs.writeFileSync(path.join(backupDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return backupDir;
}

function moveDirectory(oldPath, newPath) {
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "Move-Item -LiteralPath $args[0] -Destination $args[1]",
      oldPath,
      newPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
}

function applySqlUpdates(sqlInfo) {
  if (!sqlInfo.updates.length) {
    return;
  }
  const sql = [
    "BEGIN;",
    ...sqlInfo.updates.map((update) => `UPDATE threads SET cwd = ${sqlString(update.newCwd)} WHERE id = ${sqlString(update.id)};`),
    "COMMIT;",
  ].join("\n");
  execFileSync("sqlite3", [sqlInfo.dbPath], { input: sql, stdio: ["pipe", "pipe", "pipe"] });
}

function validateRolloutJsonl(rolloutPaths) {
  const errors = [];
  for (const filePath of rolloutPaths) {
    const text = fs.readFileSync(filePath, "utf8");
    let lineNumber = 0;
    for (const line of text.split(/\r?\n/)) {
      lineNumber += 1;
      if (!line.trim()) {
        continue;
      }
      try {
        JSON.parse(line);
      } catch (error) {
        errors.push(`${filePath}:${lineNumber}: ${error.message}`);
      }
    }
  }
  if (errors.length) {
    throw new Error(`Rollout JSONL validation failed:\n${errors.slice(0, 20).join("\n")}`);
  }
}

function writeResult(summary) {
  const outDir = path.join(rootDir, "codex-project-move-results");
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, `move-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return filePath;
}

function buildSummary(options) {
  const matchingThreads = listMatchingThreads(options.codexHome, options.projectPath);
  const rollouts = findRollouts(options.codexHome, options.projectPath, matchingThreads);
  const rolloutAnalyses = rollouts.map((rolloutPath) => analyzeRollout(rolloutPath, options.projectPath, options.newPath));
  const globalState = analyzeGlobalState(options.codexHome, options.projectPath, options.newPath);
  const sqlInfo = buildSqlUpdates(options.codexHome, options.projectPath, options.newPath, matchingThreads);
  const changedRollouts = rolloutAnalyses.filter((item) => item.stats.changed);
  const oldExists = exists(options.projectPath);
  const newExists = exists(options.newPath);

  return {
    mode: options.apply ? "apply" : "dry-run",
    codexHome: options.codexHome,
    oldPath: options.projectPath,
    newPath: options.newPath,
    moveFolder: options.moveFolder,
    oldExists,
    newExists,
    threadCount: matchingThreads.length,
    sqliteUpdateCount: sqlInfo.updates.length,
    rolloutCount: rollouts.length,
    changedRolloutCount: changedRollouts.length,
    globalStateChanged: globalState.changed,
    replacements: {
      rolloutStrings: changedRollouts.reduce((sum, item) => sum + item.stats.stringReplacements, 0),
      rolloutKeys: changedRollouts.reduce((sum, item) => sum + item.stats.keyReplacements, 0),
      globalStrings: globalState.stringReplacements,
      globalKeys: globalState.keyReplacements,
    },
    threads: matchingThreads.slice(0, 100).map((thread) => ({
      id: thread.id,
      title: thread.title,
      cwd: thread.cwd,
      rolloutPath: thread.rollout_path,
    })),
    rollouts: changedRollouts.slice(0, 100).map((item) => item.stats),
    _internal: {
      matchingThreads,
      rolloutAnalyses,
      globalState,
      sqlInfo,
    },
  };
}

function applyMove(options, summary) {
  if (!options.allowRunning && isCodexRunning()) {
    throw new Error("Codex is running. Close Codex first or run through the after-close scheduler.");
  }
  if (options.moveFolder) {
    if (!summary.oldExists) {
      throw new Error(`Cannot move project because the current folder does not exist: ${options.projectPath}`);
    }
    if (summary.newExists) {
      throw new Error(`Cannot move project because the destination already exists: ${options.newPath}`);
    }
    const parent = path.dirname(options.newPath);
    if (!exists(parent)) {
      throw new Error(`Destination parent folder does not exist: ${parent}`);
    }
  }
  if (!summary.threadCount && !summary.globalStateChanged) {
    throw new Error("Codex does not appear to reference that project path.");
  }

  const backupSummary = { ...summary };
  delete backupSummary._internal;
  const backupDir = backupState(options.codexHome, summary._internal.rolloutAnalyses, backupSummary);

  let folderMoved = false;
  try {
    if (options.moveFolder) {
      moveDirectory(options.projectPath, options.newPath);
      folderMoved = true;
    }
    applySqlUpdates(summary._internal.sqlInfo);
    for (const analysis of summary._internal.rolloutAnalyses.filter((item) => item.stats.changed)) {
      fs.writeFileSync(analysis.stats.path, analysis.text, "utf8");
    }
    if (summary._internal.globalState.changed) {
      fs.writeFileSync(summary._internal.globalState.path, summary._internal.globalState.text, "utf8");
    }
    validateRolloutJsonl(summary._internal.rolloutAnalyses.filter((item) => item.stats.changed).map((item) => item.stats.path));
  } catch (error) {
    if (folderMoved && !exists(options.projectPath) && exists(options.newPath)) {
      try {
        moveDirectory(options.newPath, options.projectPath);
      } catch {
        // The backup manifest still records the original paths if automatic rollback fails.
      }
    }
    throw error;
  }

  return backupDir;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const summary = buildSummary(options);
  if (options.apply) {
    const backupDir = applyMove(options, summary);
    summary.backupDir = backupDir;
    summary.resultPath = writeResult({ ...summary, _internal: undefined });
  }
  delete summary._internal;
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    console.log(JSON.stringify(summary, null, 2));
  }
}

try {
  main();
} catch (error) {
  const payload = { error: error.message };
  if (process.argv.includes("--json")) {
    console.error(JSON.stringify(payload, null, 2));
  } else {
    console.error(error.stack || error.message);
  }
  process.exit(1);
}
