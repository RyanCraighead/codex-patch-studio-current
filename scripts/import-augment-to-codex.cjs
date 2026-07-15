#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const defaultCodexHome = path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex");
const defaultApiBase = "http://127.0.0.1:4577";

function usage() {
  console.error(`Usage:
  node scripts/import-augment-to-codex.cjs --export-id <id> --conversation-id <id> [options]
  node scripts/import-augment-to-codex.cjs --job-path <path> --apply [options]

Options:
  --api-base <url>       Chat transfer viewer API base. Default: ${defaultApiBase}
  --codex-home <path>    Codex home. Default: ${defaultCodexHome}
  --title <title>        Override imported thread title.
  --thread-id <id>       Override Codex thread id. Useful for repairing an earlier import.
  --cwd <path>            Attach the imported thread to this Codex project folder.
  --dry-run              Build files under codex-import-results without touching ~/.codex.
  --apply                Write rollout, update state_5.sqlite, and update Codex global state.
  --allow-running        Permit --apply while Codex is running. Unsafe; intended only for diagnostics.
  --no-backup            Skip backing up Codex state before apply. Intended for batch jobs that already made a backup.
  --no-registry          Do not update codex-import-results/import-registry.json after apply.
  --materialize-cwd      Create the target workspace folder if it is missing.
  --no-materialize-cwd   Do not create missing target workspace folders.
  --no-cards             Do not emit native function/edit card events.
  --no-tools             Do not emit imported historical tool/action cards. Fastest archival mode.
  --validate             Validate the imported thread through Codex app-server after apply.
  --restart-app          Try to restart the Codex desktop app after import.
  --job-path <path>      Import every item in a scheduled import job in one process.
`);
}

function parseArgs(argv) {
  const args = {
    apiBase: defaultApiBase,
    codexHome: defaultCodexHome,
    dryRun: true,
    apply: false,
    cards: true,
    materializeCwd: false,
    restartApp: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      return argv[index];
    };

    if (arg === "--export-id") args.exportId = next();
    else if (arg === "--conversation-id") args.conversationId = next();
    else if (arg === "--job-path") args.jobPath = path.resolve(next());
    else if (arg === "--api-base") args.apiBase = next();
    else if (arg === "--codex-home") args.codexHome = path.resolve(next());
    else if (arg === "--title") args.title = next();
    else if (arg === "--thread-id") args.threadId = next();
    else if (arg === "--cwd") args.cwd = next();
    else if (arg === "--dry-run") {
      args.dryRun = true;
      args.apply = false;
    } else if (arg === "--apply") {
      args.apply = true;
      args.dryRun = false;
    } else if (arg === "--allow-running") {
      args.allowRunning = true;
    } else if (arg === "--no-backup") {
      args.noBackup = true;
    } else if (arg === "--no-registry") {
      args.noRegistry = true;
    } else if (arg === "--materialize-cwd") {
      args.materializeCwd = true;
    } else if (arg === "--no-materialize-cwd") {
      args.materializeCwd = false;
    } else if (arg === "--no-cards") args.cards = false;
    else if (arg === "--no-tools") args.tools = false;
    else if (arg === "--validate") args.validate = true;
    else if (arg === "--restart-app") args.restartApp = true;
    else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.jobPath && (!args.exportId || !args.conversationId)) {
    usage();
    process.exit(2);
  }
  if (!args.apply && !args.dryRun) {
    args.dryRun = true;
  }
  return args;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode} from ${url}: ${body.slice(0, 500)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Could not parse JSON from ${url}: ${error.message}`));
        }
      });
    });
    request.on("error", reject);
  });
}

function startViewerApi() {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(rootDir, "viewer", "server.cjs");
    const child = spawn(process.execPath, [serverPath, "0"], {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Timed out starting viewer API. ${stderr || stdout}`));
    }, 10000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match || settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        baseUrl: `http://127.0.0.1:${match[1]}`,
        close: () => child.kill(),
      });
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Viewer API exited before ready with code ${code}. ${stderr || stdout}`));
    });
  });
}

async function loadConversation(options) {
  const pathPart = `/api/exports/${encodeURIComponent(options.exportId)}/conversations/${encodeURIComponent(options.conversationId)}`;
  const url = `${options.apiBase.replace(/\/$/, "")}${pathPart}`;
  try {
    return await fetchJson(url);
  } catch (firstError) {
    let viewer = null;
    try {
      viewer = await startViewerApi();
      return await fetchJson(`${viewer.baseUrl}${pathPart}`);
    } catch (secondError) {
      throw new Error(
        [
          `Could not load normalized source conversation ${options.exportId}/${options.conversationId}.`,
          `Existing API error: ${firstError.message}`,
          `Local viewer API error: ${secondError.message}`,
        ].join("\n")
      );
    } finally {
      if (viewer) {
        viewer.close();
      }
    }
  }
}

function toIso(value, fallback = new Date()) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value > 100000000000 ? value : value * 1000).toISOString();
  }
  if (typeof value === "string" && value) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }
  return fallback.toISOString();
}

function toUnixSeconds(iso) {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function toUnixMillis(iso) {
  return new Date(iso).getTime();
}

function uuidV7(date = new Date()) {
  const bytes = new Uint8Array(16);
  let time = BigInt(date.getTime());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(time & 0xffn);
    time >>= 8n;
  }
  for (let index = 6; index < 16; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function callId(prefix = "call") {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let suffix = "";
  for (let index = 0; index < 24; index += 1) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}_${suffix}`;
}

function normalizeCwd(cwd) {
  if (!cwd) {
    return process.cwd();
  }
  return String(cwd).replace(/^\\\\\?\\/, "");
}

function dbCwd(cwd) {
  return normalizeCwd(cwd);
}

