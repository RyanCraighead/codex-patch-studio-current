#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const defaultTasksRoot = path.join(
  process.env.APPDATA || "",
  "Code",
  "User",
  "globalStorage",
  "rooveterinaryinc.roo-cline",
  "tasks"
);
const defaultOutRoot = path.join(rootDir, "roo-code-exports");

function sourceConfigFromArgs(argv) {
  const sourceType = argv[0] || "roo-code";
  const sourceName = argv[1] || "Roo Code";
  const idPrefix = argv[2] || sourceType;
  return { sourceType, sourceName, idPrefix };
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeFileName(value, fallback = "untitled") {
  return String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || fallback;
}

function shortHash(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, 10);
}

function toIso(value) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) {
    return new Date(number > 100000000000 ? number : number * 1000).toISOString();
  }
  if (typeof value === "string" && value) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }
  return null;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim()) || "";
}

function parseJsonMaybe(value) {
  if (typeof value !== "string") {
    return value && typeof value === "object" ? value : null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stringifyCompact(value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function stripEnvironmentDetails(text) {
  return String(text || "")
    .replace(/<environment_details>[\s\S]*?<\/environment_details>/g, "")
    .trim();
}

function contentToText(content) {
  if (typeof content === "string") {
    return stripEnvironmentDetails(content);
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return stripEnvironmentDetails(
    content
      .map((item) => {
        if (typeof item === "string") return item;
        return firstString(item?.text, item?.content);
      })
      .filter(Boolean)
      .join("\n\n")
  );
}

function diffLines(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function parseUnifiedDiff(pathValue, unified, stats = {}) {
  const lines = diffLines(unified);
  const edits = [];
  let current = null;

  for (const line of lines) {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      if (current) edits.push(current);
      current = {
        lineStart: Number(header[1]) || Number(header[2]) || 1,
        beforeText: "",
        afterText: "",
        removedLineCount: 0,
        addedLineCount: 0,
      };
      continue;
    }
    if (!current || line.startsWith("---") || line.startsWith("+++")) {
      continue;
    }
    if (line.startsWith("-")) {
      current.beforeText += `${current.beforeText ? "\n" : ""}${line.slice(1)}`;
      current.removedLineCount += 1;
    } else if (line.startsWith("+")) {
      current.afterText += `${current.afterText ? "\n" : ""}${line.slice(1)}`;
      current.addedLineCount += 1;
    }
  }
  if (current) edits.push(current);

  return {
    path: pathValue || "unknown",
    source: "roo-code-diff",
    changeKind: "edited",
    totalAddedLines: Number(stats.added) || edits.reduce((sum, edit) => sum + edit.addedLineCount, 0),
    totalRemovedLines: Number(stats.removed) || edits.reduce((sum, edit) => sum + edit.removedLineCount, 0),
    edits,
  };
}

function parseSearchReplaceDiff(pathValue, text, stats = {}) {
  const edits = [];
  const regex = /<<<<<<< SEARCH\s*(?::start_line:(\d+)\s*)?-------\s*([\s\S]*?)=======\s*([\s\S]*?)>>>>>>> REPLACE/g;
  let match = null;
  while ((match = regex.exec(String(text || "")))) {
    const beforeText = match[2].replace(/^\n|\n$/g, "");
    const afterText = match[3].replace(/^\n|\n$/g, "");
    edits.push({
      lineStart: Number(match[1]) || 1,
      beforeText,
      afterText,
      removedLineCount: diffLines(beforeText).length,
      addedLineCount: diffLines(afterText).length,
    });
  }
  return {
    path: pathValue || "unknown",
    source: "roo-code-search-replace",
    changeKind: "edited",
    totalAddedLines: Number(stats.added) || edits.reduce((sum, edit) => sum + edit.addedLineCount, 0),
    totalRemovedLines: Number(stats.removed) || edits.reduce((sum, edit) => sum + edit.removedLineCount, 0),
    edits,
  };
}

function parseClineSearchReplaceDiff(pathValue, text, stats = {}) {
  const edits = [];
  const regex = /------- SEARCH\s*([\s\S]*?)=======\s*([\s\S]*?)\+{6} REPLACE/g;
  let match = null;
  while ((match = regex.exec(String(text || "")))) {
    const beforeText = match[1].replace(/^\n|\n$/g, "");
    const afterText = match[2].replace(/^\n|\n$/g, "");
    edits.push({
      lineStart: 1,
      beforeText,
      afterText,
      removedLineCount: diffLines(beforeText).length,
      addedLineCount: diffLines(afterText).length,
    });
  }
  return {
    path: pathValue || "unknown",
    source: "cline-search-replace",
    changeKind: "edited",
    totalAddedLines: Number(stats.added) || edits.reduce((sum, edit) => sum + edit.addedLineCount, 0),
    totalRemovedLines: Number(stats.removed) || edits.reduce((sum, edit) => sum + edit.removedLineCount, 0),
    edits,
  };
}

function diffFromRooPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const pathValue = firstString(payload.path, payload.file, payload.target_file);
  const stats = payload.diffStats || {};
  if (typeof payload.content === "string" && payload.content.includes("@@")) {
    return [parseUnifiedDiff(pathValue, payload.content, stats)];
  }
  if (typeof payload.diff === "string" && payload.diff.includes("<<<<<<< SEARCH")) {
    return [parseSearchReplaceDiff(pathValue, payload.diff, stats)];
  }
  if (payload.tool === "editedExistingFile" && typeof payload.content === "string" && payload.content.includes("------- SEARCH")) {
    return [parseClineSearchReplaceDiff(pathValue, payload.content, stats)];
  }
  if (payload.tool === "newFileCreated" && typeof payload.content === "string") {
    const afterText = payload.content;
    return [
      {
        path: pathValue || "unknown",
        source: "cline-new-file",
        changeKind: "created",
        totalAddedLines: diffLines(afterText).length,
        totalRemovedLines: 0,
        edits: [
          {
            lineStart: 1,
            beforeText: "",
            afterText,
            removedLineCount: 0,
            addedLineCount: diffLines(afterText).length,
          },
        ],
      },
    ];
  }
  return [];
}

function summarizeToolPayload(toolName, payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const parts = [];
  if (payload.serverName) parts.push(String(payload.serverName));
  if (payload.toolName) parts.push(String(payload.toolName));
  if (payload.tool) parts.push(String(payload.tool));
  if (payload.path) parts.push(String(payload.path));
  if (payload.file) parts.push(String(payload.file));
  if (payload.command) parts.push(String(payload.command));
  if (payload.regex) parts.push(String(payload.regex));
  if (payload.query) parts.push(String(payload.query));
  if (Array.isArray(payload.batchFiles)) parts.push(`${payload.batchFiles.length} files`);
  if (Array.isArray(payload.todos)) parts.push(`${payload.todos.length} todos`);
  return parts.join(" · ") || toolName;
}

function normalizeRooAsk(message) {
  const payload = parseJsonMaybe(message.text);
  if (message.ask === "followup" && payload?.question) {
    return { type: "assistant_text", text: payload.question };
  }
  if (message.ask === "completion_result") {
    return { type: "assistant_text", text: firstString(payload?.result, payload?.text, message.text) };
  }

  let toolName = message.ask || "tool";
  if (payload?.type === "use_mcp_tool") {
    toolName = payload.toolName ? `${payload.serverName || "mcp"}.${payload.toolName}` : payload.serverName || "mcp";
  } else if (payload?.tool) {
    toolName = payload.tool;
  } else if (message.ask === "command") {
    toolName = "terminal";
  } else if (message.ask === "command_output") {
    toolName = "terminal_output";
  }

  return {
    type: "tool",
    tool: {
      requestId: String(message.ts || ""),
      toolUseId: `${message.ask || "ask"}-${message.ts || ""}`,
      toolName,
      input: payload || { text: message.text || "" },
      inputJson: payload ? JSON.stringify(payload) : "",
      inputSummary: payload ? summarizeToolPayload(toolName, payload) : firstString(message.text).slice(0, 180),
      isError: false,
      text: payload?.content || "",
      metrics: payload?.diffStats || {},
      diffs: diffFromRooPayload(payload),
    },
  };
}

function normalizeRooSay(message) {
  const text = String(message.text || "");
  if (message.say === "text") {
    return text.trim() ? { type: "assistant_text", text } : null;
  }
  if (message.say === "completion_result" || message.say === "subtask_result") {
    return text.trim() ? { type: "assistant_text", text } : null;
  }
  if (message.say === "user_feedback") {
    return { type: "user_feedback", text };
  }

  const payload = parseJsonMaybe(text);
  if (message.say === "tool" && payload?.tool) {
    const toolName = payload.tool;
    return {
      type: "tool",
      tool: {
        requestId: String(message.ts || ""),
        toolUseId: `${toolName}-${message.ts || ""}`,
        toolName,
        input: payload,
        inputJson: JSON.stringify(payload),
        inputSummary: summarizeToolPayload(toolName, payload),
        isError: false,
        text: payload.content || "",
        metrics: payload.diffStats || {},
        diffs: diffFromRooPayload(payload),
      },
    };
  }
  const toolName =
    message.say === "api_req_started"
      ? "api_request"
      : message.say === "mcp_server_response"
        ? "mcp_server_response"
        : message.say || "event";

  return {
    type: "tool",
    tool: {
      requestId: String(message.ts || ""),
      toolUseId: `${message.say || "say"}-${message.ts || ""}`,
      toolName,
      input: payload && message.say === "api_req_started" ? payload : null,
      inputJson: payload ? JSON.stringify(payload) : "",
      inputSummary: payload ? summarizeToolPayload(toolName, payload) : "",
      isError: message.say === "error",
      text: payload && message.say === "api_req_started" ? JSON.stringify(payload, null, 2) : text,
      metrics: payload && message.say === "api_req_started" ? payload : {},
      diffs: [],
    },
  };
}

function lastAssistantText(events) {
  const event = [...events].reverse().find((item) => item.type === "assistant_text" && item.text && item.text.trim());
  return event ? event.text : "";
}

function normalizeUiMessages(taskId, title, historyItem, uiMessages) {
  const sorted = [...(uiMessages || [])].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
  const exchanges = [];
  let current = null;
  let consumedInitialTask = false;

  const startExchange = (request, timestamp) => {
    current = {
      exchangeId: `${taskId}-${exchanges.length + 1}`,
      timestamp: toIso(timestamp) || toIso(historyItem.ts) || new Date(0).toISOString(),
      status: historyItem.status || "",
      model: "",
      request: String(request || ""),
      response: "",
      events: [],
      tools: [],
      raw: {},
    };
    exchanges.push(current);
  };

  startExchange(historyItem.task || title || taskId, historyItem.ts || sorted[0]?.ts);

  for (const message of sorted) {
    if (message.type === "say" && message.say === "text" && !consumedInitialTask) {
      const text = String(message.text || "").trim();
      const task = String(historyItem.task || "").trim();
      if (text && (!task || text === task || task.startsWith(text) || text.startsWith(task.slice(0, 120)))) {
        current.request = message.text;
        current.timestamp = toIso(message.ts) || current.timestamp;
        consumedInitialTask = true;
        continue;
      }
    }

    let event = null;
    if (message.type === "ask") {
      event = normalizeRooAsk(message);
    } else if (message.type === "say") {
      event = normalizeRooSay(message);
    }
    if (!event) {
      continue;
    }
    if (event.type === "user_feedback") {
      startExchange(event.text, message.ts);
      continue;
    }
    current.events.push(event);
    if (event.type === "tool") {
      current.tools.push(event.tool);
    }
    if (event.type === "assistant_text") {
      current.response = event.text;
    }
  }

  for (const exchange of exchanges) {
    if (!exchange.response) {
      exchange.response = lastAssistantText(exchange.events);
    }
  }

  return exchanges.filter((exchange) => exchange.request.trim() || exchange.events.length || exchange.response.trim());
}

function normalizeApiMessages(taskId, title, historyItem, apiMessages) {
  const exchanges = [];
  const messages = Array.isArray(apiMessages) ? apiMessages : [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "user") {
      continue;
    }
    const assistant = messages.slice(index + 1).find((item) => item.role === "assistant");
    const assistantText = contentToText(assistant?.content);
    exchanges.push({
      exchangeId: `${taskId}-${exchanges.length + 1}`,
      timestamp: toIso(message.ts) || toIso(historyItem.ts) || new Date(0).toISOString(),
      status: historyItem.status || "",
      model: "",
      request: contentToText(message.content) || title || taskId,
      response: assistantText,
      events: assistantText ? [{ type: "assistant_text", text: assistantText }] : [],
      tools: [],
      raw: { userMessageIndex: index },
    });
  }
  return exchanges;
}

function workspaceForHistoryItem(historyItem) {
  return historyItem.workspace || historyItem.cwdOnTaskInitialization || historyItem.cwd || "";
}

function modeForHistoryItem(historyItem) {
  return historyItem.mode || historyItem.modelInfo?.mode || "";
}

function modelForHistoryItem(historyItem) {
  return historyItem.modelId || historyItem.model || "";
}

function exportTask(tasksRoot, outDir, historyItem, sourceConfig) {
  const taskDir = path.join(tasksRoot, historyItem.id);
  const uiMessages = readJsonSafe(path.join(taskDir, "ui_messages.json"));
  const apiMessages = readJsonSafe(path.join(taskDir, "api_conversation_history.json"));
  const taskMetadata = readJsonSafe(path.join(taskDir, "task_metadata.json"));
  const title = firstString(historyItem.task, historyItem.id).split(/\r?\n/)[0].slice(0, 180) || historyItem.id;
  const exchanges = Array.isArray(uiMessages) && uiMessages.length
    ? normalizeUiMessages(historyItem.id, title, historyItem, uiMessages)
    : normalizeApiMessages(historyItem.id, title, historyItem, apiMessages);
  const toolUseCount = exchanges.reduce((sum, exchange) => sum + (exchange.tools || []).length, 0);
  const editDiffCount = exchanges.reduce(
    (sum, exchange) => sum + (exchange.tools || []).reduce((toolSum, tool) => toolSum + ((tool.diffs || []).length), 0),
    0
  );
  const firstTimestamp = exchanges[0]?.timestamp || toIso(historyItem.ts);
  const lastTimestamp = [...exchanges].reverse().find((exchange) => exchange.timestamp)?.timestamp || firstTimestamp;

  const conversation = {
    normalizedConversationVersion: 1,
    sourceType: sourceConfig.sourceType,
    sourceName: sourceConfig.sourceName,
    conversationId: historyItem.id,
    title,
    workspacePath: workspaceForHistoryItem(historyItem),
    metadata: {
      historyItem,
      taskMetadata,
      sourceFiles: {
        uiMessages: fs.existsSync(path.join(taskDir, "ui_messages.json")) ? path.join(taskDir, "ui_messages.json") : null,
        apiConversationHistory: fs.existsSync(path.join(taskDir, "api_conversation_history.json")) ? path.join(taskDir, "api_conversation_history.json") : null,
        taskMetadata: fs.existsSync(path.join(taskDir, "task_metadata.json")) ? path.join(taskDir, "task_metadata.json") : null,
      },
    },
    exchanges,
    toolUseCount,
    editDiffCount,
  };

  const baseName = `${sanitizeFileName(title)} -- ${historyItem.id}`;
  fs.writeFileSync(path.join(outDir, "conversations", `${baseName}.json`), `${JSON.stringify(conversation, null, 2)}\n`, "utf8");

  return {
    conversationId: historyItem.id,
    id: historyItem.id,
    title,
    exchangeCount: exchanges.length,
    toolUseCount,
    editDiffCount,
    firstTimestamp,
    lastTimestamp,
    workspacePath: workspaceForHistoryItem(historyItem),
    mode: modeForHistoryItem(historyItem),
    model: modelForHistoryItem(historyItem),
    status: historyItem.status || "",
    rootTaskUuid: historyItem.parentTaskId || null,
    isPinned: Boolean(historyItem.isFavorited),
  };
}

function readHistoryEntries(tasksRoot) {
  const index = readJsonSafe(path.join(tasksRoot, "_index.json"));
  const byId = new Map();
  if (Array.isArray(index?.entries)) {
    for (const entry of index.entries) {
      if (entry?.id) byId.set(String(entry.id), entry);
    }
  }

  const taskHistoryPath = path.join(path.dirname(tasksRoot), "state", "taskHistory.json");
  const taskHistory = readJsonSafe(taskHistoryPath);
  if (Array.isArray(taskHistory)) {
    for (const entry of taskHistory) {
      if (entry?.id && !byId.has(String(entry.id))) {
        byId.set(String(entry.id), entry);
      }
    }
  }

  for (const dirEntry of fs.readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!dirEntry.isDirectory() || dirEntry.name.startsWith("_")) {
      continue;
    }
    if (!byId.has(dirEntry.name)) {
      const uiMessages = readJsonSafe(path.join(tasksRoot, dirEntry.name, "ui_messages.json"));
      const firstText = Array.isArray(uiMessages)
        ? uiMessages.find((message) => message.type === "say" && message.say === "text" && String(message.text || "").trim())?.text
        : "";
      byId.set(dirEntry.name, {
        id: dirEntry.name,
        ts: Number(dirEntry.name) || null,
        task: firstText || dirEntry.name,
      });
    }
  }

  return [...byId.values()].filter((entry) => {
    const taskDir = path.join(tasksRoot, String(entry.id || ""));
    return entry?.id && fs.existsSync(taskDir) && fs.statSync(taskDir).isDirectory();
  });
}

function main() {
  const tasksRoot = path.resolve(process.argv[2] || defaultTasksRoot);
  const outRoot = path.resolve(process.argv[3] || defaultOutRoot);
  const sourceConfig = sourceConfigFromArgs(process.argv.slice(4));
  if (!fs.existsSync(tasksRoot)) {
    throw new Error(`${sourceConfig.sourceName} task root does not exist: ${tasksRoot}`);
  }

  const entries = readHistoryEntries(tasksRoot);
  const groups = new Map();
  for (const entry of entries) {
    const workspace = workspaceForHistoryItem(entry) || "(unknown workspace)";
    if (!groups.has(workspace)) groups.set(workspace, []);
    groups.get(workspace).push(entry);
  }

  ensureDir(outRoot);
  const exports = [];
  for (const [workspace, items] of groups) {
    const workspaceName = path.basename(workspace) || "unknown";
    const exportId = `${sourceConfig.idPrefix}-${sanitizeFileName(workspaceName, "workspace").toLowerCase()}-${shortHash(workspace)}`;
    const outDir = path.join(outRoot, exportId);
    ensureDir(path.join(outDir, "conversations"));

    const metadata = {
      sourceType: sourceConfig.sourceType,
      sourceName: sourceConfig.sourceName,
      storageId: exportId,
      sourceRoot: tasksRoot,
      exportedAt: new Date().toISOString(),
      workspace: {
        name: workspaceName,
        path: workspace === "(unknown workspace)" ? "" : workspace,
        targetPath: workspace === "(unknown workspace)" ? "" : workspace,
        raw: { workspace },
      },
    };
    fs.writeFileSync(path.join(outDir, "workspace-export-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    const conversations = items
      .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
      .map((entry) => exportTask(tasksRoot, outDir, entry, sourceConfig))
      .sort((a, b) => String(b.lastTimestamp || "").localeCompare(String(a.lastTimestamp || "")));

    const summary = {
      ...metadata,
      source: tasksRoot,
      counts: {
        tasks: items.length,
        conversations: conversations.length,
      },
      conversations,
    };
    fs.writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    exports.push({ exportId, workspace, conversationCount: conversations.length, outDir });
  }

  console.log(JSON.stringify({ outRoot, exportCount: exports.length, exports }, null, 2));
}

main();
