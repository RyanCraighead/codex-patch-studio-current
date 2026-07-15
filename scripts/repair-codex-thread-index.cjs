#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const rootDir = path.resolve(__dirname, "..");

function usage() {
  console.error(`Usage:
  node --no-warnings scripts/repair-codex-thread-index.cjs --thread-id <id> [options]

Options:
  --codex-home <path>     Codex home directory. Defaults to %USERPROFILE%\\.codex.
  --workspace <path>      Workspace path to register. Defaults to the thread cwd.
  --title <title>         Sidebar title. Defaults to session_index thread_name, then global title, then DB title.
  --normalize-thread-source
                          Set this thread's DB thread_source to "user" when it is NULL/empty.
  --touch-updated-at <iso|now>
                          Set this thread's updated_at/updated_at_ms, session_index timestamp,
                          and rollout file mtime.
  --touch-updated-at-now  Shortcut for --touch-updated-at now.
  --apply                 Write the repaired index state.
  --allow-running         Allow writes while Codex is running.
  --no-backup             Skip backup before writing.
  --json                  Print machine-readable JSON only.`);
}

function parseArgs(argv) {
  const options = {
    codexHome: path.join(os.homedir(), ".codex"),
    apply: false,
    allowRunning: false,
    backup: true,
    json: false,
    normalizeThreadSource: false,
    touchUpdatedAt: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--thread-id") {
      options.threadId = argv[++index];
    } else if (arg === "--codex-home") {
      options.codexHome = argv[++index];
    } else if (arg === "--workspace") {
      options.workspace = argv[++index];
    } else if (arg === "--title") {
      options.title = argv[++index];
    } else if (arg === "--normalize-thread-source") {
      options.normalizeThreadSource = true;
    } else if (arg === "--touch-updated-at") {
      options.touchUpdatedAt = argv[++index];
    } else if (arg === "--touch-updated-at-now") {
      options.touchUpdatedAt = "now";
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--allow-running") {
      options.allowRunning = true;
    } else if (arg === "--no-backup") {
      options.backup = false;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.threadId) {
    usage();
    process.exit(2);
  }

  options.codexHome = path.resolve(options.codexHome);
  if (options.workspace) {
    options.workspace = normalizeCwd(options.workspace);
  }
  return options;
}

