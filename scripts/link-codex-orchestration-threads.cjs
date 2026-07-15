#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const rootDir = path.resolve(__dirname, "..");

function usage() {
  console.error(`Usage:
  node --no-warnings scripts/link-codex-orchestration-threads.cjs --parent <thread-id> --child <thread-id> [options]

Options:
  --codex-home <path>     Codex home directory. Defaults to %USERPROFILE%\\.codex.
  --nickname <name>       Agent nickname shown by native Codex. Defaults to child project name/title.
  --role <role>           Agent role shown by native Codex. Defaults to project.
  --depth <n>             Subagent depth. Defaults to 1.
  --status <status>       thread_spawn_edges status. Defaults to open.
  --apply                 Write the DB and rollout session metadata.
  --allow-running         Allow writes while Codex is running.
  --no-backup             Skip backup before writing.
  --json                  Print machine-readable JSON only.`);
}

function parseArgs(argv) {
  const options = {
    codexHome: path.join(os.homedir(), ".codex"),
    nickname: "",
    role: "project",
    depth: 1,
    status: "open",
    apply: false,
    allowRunning: false,
    backup: true,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--parent") {
      options.parentThreadId = argv[++index];
    } else if (arg === "--child") {
      options.childThreadId = argv[++index];
    } else if (arg === "--codex-home") {
      options.codexHome = argv[++index];
    } else if (arg === "--nickname") {
      options.nickname = argv[++index];
    } else if (arg === "--role") {
      options.role = argv[++index];
    } else if (arg === "--depth") {
      options.depth = Number(argv[++index]);
    } else if (arg === "--status") {
      options.status = argv[++index];
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

  if (!options.parentThreadId || !options.childThreadId) {
    usage();
    process.exit(2);
  }
  if (options.parentThreadId === options.childThreadId) {
    throw new Error("Parent and child thread ids must be different.");
  }
  if (!Number.isInteger(options.depth) || options.depth < 1 || options.depth > 20) {
    throw new Error("--depth must be an integer from 1 through 20.");
  }

  options.codexHome = path.resolve(options.codexHome);
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

function fileInfo(filePath) {
  if (!filePath || !exists(filePath)) {
    return { path: filePath || null, exists: false };
  }
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    exists: true,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
  };
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
      }).trim()
    );
  } catch {
    return false;
  }
}

function readThread(db, threadId) {
  return db
    .prepare(
      [
        "SELECT id, title, cwd, rollout_path, source, thread_source, agent_nickname, agent_role, archived",
        "FROM threads",
        "WHERE id = ?",
      ].join(" ")
    )
    .get(threadId);
}

function readEdge(db, childThreadId) {
  return db
    .prepare("SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges WHERE child_thread_id = ?")
    .get(childThreadId);
}

function projectLabelFromThread(thread) {
  const cwd = String(thread?.cwd || "").replace(/^\\\\\?\\/, "");
  const title = String(thread?.title || "").replace(/\s+/g, " ").trim();
  if (title) {
    const match = /^\[([^\]]+)\]/.exec(title);
    if (match) {
      return match[1].slice(0, 80);
    }
  }
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return (parts[parts.length - 1] || title || "Project").slice(0, 80);
}

function makeSource(parentThreadId, nickname, role, depth) {
  return {
    subagent: {
      thread_spawn: {
        parent_thread_id: parentThreadId,
        depth,
        agent_path: null,
        agent_nickname: nickname,
        agent_role: role,
      },
    },
  };
}

