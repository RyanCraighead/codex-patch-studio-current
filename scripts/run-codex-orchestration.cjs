#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const orchestrationWorkspacesDir = path.join(rootDir, "codex-orchestrations", "workspaces");

function usage() {
  console.error("Usage: node scripts/run-codex-orchestration.cjs --run-path <path>");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--run-path") {
      options.runPath = argv[++index];
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.runPath) {
    usage();
    process.exit(2);
  }
  options.runPath = path.resolve(options.runPath);
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonSafe(filePath) {
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function nowIso() {
  return new Date().toISOString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compact(value, limit = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function makeTextInput(text) {
  return [{ type: "text", text, text_elements: [] }];
}

function appendLog(run, message) {
  const logPath = run.logPath || path.join(path.dirname(run.runPath || "."), `${run.id || "orchestration"}.log`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${nowIso()} ${message}\n`, "utf8");
}

function patchRun(runPath, updater) {
  const run = readJson(runPath);
  const next = updater(run) || run;
  next.updatedAt = nowIso();
  writeJson(runPath, next);
  return next;
}

function patchChild(runPath, index, updater) {
  return patchRun(runPath, (run) => {
    const child = run.children[index];
    if (!child) return run;
    updater(child, run);
    child.updatedAt = nowIso();
    return run;
  });
}

function findCodexCliExe() {
  const launcherConfig = readJsonSafe(path.join(rootDir, "codex-launcher.local.json"));
  const configuredCli = launcherConfig?.resourcesDir ? path.join(launcherConfig.resourcesDir, "codex.exe") : null;
  if (configuredCli && exists(configuredCli)) {
    return configuredCli;
  }

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
  const candidates = [];
  if (exists(binRoot)) {
    for (const entry of fs.readdirSync(binRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.push(path.join(binRoot, entry.name, "codex.exe"));
      }
    }
  }
  candidates.push(path.join(binRoot, "codex.exe"));

  const existing = candidates
    .filter(exists)
    .map((candidate) => ({ candidate, mtime: fs.statSync(candidate).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return existing[0]?.candidate || "codex";
}

function orchestrationWorkspaceForRun(run) {
  const safeId = String(run.id || `run-${Date.now()}`).replace(/[^a-zA-Z0-9_.-]/g, "");
  const workspace = path.join(orchestrationWorkspacesDir, safeId || `run-${Date.now()}`);
  fs.mkdirSync(workspace, { recursive: true });
  return workspace;
}

function parentPromptForRun(run) {
  const children = Array.isArray(run.children) ? run.children : [];
  const childLines = children
    .map((child) => {
      const threadPart = child.threadId ? ` thread ${child.threadId}` : "";
      return `- ${child.projectLabel}: ${child.projectPath}${threadPart}`;
    })
    .join("\n");
  return [
    "You are the parent Codex agent for a multi-project orchestration.",
    "",
    `Orchestration: ${run.title || run.id || "Multi-project orchestration"}`,
    "",
    "User request:",
    String(run.prompt || "").trim(),
    "",
    "Spawned project chats:",
    childLines || "- No project chats have been created yet.",
    "",
    "Use the spawned project chats as the project-specific workers for this run. Keep this parent chat focused on coordination, status, blockers, and final synthesis.",
  ].join("\n");
}

function startParamsForParent(run, cwd) {
  return {
    input: [],
    cwd,
    workspaceRoots: [cwd],
    workspaceKind: "projectless",
    projectlessOutputDirectory: cwd,
    threadSource: "user",
  };
}

async function createParentThread({ client, runPath, run }) {
  if (run.parentThreadId) {
    appendLog(run, `Using existing parent orchestration thread: ${run.parentThreadId}`);
    return run;
  }

  const orchestrationCwd = run.orchestrationCwd || orchestrationWorkspaceForRun(run);
  patchRun(runPath, (current) => {
    current.status = "starting-parent";
    current.orchestrationCwd = orchestrationCwd;
    return current;
  });
  appendLog(run, `Starting parent orchestration thread in ${orchestrationCwd}`);

  const started = await client.request("thread/start", startParamsForParent(run, orchestrationCwd), 90000);
  const threadId = started?.thread?.id;
  if (!threadId) {
    throw new Error("thread/start returned no parent orchestration thread id.");
  }
  await client.request("thread/name/set", { threadId, name: run.title || "Multi-project orchestration" });

  return patchRun(runPath, (current) => {
    current.parentThreadId = threadId;
    current.orchestrationCwd = orchestrationCwd;
    current.status = "running";
    return current;
  });
}

function linkChildToParent({ runPath, run, child, index }) {
  if (!run.parentThreadId || !child.threadId) {
    return null;
  }

  const command = [
    path.join(rootDir, "scripts", "link-codex-orchestration-threads.cjs"),
    "--codex-home",
    run.codexHome || path.join(os.homedir(), ".codex"),
    "--parent",
    run.parentThreadId,
    "--child",
    child.threadId,
    "--nickname",
    child.projectLabel || "Project",
    "--role",
    "project",
    "--apply",
    "--allow-running",
    "--no-backup",
    "--json",
  ];

  try {
    const output = execFileSync(process.execPath, command, {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 5,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = JSON.parse(output);
    patchChild(runPath, index, (record) => {
      record.parentThreadId = run.parentThreadId;
      record.linkedAsSubagent = true;
      record.linkResult = {
        dbChanges: result.dbChanges || null,
        rolloutPatch: result.rolloutPatch || null,
      };
    });
    appendLog(run, `Linked child ${child.threadId} to parent ${run.parentThreadId}`);
    return result;
  } catch (error) {
    const message = `${error.message || error}`;
    patchChild(runPath, index, (record) => {
      record.parentThreadId = run.parentThreadId;
      record.linkedAsSubagent = false;
      record.linkError = message;
    });
    appendLog(run, `Failed to link child ${child.threadId} to parent ${run.parentThreadId}: ${message}`);
    return null;
  }
}

async function startParentTurn({ client, runPath, run }) {
  if (!run.parentThreadId || run.parentTurnId || !run.startTurns) {
    return;
  }
  const prompt = parentPromptForRun(run);
  patchRun(runPath, (current) => {
    current.parentStatus = "starting-turn";
    return current;
  });
  appendLog(run, `Starting parent orchestration turn in ${run.parentThreadId}`);
  try {
    const turn = await client.request(
      "turn/start",
      {
        threadId: run.parentThreadId,
        input: makeTextInput(prompt),
        cwd: run.orchestrationCwd || orchestrationWorkspaceForRun(run),
      },
      90000
    );
    const turnId = turn?.turn?.id || null;
    patchRun(runPath, (current) => {
      current.parentTurnId = turnId;
      current.parentStatus = "in-progress";
      return current;
    });
    appendLog(run, `Started parent orchestration turn ${turnId || "(unknown)"}.`);
  } catch (error) {
    patchRun(runPath, (current) => {
      current.parentStatus = "failed";
      current.parentError = error.stack || error.message;
      return current;
    });
    appendLog(run, `Failed to start parent orchestration turn: ${error.stack || error.message}`);
  }
}

class AppServerClient {
  constructor({ codexHome, exe }) {
    this.codexHome = codexHome;
    this.exe = exe;
    this.nextId = 1;
    this.responses = new Map();
    this.notifications = [];
    this.stderr = "";
    this.stdout = "";
    this.child = null;
  }

  start() {
    this.child = spawn(this.exe, ["app-server", "--listen", "stdio://"], {
      cwd: rootDir,
      env: { ...process.env, CODEX_HOME: this.codexHome },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk.toString()));
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
    });
  }

  onStdout(chunk) {
    this.stdout += chunk;
    let index;
    while ((index = this.stdout.indexOf("\n")) >= 0) {
      const raw = this.stdout.slice(0, index);
      this.stdout = this.stdout.slice(index + 1);
      if (!raw.trim()) continue;
      try {
        const message = JSON.parse(raw);
        if (message.id !== undefined) {
          this.responses.set(message.id, message);
        } else {
          this.notifications.push(message);
        }
      } catch {
        this.stderr += `\nUnparsed stdout: ${raw.slice(0, 500)}`;
      }
    }
  }

  async initialize() {
    return this.request("initialize", {
      clientInfo: { name: "codex-orchestrator", title: "Codex Orchestrator", version: "0.0.0" },
      capabilities: null,
    });
  }

  request(method, params, timeoutMs = 60000) {
    if (!this.child) {
      throw new Error("App-server process has not started.");
    }
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (this.responses.has(id)) {
          clearInterval(timer);
          const response = this.responses.get(id);
          this.responses.delete(id);
          if (response.error) {
            reject(new Error(`${method} failed: ${response.error.message || JSON.stringify(response.error)}`));
          } else {
            resolve(response.result);
          }
          return;
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`Timed out waiting for ${method}. ${this.stderr.slice(-2000)}`));
        }
      }, 50);
    });
  }

  stop() {
    try {
      this.child?.kill();
    } catch {
      // Ignore shutdown failures.
    }
  }
}

function startParamsForChild(child) {
  return {
    input: [],
    cwd: child.projectPath,
    workspaceRoots: [child.projectPath],
    workspaceKind: "project",
    threadSource: "subagent",
  };
}

async function createChildThread({ client, runPath, child, index, run }) {
  patchChild(runPath, index, (record) => {
    record.status = "starting-thread";
    record.error = null;
  });
  appendLog(run, `Starting child ${index + 1}/${run.children.length}: ${child.projectLabel} (${child.projectPath})`);

  const started = await client.request("thread/start", startParamsForChild(child));
  const threadId = started?.thread?.id;
  if (!threadId) {
    throw new Error(`thread/start returned no thread id for ${child.projectPath}`);
  }

  patchChild(runPath, index, (record) => {
    record.threadId = threadId;
    record.createdAt = nowIso();
    record.status = "naming-thread";
  });
  child.threadId = threadId;

  await client.request("thread/name/set", { threadId, name: child.title });
  linkChildToParent({ runPath, run, child, index });

  if (!run.startTurns) {
    patchChild(runPath, index, (record) => {
      record.status = "created";
    });
    appendLog(run, `Created child thread ${threadId} for ${child.projectLabel}`);
    return;
  }

  patchChild(runPath, index, (record) => {
    record.status = "starting-turn";
  });
  const turn = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: child.prompt }],
    cwd: child.projectPath,
  });
  const turnId = turn?.turn?.id || null;
  child.turnId = turnId;
  patchChild(runPath, index, (record) => {
    record.turnId = turnId;
    record.status = "in-progress";
  });
  appendLog(run, `Started child turn ${turnId || "(unknown)"} in thread ${threadId} for ${child.projectLabel}`);
}

async function readTurnStatus(client, child) {
  if (!child.threadId || !child.turnId) {
    return null;
  }
  const result = await client.request(
    "thread/read",
    {
      threadId: child.threadId,
      includeTurns: true,
    },
    60000
  );
  const turns = result?.thread?.turns || [];
  const turn = turns.find((item) => item.id === child.turnId) || turns.at(-1) || null;
  return turn
    ? {
        status: turn.status || null,
        error: turn.error ? compact(turn.error.message || JSON.stringify(turn.error), 600) : null,
      }
    : null;
}

async function monitorTurns({ client, runPath, run }) {
  if (!run.startTurns) {
    return;
  }
  const started = Date.now();
  const maxRuntimeMs = Number(run.maxRuntimeMs || 12 * 60 * 60 * 1000);
  const pollIntervalMs = Number(run.pollIntervalMs || 15000);
  while (Date.now() - started < maxRuntimeMs) {
    const current = readJson(runPath);
    const active = current.children
      .map((child, index) => ({ child, index }))
      .filter(({ child }) => child.status === "in-progress" && child.threadId && child.turnId);
    if (!active.length) {
      return;
    }

    for (const { child, index } of active) {
      try {
        const status = await readTurnStatus(client, child);
        if (!status || status.status === "inProgress" || status.status === "in-progress") {
          continue;
        }
        patchChild(runPath, index, (record) => {
          record.status = status.status === "completed" ? "completed" : "failed";
          record.error = status.error;
        });
        appendLog(current, `Child ${child.projectLabel} turn finished with status ${status.status}`);
      } catch (error) {
        patchChild(runPath, index, (record) => {
          record.status = "monitor-error";
          record.error = error.stack || error.message;
        });
        appendLog(current, `Monitor error for ${child.projectLabel}: ${error.stack || error.message}`);
      }
    }
    await delay(pollIntervalMs);
  }

  patchRun(runPath, (current) => {
    for (const child of current.children) {
      if (child.status === "in-progress") {
        child.status = "monitor-timeout";
        child.error = `Runner stopped monitoring after ${Math.round(maxRuntimeMs / 60000)} minutes.`;
      }
    }
    return current;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let run = readJson(options.runPath);
  run.runPath = options.runPath;
  appendLog(run, `Starting orchestration runner for ${run.id}`);

  const exe = findCodexCliExe();
  run = patchRun(options.runPath, (current) => {
    current.status = "running";
    current.startedAt = current.startedAt || nowIso();
    current.codexExe = exe;
    return current;
  });

  const client = new AppServerClient({ codexHome: run.codexHome || path.join(os.homedir(), ".codex"), exe });
  const stopClient = () => client.stop();
  process.once("exit", stopClient);
  process.once("SIGINT", () => {
    stopClient();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    stopClient();
    process.exit(143);
  });
  try {
    client.start();
    const init = await client.initialize();
    appendLog(run, `App-server initialized: ${init.userAgent || exe}`);
    run = await createParentThread({ client, runPath: options.runPath, run });

    for (let index = 0; index < run.children.length; index += 1) {
      run = readJson(options.runPath);
      const child = run.children[index];
      if (child.threadId) {
        appendLog(run, `Skipping existing child thread for ${child.projectLabel}: ${child.threadId}`);
        continue;
      }
      try {
        await createChildThread({ client, runPath: options.runPath, child, index, run });
      } catch (error) {
        patchChild(options.runPath, index, (record) => {
          record.status = "failed";
          record.error = error.stack || error.message;
        });
        appendLog(run, `Failed child ${child.projectLabel}: ${error.stack || error.message}`);
      }
    }

    run = readJson(options.runPath);
    await startParentTurn({ client, runPath: options.runPath, run });
    run = readJson(options.runPath);
    await monitorTurns({ client, runPath: options.runPath, run });

    patchRun(options.runPath, (current) => {
      const statuses = current.children.map((child) => child.status);
      const hasActive = statuses.some((status) => ["queued", "starting-thread", "naming-thread", "starting-turn", "in-progress"].includes(status));
      const hasFailures = statuses.some((status) => ["failed", "monitor-error", "monitor-timeout"].includes(status));
      current.status = hasActive ? "running" : hasFailures ? "completed-with-errors" : "completed";
      current.completedAt = hasActive ? null : nowIso();
      return current;
    });
    appendLog(readJson(options.runPath), "Orchestration runner finished.");
  } catch (error) {
    patchRun(options.runPath, (current) => {
      current.status = "failed";
      current.error = error.stack || error.message;
      current.completedAt = nowIso();
      return current;
    });
    appendLog(run, `ERROR: ${error.stack || error.message}`);
    process.exitCode = 1;
  } finally {
    client.stop();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