function isMaterializableWorkspace(workspace) {
  const normalized = normalizeCwd(workspace);
  if (!normalized || normalized === process.cwd()) {
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

function materializeWorkspace(workspace) {
  const normalized = normalizeCwd(workspace);
  if (!isMaterializableWorkspace(normalized) || fs.existsSync(normalized)) {
    return false;
  }
  fs.mkdirSync(normalized, { recursive: true });
  return true;
}

function line(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload });
}

function contentText(text, type) {
  return [{ type, text: String(text || "") }];
}

function firstText(...values) {
  return values.find((value) => typeof value === "string" && value.trim()) || "";
}

function titleFromConversation(conversation, fallback) {
  const record = conversation.indexRecord || conversation.levelMetadata || conversation.webview || {};
  return firstText(record.name, record.title, record.summary, fallback);
}

function sourceNameForConversation(conversation) {
  return firstText(
    conversation.sourceName,
    conversation.indexRecord?.sourceName,
    conversation.levelMetadata?.sourceName,
    conversation.levelMetadata?.source?.name,
    "Augment VS Code"
  );
}

function sourceTypeForConversation(conversation) {
  return firstText(
    conversation.sourceType,
    conversation.indexRecord?.sourceType,
    conversation.levelMetadata?.sourceType,
    "augment"
  );
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function loadExportMetadata(exportId) {
  return (
    readJsonSafe(path.join(rootDir, "augment-chat-exports", exportId, "workspace-export-metadata.json")) ||
    readJsonSafe(path.join(rootDir, "augment-vscode-state-exports", exportId, "workspace-export-metadata.json")) ||
    readJsonSafe(path.join(rootDir, "roo-code-exports", exportId, "workspace-export-metadata.json")) ||
    readJsonSafe(path.join(rootDir, "cline-chat-exports", exportId, "workspace-export-metadata.json")) ||
    readJsonSafe(path.join(rootDir, "kiro-chat-exports", exportId, "workspace-export-metadata.json")) ||
    null
  );
}

function groupExchanges(exchanges) {
  const turns = [];
  let current = null;

  for (const exchange of exchanges || []) {
    const hasRequest = Boolean(exchange.request && exchange.request.trim());
    if (!current || hasRequest) {
      current = {
        request: hasRequest ? exchange.request : "(Imported continuation without a saved user message.)",
        exchanges: [],
      };
      turns.push(current);
    }
    current.exchanges.push(exchange);
  }
  return turns;
}

function summarizeTool(tool, sourceName = "source") {
  const parts = [
    `${sourceName} tool: ${tool.toolName || "tool"}`,
    tool.inputSummary ? `Input: ${tool.inputSummary}` : "",
    tool.requestId ? `Request id: ${tool.requestId}` : "",
    tool.toolUseId ? `Tool use id: ${tool.toolUseId}` : "",
  ].filter(Boolean);
  return parts.join("\n");
}

function diffLineCount(text) {
  const value = String(text || "");
  if (!value) {
    return 0;
  }
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.length;
}

function unifiedDiffForDiff(diff) {
  const filePath = diff.path || "unknown";
  const lines = [`--- a/${filePath}`, `+++ b/${filePath}`];
  for (const edit of diff.edits || []) {
    const removedCount = Number(edit.removedLineCount) || diffLineCount(edit.beforeText);
    const addedCount = Number(edit.addedLineCount) || diffLineCount(edit.afterText);
    const start = Number(edit.lineStart) || 1;
    lines.push(`@@ -${start},${removedCount} +${start},${addedCount} @@`);
    for (const oldLine of String(edit.beforeText || "").replace(/\r\n/g, "\n").split("\n")) {
      if (oldLine === "" && !removedCount) continue;
      lines.push(`-${oldLine}`);
    }
    for (const newLine of String(edit.afterText || "").replace(/\r\n/g, "\n").split("\n")) {
      if (newLine === "" && !addedCount) continue;
      lines.push(`+${newLine}`);
    }
  }
  return lines.join("\n");
}

function patchLine(prefix, text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((value) => `${prefix}${value}`);
}

function applyPatchForDiff(diff) {
  const filePath = diff.path || "unknown";
  const changeKind = diff.changeKind || "edited";
  if (changeKind === "created") {
    const content = (diff.edits || []).map((edit) => edit.afterText || "").join("\n");
    return [`*** Add File: ${filePath}`, ...patchLine("+", content)];
  }
  if (changeKind === "deleted") {
    return [`*** Delete File: ${filePath}`];
  }

  const lines = [`*** Update File: ${filePath}`];
  for (const edit of diff.edits || []) {
    lines.push("@@");
    lines.push(...patchLine("-", edit.beforeText || ""));
    lines.push(...patchLine("+", edit.afterText || ""));
  }
  return lines;
}

function applyPatchForTool(tool) {
  const diffs = Array.isArray(tool.diffs) ? tool.diffs : [];
  if (!diffs.length) {
    return "";
  }
  return ["*** Begin Patch", ...diffs.flatMap((diff) => applyPatchForDiff(diff)), "*** End Patch"].join("\n");
}

function absoluteDiffPath(diff, cwd) {
  const filePath = diff.path || "unknown";
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.join(normalizeCwd(diff.rootPath || cwd), filePath);
}

function patchChangesForTool(tool, cwd) {
  const changes = {};
  for (const diff of tool.diffs || []) {
    const absPath = absoluteDiffPath(diff, cwd);
    const changeKind = diff.changeKind || "edited";
    if (changeKind === "created") {
      const content = (diff.edits || []).map((edit) => edit.afterText || "").join("\n");
      changes[absPath] = { type: "add", content };
    } else if (changeKind === "deleted") {
      changes[absPath] = { type: "delete" };
    } else {
      changes[absPath] = {
        type: "update",
        unified_diff: unifiedDiffForDiff(diff),
        move_path: null,
      };
    }
  }
  return changes;
}

function toolOutput(tool, sourceName = "source") {
  const blocks = [];
  if (tool.text) {
    blocks.push(String(tool.text));
  }
  if (Array.isArray(tool.diffs) && tool.diffs.length) {
    for (const diff of tool.diffs) {
      const added = Number(diff.totalAddedLines) || 0;
      const removed = Number(diff.totalRemovedLines) || 0;
      blocks.push(
        [
          `${diff.changeKind || "edited"} ${diff.path || "unknown file"} (+${added}/-${removed})`,
          unifiedDiffForDiff(diff),
        ].join("\n")
      );
    }
  }
  return blocks.join("\n\n") || `${sourceName} did not save result text for this tool call.`;
}

function codexCustomToolOutput(output, exitCode = 0) {
  return JSON.stringify({
    output,
    metadata: {
      exit_code: exitCode,
      duration_seconds: 0.0,
    },
  });
}

function codexToolName(name) {
  return String(name || "tool")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 64) || "tool";
}

