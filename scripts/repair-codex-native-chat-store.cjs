#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { execFileSync } = require("child_process");

function usage() {
  console.error(`Usage:
  node scripts/repair-codex-native-chat-store.cjs [options]

Options:
  --codex-home <path>          Codex home. Defaults to %USERPROFILE%\\.codex.
  --apply                      Apply repairs. Default is dry-run only.
  --allow-running              Allow --apply while Codex processes are running.
  --skip-db                    Do not repair native DB visibility flags.
  --skip-rollouts              Do not repair duplicate leading session_meta records.
  --backup-root <path>         Backup/report root. Defaults to ./codex-recovery-backups.
  --rollout-backup <mode>      full, headers, or none. Default: headers.
  --json                       Print machine-readable JSON.

The repair does two things:
  1. Marks normal non-subagent chats as user-visible in state_5.sqlite.
  2. Removes duplicate leading session_meta lines from rollout JSONL files.
`);
}

function parseArgs(argv) {
  const options = {
    codexHome: path.join(os.homedir(), ".codex"),
    apply: false,
    allowRunning: false,
    skipDb: false,
    skipRollouts: false,
    backupRoot: path.resolve("codex-recovery-backups"),
    rolloutBackup: "headers",
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
    } else if (arg === "--skip-db") {
      options.skipDb = true;
    } else if (arg === "--skip-rollouts") {
      options.skipRollouts = true;
    } else if (arg === "--backup-root") {
      options.backupRoot = argv[++index];
    } else if (arg === "--rollout-backup") {
      options.rolloutBackup = argv[++index];
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!["full", "headers", "none"].includes(options.rolloutBackup)) {
    throw new Error(`Invalid --rollout-backup value: ${options.rolloutBackup}`);
  }

  options.codexHome = path.resolve(options.codexHome);
  options.backupRoot = path.resolve(options.backupRoot);
  return options;
}