function resolveTouchUpdatedAt(value) {
  if (!value) {
    return null;
  }

  const date = value === "now" ? new Date() : new Date(value);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid --touch-updated-at value: ${value}`);
  }

  return {
    iso: date.toISOString(),
    ms,
    seconds: Math.floor(ms / 1000),
  };
}

function exists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function fileInfo(filePath) {
  if (!filePath || !exists(filePath)) {
    return { path: filePath || null, exists: false };
  }
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    exists: true,
    size: stat.size,
    atime: stat.atime.toISOString(),
    mtime: stat.mtime.toISOString(),
    birthtime: stat.birthtime.toISOString(),
  };
}

function stripExtendedPrefix(value) {
  const text = String(value || "");
  if (text.startsWith("\\\\?\\")) {
    return text.slice(4);
  }
  return text;
}

function normalizeCwd(value) {
  const stripped = stripExtendedPrefix(value).replace(/\//g, "\\");
  return path.win32.normalize(stripped);
}

function normalizeForCompare(value) {
  return normalizeCwd(value).replace(/\\+$/, "").toLowerCase();
}

function prependUnique(values, value, normalizer = (item) => item) {
  const normalizedValue = normalizer(value);
  return [value, ...(Array.isArray(values) ? values : []).filter((item) => normalizer(item) !== normalizedValue)];
}

function readJsonSafe(filePath, fallback = null) {
  if (!exists(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readThread(codexHome, threadId) {
  const dbPath = path.join(codexHome, "state_5.sqlite");
  if (!exists(dbPath)) {
    throw new Error(`Missing Codex database: ${dbPath}`);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        [
          "SELECT id, title, cwd, rollout_path, updated_at, updated_at_ms, thread_source, archived",
          "FROM threads",
          "WHERE id = ?",
        ].join(" ")
      )
      .get(threadId);
  } finally {
    db.close();
  }
}

function updateThreadSource(codexHome, threadId) {
  const dbPath = path.join(codexHome, "state_5.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("BEGIN");
    const result = db
      .prepare("UPDATE threads SET thread_source = 'user' WHERE id = ? AND (thread_source IS NULL OR thread_source = '')")
      .run(threadId);
    db.exec("COMMIT");
    return Number(result.changes || 0);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  } finally {
    db.close();
  }
}

function updateThreadTimestamp(codexHome, threadId, timestamp) {
  const dbPath = path.join(codexHome, "state_5.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("BEGIN");
    const result = db
      .prepare("UPDATE threads SET updated_at = ?, updated_at_ms = ? WHERE id = ?")
      .run(timestamp.seconds, timestamp.ms, threadId);
    db.exec("COMMIT");
    return Number(result.changes || 0);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  } finally {
    db.close();
  }
}

function updateRolloutMtime(rolloutPath, timestamp) {
  if (!rolloutPath || !exists(rolloutPath)) {
    return 0;
  }
  const stat = fs.statSync(rolloutPath);
  fs.utimesSync(rolloutPath, stat.atime, new Date(timestamp.ms));
  return 1;
}

function readSessionIndex(codexHome) {
  const indexPath = path.join(codexHome, "session_index.jsonl");
  if (!exists(indexPath)) {
    return { indexPath, lines: [], entries: [] };
  }

  const lines = fs.readFileSync(indexPath, "utf8").split(/\r?\n/);
  const entries = [];
  lines.forEach((line, index) => {
    if (!line.trim()) {
      return;
    }
    try {
      entries.push({ index, line, value: JSON.parse(line) });
    } catch {
      entries.push({ index, line, value: null, parseError: true });
    }
  });
  return { indexPath, lines, entries };
}

function threadUpdatedIso(thread) {
  const updatedMs = Number(thread.updated_at_ms);
  if (Number.isFinite(updatedMs) && updatedMs > 0) {
    return new Date(updatedMs).toISOString();
  }

  const updatedSeconds = Number(thread.updated_at);
  if (Number.isFinite(updatedSeconds) && updatedSeconds > 0) {
    return new Date(updatedSeconds * 1000).toISOString();
  }

  return new Date().toISOString();
}

function displayTitle(options, thread, state, indexInfo) {
  if (options.title) {
    return options.title;
  }

  const fromIndex = indexInfo.entries
    .filter((entry) => entry.value && entry.value.id === options.threadId && entry.value.thread_name)
    .map((entry) => String(entry.value.thread_name))
    .pop();
  if (fromIndex) {
    return fromIndex;
  }

  const fromGlobal = state?.["thread-titles"]?.titles?.[options.threadId];
  if (fromGlobal) {
    return String(fromGlobal);
  }

  const raw = String(thread.title || options.threadId).replace(/\s+/g, " ").trim();
  return raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
}

function isCodexRunning() {
  if (process.platform !== "win32") {
    return false;
  }

  const command = [
    "$items = Get-Process -ErrorAction SilentlyContinue | Where-Object {",
    "($_.ProcessName -in @('ChatGPT','Codex')) -or",
    "($_.ProcessName -eq 'codex' -and ($_.Path -like '*\\OpenAI\\Codex\\bin\\*' -or $_.Path -like '*\\WindowsApps\\OpenAI.Codex_*' -or $_.Path -like '*\\CodexPatchStudioCurrent\\*'))",
    "};",
    "$items | Select-Object -First 1 -ExpandProperty Id",
  ].join(" ");

  try {
    return Boolean(
      execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }).trim()
    );
  } catch {
    return false;
  }
}

function copyIfExists(source, target) {
  if (!exists(source)) {
    return false;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return true;
}

function backupCodexState(codexHome, thread) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(rootDir, "codex-chat-backups", `thread-index-repair-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });

  for (const file of ["state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm", ".codex-global-state.json", "session_index.jsonl"]) {
    copyIfExists(path.join(codexHome, file), path.join(backupDir, file));
  }

  if (thread.rollout_path) {
    copyIfExists(thread.rollout_path, path.join(backupDir, "rollouts", path.basename(thread.rollout_path)));
    fs.writeFileSync(
      path.join(backupDir, "rollout_metadata.json"),
      `${JSON.stringify(fileInfo(thread.rollout_path), null, 2)}\n`,
      "utf8"
    );
  }

  return backupDir;
}