function toolArguments(tool, sourceType = "source") {
  return {
    imported_from: sourceType,
    requestId: tool.requestId || null,
    toolUseId: tool.toolUseId || null,
    inputSummary: tool.inputSummary || "",
    input: tool.input || null,
    diffs: tool.diffs || [],
  };
}

function importNotes(conversation, source) {
  const sourceName = source.sourceName || sourceNameForConversation(conversation);
  return [
    `Imported from ${sourceName} chat history.`,
    `Source export: ${source.exportId}`,
    `Source conversation: ${source.conversationId}`,
    `Exchange source: ${conversation.exchangeSource || "unknown"}`,
    `Exchanges: ${(conversation.exchanges || []).length}`,
    `Tool uses: ${conversation.toolUseCount || 0}`,
    `Checkpoint diffs: ${conversation.editDiffCount || 0}`,
  ].join("\n");
}

function importModeForOptions(options) {
  if (options.tools === false) return "turbo";
  if (options.cards === false) return "no-cards";
  return "full";
}

function buildRollout(conversation, options) {
  const sourceName = sourceNameForConversation(conversation);
  const sourceType = sourceTypeForConversation(conversation);
  const firstExchange = (conversation.exchanges || [])[0] || {};
  const createdIso = toIso(firstExchange.timestamp, new Date());
  const updatedIso = toIso(
    ((conversation.exchanges || [])[conversation.exchanges.length - 1] || {}).timestamp,
    new Date(createdIso)
  );
  const cwd = normalizeCwd(options.cwd || conversation.indexRecord?.workspacePath || conversation.levelMetadata?.workspace?.path || process.cwd());
  const threadId = options.threadId || uuidV7(new Date(createdIso));
  const title = options.title || titleFromConversation(conversation, `[${sourceName}] ${options.conversationId}`);
  const firstUserMessage = firstText((conversation.exchanges || []).find((exchange) => exchange.request)?.request, title);
  const lines = [];

  lines.push(
    line(createdIso, "session_meta", {
      id: threadId,
      timestamp: createdIso,
      cwd,
      originator: "Chat History Import",
      source_name: sourceName,
      source_type: sourceType,
      cli_version: "0.131.0",
      source: "vscode",
      thread_source: "user",
      model_provider: "openai",
      base_instructions: {
        text: [
          `You are Codex. This thread was imported from ${sourceName} chat history.`,
          `Original source: ${sourceName}.`,
          "Use the imported transcript, tool outputs, and file diffs as historical context.",
          "The imported tool calls are historical records; do not assume those tools are callable in this environment unless available in the current session.",
        ].join("\n"),
      },
      dynamic_tools: [],
      memory_mode: "disabled",
    })
  );

  const turns = groupExchanges(conversation.exchanges || []);
  for (const [turnIndex, turn] of turns.entries()) {
    const turnStart = toIso(turn.exchanges[0]?.timestamp, new Date(new Date(createdIso).getTime() + turnIndex));
    const turnEnd = toIso(turn.exchanges[turn.exchanges.length - 1]?.timestamp, new Date(turnStart));
    const turnId = uuidV7(new Date(turnStart));
    let lastAgentMessage = "";
    let assistantMessageIndexes = [];

    lines.push(
      line(turnStart, "event_msg", {
        type: "task_started",
        turn_id: turnId,
        started_at: toUnixSeconds(turnStart),
        model_context_window: 258400,
        collaboration_mode_kind: "default",
      })
    );
    lines.push(
      line(turnStart, "turn_context", {
        turn_id: turnId,
        cwd,
        current_date: turnStart.slice(0, 10),
        timezone: "America/Toronto",
        approval_policy: "never",
        sandbox_policy: { type: "danger-full-access" },
        permission_profile: { type: "disabled" },
        model: "gpt-5.5",
        personality: "pragmatic",
        collaboration_mode: { mode: "default", settings: { model: "gpt-5.5", reasoning_effort: "medium" } },
        realtime_active: false,
        effort: "medium",
        summary: "none",
        user_instructions: "",
        developer_instructions: `Imported ${sourceName} history.`,
        truncation_policy: null,
      })
    );
    lines.push(
      line(turnStart, "response_item", {
        type: "message",
        role: "user",
        content: contentText(turn.request, "input_text"),
      })
    );
    lines.push(
      line(turnStart, "event_msg", {
        type: "user_message",
        message: turn.request,
        images: [],
        local_images: [],
        text_elements: [],
      })
    );

    if (turnIndex === 0) {
      const note = importNotes(conversation, { ...options, sourceName, sourceType });
      lines.push(
        line(turnStart, "response_item", {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: contentText(note, "output_text"),
        })
      );
      lines.push(line(turnStart, "event_msg", { type: "agent_message", message: note, phase: "commentary", memory_citation: null }));
      lastAgentMessage = note;
    }

    for (const exchange of turn.exchanges) {
      for (const event of exchange.events || []) {
        const timestamp = toIso(exchange.timestamp, new Date(turnStart));
        if (event.type === "thinking") {
          lines.push(
            line(timestamp, "response_item", {
              type: "reasoning",
              summary: event.summary ? [{ type: "summary_text", text: event.summary }] : [],
              content: event.summary ? [{ type: "reasoning_text", text: event.summary }] : null,
              encrypted_content: null,
            })
          );
        } else if (event.type === "assistant_text") {
          const message = event.text || "";
          if (message.trim()) {
            assistantMessageIndexes.push(lines.length);
            lines.push(
              line(timestamp, "response_item", {
                type: "message",
                role: "assistant",
                phase: "commentary",
                content: contentText(message, "output_text"),
              })
            );
            lines.push(line(timestamp, "event_msg", { type: "agent_message", message, phase: "commentary", memory_citation: null }));
            lastAgentMessage = message;
          }
        } else if (event.type === "tool" && event.tool && options.tools !== false) {
          appendTool(lines, event.tool, timestamp, turnId, cwd, options.cards, sourceName, sourceType);
        }
      }

      if (exchange.response && String(exchange.response).trim() && !(exchange.events || []).some((event) => event.type === "assistant_text" && event.text === exchange.response)) {
        const timestamp = toIso(exchange.timestamp, new Date(turnStart));
        assistantMessageIndexes.push(lines.length);
        lines.push(
          line(timestamp, "response_item", {
            type: "message",
            role: "assistant",
            phase: "commentary",
            content: contentText(exchange.response, "output_text"),
          })
        );
        lines.push(line(timestamp, "event_msg", { type: "agent_message", message: exchange.response, phase: "commentary", memory_citation: null }));
        lastAgentMessage = exchange.response;
      }
    }

    if (assistantMessageIndexes.length) {
      const lastIndex = assistantMessageIndexes[assistantMessageIndexes.length - 1];
      const parsed = JSON.parse(lines[lastIndex]);
      parsed.payload.phase = "final_answer";
      lines[lastIndex] = JSON.stringify(parsed);
    }

    lines.push(
      line(turnEnd, "event_msg", {
        type: "task_complete",
        turn_id: turnId,
        last_agent_message: lastAgentMessage || "",
        completed_at: toUnixSeconds(turnEnd),
        duration_ms: Math.max(0, new Date(turnEnd).getTime() - new Date(turnStart).getTime()),
        time_to_first_token_ms: null,
      })
    );
  }

  return {
    threadId,
    title,
    cwd,
    createdIso,
    updatedIso,
    firstUserMessage,
    rolloutText: `${lines.join("\n")}\n`,
    lineCount: lines.length,
    turnCount: turns.length,
  };
}

