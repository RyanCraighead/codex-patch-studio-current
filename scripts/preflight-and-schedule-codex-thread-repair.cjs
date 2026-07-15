#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const rootDir = path.resolve(__dirname, "..");
const repairResultsDir = path.join(rootDir, "codex-repair-results");

function usage() {
  console.error("Usage: node scripts/preflight-and-schedule-codex-thread-repair.cjs --job-path <path> --log-path <path>");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--job-path") {
      options.jobPath = argv[++index];
    } else if (arg === "--log-path") {
      options.logPath = argv[++index];
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.jobPath || !options.logPath) {
    usage();
    process.exit(2);
  }
  options.jobPath = path.resolve(options.jobPath);
  options.logPath = path.resolve(options.logPath);
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

function log(logPath, message) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fileInfo(filePath) {
  if (!exists(filePath)) {
    return { path: filePath, exists: false };
  }
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    exists: true,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}

function timestampStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function copyCodexHomeForPreflight(codexHome) {
  const tempHome = path.join(repairResultsDir, "preflight-codex-home", timestampStamp());
  fs.mkdirSync(tempHome, { recursive: true });

  const sourceDb = path.join(codexHome, "state_5.sqlite");
  const targetDb = path.join(tempHome, "state_5.sqlite");
  if (exists(sourceDb)) {
    execFileSync("sqlite3", [sourceDb, `.backup '${targetDb.replace(/'/g, "''")}'`], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  for (const file of [".codex-global-state.json", "session_index.jsonl"]) {
    const source = path.join(codexHome, file);
    if (exists(source)) {
      fs.copyFileSync(source, path.join(tempHome, file));
    }
  }

  return tempHome;
}

function copyRolloutIntoPreflightHome({ codexHome, tempCodexHome, threadId, rolloutPath }) {
  if (!rolloutPath || !exists(rolloutPath)) {
    return null;
  }

  const relative = path.relative(codexHome, rolloutPath);
  const target =
    relative && !relative.startsWith("..") && !path.isAbsolute(relative)
      ? path.join(tempCodexHome, relative)
      : path.join(tempCodexHome, "rollouts", path.basename(rolloutPath));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(rolloutPath, target);
  const stat = fs.statSync(rolloutPath);
  fs.utimesSync(target, stat.atime, stat.mtime);

  const db = new DatabaseSync(path.join(tempCodexHome, "state_5.sqlite"));
  try {
    db.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(target, threadId);
  } finally {
    db.close();
  }

  return target;
}

function runRepairJson(args, logPath, label, timeoutMs = 120000) {
  const command = [path.join(rootDir, "scripts", "repair-codex-thread-index.cjs"), ...args];
  log(logPath, `${label}: node ${command.join(" ")}`);
  let output;
  try {
    output = execFileSync(process.execPath, command, {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 10,
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(
      [
        `${label} failed.`,
        `command: node ${command.join(" ")}`,
        `status: ${error.status}`,
        `stdout: ${String(error.stdout || "").slice(-4000)}`,
        `stderr: ${String(error.stderr || "").slice(-4000)}`,
      ].join("\n")
    );
  }
  log(logPath, `${label}: stdout ${output.length} byte(s)`);
  return JSON.parse(output);
}

function repairArgsForItem(item, modeArgs = []) {
  const args = ["--thread-id", item.threadId, ...modeArgs];
  if (item.workspace) {
    args.push("--workspace", item.workspace);
  }
  if (item.title) {
    args.push("--title", item.title);
  }
  if (item.normalizeThreadSource) {
    args.push("--normalize-thread-source");
  }
  if (item.touchUpdatedAtNow) {
    args.push("--touch-updated-at-now");
  } else if (item.touchUpdatedAt) {
    args.push("--touch-updated-at", item.touchUpdatedAt);
  }
  return args;
}

function startHiddenPowerShell(args, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const out = fs.openSync(outputPath, "a");
  let closed = false;
  const closeOutput = () => {
    if (!closed) {
      closed = true;
      fs.closeSync(out);
    }
  };
  const child = spawn("powershell.exe", args, {
    cwd: rootDir,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  const completion = new Promise((resolve, reject) => {
    child.on("error", (error) => {
      closeOutput();
      error.pid = child.pid;
      reject(error);
    });
    child.on("exit", (code, signal) => {
      closeOutput();
      resolve({ code, signal });
    });
  });
  return { pid: child.pid, completion };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const job = JSON.parse(fs.readFileSync(options.jobPath, "utf8"));
  const items = Array.isArray(job.items) ? job.items : job.threadId ? [job] : [];
  if (!items.length) {
    throw new Error("Repair job has no items.");
  }

  const preflightPath =
    job.preflightPath || path.join(path.dirname(options.jobPath), `${path.basename(options.jobPath, ".json")}.preflight.json`);
  log(options.logPath, `Starting background preflight for ${items.length} thread repair(s).`);
  log(options.logPath, `Process pid=${process.pid} node=${process.version} cwd=${process.cwd()} root=${rootDir}`);
  log(options.logPath, `Job path: ${options.jobPath}`);
  log(options.logPath, `Preflight path: ${preflightPath}`);
  log(options.logPath, `Job JSON: ${JSON.stringify(job)}`);

  const preflight = {
    status: "running",
    createdAt: job.createdAt || new Date().toISOString(),
    startedAt: new Date().toISOString(),
    tempCodexHome: null,
    sourceFiles: {
      db: fileInfo(path.join(job.codexHome, "state_5.sqlite")),
      globalState: fileInfo(path.join(job.codexHome, ".codex-global-state.json")),
      sessionIndex: fileInfo(path.join(job.codexHome, "session_index.jsonl")),
    },
    validations: [],
  };
  writeJson(preflightPath, preflight);

  preflight.tempCodexHome = copyCodexHomeForPreflight(job.codexHome);
  preflight.tempFiles = {
    db: fileInfo(path.join(preflight.tempCodexHome, "state_5.sqlite")),
    globalState: fileInfo(path.join(preflight.tempCodexHome, ".codex-global-state.json")),
    sessionIndex: fileInfo(path.join(preflight.tempCodexHome, "session_index.jsonl")),
  };
  writeJson(preflightPath, preflight);
  log(options.logPath, `Copied Codex home for preflight: ${preflight.tempCodexHome}`);

  const validatedItems = [];
  for (const [index, item] of items.entries()) {
    if (!item.threadId) {
      throw new Error(`Repair item ${index + 1} is missing threadId.`);
    }

    log(options.logPath, `Preflight dry run ${index + 1}/${items.length}: ${item.threadId}`);
    const dryRun = runRepairJson(repairArgsForItem(item, ["--json"]), options.logPath, `dry-run ${index + 1}`);
    if (!dryRun.rolloutPath) {
      throw new Error(`Repair item ${index + 1} has no rollout path: ${item.threadId}`);
    }
    log(options.logPath, `Dry run result ${index + 1}: ${JSON.stringify(dryRun)}`);

    const preflightRolloutPath = copyRolloutIntoPreflightHome({
      codexHome: job.codexHome,
      tempCodexHome: preflight.tempCodexHome,
      threadId: item.threadId,
      rolloutPath: dryRun.rolloutPath,
    });
    log(options.logPath, `Preflight rollout copy ${index + 1}: ${preflightRolloutPath || "none"}`);

    const validatedItem = {
      ...item,
      workspace: dryRun.workspace,
      title: dryRun.title,
    };

    log(options.logPath, `Validating ${index + 1}/${items.length}: ${validatedItem.threadId}`);
    const validation = runRepairJson(
      repairArgsForItem(validatedItem, [
        "--codex-home",
        preflight.tempCodexHome,
        "--apply",
        "--allow-running",
        "--no-backup",
        "--json",
      ]),
      options.logPath,
      `validation ${index + 1}`
    );
    log(options.logPath, `Validation result ${index + 1}: ${JSON.stringify(validation)}`);

    validatedItems.push(validatedItem);
    preflight.validations.push({
      threadId: validation.threadId,
      title: validation.title,
      workspace: validation.workspace,
      rolloutPath: validation.rolloutPath,
      updatedIso: validation.updatedIso,
      plannedChanges: validation.plannedChanges,
      before: validation.before,
      after: validation.after,
    });
    writeJson(preflightPath, preflight);
  }

  const repairLogPath = path.resolve(
    job.repairLogPath || path.join(path.dirname(options.jobPath), `${path.basename(options.jobPath, ".json")}.repair.log`)
  );
  preflight.status = "passed";
  preflight.completedAt = new Date().toISOString();
  preflight.repairLogPath = repairLogPath;
  const updatedJob = {
    ...job,
    preflightPath,
    repairLogPath,
    stopCodex: job.stopCodex !== false,
    preflightCompletedAt: preflight.completedAt,
    items: validatedItems,
  };
  writeJson(options.jobPath, updatedJob);

  const scriptPath = path.join(rootDir, "scripts", "run-codex-thread-repair-after-close.ps1");
  const psArgs = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-File",
    scriptPath,
    "-JobPath",
    options.jobPath,
    "-LogPath",
    repairLogPath,
  ];
  if (updatedJob.stopCodex) {
    psArgs.push("-StopCodex");
  }
  if (job.noRestartApp) {
    psArgs.push("-NoRestartApp");
  }
  log(options.logPath, `PowerShell repair script: ${scriptPath}`);
  log(options.logPath, `PowerShell args: ${JSON.stringify(psArgs)}`);
  writeJson(preflightPath, preflight);

  const repairPowerShellLogPath = `${repairLogPath}.powershell.log`;
  const repair = startHiddenPowerShell(psArgs, repairPowerShellLogPath);
  preflight.repairPid = repair.pid;
  preflight.repairStartedAt = new Date().toISOString();
  preflight.repairPowerShellLogPath = repairPowerShellLogPath;
  writeJson(preflightPath, preflight);
  log(
    options.logPath,
    `Preflight passed. Running hidden stop/repair/relaunch job as PowerShell PID ${repair.pid}. Repair log: ${repairLogPath}. PowerShell log: ${repairPowerShellLogPath}`
  );

  const result = await repair.completion;
  preflight.repairExitedAt = new Date().toISOString();
  preflight.repairExitCode = result.code;
  preflight.repairExitSignal = result.signal || null;
  writeJson(preflightPath, preflight);
  log(
    options.logPath,
    `Repair PowerShell PID ${repair.pid} exited with code ${result.code}${result.signal ? ` signal ${result.signal}` : ""}.`
  );
  if (result.code !== 0) {
    throw new Error(`Repair PowerShell exited with code ${result.code}. See ${repairLogPath} and ${repairPowerShellLogPath}`);
  }
}

main().catch((error) => {
  const message = error.stack || error.message;
  try {
    const options = parseArgs(process.argv.slice(2));
    log(options.logPath, `ERROR: ${message}`);
    const job = exists(options.jobPath) ? JSON.parse(fs.readFileSync(options.jobPath, "utf8")) : {};
    const preflightPath =
      job.preflightPath || path.join(path.dirname(options.jobPath), `${path.basename(options.jobPath, ".json")}.preflight.json`);
    writeJson(preflightPath, {
      status: "failed",
      failedAt: new Date().toISOString(),
      error: message,
    });
  } catch {
    // Keep the original failure as the process exit signal.
  }
  console.error(message);
  process.exit(1);
});