function buildGlobalStateRepair(state, threadId, workspace, title) {
  const next = state && typeof state === "object" ? structuredClone(state) : {};
  const changes = [];

  for (const key of ["electron-saved-workspace-roots", "active-workspace-roots", "project-order"]) {
    const before = JSON.stringify(next[key] || []);
    next[key] = prependUnique(next[key], workspace, normalizeForCompare);
    if (JSON.stringify(next[key] || []) !== before) {
      changes.push(`${key}:workspace`);
    }
  }

  if (!next["electron-workspace-root-labels"] || typeof next["electron-workspace-root-labels"] !== "object") {
    next["electron-workspace-root-labels"] = {};
  }
  const label = path.win32.basename(workspace) || workspace;
  if (next["electron-workspace-root-labels"][workspace] !== label) {
    next["electron-workspace-root-labels"][workspace] = label;
    changes.push("electron-workspace-root-labels");
  }

  if (!next["thread-titles"] || typeof next["thread-titles"] !== "object") {
    next["thread-titles"] = {};
  }
  if (!next["thread-titles"].titles || typeof next["thread-titles"].titles !== "object") {
    next["thread-titles"].titles = {};
  }
  if (next["thread-titles"].titles[threadId] !== title) {
    next["thread-titles"].titles[threadId] = title;
    changes.push("thread-titles.titles");
  }
  const beforeOrder = JSON.stringify(next["thread-titles"].order || []);
  next["thread-titles"].order = prependUnique(next["thread-titles"].order, threadId);
  if (JSON.stringify(next["thread-titles"].order || []) !== beforeOrder) {
    changes.push("thread-titles.order");
  }

  return { state: next, changes };
}

function buildSessionIndexRepair(indexInfo, threadId, title, updatedIso) {
  const entry = { id: threadId, thread_name: title, updated_at: updatedIso };
  const serialized = JSON.stringify(entry);
  const retained = [];
  let removed = 0;

  for (const line of indexInfo.lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.id === threadId) {
        removed += 1;
        continue;
      }
    } catch {
      // Preserve malformed lines instead of silently dropping data.
    }
    retained.push(line);
  }

  retained.push(serialized);
  return {
    text: `${retained.join("\n")}\n`,
    entry,
    changes: removed === 1 && indexInfo.entries.some((item) => JSON.stringify(item.value) === serialized) ? [] : ["session_index.jsonl"],
    removed,
  };
}