function appendTool(lines, tool, timestamp, turnId, cwd, cards, sourceName = "source", sourceType = "source") {
  const hasDiffs = Array.isArray(tool.diffs) && tool.diffs.length;
  if (cards && hasDiffs) {
    const id = callId("call");
    const changes = patchChangesForTool(tool, cwd);
    const input = applyPatchForTool(tool);
    const output = `Imported ${sourceName} edit from ${tool.toolName || "tool"}.`;
    lines.push(
      line(timestamp, "response_item", {
        type: "custom_tool_call",
        status: "completed",
        call_id: id,
        name: "apply_patch",
        input,
      })
    );
    lines.push(
      line(timestamp, "event_msg", {
        type: "patch_apply_end",
        call_id: id,
        turn_id: turnId,
        stdout: `Imported ${sourceName} edit from ${tool.toolName || "tool"}.`,
        stderr: "",
        success: !tool.isError,
        changes,
        status: "completed",
      })
    );
    lines.push(line(timestamp, "response_item", { type: "custom_tool_call_output", call_id: id, output: codexCustomToolOutput(output, tool.isError ? 1 : 0) }));
    return;
  }

  const id = callId("call");
  const name = codexToolName(tool.toolName || "imported_tool");
  const argumentsObject = toolArguments(tool, sourceType);
  const output = toolOutput(tool, sourceName);
  lines.push(
    line(timestamp, "response_item", {
      type: "function_call",
      name,
      namespace: "mcp__chat_history_import__",
      arguments: JSON.stringify(argumentsObject),
      call_id: id,
    })
  );
  lines.push(
    line(timestamp, "event_msg", {
      type: "mcp_tool_call_end",
      call_id: id,
      invocation: {
        server: "chat_history_import",
        tool: name,
        arguments: argumentsObject,
      },
      duration: {
        secs: 0,
        nanos: 0,
      },
      result: {
        Ok: {
          content: [{ type: "text", text: output }],
          isError: Boolean(tool.isError),
        },
      },
    })
  );
  lines.push(line(timestamp, "response_item", { type: "function_call_output", call_id: id, output }));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function backupCodexState(codexHome) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(rootDir, "codex-import-backups", stamp);
  ensureDir(backupDir);

  const stateDb = path.join(codexHome, "state_5.sqlite");
  execFileSync("sqlite3", [stateDb, `.backup '${path.join(backupDir, "state_5.sqlite").replace(/'/g, "''")}'`], {
    stdio: "pipe",
    windowsHide: true,
  });

  for (const file of [".codex-global-state.json", "session_index.jsonl"]) {
    const source = path.join(codexHome, file);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(backupDir, file));
    }
  }
  return backupDir;
}