function copyIfExists(source, target) {
  if (!source || !exists(source)) {
    return false;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return true;
}

function backupCodexState(codexHome, parent, child) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(rootDir, "codex-chat-backups", `orchestration-link-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });

  for (const file of ["state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm", "session_index.jsonl"]) {
    copyIfExists(path.join(codexHome, file), path.join(backupDir, file));
  }
  copyIfExists(parent.rollout_path, path.join(backupDir, "rollouts", `parent-${path.basename(parent.rollout_path || "")}`));
  copyIfExists(child.rollout_path, path.join(backupDir, "rollouts", `child-${path.basename(child.rollout_path || "")}`));

  fs.writeFileSync(
    path.join(backupDir, "metadata.json"),
    `${JSON.stringify({ parent: fileInfo(parent.rollout_path), child: fileInfo(child.rollout_path) }, null, 2)}\n`,
    "utf8"
  );
  return backupDir;
}

function patchRolloutSessionMeta(rolloutPath, source, nickname, role) {
  if (!rolloutPath || !exists(rolloutPath)) {
    return { changed: false, reason: "missing-rollout" };
  }
  const before = fs.readFileSync(rolloutPath, "utf8");
  const lines = before.split(/\r?\n/);
  let changed = false;
  let patchedLine = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim()) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      continue;
    }
    if (record.type !== "session_meta" || !record.payload || typeof record.payload !== "object") {
      continue;
    }
    record.payload.source = source;
    record.payload.thread_source = "subagent";
    record.payload.agent_nickname = nickname;
    record.payload.agent_role = role;
    lines[index] = JSON.stringify(record);
    changed = lines[index] !== raw;
    patchedLine = index + 1;
    break;
  }

  if (!changed) {
    return { changed: false, patchedLine, reason: patchedLine > 0 ? "already-current" : "session-meta-not-found" };
  }

  const after = lines.join("\n");
  const tempPath = `${rolloutPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, after, "utf8");
  fs.renameSync(tempPath, rolloutPath);
  return { changed: true, patchedLine };
}

function diagnostics(db, options, source, nickname, role) {
  const parent = readThread(db, options.parentThreadId);
  const child = readThread(db, options.childThreadId);
  const edge = readEdge(db, options.childThreadId);
  return {
    parent: parent
      ? { id: parent.id, title: parent.title, cwd: parent.cwd, archived: Boolean(parent.archived) }
      : null,
    child: child
      ? {
          id: child.id,
          title: child.title,
          cwd: child.cwd,
          rolloutPath: child.rollout_path,
          source: child.source,
          threadSource: child.thread_source,
          agentNickname: child.agent_nickname,
          agentRole: child.agent_role,
          archived: Boolean(child.archived),
        }
      : null,
    edge: edge || null,
    desired: {
      source,
      sourceJson: JSON.stringify(source),
      threadSource: "subagent",
      agentNickname: nickname,
      agentRole: role,
      edgeStatus: options.status,
    },
  };
}

function applyLink(db, options, source, nickname, role) {
  db.exec("BEGIN");
  try {
    const sourceJson = JSON.stringify(source);
    const threadResult = db
      .prepare(
        [
          "UPDATE threads",
          "SET source = ?, thread_source = 'subagent', agent_nickname = ?, agent_role = ?",
          "WHERE id = ?",
        ].join(" ")
      )
      .run(sourceJson, nickname, role, options.childThreadId);

    const edgeResult = db
      .prepare(
        [
          "INSERT INTO thread_spawn_edges(parent_thread_id, child_thread_id, status)",
          "VALUES (?, ?, ?)",
          "ON CONFLICT(child_thread_id) DO UPDATE SET",
          "parent_thread_id = excluded.parent_thread_id,",
          "status = excluded.status",
        ].join(" ")
      )
      .run(options.parentThreadId, options.childThreadId, options.status);

    db.exec("COMMIT");
    return {
      threadChanges: Number(threadResult.changes || 0),
      edgeChanges: Number(edgeResult.changes || 0),
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const dbPath = path.join(options.codexHome, "state_5.sqlite");
  if (!exists(dbPath)) {
    throw new Error(`Missing Codex database: ${dbPath}`);
  }

  const db = new DatabaseSync(dbPath);
  let backupDir = null;
  let applied = null;
  let rolloutPatch = null;
  try {
    const parent = readThread(db, options.parentThreadId);
    const child = readThread(db, options.childThreadId);
    if (!parent) {
      throw new Error(`Parent thread not found: ${options.parentThreadId}`);
    }
    if (!child) {
      throw new Error(`Child thread not found: ${options.childThreadId}`);
    }
    if (Number(parent.archived) === 1) {
      throw new Error(`Parent thread is archived: ${options.parentThreadId}`);
    }
    if (Number(child.archived) === 1) {
      throw new Error(`Child thread is archived: ${options.childThreadId}`);
    }

    const nickname = (options.nickname || projectLabelFromThread(child)).slice(0, 80);
    const role = (options.role || "project").slice(0, 80);
    const source = makeSource(options.parentThreadId, nickname, role, options.depth);
    const before = diagnostics(db, options, source, nickname, role);

    if (options.apply) {
      if (!options.allowRunning && isCodexRunning()) {
        throw new Error("Codex is running. Close Codex first, or run this through the close/stop/repair/relaunch workflow.");
      }
      if (options.backup) {
        backupDir = backupCodexState(options.codexHome, parent, child);
      }
      applied = applyLink(db, options, source, nickname, role);
      rolloutPatch = patchRolloutSessionMeta(child.rollout_path, source, nickname, role);
    }

    const after = options.apply ? diagnostics(db, options, source, nickname, role) : null;
    const result = {
      applied: options.apply,
      codexHome: options.codexHome,
      parentThreadId: options.parentThreadId,
      childThreadId: options.childThreadId,
      plannedChanges: ["threads.source", "threads.thread_source", "threads.agent", "thread_spawn_edges", "rollout.session_meta"],
      backupDir,
      dbChanges: applied,
      rolloutPatch,
      before,
      after,
    };

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