function diagnostics(codexHome, threadId, workspace) {
  const state = readJsonSafe(path.join(codexHome, ".codex-global-state.json"), {});
  const indexInfo = readSessionIndex(codexHome);
  const thread = readThread(codexHome, threadId);
  return {
    dbThreadSource: thread?.thread_source ?? null,
    dbUpdatedAt: thread?.updated_at ?? null,
    dbUpdatedAtMs: thread?.updated_at_ms ?? null,
    rolloutFile: fileInfo(thread?.rollout_path),
    globalHasWorkspace: ["electron-saved-workspace-roots", "active-workspace-roots", "project-order"].reduce((acc, key) => {
      acc[key] = (Array.isArray(state[key]) ? state[key] : []).some((item) => normalizeForCompare(item) === normalizeForCompare(workspace));
      return acc;
    }, {}),
    globalTitle: state?.["thread-titles"]?.titles?.[threadId] || null,
    globalOrderContains: Boolean(state?.["thread-titles"]?.order?.includes(threadId)),
    sessionIndexEntries: indexInfo.entries
      .filter((entry) => entry.value && entry.value.id === threadId)
      .map((entry) => ({ lineNumber: entry.index + 1, value: entry.value })),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const thread = readThread(options.codexHome, options.threadId);
  if (!thread) {
    throw new Error(`Thread not found in state_5.sqlite: ${options.threadId}`);
  }
  if (Number(thread.archived) === 1) {
    throw new Error(`Thread is archived: ${options.threadId}`);
  }
  if (thread.thread_source && thread.thread_source !== "user") {
    throw new Error(`Refusing to repair non-user thread_source=${thread.thread_source} without a more specific repair mode.`);
  }

  const workspace = options.workspace || normalizeCwd(thread.cwd);
  const statePath = path.join(options.codexHome, ".codex-global-state.json");
  const state = readJsonSafe(statePath, {});
  const indexInfo = readSessionIndex(options.codexHome);
  const title = displayTitle(options, thread, state, indexInfo);
  const touchUpdatedAt = resolveTouchUpdatedAt(options.touchUpdatedAt);
  const updatedIso = touchUpdatedAt?.iso || threadUpdatedIso(thread);
  const before = diagnostics(options.codexHome, options.threadId, workspace);
  const globalRepair = buildGlobalStateRepair(state, options.threadId, workspace, title);
  const indexRepair = buildSessionIndexRepair(indexInfo, options.threadId, title, updatedIso);
  const plannedChanges = [...globalRepair.changes, ...indexRepair.changes];
  if (options.normalizeThreadSource && thread.thread_source !== "user") {
    plannedChanges.unshift("threads.thread_source");
  }
  if (touchUpdatedAt && Number(thread.updated_at_ms) !== touchUpdatedAt.ms) {
    plannedChanges.unshift("threads.updated_at");
  }
  const rolloutBefore = fileInfo(thread.rollout_path);
  if (touchUpdatedAt && rolloutBefore.exists && rolloutBefore.mtime !== touchUpdatedAt.iso) {
    plannedChanges.push("rollout_path.mtime");
  }

  let dbThreadSourceChanges = 0;
  let dbThreadTimestampChanges = 0;
  let rolloutMtimeChanges = 0;
  let backupDir = null;
  if (options.apply) {
    if (!options.allowRunning && isCodexRunning()) {
      throw new Error(
        "Codex is running. Close Codex first, or run through the after-close repair wrapper so the app cannot overwrite the repaired sidebar state."
      );
    }

    if (options.backup) {
      backupDir = backupCodexState(options.codexHome, thread);
    }

    if (options.normalizeThreadSource) {
      dbThreadSourceChanges = updateThreadSource(options.codexHome, options.threadId);
    }
    if (touchUpdatedAt) {
      dbThreadTimestampChanges = updateThreadTimestamp(options.codexHome, options.threadId, touchUpdatedAt);
      rolloutMtimeChanges = updateRolloutMtime(thread.rollout_path, touchUpdatedAt);
    }
    fs.writeFileSync(statePath, `${JSON.stringify(globalRepair.state, null, 2)}\n`, "utf8");
    fs.writeFileSync(indexInfo.indexPath, indexRepair.text, "utf8");
  }

  const result = {
    applied: options.apply,
    codexHome: options.codexHome,
    threadId: options.threadId,
    title,
    workspace,
    rolloutPath: thread.rollout_path,
    updatedIso,
    plannedChanges,
    dbThreadSourceChanges,
    dbThreadTimestampChanges,
    rolloutMtimeChanges,
    backupDir,
    before,
    after: options.apply ? diagnostics(options.codexHome, options.threadId, workspace) : null,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