function sqlString(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlNumber(value) {
  return Number.isFinite(value) ? String(Math.trunc(value)) : "NULL";
}

function threadInsertSql(rolloutPath, result) {
  const createdAt = toUnixSeconds(result.createdIso);
  const updatedAt = toUnixSeconds(result.updatedIso);
  const createdAtMs = toUnixMillis(result.createdIso);
  const updatedAtMs = toUnixMillis(result.updatedIso);
  const sandboxPolicy = JSON.stringify({ type: "danger-full-access" });
  const values = [
    result.threadId,
    rolloutPath,
    createdAt,
    updatedAt,
    "vscode",
    "openai",
    dbCwd(result.cwd),
    result.title,
    sandboxPolicy,
    "never",
    0,
    1,
    0,
    null,
    null,
    null,
    null,
    "0.131.0",
    result.firstUserMessage,
    null,
    null,
    "disabled",
    "gpt-5.5",
    "medium",
    null,
    createdAtMs,
    updatedAtMs,
    "user",
    result.firstUserMessage.slice(0, 1000),
  ];
  const columns = [
    "id",
    "rollout_path",
    "created_at",
    "updated_at",
    "source",
    "model_provider",
    "cwd",
    "title",
    "sandbox_policy",
    "approval_mode",
    "tokens_used",
    "has_user_event",
    "archived",
    "archived_at",
    "git_sha",
    "git_branch",
    "git_origin_url",
    "cli_version",
    "first_user_message",
    "agent_nickname",
    "agent_role",
    "memory_mode",
    "model",
    "reasoning_effort",
    "agent_path",
    "created_at_ms",
    "updated_at_ms",
    "thread_source",
    "preview",
  ];
  return [
    `DELETE FROM threads WHERE id = ${sqlString(result.threadId)};`,
    `INSERT INTO threads (${columns.join(", ")}) VALUES (${values.map((value) => (typeof value === "number" ? sqlNumber(value) : sqlString(value))).join(", ")});`,
  ].join("\n");
}

function insertThread(codexHome, rolloutPath, result) {
  const dbPath = path.join(codexHome, "state_5.sqlite");
  const sql = [
    "BEGIN;",
    threadInsertSql(rolloutPath, result),
    "COMMIT;",
  ].join("\n");
  execFileSync("sqlite3", [dbPath], { input: sql, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}

function insertThreads(codexHome, entries) {
  if (!entries.length) {
    return;
  }
  const dbPath = path.join(codexHome, "state_5.sqlite");
  const sql = [
    "BEGIN;",
    ...entries.map((entry) => threadInsertSql(entry.rolloutPath, entry.result)),
    "COMMIT;",
  ].join("\n");
  execFileSync("sqlite3", [dbPath], { input: sql, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}

function updateGlobalStateMany(codexHome, results) {
  const statePath = path.join(codexHome, ".codex-global-state.json");
  if (!fs.existsSync(statePath)) {
    return false;
  }
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const prependUnique = (values, value, normalizer = (item) => item) => [
    value,
    ...(Array.isArray(values) ? values : []).filter((item) => normalizer(item) !== normalizer(value)),
  ];

  if (!state["electron-workspace-root-labels"] || typeof state["electron-workspace-root-labels"] !== "object") {
    state["electron-workspace-root-labels"] = {};
  }
  if (!state["thread-titles"] || typeof state["thread-titles"] !== "object") {
    state["thread-titles"] = {};
  }
  if (!state["thread-titles"].titles || typeof state["thread-titles"].titles !== "object") {
    state["thread-titles"].titles = {};
  }

  for (const result of results) {
    const workspace = normalizeCwd(result.cwd);
    const normalizedWorkspace = normalizeCwd(workspace);
    for (const key of ["electron-saved-workspace-roots", "active-workspace-roots", "project-order"]) {
      state[key] = prependUnique(state[key], workspace, normalizeCwd);
    }
    state["electron-workspace-root-labels"][workspace] = path.basename(normalizedWorkspace) || workspace;
    state["thread-titles"].titles[result.threadId] = result.title;
    state["thread-titles"].order = prependUnique(state["thread-titles"].order, result.threadId);
  }

  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return true;
}

function updateGlobalState(codexHome, result) {
  return updateGlobalStateMany(codexHome, [result]);
}

function appendSessionIndex(codexHome, result) {
  const indexPath = path.join(codexHome, "session_index.jsonl");
  const entry = {
    id: result.threadId,
    thread_name: result.title,
    updated_at: result.updatedIso,
  };
  fs.appendFileSync(indexPath, `${JSON.stringify(entry)}\n`, "utf8");
}

function appendSessionIndexMany(codexHome, results) {
  if (!results.length) {
    return;
  }
  const indexPath = path.join(codexHome, "session_index.jsonl");
  const text = results
    .map((result) =>
      JSON.stringify({
        id: result.threadId,
        thread_name: result.title,
        updated_at: result.updatedIso,
      })
    )
    .join("\n");
  fs.appendFileSync(indexPath, `${text}\n`, "utf8");
}

function runningCodexProcesses() {
  if (process.platform !== "win32") {
    return [];
  }
  const command = [
    "$items = Get-Process -ErrorAction SilentlyContinue | Where-Object {",
    "($_.ProcessName -in @('ChatGPT','Codex')) -or",
    "($_.ProcessName -eq 'codex' -and ($_.Path -like '*\\OpenAI\\Codex\\bin\\*' -or $_.Path -like '*\\WindowsApps\\OpenAI.Codex_*' -or $_.Path -like '*\\CodexPatchStudioCurrent\\*'))",
    "};",
    "$items | Select-Object Id,ProcessName,MainWindowHandle,Path | ConvertTo-Json -Compress",
  ].join(" ");
  try {
    const output = execFileSync("powershell", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    if (!output) {
      return [];
    }
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function assertCodexNotRunning(options) {
  if (!options.apply || options.allowRunning) {
    return;
  }
  const processes = runningCodexProcesses();
  if (!processes.length) {
    return;
  }
  const summary = processes
    .slice(0, 10)
    .map((processInfo) => `${processInfo.ProcessName || "Codex"}:${processInfo.Id}`)
    .join(", ");
  throw new Error(
    [
      "Refusing live import because Codex is still running.",
      "Close Codex and run through scripts/run-codex-import-after-close.ps1 so rollout, SQLite, session_index, and global sidebar state are written while Codex cannot overwrite them.",
      `Running Codex processes: ${summary}${processes.length > 10 ? `, +${processes.length - 10} more` : ""}`,
      "Use --allow-running only for diagnostics.",
    ].join("\n")
  );
}

function findCodexExe() {
  const launcherConfig = readJsonSafe(path.join(rootDir, "codex-launcher.local.json"));
  const configuredCli = launcherConfig?.resourcesDir ? path.join(launcherConfig.resourcesDir, "codex.exe") : null;
  if (configuredCli && fs.existsSync(configuredCli)) {
    return configuredCli;
  }

  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
  const candidates = [
    path.join(localAppData, "OpenAI", "Codex", "bin", "3b5d676fd5f36bba", "codex.exe"),
    path.join(localAppData, "OpenAI", "Codex", "bin", "codex.exe"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  try {
    const output = execFileSync("where.exe", ["codex"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const match = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.toLowerCase().endsWith("codex.exe"));
    if (match) {
      return match;
    }
  } catch {
    // Fall through to the PATH command name.
  }
  return "codex";
}

function jsonRpcWait(responses, id, child, stderrRef, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (responses.has(id)) {
        clearInterval(timer);
        resolve(responses.get(id));
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        try {
          child.kill();
        } catch {
          // Ignore cleanup failure.
        }
        reject(new Error(`Timed out waiting for app-server response ${id}. ${stderrRef.value.slice(-2000)}`));
      }
    }, 50);
  });
}

async function validateThreadWithAppServer(result, codexHome) {
  const exe = findCodexExe();
  const child = spawn(exe, ["app-server", "--listen", "stdio://"], {
    cwd: rootDir,
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const responses = new Map();
  const stderrRef = { value: "" };
  let stdout = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    let index;
    while ((index = stdout.indexOf("\n")) >= 0) {
      const raw = stdout.slice(0, index);
      stdout = stdout.slice(index + 1);
      if (!raw.trim()) {
        continue;
      }
      try {
        const message = JSON.parse(raw);
        if (message.id !== undefined) {
          responses.set(message.id, message);
        }
      } catch {
        stderrRef.value += `\nUnparsed stdout: ${raw.slice(0, 500)}`;
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrRef.value += chunk.toString();
  });

  const send = (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  };

  send(1, "initialize", {
    clientInfo: { name: "chat-history-import-validator", title: "Chat History Import Validator", version: "0.0.0" },
    capabilities: null,
  });
  const init = await jsonRpcWait(responses, 1, child, stderrRef);
  if (init.error) {
    throw new Error(`app-server initialize failed: ${JSON.stringify(init.error)}`);
  }

  send(2, "thread/list", {
    limit: 1000,
    sourceKinds: ["vscode"],
    cwd: result.cwd,
    useStateDbOnly: false,
  });
  send(3, "thread/read", {
    threadId: result.threadId,
    includeTurns: true,
  });

  const [listResponse, readResponse] = await Promise.all([
    jsonRpcWait(responses, 2, child, stderrRef),
    jsonRpcWait(responses, 3, child, stderrRef),
  ]);

  try {
    child.kill();
  } catch {
    // Ignore cleanup failure.
  }

  if (listResponse.error) {
    throw new Error(`thread/list failed: ${JSON.stringify(listResponse.error)}`);
  }
  if (readResponse.error) {
    throw new Error(`thread/read failed: ${JSON.stringify(readResponse.error)}`);
  }
  if (/failed to parse rollout line|parse errors:/i.test(stderrRef.value)) {
    throw new Error(`app-server reported rollout parse errors:\n${stderrRef.value}`);
  }

  const listed = listResponse.result?.data || [];
  const listedThread = listed.find((thread) => thread.id === result.threadId);
  const thread = readResponse.result?.thread;
  const turns = thread?.turns || [];
  const items = turns.flatMap((turn) => turn.items || []);
  const itemCounts = items.reduce((counts, item) => {
    counts[item.type] = (counts[item.type] || 0) + 1;
    return counts;
  }, {});

  if (!listedThread) {
    throw new Error(`thread/list did not return ${result.threadId} for cwd ${result.cwd}`);
  }
  if (!turns.length || !itemCounts.userMessage || !itemCounts.agentMessage) {
    throw new Error(`thread/read returned an incomplete thread: ${JSON.stringify({ turns: turns.length, itemCounts })}`);
  }

  return {
    listed: true,
    name: listedThread.name || thread?.name || null,
    turnCount: turns.length,
    itemCounts,
  };
}

function rolloutPathFor(codexHome, result) {
  const date = new Date(result.createdIso);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const dir = path.join(codexHome, "sessions", year, month, day);
  const localStamp = result.createdIso.replace(/:/g, "-").replace(/\.\d{3}Z$/, "");
  return path.join(dir, `rollout-${localStamp}-${result.threadId}.jsonl`);
}

function writeResultFiles(result, options, conversation) {
  const sourceName = sourceNameForConversation(conversation);
  const sourceType = sourceTypeForConversation(conversation);
  const outDir = path.join(rootDir, "codex-import-results", result.threadId);
  ensureDir(outDir);
  fs.writeFileSync(path.join(outDir, "rollout.jsonl"), result.rolloutText, "utf8");
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    `${JSON.stringify(
      {
        threadId: result.threadId,
        title: result.title,
        cwd: result.cwd,
        createdIso: result.createdIso,
        updatedIso: result.updatedIso,
        lineCount: result.lineCount,
        turnCount: result.turnCount,
        applied: Boolean(options.apply && !options.noRegistry),
        validatedOnly: Boolean(options.apply && options.noRegistry),
        importMode: importModeForOptions(options),
        cards: options.cards !== false,
        tools: options.tools !== false,
        source: { exportId: options.exportId, conversationId: options.conversationId, sourceName, sourceType },
        importCounts: {
          exchanges: (conversation.exchanges || []).length,
          toolUses: conversation.toolUseCount || 0,
          checkpointDiffs: conversation.editDiffCount || 0,
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return outDir;
}

function updateImportRegistry(options, summary) {
  updateImportRegistryMany([
    {
      options,
      summary,
    },
  ]);
}

function updateImportRegistryMany(entries) {
  if (!entries.length) {
    return;
  }
  const registryPath = path.join(rootDir, "codex-import-results", "import-registry.json");
  ensureDir(path.dirname(registryPath));
  let registry = readJsonSafe(registryPath);
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    registry = { version: 1, imports: {} };
  }
  if (!registry.imports || typeof registry.imports !== "object" || Array.isArray(registry.imports)) {
    registry.imports = {};
  }

  const importedAt = new Date().toISOString();
  for (const entry of entries) {
    const options = entry.options;
    const summary = entry.summary;
    const key = `${options.exportId}:${options.conversationId}`;
    registry.imports[key] = {
      key,
      exportId: options.exportId,
      conversationId: options.conversationId,
      threadId: summary.threadId,
      title: summary.title,
      sourceName: summary.sourceName || null,
      sourceType: summary.sourceType || null,
      cwd: summary.cwd,
      rolloutPath: summary.rolloutPath,
      resultDir: summary.resultDir,
      importedAt,
      validation: summary.validation || null,
      importMode: summary.importMode || (summary.tools === false ? "turbo" : summary.cards === false ? "no-cards" : "full"),
      cards: summary.cards !== false,
      tools: summary.tools !== false,
    };
  }
  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

function restartCodexApp() {
  const launcherConfig = readJsonSafe(path.join(rootDir, "codex-launcher.local.json"));
  if (launcherConfig?.codexExe && fs.existsSync(launcherConfig.codexExe)) {
    const electronUserDataPath =
      launcherConfig.electronUserDataPath ||
      (launcherConfig.cloneRoot ? path.join(launcherConfig.cloneRoot, "electron-user-data") : "");
    const env = { ...process.env };
    if (electronUserDataPath) {
      env.CODEX_ELECTRON_USER_DATA_PATH = electronUserDataPath;
    }
    const child = spawn(launcherConfig.codexExe, [], {
      cwd: path.dirname(launcherConfig.codexExe),
      env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return;
  }

  const command = "Start-Process explorer.exe 'shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App'";
  execFileSync("powershell", ["-NoProfile", "-Command", command], { stdio: "pipe", windowsHide: true });
}

async function prepareImport(options) {
  const conversation = await loadConversation(options);
  const exportMetadata = loadExportMetadata(options.exportId);
  const metadataWorkspacePath =
    exportMetadata?.workspace?.targetPath ||
    exportMetadata?.workspace?.path ||
    conversation.workspacePath ||
    conversation.levelMetadata?.workspace?.path ||
    conversation.indexRecord?.workspacePath ||
    "";
  const result = buildRollout(conversation, {
    ...options,
    cwd: options.cwd || metadataWorkspacePath || process.cwd(),
  });
  const resultDir = options.writeResults === false ? null : writeResultFiles(result, options, conversation);
  return { conversation, result, resultDir };
}

async function runSingleImport(options) {
  assertCodexNotRunning(options);
  const { conversation, result, resultDir } = await prepareImport(options);
  let backupDir = null;
  let rolloutPath = null;
  let validation = null;
  if (options.apply) {
    backupDir = options.noBackup ? null : backupCodexState(options.codexHome);
    if (options.materializeCwd) {
      materializeWorkspace(result.cwd);
    }
    rolloutPath = rolloutPathFor(options.codexHome, result);
    ensureDir(path.dirname(rolloutPath));
    fs.writeFileSync(rolloutPath, result.rolloutText, "utf8");
    insertThread(options.codexHome, rolloutPath, result);
    appendSessionIndex(options.codexHome, result);
    updateGlobalState(options.codexHome, result);
    if (options.validate) {
      validation = await validateThreadWithAppServer(result, options.codexHome);
    }
  }

  const summary = {
    ok: true,
    applied: options.apply,
    threadId: result.threadId,
    title: result.title,
    sourceName: sourceNameForConversation(conversation),
    sourceType: sourceTypeForConversation(conversation),
    cwd: result.cwd,
    resultDir,
    rolloutPath,
    backupDir,
    lineCount: result.lineCount,
    turnCount: result.turnCount,
    exchangeCount: (conversation.exchanges || []).length,
    toolUseCount: conversation.toolUseCount || 0,
    checkpointDiffCount: conversation.editDiffCount || 0,
    importMode: importModeForOptions(options),
    cards: options.cards,
    tools: options.tools !== false,
    validation,
  };
  if (options.apply && !options.noRegistry) {
    updateImportRegistry(options, summary);
  }
  console.log(JSON.stringify(summary, null, 2));

  if (options.apply && options.restartApp) {
    restartCodexApp();
  }
}

function itemOptionsForBatch(baseOptions, job, item, apiBase) {
  return {
    ...baseOptions,
    apiBase,
    exportId: item.exportId,
    conversationId: item.conversationId,
    title: item.title || "",
    threadId: item.threadId || "",
    cwd: item.targetCwd || item.cwd || "",
    codexHome: job.codexHome || baseOptions.codexHome,
    validate: Boolean(baseOptions.validate || job.validateImports),
    cards: baseOptions.cards,
    tools: baseOptions.tools,
    noBackup: true,
    noRegistry: baseOptions.noRegistry,
    materializeCwd: Boolean(baseOptions.materializeCwd || job.materializeCwd),
    restartApp: false,
  };
}

async function runBatchImport(options) {
  const job = readJsonSafe(options.jobPath);
  if (!job || typeof job !== "object") {
    throw new Error(`Could not read import job: ${options.jobPath}`);
  }
  const items = Array.isArray(job.items) ? job.items : [];
  if (!items.length) {
    throw new Error("Import job has no items.");
  }

  const batchOptions = {
    ...options,
    codexHome: path.resolve(job.codexHome || options.codexHome),
    apply: options.apply,
    dryRun: !options.apply,
    validate: Boolean(options.validate || job.validateImports),
    cards: job.cards === false || job.importMode === "no-cards" || job.importMode === "turbo" ? false : options.cards,
    tools: job.tools === false || job.importMode === "turbo" ? false : options.tools,
    noBackup: Boolean(options.noBackup || job.noBackup),
    noRegistry: Boolean(options.noRegistry || job.noRegistry),
    materializeCwd: Boolean(options.materializeCwd || job.materializeCwd),
    writeResults: Boolean(options.apply),
  };
  assertCodexNotRunning(batchOptions);

  const viewer = await startViewerApi();
  const prepared = [];
  const failedItems = [];
  try {
    for (const [index, item] of items.entries()) {
      const itemOptions = itemOptionsForBatch(batchOptions, job, item, viewer.baseUrl);
      try {
        const preparedItem = await prepareImport(itemOptions);
        if (!preparedItem.result.turnCount || !(preparedItem.conversation.exchanges || []).length) {
          failedItems.push({
            exportId: item.exportId,
            conversationId: item.conversationId,
            reason: "empty-conversation",
            lineCount: preparedItem.result.lineCount,
            turnCount: preparedItem.result.turnCount,
            exchangeCount: (preparedItem.conversation.exchanges || []).length,
          });
          continue;
        }
        prepared.push({ index, item, itemOptions, ...preparedItem });
      } catch (error) {
        failedItems.push({
          exportId: item.exportId,
          conversationId: item.conversationId,
          reason: "failed",
          error: error.message || String(error),
        });
      }
    }
  } finally {
    viewer.close();
  }

  if (!prepared.length) {
    throw new Error(`All ${items.length} imports failed during batch preparation.`);
  }

  let backupDir = null;
  const appliedEntries = [];
  if (batchOptions.apply) {
    backupDir = batchOptions.noBackup ? null : backupCodexState(batchOptions.codexHome);
    for (const entry of prepared) {
      if (batchOptions.materializeCwd) {
        materializeWorkspace(entry.result.cwd);
      }
      const rolloutPath = rolloutPathFor(batchOptions.codexHome, entry.result);
      ensureDir(path.dirname(rolloutPath));
      fs.writeFileSync(rolloutPath, entry.result.rolloutText, "utf8");
      entry.rolloutPath = rolloutPath;
      appliedEntries.push({ rolloutPath, result: entry.result });
    }
    insertThreads(batchOptions.codexHome, appliedEntries);
    appendSessionIndexMany(batchOptions.codexHome, prepared.map((entry) => entry.result));
    updateGlobalStateMany(batchOptions.codexHome, prepared.map((entry) => entry.result));
  }

  const summaries = [];
  for (const entry of prepared) {
    let validation = null;
    if (batchOptions.apply && batchOptions.validate) {
      validation = await validateThreadWithAppServer(entry.result, batchOptions.codexHome);
    }
    summaries.push({
      ok: true,
      applied: batchOptions.apply,
      exportId: entry.itemOptions.exportId,
      conversationId: entry.itemOptions.conversationId,
      threadId: entry.result.threadId,
      title: entry.result.title,
      sourceName: sourceNameForConversation(entry.conversation),
      sourceType: sourceTypeForConversation(entry.conversation),
      cwd: entry.result.cwd,
      resultDir: entry.resultDir,
      rolloutPath: entry.rolloutPath || null,
      backupDir,
      lineCount: entry.result.lineCount,
      turnCount: entry.result.turnCount,
      exchangeCount: (entry.conversation.exchanges || []).length,
      toolUseCount: entry.conversation.toolUseCount || 0,
      checkpointDiffCount: entry.conversation.editDiffCount || 0,
      importMode: importModeForOptions(batchOptions),
      cards: batchOptions.cards,
      tools: batchOptions.tools !== false,
      validation,
    });
  }

  if (batchOptions.apply && !batchOptions.noRegistry) {
    updateImportRegistryMany(
      summaries.map((summary) => ({
        options: {
          exportId: summary.exportId,
          conversationId: summary.conversationId,
        },
        summary,
      }))
    );
  }

  const summary = {
    ok: true,
    batch: true,
    applied: batchOptions.apply,
    total: items.length,
    successCount: summaries.length,
    failedCount: failedItems.length,
    backupDir,
    items: summaries,
    failedItems,
    importMode: batchOptions.tools === false ? "turbo" : batchOptions.cards === false ? "no-cards" : "full",
  };
  console.log(JSON.stringify(summary, null, 2));

  if (batchOptions.apply && options.restartApp) {
    restartCodexApp();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.jobPath) {
    await runBatchImport(options);
    return;
  }
  await runSingleImport(options);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
