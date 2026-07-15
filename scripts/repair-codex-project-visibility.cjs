#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const rootDir = path.resolve(__dirname, "..");

function usage() {
  console.error(`Usage:
  node --no-warnings scripts/repair-codex-project-visibility.cjs [options]

Options:
  --codex-home <path>        Codex home. Defaults to %USERPROFILE%\\.codex.
  --apply                    Write repairs. Default is dry-run only.
  --allow-running            Allow writes while Codex is running.
  --include-registered       Also rewrite projects already present in global state.
  --touch-updated-at-now     Touch representative thread timestamps to now.
  --materialize-workspaces   Create missing workspace folders referenced by visible chats.
  --backup-root <path>       Backup/report root. Defaults to ./codex-recovery-backups.
  --json                     Print machine-readable JSON.

This repairs existing Codex chats without importing duplicates. It mirrors the
native metadata written by the import flow: workspace roots, project order,
workspace labels, thread titles, session_index.jsonl, and blank thread_source.
`);
}

function parseArgs(argv) {
  const options = {
    codexHome: path.join(os.homedir(), ".codex"),
    apply: false,
    allowRunning: false,
    includeRegistered: false,
    touchUpdatedAtNow: false,
    materializeWorkspaces: false,
    backupRoot: path.resolve("codex-recovery-backups"),
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--codex-home") {
      options.codexHome = argv[++index];
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--allow-running") {
      options.allowRunning = true;
    } else if (arg === "--include-registered") {
      options.includeRegistered = true;
    } else if (arg === "--touch-updated-at-now") {
      options.touchUpdatedAtNow = true;
    } else if (arg === "--materialize-workspaces") {
      options.materializeWorkspaces = true;
    } else if (arg === "--backup-root") {
      options.backupRoot = argv[++index];
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.codexHome = path.resolve(options.codexHome);
  options.sqliteHome = resolveSqliteHome(options.codexHome);
  options.backupRoot = path.resolve(options.backupRoot);
  return options;
}

function resolveSqliteHome(codexHome) {
  const configPath = path.join(codexHome, "config.toml");
  try {
    const text = fs.readFileSync(configPath, "utf8");
    const match = text.match(/^\s*sqlite_home\s*=\s*(["'])(.*?)\1\s*$/m);
    if (!match?.[2]) {
      return codexHome;
    }
    return path.resolve(match[2].replace(/\\\\/g, "\\"));
  } catch {
    return codexHome;
  }
}

function exists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function stripExtendedPrefix(value) {
  const text = String(value || "");
  return text.startsWith("\\\\?\\") ? text.slice(4) : text;
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

function readSessionIndex(indexPath) {
  if (!exists(indexPath)) {
    return { lines: [], entries: [] };
  }
  const lines = fs.readFileSync(indexPath, "utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
  const entries = [];
  lines.forEach((line, index) => {
    try {
      entries.push({ index, line, value: JSON.parse(line) });
    } catch {
      entries.push({ index, line, value: null });
    }
  });
  return { lines, entries };
}

function titleForThread(thread, existingTitles, indexEntries) {
  const fromIndex = indexEntries
    .filter((entry) => entry.value && entry.value.id === thread.id && entry.value.thread_name)
    .map((entry) => String(entry.value.thread_name))
    .pop();
  if (fromIndex) {
    return compactTitle(fromIndex, thread.id);
  }
  const fromGlobal = existingTitles?.[thread.id];
  if (fromGlobal) {
    return compactTitle(fromGlobal, thread.id);
  }
  return compactTitle(thread.title || thread.first_user_message || thread.preview, thread.id);
}

function compactTitle(value, fallback) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return fallback;
  }
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function threadUpdatedIso(thread) {
  const ms = Number(thread.updated_at_ms) || Number(thread.updated_at) * 1000 || Date.now();
  return new Date(ms).toISOString();
}

function workspaceLabel(workspace) {
  return path.win32.basename(normalizeCwd(workspace)) || workspace;
}

function isMaterializableWorkspace(workspace) {
  const normalized = normalizeCwd(workspace);
  if (!normalized) {
    return false;
  }
  const basename = path.win32.basename(normalized).toLowerCase();
  if (normalized.includes("://") || basename === "workspace.json" || basename.endsWith(".code-workspace")) {
    return false;
  }
  const parsed = path.win32.parse(normalized);
  if (!path.win32.isAbsolute(normalized) || normalized === parsed.root) {
    return false;
  }
  return /^[a-z]:\\/i.test(normalized) || normalized.startsWith("\\\\");
}

function isCodexRunning() {
  if (process.platform !== "win32") {
    return [];
  }
  try {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        [
          "Get-CimInstance Win32_Process |",
          "Where-Object { $_.Name -in @('ChatGPT.exe','Codex.exe','codex.exe') } |",
          "Select-Object ProcessId,Name,ExecutablePath |",
          "ConvertTo-Json -Compress",
        ].join(" "),
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }
    ).trim();
    if (!output) {
      return [];
    }
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function sqliteBackup(sourceDb, targetDb) {
  fs.mkdirSync(path.dirname(targetDb), { recursive: true });
  execFileSync("sqlite3", [sourceDb, `.backup '${targetDb.replace(/'/g, "''")}'`], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function copyIfExists(source, target) {
  if (!exists(source)) {
    return false;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return true;
}

function backupCodexHome(codexHome, backupRoot, sqliteHome = codexHome) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(backupRoot, `project-visibility-repair-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });

  const dbPath = path.join(sqliteHome, "state_5.sqlite");
  if (exists(dbPath)) {
    sqliteBackup(dbPath, path.join(backupDir, "state_5.sqlite"));
  }
  for (const fileName of ["state_5.sqlite-wal", "state_5.sqlite-shm"]) {
    copyIfExists(path.join(sqliteHome, fileName), path.join(backupDir, fileName));
  }
  for (const fileName of [".codex-global-state.json", "session_index.jsonl"]) {
    copyIfExists(path.join(codexHome, fileName), path.join(backupDir, fileName));
  }
  return backupDir;
}

function globalProjectKeys(state) {
  const keys = new Set();
  for (const key of ["electron-saved-workspace-roots", "active-workspace-roots", "project-order", "pinned-project-ids"]) {
    for (const item of Array.isArray(state[key]) ? state[key] : []) {
      keys.add(normalizeForCompare(item));
    }
  }
  const labels = state["electron-workspace-root-labels"];
  if (labels && typeof labels === "object" && !Array.isArray(labels)) {
    for (const item of Object.keys(labels)) {
      keys.add(normalizeForCompare(item));
    }
  }
  return keys;
}

function visibleThreads(sqliteHome) {
  const dbPath = path.join(sqliteHome, "state_5.sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        [
          "SELECT id, title, first_user_message, preview, cwd, rollout_path, updated_at, updated_at_ms,",
          "source, thread_source, has_user_event, archived",
          "FROM threads",
          "WHERE archived = 0",
          "AND has_user_event = 1",
          "AND COALESCE(thread_source, 'user') = 'user'",
          "AND cwd IS NOT NULL",
          "AND cwd != ''",
          "ORDER BY COALESCE(updated_at_ms, updated_at * 1000, 0) DESC",
        ].join(" ")
      )
      .all();
    return rows.map((row) => {
      const workspace = normalizeCwd(row.cwd);
      const key = normalizeForCompare(workspace);
      return { ...row, workspace, projectKey: key };
    });
  } finally {
    db.close();
  }
}

function buildRepairs(options) {
  const statePath = path.join(options.codexHome, ".codex-global-state.json");
  const indexPath = path.join(options.codexHome, "session_index.jsonl");
  const state = readJsonSafe(statePath, {});
  const index = readSessionIndex(indexPath);
  const titles = state?.["thread-titles"]?.titles || {};
  const registered = globalProjectKeys(state);
  const allThreads = visibleThreads(options.sqliteHome)
    .filter((thread) => thread.projectKey)
    .map((thread) => ({
      ...thread,
      globalRegistered: registered.has(thread.projectKey),
      dbCwdNeedsNormalization: thread.cwd !== thread.workspace,
      workspaceExists: exists(thread.workspace),
      titleForSidebar: titleForThread(thread, titles, index.entries),
      updatedIso: threadUpdatedIso(thread),
    }));
  const repsByProject = new Map();
  for (const thread of allThreads) {
    if (!repsByProject.has(thread.projectKey)) {
      repsByProject.set(thread.projectKey, thread);
    }
  }
  const reps = [...repsByProject.values()].map((thread) => ({
    ...thread,
    projectThreadCount: allThreads.filter((candidate) => candidate.projectKey === thread.projectKey).length,
  }));

  const projectCandidates = reps.filter(
    (thread) =>
      options.includeRegistered ||
      !thread.globalRegistered ||
      thread.dbCwdNeedsNormalization ||
      (options.materializeWorkspaces && !thread.workspaceExists && isMaterializableWorkspace(thread.workspace)) ||
      !thread.thread_source ||
      thread.thread_source !== "user"
  );
  const candidateProjectKeys = new Set(projectCandidates.map((thread) => thread.projectKey));
  const rowCandidates = allThreads.filter(
    (thread) =>
      candidateProjectKeys.has(thread.projectKey) ||
      thread.dbCwdNeedsNormalization ||
      !thread.thread_source ||
      thread.thread_source !== "user"
  );

  return { state, statePath, index, indexPath, reps, candidates: projectCandidates, rowCandidates };
}

function buildNextState(state, candidates) {
  const next = state && typeof state === "object" ? structuredClone(state) : {};
  if (!next["electron-workspace-root-labels"] || typeof next["electron-workspace-root-labels"] !== "object") {
    next["electron-workspace-root-labels"] = {};
  }
  if (!next["thread-titles"] || typeof next["thread-titles"] !== "object") {
    next["thread-titles"] = {};
  }
  if (!next["thread-titles"].titles || typeof next["thread-titles"].titles !== "object") {
    next["thread-titles"].titles = {};
  }

  for (const thread of candidates) {
    for (const key of ["electron-saved-workspace-roots", "active-workspace-roots", "project-order"]) {
      next[key] = prependUnique(next[key], thread.workspace, normalizeForCompare);
    }
    next["electron-workspace-root-labels"][thread.workspace] = workspaceLabel(thread.workspace);
    next["thread-titles"].titles[thread.id] = thread.titleForSidebar;
    next["thread-titles"].order = prependUnique(next["thread-titles"].order, thread.id);
  }

  return next;
}

function buildNextSessionIndex(index, candidates, touchUpdatedAt) {
  const byId = new Map(
    candidates.map((thread) => [
      thread.id,
      {
        id: thread.id,
        thread_name: thread.titleForSidebar,
        updated_at: touchUpdatedAt?.iso || thread.updatedIso,
      },
    ])
  );
  const retained = [];
  for (const line of index.lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && byId.has(parsed.id)) {
        continue;
      }
    } catch {
      // Preserve malformed lines.
    }
    retained.push(line);
  }
  for (const entry of byId.values()) {
    retained.push(JSON.stringify(entry));
  }
  return `${retained.join("\n")}\n`;
}

function updateDb(options, rowCandidates, touchUpdatedAt) {
  const db = new DatabaseSync(path.join(options.sqliteHome, "state_5.sqlite"));
  try {
    const updateSource = db.prepare("UPDATE threads SET thread_source = 'user' WHERE id = ? AND (thread_source IS NULL OR thread_source = '')");
    const updateCwd = db.prepare("UPDATE threads SET cwd = ? WHERE id = ? AND cwd != ?");
    const updateTime = db.prepare("UPDATE threads SET updated_at = ?, updated_at_ms = ?, recency_at = ?, recency_at_ms = ? WHERE id = ?");
    let sourceChanges = 0;
    let cwdChanges = 0;
    let timestampChanges = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const thread of rowCandidates) {
        sourceChanges += updateSource.run(thread.id).changes;
        if (thread.dbCwdNeedsNormalization) {
          cwdChanges += updateCwd.run(thread.workspace, thread.id, thread.workspace).changes;
        }
        if (touchUpdatedAt) {
          timestampChanges += updateTime.run(
            touchUpdatedAt.seconds,
            touchUpdatedAt.ms,
            touchUpdatedAt.seconds,
            touchUpdatedAt.ms,
            thread.id
          ).changes;
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { sourceChanges, cwdChanges, timestampChanges };
  } finally {
    db.close();
  }
}

function materializeWorkspaces(candidates, enabled) {
  if (!enabled) {
    return [];
  }
  const created = [];
  const seen = new Set();
  for (const thread of candidates) {
    const workspace = normalizeCwd(thread.workspace);
    const key = normalizeForCompare(workspace);
    if (seen.has(key) || exists(workspace) || !isMaterializableWorkspace(workspace)) {
      continue;
    }
    fs.mkdirSync(workspace, { recursive: true });
    created.push(workspace);
    seen.add(key);
  }
  return created;
}

function touchRolloutFiles(candidates, touchUpdatedAt) {
  if (!touchUpdatedAt) {
    return 0;
  }
  let changed = 0;
  const date = new Date(touchUpdatedAt.ms);
  for (const thread of candidates) {
    if (thread.rollout_path && exists(thread.rollout_path)) {
      fs.utimesSync(thread.rollout_path, date, date);
      changed += 1;
    }
  }
  return changed;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const running = isCodexRunning();
  if (options.apply && running.length && !options.allowRunning) {
    throw new Error(
      [
        "Codex is running. Close Codex first, or run this through the close/stop/repair/relaunch workflow.",
        `Running Codex processes: ${running.slice(0, 8).map((item) => `${item.Name}:${item.ProcessId}`).join(", ")}`,
      ].join("\n")
    );
  }

  const touchUpdatedAt = options.touchUpdatedAtNow
    ? (() => {
        const ms = Date.now();
        return { ms, seconds: Math.floor(ms / 1000), iso: new Date(ms).toISOString() };
      })()
    : null;
  const repair = buildRepairs(options);
  const nextState = buildNextState(repair.state, repair.candidates);
  const nextIndexText = buildNextSessionIndex(repair.index, repair.candidates, touchUpdatedAt);
  let backupDir = null;
  let dbChanges = { sourceChanges: 0, cwdChanges: 0, timestampChanges: 0 };
  let rolloutMtimeChanges = 0;
  let createdWorkspaces = [];

  if (options.apply && (repair.candidates.length || repair.rowCandidates.length)) {
    backupDir = backupCodexHome(options.codexHome, options.backupRoot, options.sqliteHome);
    createdWorkspaces = materializeWorkspaces(repair.candidates, options.materializeWorkspaces);
    dbChanges = updateDb(options, repair.rowCandidates, touchUpdatedAt);
    rolloutMtimeChanges = touchRolloutFiles(repair.candidates, touchUpdatedAt);
    fs.writeFileSync(repair.statePath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
    fs.writeFileSync(repair.indexPath, nextIndexText, "utf8");
  }

  const result = {
    applied: options.apply,
    codexHome: options.codexHome,
    sqliteHome: options.sqliteHome,
    representativeProjects: repair.reps.length,
    alreadyGlobalRegistered: repair.reps.filter((thread) => thread.globalRegistered).length,
    missingGlobalRegistration: repair.reps.filter((thread) => !thread.globalRegistered).length,
    dbCwdNeedsNormalization: repair.reps.filter((thread) => thread.dbCwdNeedsNormalization).length,
    missingWorkspaceFolders: repair.reps.filter((thread) => !thread.workspaceExists).length,
    repairCandidates: repair.candidates.length,
    repairRowCandidates: repair.rowCandidates.length,
    dbRowsNeedingCwdNormalization: repair.rowCandidates.filter((thread) => thread.dbCwdNeedsNormalization).length,
    blankThreadSourceCandidates: repair.candidates.filter((thread) => !thread.thread_source).length,
    touchUpdatedAt: touchUpdatedAt?.iso || null,
    backupDir,
    dbChanges,
    createdWorkspaces,
    rolloutMtimeChanges,
    sample: repair.candidates.slice(0, 25).map((thread) => ({
      threadId: thread.id,
      workspace: thread.workspace,
      title: thread.titleForSidebar,
      globalRegistered: thread.globalRegistered,
      dbCwdNeedsNormalization: thread.dbCwdNeedsNormalization,
      workspaceExists: thread.workspaceExists,
      threadSource: thread.thread_source || "",
    })),
  };

  const output = options.json ? JSON.stringify(result, null, 2) : JSON.stringify(result, null, 2);
  process.stdout.write(`${output}\n`);
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