function quoteSql(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqliteJson(dbPath, sql) {
  const output = execFileSync("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
  return output.length === 0 ? [] : JSON.parse(output);
}

function sqliteExec(dbPath, sql) {
  execFileSync("sqlite3", [dbPath], {
    input: sql,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function fileInfo(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      path: filePath,
      exists: true,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
    };
  } catch {
    return { path: filePath, exists: false };
  }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function isCodexRunning() {
  try {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('ChatGPT.exe','Codex.exe','codex.exe') } | Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
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

function findRolloutFiles(root) {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(p);
      }
    }
  }
  if (fs.existsSync(root)) {
    walk(root);
  }
  return files;
}

async function scanRollout(filePath) {
  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  let leadingSessionMeta = 0;
  let firstNonSessionMeta = null;
  let firstType = null;
  const leadingLines = [];

  for await (const line of rl) {
    if (line.length === 0) {
      continue;
    }
    lineNumber += 1;
    let type = null;
    try {
      type = JSON.parse(line).type ?? null;
    } catch {
      type = "PARSE_ERROR";
    }
    if (firstType == null) {
      firstType = type;
    }
    if (firstNonSessionMeta == null && type === "session_meta") {
      leadingSessionMeta += 1;
      leadingLines.push(line);
      continue;
    }
    firstNonSessionMeta = { lineNumber, type };
    break;
  }

  rl.close();
  input.destroy();

  let reason = null;
  if (firstType !== "session_meta") {
    reason = "first-not-session-meta";
  } else if (leadingSessionMeta > 1) {
    reason = "duplicate-leading-session-meta";
  }

  return {
    path: filePath,
    reason,
    leadingSessionMeta,
    firstNonSessionMeta,
    leadingLines,
    size: fs.statSync(filePath).size,
  };
}

async function scanRollouts(sessionsRoot) {
  const files = findRolloutFiles(sessionsRoot);
  const bad = [];
  for (const file of files) {
    const result = await scanRollout(file);
    if (result.reason) {
      bad.push(result);
    }
  }
  return { total: files.length, bad };
}

function relativeUnder(root, filePath) {
  const relative = path.relative(root, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path is outside root: ${filePath}`);
  }
  return relative;
}

async function repairRollout(filePath, sessionsRoot, backupDir, backupMode) {
  const scan = await scanRollout(filePath);
  if (scan.reason !== "duplicate-leading-session-meta") {
    return { path: filePath, changed: false, reason: scan.reason };
  }

  const relative = relativeUnder(sessionsRoot, filePath);
  const backupRelativeDir = path.join(backupDir, "rollouts", path.dirname(relative));
  ensureDir(backupRelativeDir);

  const removedLeadingLines = scan.leadingLines.slice(1);
  const headerBackupPath = path.join(
    backupRelativeDir,
    `${path.basename(filePath)}.removed-leading-session-meta.jsonl`,
  );
  if (backupMode === "headers" || backupMode === "full") {
    fs.writeFileSync(headerBackupPath, `${removedLeadingLines.join("\n")}\n`, "utf8");
  }

  let fullBackupPath = null;
  if (backupMode === "full") {
    fullBackupPath = path.join(backupRelativeDir, path.basename(filePath));
    fs.copyFileSync(filePath, fullBackupPath);
  }

  const tempPath = `${filePath}.repair-${process.pid}.tmp`;
  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const output = fs.createWriteStream(tempPath, { encoding: "utf8", flags: "wx" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let keptFirstSessionMeta = false;
  let skipped = 0;
  let wrote = 0;

  try {
    for await (const line of rl) {
      if (line.length === 0) {
        output.write("\n");
        wrote += 1;
        continue;
      }
      let type = null;
      try {
        type = JSON.parse(line).type ?? null;
      } catch {
        type = "PARSE_ERROR";
      }
      if (!keptFirstSessionMeta && type === "session_meta") {
        keptFirstSessionMeta = true;
        output.write(`${line}\n`);
        wrote += 1;
        continue;
      }
      if (keptFirstSessionMeta && type === "session_meta" && wrote === 1) {
        skipped += 1;
        continue;
      }
      output.write(`${line}\n`);
      wrote += 1;
    }
  } finally {
    rl.close();
    input.destroy();
    await new Promise((resolve, reject) => {
      output.end((error) => (error ? reject(error) : resolve()));
    });
  }

  fs.renameSync(tempPath, filePath);
  return {
    path: filePath,
    changed: true,
    skippedDuplicateSessionMeta: skipped,
    headerBackupPath,
    fullBackupPath,
  };
}

function backupDatabase(dbPath, backupDir) {
  ensureDir(backupDir);
  const backupPath = path.join(backupDir, "state_5.sqlite");
  execFileSync("sqlite3", [dbPath, `.backup ${quoteSql(backupPath)}`], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return backupPath;
}

function getDbVisibilityPlan(dbPath) {
  const humanishWhere = `
    archived = 0
    AND source NOT LIKE '{%subagent%'
    AND COALESCE(thread_source, '') != 'subagent'
  `;
  const hiddenWhere = `
    ${humanishWhere}
    AND (
      COALESCE(thread_source, '') = ''
      OR has_user_event = 0
    )
  `;
  const counts = {
    total: sqliteJson(dbPath, "SELECT count(*) AS count FROM threads;")[0]?.count ?? 0,
    visibleBefore:
      sqliteJson(
        dbPath,
        `SELECT count(*) AS count FROM threads WHERE ${humanishWhere} AND (thread_source = 'user' OR has_user_event = 1);`,
      )[0]?.count ?? 0,
    hiddenHumanish: sqliteJson(dbPath, `SELECT count(*) AS count FROM threads WHERE ${hiddenWhere};`)[0]?.count ?? 0,
  };
  const samples = sqliteJson(
    dbPath,
    `SELECT id, substr(title, 1, 110) AS title, source, thread_source, has_user_event, updated_at_ms
     FROM threads
     WHERE ${hiddenWhere}
     ORDER BY updated_at_ms DESC
     LIMIT 25;`,
  );
  return { counts, samples, humanishWhere, hiddenWhere };
}

function repairDbVisibility(dbPath) {
  sqliteExec(
    dbPath,
    `
    UPDATE threads
    SET
      thread_source = 'user',
      has_user_event = 1
    WHERE
      archived = 0
      AND source NOT LIKE '{%subagent%'
      AND COALESCE(thread_source, '') != 'subagent'
      AND (
        COALESCE(thread_source, '') = ''
        OR has_user_event = 0
      );
    `,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dbPath = path.join(options.codexHome, "state_5.sqlite");
  const sessionsRoot = path.join(options.codexHome, "sessions");
  if (!fs.existsSync(options.codexHome)) {
    throw new Error(`Codex home not found: ${options.codexHome}`);
  }
  if (!fs.existsSync(dbPath) && !options.skipDb) {
    throw new Error(`Codex state DB not found: ${dbPath}`);
  }

  const running = isCodexRunning();
  if (options.apply && running.length > 0 && !options.allowRunning) {
    throw new Error(
      `Refusing to apply while Codex is running (${running.map((process) => process.ProcessId).join(", ")}). Close Codex or pass --allow-running deliberately.`,
    );
  }

  const backupDir = path.join(options.backupRoot, `native-chat-store-repair-${stamp()}`);
  const result = {
    mode: options.apply ? "apply" : "dry-run",
    codexHome: options.codexHome,
    db: { path: dbPath, file: fileInfo(dbPath), backupPath: null, before: null, after: null },
    rollouts: {
      sessionsRoot,
      total: 0,
      badCount: 0,
      duplicateLeadingSessionMetaCount: 0,
      firstNotSessionMetaCount: 0,
      duplicateBytes: 0,
      samples: [],
      repaired: [],
    },
    runningCodexProcesses: running,
    backupDir: options.apply ? backupDir : null,
  };

  if (!options.skipDb) {
    result.db.before = getDbVisibilityPlan(dbPath);
    if (options.apply) {
      result.db.backupPath = backupDatabase(dbPath, path.join(backupDir, "db"));
      repairDbVisibility(dbPath);
      result.db.after = getDbVisibilityPlan(dbPath);
    }
  }

  if (!options.skipRollouts) {
    const scan = await scanRollouts(sessionsRoot);
    result.rollouts.total = scan.total;
    const duplicate = scan.bad.filter((item) => item.reason === "duplicate-leading-session-meta");
    const firstNot = scan.bad.filter((item) => item.reason === "first-not-session-meta");
    result.rollouts.badCount = scan.bad.length;
    result.rollouts.duplicateLeadingSessionMetaCount = duplicate.length;
    result.rollouts.firstNotSessionMetaCount = firstNot.length;
    result.rollouts.duplicateBytes = duplicate.reduce((total, item) => total + item.size, 0);
    result.rollouts.samples = scan.bad.slice(0, 25).map((item) => ({
      path: item.path,
      reason: item.reason,
      leadingSessionMeta: item.leadingSessionMeta,
      firstNonSessionMeta: item.firstNonSessionMeta,
      size: item.size,
    }));

    if (options.apply) {
      for (const item of duplicate) {
        result.rollouts.repaired.push(
          await repairRollout(item.path, sessionsRoot, backupDir, options.rolloutBackup),
        );
      }
    }
  }

  if (options.apply) {
    ensureDir(backupDir);
    fs.writeFileSync(path.join(backupDir, "repair-report.json"), JSON.stringify(result, null, 2));
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Mode: ${result.mode}`);
    console.log(`Codex home: ${result.codexHome}`);
    if (result.db.before) {
      console.log(
        `DB hidden human/user chats: ${result.db.before.counts.hiddenHumanish} (visible before: ${result.db.before.counts.visibleBefore})`,
      );
    }
    console.log(
      `Rollouts: ${result.rollouts.badCount}/${result.rollouts.total} abnormal; ${result.rollouts.duplicateLeadingSessionMetaCount} duplicate-leading-session_meta; ${result.rollouts.firstNotSessionMetaCount} first-not-session_meta; duplicate bytes ${(result.rollouts.duplicateBytes / 1024 / 1024).toFixed(1)} MB`,
    );
    if (options.apply) {
      console.log(`Backup/report: ${backupDir}`);
      if (result.db.after) {
        console.log(
          `DB hidden human/user chats after: ${result.db.after.counts.hiddenHumanish} (visible after: ${result.db.after.counts.visibleBefore})`,
        );
      }
      console.log(`Rollouts repaired: ${result.rollouts.repaired.length}`);
    } else if (running.length > 0) {
      console.log(`Codex is running; --apply will refuse unless you close it or pass --allow-running.`);
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
