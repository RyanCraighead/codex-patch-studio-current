#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function base62Decode(value) {
  let result = 0;
  for (const char of String(value)) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) {
      throw new Error(`Invalid base62 character: ${char}`);
    }
    result = result * 62 + digit;
  }
  return result;
}

function sanitizeFileName(value) {
  return String(value || "untitled")
    .trim()
    .replace(/\r?\n/g, " ")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "untitled";
}

function readWebviewState(dbPath, key) {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = database.prepare("select value from ItemTable where key=?").get(key);
    if (!row) {
      throw new Error(`Key not found in ${dbPath}: ${key}`);
    }
    const value = Buffer.isBuffer(row.value) || row.value instanceof Uint8Array
      ? Buffer.from(row.value).toString("utf8")
      : String(row.value);
    const wrapper = JSON.parse(value);
    return wrapper.webviewState;
  } finally {
    database.close();
  }
}

function decodeWebviewState(webviewState) {
  const rawState = JSON.parse(webviewState);
  if (rawState && typeof rawState === "object" && !Array.isArray(rawState)) {
    return rawState;
  }
  if (!Array.isArray(rawState) || rawState.length !== 2) {
    throw new Error(`Unsupported webviewState format: ${typeof rawState}`);
  }

  const [table, rootRef] = rawState;
  const memo = new Map();
  const decodeRef = (ref) => decodeIndex(base62Decode(ref));
  const decodeIndex = (index) => {
    if (memo.has(index)) {
      return memo.get(index);
    }
    const value = table[index];
    if (typeof value === "string" && value.length >= 2 && value[1] === "|") {
      const kind = value[0];
      const parts = value.slice(2) ? value.slice(2).split("|") : [];
      if (kind === "a") {
        const decoded = [];
        memo.set(index, decoded);
        decoded.push(...parts.filter(Boolean).map(decodeRef));
        return decoded;
      }
      if (kind === "o") {
        const keys = parts.length ? decodeRef(parts[0]) : [];
        const decoded = {};
        memo.set(index, decoded);
        for (let itemIndex = 1; itemIndex < parts.length; itemIndex += 1) {
          decoded[String(keys[itemIndex - 1])] = decodeRef(parts[itemIndex]);
        }
        return decoded;
      }
      if (kind === "b") {
        return parts[0] === "T";
      }
      if (kind === "n") {
        return parts[0] ? base62Decode(parts[0]) : 0;
      }
    }
    memo.set(index, value);
    return value;
  };

  return decodeRef(rootRef);
}

function exchangeToMarkdown(item, index) {
  const lines = [];
  const timestamp = item.timestamp || item.createdAtIso || item.created_at;
  let heading = `## Item ${index + 1}`;
  if (item.chatItemType) heading += ` - ${item.chatItemType}`;
  if (timestamp) heading += ` - ${timestamp}`;
  lines.push(heading, "");
  if (item.request_message) lines.push("### User", "", String(item.request_message), "");
  if (item.response_text) lines.push("### Assistant", "", String(item.response_text), "");
  if (item.summary) lines.push("### Summary", "", String(item.summary), "");
  if (!("request_message" in item) && !("response_text" in item) && !("summary" in item)) {
    const small = {};
    for (const key of ["chatItemType", "exchangeUuid", "request_id", "status", "seen_state", "timestamp"]) {
      if (key in item) small[key] = item[key];
    }
    lines.push("```json", JSON.stringify(small, null, 2), "```", "");
  }
  return lines;
}

function utcStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function main() {
  if (process.argv.length < 3) {
    process.stderr.write("Usage: node scripts/export-augment-webview-state.cjs <state.vscdb-or-backup> [out-dir]\n");
    return 2;
  }

  const dbPath = path.resolve(process.argv[2]);
  const outDir = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.join(process.cwd(), "augment-vscode-state-exports", utcStamp());
  const key = "memento/webviewView.augment-chat";
  fs.mkdirSync(path.join(outDir, "conversations"), { recursive: true });

  const state = decodeWebviewState(readWebviewState(dbPath, key));
  const conversations = state.conversations || {};
  if (!conversations || typeof conversations !== "object" || Array.isArray(conversations)) {
    throw new Error("Decoded webview state did not contain a conversations object");
  }

  const index = [];
  for (const [conversationId, conversation] of Object.entries(conversations)) {
    if (!conversation || typeof conversation !== "object" || Array.isArray(conversation)) continue;
    const chatHistory = Array.isArray(conversation.chatHistory) ? conversation.chatHistory : [];
    const extra = conversation.extraData || {};
    const name = typeof conversation.name === "string" ? conversation.name.trim() : conversation.name;
    const record = {
      id: conversationId,
      name,
      createdAtIso: conversation.createdAtIso,
      lastInteractedAtIso: conversation.lastInteractedAtIso,
      chatHistoryCount: chatHistory.length,
      isPinned: conversation.isPinned,
      isShareable: conversation.isShareable,
      isAgentConversation: extra.isAgentConversation,
      hasTitleGenerated: extra.hasTitleGenerated,
      isForked: extra.isForked,
      forkedFrom: extra.forkedFrom,
      rootTaskUuid: conversation.rootTaskUuid,
    };
    index.push(record);

    const baseName = `${sanitizeFileName(record.name || conversationId)} -- ${conversationId}`;
    const conversationsDir = path.join(outDir, "conversations");
    fs.writeFileSync(path.join(conversationsDir, `${baseName}.json`), JSON.stringify(conversation, null, 2), "utf8");
    const lines = [
      `# ${record.name || conversationId}`,
      "",
      `Conversation ID: \`${conversationId}\``,
      `Created: ${record.createdAtIso}`,
      `Last interacted: ${record.lastInteractedAtIso}`,
      `Chat history items: ${record.chatHistoryCount}`,
      "",
    ];
    for (let itemIndex = 0; itemIndex < chatHistory.length; itemIndex += 1) {
      const item = chatHistory[itemIndex];
      if (item && typeof item === "object" && !Array.isArray(item)) {
        lines.push(...exchangeToMarkdown(item, itemIndex));
      }
    }
    fs.writeFileSync(path.join(conversationsDir, `${baseName}.md`), lines.join("\n"), "utf8");
  }

  index.sort((left, right) => String(right.lastInteractedAtIso || "").localeCompare(String(left.lastInteractedAtIso || "")));
  fs.writeFileSync(path.join(outDir, "webview-state.json"), JSON.stringify(state, null, 2), "utf8");
  fs.writeFileSync(path.join(outDir, "conversation-index.json"), JSON.stringify(index, null, 2), "utf8");
  process.stdout.write(`${JSON.stringify({
    outDir,
    conversationCount: index.length,
    currentConversationId: state.currentConversationId,
    newestConversations: index.slice(0, 10),
  }, null, 2)}\n`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
}
