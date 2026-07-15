#!/usr/bin/env node
"use strict";

const http = require("node:http");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROXY_FEATURES = {
  envAdmin: true,
  toolMessageRepair: true,
  modelReasoningProfiles: true,
  modelReasoningProfilesVersion: 2,
};

const DASHSCOPE_MODELS = [
  "qwen3.7-plus",
  "qwen3.7-plus-2026-05-26",
  "qwen3.7-max",
  "qwen3.7-max-2026-06-08",
  "qwen3.6-plus",
  "qwen3.6-plus-2026-04-02",
  "qwen3.6-max-preview",
  "qwen3.6-flash",
  "qwen3.6-27b",
  "qwen3.5-plus",
  "qwen3.5-plus-2026-04-20",
  "qwen3.5-flash",
  "qwen3.5-27b",
  "qwen3-max",
  "qwen3-max-2026-01-23",
  "qwen-plus",
  "qwen-plus-2025-12-01",
  "qwen-plus-us",
  "qwen-plus-2025-12-01-us",
  "qwen-plus-character",
  "qwen-flash",
  "qwen-flash-2025-07-28",
  "qwen-flash-us",
  "qwen-flash-2025-07-28-us",
  "qwen3-coder-next",
  "qwen3-coder-plus",
  "qwen3-coder-plus-2025-09-23",
  "qwen3-coder-flash",
  "qwen3-coder-flash-2025-07-28",
];

const CEREBRAS_MODELS = [
  "gemma-4-31b",
  "gpt-oss-120b",
  "zai-glm-4.7",
];

const PROVIDERS = {
  deepseek: {
    label: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com",
    chatPath: "/chat/completions",
    models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
  },
  zai: {
    label: "Z.ai GLM",
    envKey: "ZAI_API_KEY",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    chatPath: "/chat/completions",
    models: ["glm-5.2", "glm-5.1", "glm-5", "glm-4.7", "glm-4.6", "glm-4.5"],
  },
  dashscope: {
    label: "Alibaba Qwen",
    envKey: "DASHSCOPE_API_KEY",
    baseUrl: "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
    chatPath: "/chat/completions",
    models: DASHSCOPE_MODELS,
  },
  cerebras: {
    label: "Cerebras",
    envKey: "CEREBRAS_API_KEY",
    baseUrl: "https://api.cerebras.ai/v1",
    chatPath: "/chat/completions",
    models: CEREBRAS_MODELS,
  },
};

const providerId = process.env.CODEX_PROXY_PROVIDER || "deepseek";
const configuredProvider = PROVIDERS[providerId] || PROVIDERS.deepseek;
const providerBaseUrlOverride =
  process.env[`${providerId.toUpperCase()}_BASE_URL`] ||
  process.env[`${configuredProvider.envKey.replace(/_API_KEY$/, "")}_BASE_URL`];
const provider = {
  ...configuredProvider,
  baseUrl: providerBaseUrlOverride || configuredProvider.baseUrl,
};
const host = process.env.CODEX_PROXY_HOST || "127.0.0.1";
const port = Number(process.env.CODEX_PROXY_PORT || 47731);
const localRuntimeRoot = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "CodexPatchStudioCurrent");
const logPath =
  process.env.CODEX_PROXY_LOG ||
  path.join(localRuntimeRoot, "logs", "codex-provider-proxy.log");
const modelCacheDir =
  process.env.CODEX_PROVIDER_MODEL_CACHE_DIR || path.join(localRuntimeRoot, "model-cache");

const responseStore = new Map();
const reasoningByCallId = new Map();
const modelListCache = new Map();
const MAX_REASONING_CACHE_ENTRIES = 1000;
const MAX_REQUEST_BODY_BYTES = Number(process.env.CODEX_PROXY_MAX_BODY_BYTES || 64 * 1024 * 1024);
const MODEL_LIST_CACHE_MS = Number(process.env.CODEX_PROXY_MODEL_LIST_CACHE_MS || 5 * 60 * 1000);
PROXY_FEATURES.bodyLimitBytes = MAX_REQUEST_BODY_BYTES;

function log(message, extra = null) {
  const line = `${new Date().toISOString()} ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}\n`;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line, "utf8");
  } catch {
    // Logging must never break the provider.
  }
}

function corsHeaders(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-allow-private-network": "true",
    "access-control-max-age": "600",
    ...extra,
  };
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...corsHeaders(),
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(new Error(`Request body too large; limit is ${MAX_REQUEST_BODY_BYTES} bytes.`));
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(Object.assign(new Error("Invalid JSON request body"), { cause: error }));
      }
    });
    req.on("error", reject);
  });
}

function hasProviderApiKey() {
  return Boolean(process.env[provider.envKey]);
}

function healthBody() {
  return {
    ok: true,
    provider: providerId,
    upstream: provider.baseUrl,
    envKey: provider.envKey,
    hasApiKey: hasProviderApiKey(),
    modelCacheDir,
    pid: process.pid,
    features: PROXY_FEATURES,
  };
}

function setUserEnvironmentVariable(name, value) {
  if (!/^[A-Z0-9_]+$/.test(name)) {
    throw new Error("Environment variable names can only contain A-Z, 0-9, and underscore.");
  }
  if (name !== provider.envKey) {
    throw new Error(`This proxy can only manage ${provider.envKey}.`);
  }
  const shell = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const script = "[Environment]::SetEnvironmentVariable($env:CODEX_ENV_NAME, $env:CODEX_ENV_VALUE, 'User')";
  const result = spawnSync(shell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_ENV_NAME: name,
      CODEX_ENV_VALUE: value,
    },
    windowsHide: true,
  });
  if (result.status !== 0) {
    const message = String(result.stderr || result.stdout || "PowerShell failed to set the environment variable.").trim();
    throw new Error(message);
  }
  process.env[name] = value;
}

function textFromContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        return part.text ?? part.output_text ?? part.input_text ?? part.content ?? "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") {
    return content.text ?? content.output_text ?? content.input_text ?? content.content ?? "";
  }
  return String(content);
}

function normalizeRole(role) {
  if (role === "assistant" || role === "system" || role === "tool") return role;
  return "user";
}

function safeToolName(name) {
  const value = String(name || "unknown_tool").replace(/[^A-Za-z0-9_-]/g, "_");
  return value || "unknown_tool";
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return null;
}

function reasoningContentFromContent(content) {
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (typeof part.reasoning_content === "string") return part.reasoning_content;
      if (typeof part.reasoningContent === "string") return part.reasoningContent;
      if (typeof part.thinking === "string") return part.thinking;
      if (part.type === "reasoning_text" && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean);
  return parts.length ? parts.join("\n") : null;
}

function reasoningContentFromItem(item) {
  if (!item || typeof item !== "object") return null;
  return firstString(
    item.reasoning_content,
    item.reasoningContent,
    item.thinking,
    reasoningContentFromContent(item.content),
  );
}

function rememberReasoningForToolCalls(toolCalls, reasoningContent) {
  if (!Array.isArray(toolCalls) || !toolCalls.length || typeof reasoningContent !== "string") return;
  for (const call of toolCalls) {
    const id = call?.id || call?.call_id;
    if (id) reasoningByCallId.set(id, reasoningContent);
  }
  while (reasoningByCallId.size > MAX_REASONING_CACHE_ENTRIES) {
    reasoningByCallId.delete(reasoningByCallId.keys().next().value);
  }
}

function cachedReasoningForToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return null;
  for (const call of toolCalls) {
    const id = call?.id || call?.call_id;
    if (id && reasoningByCallId.has(id)) return reasoningByCallId.get(id);
  }
  return null;
}

function attachReasoningToAssistantToolCallMessage(message, explicitReasoning, options = {}) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.tool_calls) || !message.tool_calls.length) {
    return message;
  }
  if (typeof message.reasoning_content === "string") return message;

  const cached = cachedReasoningForToolCalls(message.tool_calls);
  const reasoning =
    typeof explicitReasoning === "string"
      ? explicitReasoning
      : typeof cached === "string"
        ? cached
        : options.requireReasoningContent
          ? ""
          : null;
  if (typeof reasoning === "string") message.reasoning_content = reasoning;
  return message;
}

function responseFunctionCallToToolCall(item) {
  const callId = item.call_id || item.id || "call_unknown";
  return {
    id: callId,
    type: "function",
    function: {
      name: safeToolName(item.name),
      arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
    },
  };
}

function responseFunctionCallToChatMessage(item, reasoningContent = null, options = {}) {
  return attachReasoningToAssistantToolCallMessage(
    {
      role: "assistant",
      content: "",
      tool_calls: [responseFunctionCallToToolCall(item)],
    },
    reasoningContent ?? reasoningContentFromItem(item),
    options,
  );
}

function appendPendingReasoning(current, next) {
  if (typeof next !== "string") return current;
  if (typeof current !== "string" || !current) return next;
  return `${current}\n${next}`;
}

function responseInputToMessages(input, options = {}) {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }
  if (!Array.isArray(input)) {
    return [];
  }
  const messages = [];
  let pendingReasoningContent = null;
  let pendingToolCallMessage = null;

  const flushPendingToolCallMessage = () => {
    if (!pendingToolCallMessage) return;
    messages.push(attachReasoningToAssistantToolCallMessage(pendingToolCallMessage, null, options));
    pendingToolCallMessage = null;
  };

  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "reasoning") {
      pendingReasoningContent = appendPendingReasoning(pendingReasoningContent, reasoningContentFromItem(item));
      continue;
    }
    if (item.type === "function_call") {
      const itemReasoning = reasoningContentFromItem(item);
      pendingToolCallMessage ||= { role: "assistant", content: "", tool_calls: [] };
      pendingToolCallMessage.tool_calls.push(responseFunctionCallToToolCall(item));
      const reasoning = itemReasoning ?? pendingReasoningContent;
      if (typeof reasoning === "string") pendingToolCallMessage.reasoning_content = reasoning;
      pendingReasoningContent = null;
      continue;
    }
    if (item.type === "function_call_output") {
      flushPendingToolCallMessage();
      messages.push({
        role: "tool",
        tool_call_id: item.call_id || item.id || "call_unknown",
        content: textFromContent(item.output ?? item.content),
      });
      continue;
    }
    if (item.type === "message" || item.role) {
      flushPendingToolCallMessage();
      const content = textFromContent(item.content);
      const role = normalizeRole(item.role);
      const message = { role, content };
      if (Array.isArray(item.tool_calls)) {
        message.tool_calls = item.tool_calls;
      }
      const reasoning = reasoningContentFromItem(item) ?? pendingReasoningContent;
      if (role === "assistant" && typeof reasoning === "string") {
        message.reasoning_content = reasoning;
      }
      if (content || message.tool_calls?.length || typeof message.reasoning_content === "string") {
        messages.push(attachReasoningToAssistantToolCallMessage(message, null, options));
      }
      pendingReasoningContent = null;
      continue;
    }
    flushPendingToolCallMessage();
    const content = textFromContent(item.content ?? item.text ?? item.output);
    if (content) {
      messages.push({ role: normalizeRole(item.role), content });
    }
  }
  flushPendingToolCallMessage();
  return normalizeChatMessages(messages, options);
}

function responseToolsToChatTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const chatTools = tools
    .map((tool) => {
      if (!tool || typeof tool !== "object") return null;
      if (tool.type === "function" && tool.function) return tool;
      if (tool.type === "function" || tool.name) {
        return {
          type: "function",
          function: {
            name: tool.name,
            description: tool.description || "",
            parameters: tool.parameters || tool.input_schema || { type: "object", properties: {} },
          },
        };
      }
      return null;
    })
    .filter(Boolean);
  return chatTools.length ? chatTools : undefined;
}

function requestedReasoningEffort(request) {
  const effort = String(request.reasoning?.effort || request.reasoning_effort || "").toLowerCase();
  if (effort === "off" || effort === "disabled" || effort === "disable" || effort === "none" || effort === "minimal") {
    return "none";
  }
  if (effort === "xhigh" || effort === "extra_high" || effort === "extra-high" || effort === "max") {
    return "xhigh";
  }
  if (["low", "medium", "high"].includes(effort)) {
    return effort;
  }
  return "";
}

function firstAllowedReasoning(requested, allowed, fallback = "none") {
  if (allowed.includes(requested)) {
    return requested;
  }
  if (requested === "xhigh" && allowed.includes("max")) {
    return "max";
  }
  if (requested === "xhigh" && allowed.includes("high")) {
    return "high";
  }
  if (allowed.includes(fallback)) {
    return fallback;
  }
  return allowed[0] || "none";
}

function modelReasoningProfile(model) {
  const normalized = String(model || "").toLowerCase();
  if (providerId === "deepseek") {
    if (normalized.includes("chat") && !normalized.includes("reason") && !normalized.includes("v4")) {
      return { kind: "none", allowed: ["none"], default: "none", requiresReasoningContent: false };
    }
    return {
      kind: "thinking-type-and-effort",
      allowed: ["none", "low", "medium", "high", "xhigh"],
      default: "high",
      requiresReasoningContent: true,
    };
  }
  if (providerId === "zai") {
    if (normalized === "glm-5.2") {
      return {
        kind: "thinking-type-and-effort",
        allowed: ["none", "low", "medium", "high", "xhigh"],
        default: "xhigh",
        requiresReasoningContent: true,
      };
    }
    return {
      kind: "thinking-type",
      allowed: ["none", "medium"],
      default: "medium",
      requiresReasoningContent: true,
    };
  }
  if (providerId === "dashscope") {
    if (normalized.includes("flash") || normalized.includes("chat")) {
      return { kind: "enable-thinking", allowed: ["none", "medium"], default: "none", requiresReasoningContent: false };
    }
    return { kind: "enable-thinking", allowed: ["none", "medium"], default: "medium", requiresReasoningContent: true };
  }
  if (providerId === "cerebras") {
    if (normalized === "zai-glm-4.7") {
      return { kind: "cerebras-glm-reasoning", allowed: ["none", "low", "medium", "high"], default: "medium" };
    }
    if (normalized === "gpt-oss-120b") {
      return { kind: "cerebras-reasoning-effort", allowed: ["low", "medium", "high"], default: "medium" };
    }
    return { kind: "none", allowed: ["none"], default: "none" };
  }
  return { kind: "none", allowed: ["none"], default: "none" };
}

function mapReasoningEffort(request, model) {
  const profile = modelReasoningProfile(model);
  const requested = requestedReasoningEffort(request) || profile.default;
  const level = firstAllowedReasoning(requested, profile.allowed, profile.default);
  const enabled = level !== "none";
  const maxLevel = level === "xhigh" ? "max" : level;

  if (profile.kind === "none") {
    return { params: {}, level: "none", enabled: false, profile };
  }
  if (profile.kind === "thinking-type-and-effort") {
    return {
      params: enabled
        ? { thinking: { type: "enabled" }, reasoning_effort: maxLevel }
        : { thinking: { type: "disabled" } },
      level,
      enabled,
      profile,
    };
  }
  if (profile.kind === "thinking-type") {
    return {
      params: { thinking: { type: enabled ? "enabled" : "disabled" } },
      level,
      enabled,
      profile,
    };
  }
  if (profile.kind === "enable-thinking") {
    return {
      params: { enable_thinking: enabled },
      level,
      enabled,
      profile,
    };
  }
  if (profile.kind === "cerebras-reasoning-effort") {
    return {
      params: enabled ? { reasoning_effort: maxLevel } : {},
      level,
      enabled,
      profile,
    };
  }
  if (profile.kind === "cerebras-glm-reasoning") {
    return {
      params: enabled ? { reasoning_effort: maxLevel, clear_thinking: false } : { reasoning_effort: "none" },
      level,
      enabled,
      profile,
    };
  }
  return { params: {}, level: "none", enabled: false, profile };
}

function providerModelIds() {
  const cached = modelListCache.get(providerId);
  return Array.from(new Set([...(provider.models || []), ...(Array.isArray(cached?.models) ? cached.models : [])]));
}

function normalizeProviderModel(model) {
  const models = providerModelIds();
  if (!model || models.includes(model)) {
    return model || models[0];
  }
  log("model remapped", { requested: model, using: models[0] });
  return models[0];
}

function toolCallIds(message) {
  return new Set((message?.tool_calls || []).map((call) => call.id).filter(Boolean));
}

function syntheticToolOutput(id, reason) {
  return {
    role: "tool",
    tool_call_id: id,
    content: `Tool call ${id} did not return a result in the local Codex session (${reason}).`,
  };
}

function syntheticAssistantToolCall(id, options = {}) {
  return attachReasoningToAssistantToolCallMessage(
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id,
          type: "function",
          function: {
            name: "unknown_tool",
            arguments: "{}",
          },
        },
      ],
    },
    null,
    options,
  );
}

function normalizeToolMessage(message, id) {
  return {
    ...message,
    role: "tool",
    tool_call_id: id,
    content: textFromContent(message.content),
  };
}

function normalizeChatMessages(messages, options = {}) {
  const normalized = [];
  let pendingToolResults = null;

  const openPendingToolResults = (message) => {
    const ids = toolCallIds(message);
    pendingToolResults = ids.size ? { missing: ids } : null;
  };

  const closePendingToolResults = (reason) => {
    if (!pendingToolResults) return;
    const missing = [...pendingToolResults.missing];
    for (const id of missing) {
      normalized.push(syntheticToolOutput(id, reason));
    }
    if (missing.length) {
      log("repaired missing tool outputs", { count: missing.length, reason });
    }
    pendingToolResults = null;
  };

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;

    if (message.role === "tool") {
      const id = message.tool_call_id || "call_unknown";
      const toolMessage = normalizeToolMessage(message, id);
      if (pendingToolResults?.missing.has(id)) {
        normalized.push(toolMessage);
        pendingToolResults.missing.delete(id);
        if (!pendingToolResults.missing.size) pendingToolResults = null;
        continue;
      }

      closePendingToolResults("before unexpected tool output");
      normalized.push(syntheticAssistantToolCall(id, options));
      normalized.push(toolMessage);
      continue;
    }

    closePendingToolResults("before next message");
    const normalizedMessage = attachReasoningToAssistantToolCallMessage(message, null, options);
    normalized.push(normalizedMessage);
    if (
      normalizedMessage.role === "assistant" &&
      Array.isArray(normalizedMessage.tool_calls) &&
      normalizedMessage.tool_calls.length
    ) {
      openPendingToolResults(normalizedMessage);
    }
  }
  closePendingToolResults("at end of request");
  return normalized;
}

function buildChatRequest(request) {
  const model = normalizeProviderModel(request.model);
  const reasoning = mapReasoningEffort(request, model);
  const requireReasoningContent = Boolean(reasoning.enabled && reasoning.profile.requiresReasoningContent);
  const normalizeOptions = { requireReasoningContent };
  const prior = request.previous_response_id ? responseStore.get(request.previous_response_id) : null;
  const messages = [];
  if (prior?.messages?.length) messages.push(...prior.messages);
  if (request.instructions) messages.push({ role: "system", content: String(request.instructions) });
  messages.push(...responseInputToMessages(request.input, normalizeOptions));
  const tools = responseToolsToChatTools(request.tools);
  const chat = {
    model,
    messages: normalizeChatMessages(messages, normalizeOptions),
    stream: request.stream !== false,
    ...reasoning.params,
  };
  if (tools) chat.tools = tools;
  if (request.tool_choice) chat.tool_choice = request.tool_choice;
  if (request.temperature != null) chat.temperature = request.temperature;
  if (request.top_p != null) chat.top_p = request.top_p;
  if (request.max_output_tokens != null) chat.max_tokens = request.max_output_tokens;
  if (request.max_tokens != null) chat.max_tokens = request.max_tokens;
  if (request.response_format != null) chat.response_format = request.response_format;
  return chat;
}

function chatRequestRequiresReasoningContent(chatRequest) {
  return (
    chatRequest?.thinking?.type === "enabled" ||
    chatRequest?.enable_thinking === true ||
    (typeof chatRequest?.reasoning_effort === "string" && chatRequest.reasoning_effort.length > 0)
  );
}

function responseShell(request, status = "in_progress") {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `resp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    object: "response",
    created_at: now,
    status,
    model: request.model || provider.models[0],
    output: [],
    parallel_tool_calls: true,
    tool_choice: request.tool_choice || "auto",
    usage: null,
  };
}

function sse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function errorSse(res, response, error) {
  sse(res, "response.failed", {
    type: "response.failed",
    response: {
      ...response,
      status: "failed",
      error: { message: error.message || String(error), type: "proxy_error" },
    },
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

function chatMessageFromAssistant(content, toolCalls = [], reasoningContent = null) {
  const message = { role: "assistant", content: content || "" };
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments || "{}" },
    }));
  }
  if (typeof reasoningContent === "string") message.reasoning_content = reasoningContent;
  return attachReasoningToAssistantToolCallMessage(message, reasoningContent, {
    requireReasoningContent: typeof reasoningContent === "string",
  });
}

function finalOutputItems(content, toolCalls = [], reasoningContent = null) {
  const output = [];
  if (typeof reasoningContent === "string" && reasoningContent) {
    output.push({
      id: `rs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      type: "reasoning",
      status: "completed",
      summary: [],
      reasoning_content: reasoningContent,
    });
  }
  if (content) {
    output.push({
      id: `msg_${Date.now().toString(36)}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: content, annotations: [] }],
    });
  }
  for (const [index, call] of toolCalls.entries()) {
    const item = {
      id: `fc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      type: "function_call",
      status: "completed",
      call_id: call.id,
      name: call.name,
      arguments: call.arguments || "{}",
    };
    if (index === 0 && typeof reasoningContent === "string") {
      item.reasoning_content = reasoningContent;
    }
    output.push(item);
  }
  return output;
}

function normalizeToolCalls(toolCalls) {
  return Object.values(toolCalls)
    .sort((a, b) => a.index - b.index)
    .map((call) => ({
      id: call.id || `call_${call.index}`,
      name: call.name || "unknown_tool",
      arguments: call.arguments || "",
    }));
}

function modelListUrl() {
  return new URL(`${provider.baseUrl.replace(/\/+$/, "")}/models`);
}

function modelIdsFromPayload(payload) {
  const values = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];
  return Array.from(
    new Set(
      values
        .map((item) => {
          if (typeof item === "string") return item;
          if (!item || typeof item !== "object") return "";
          return item.id || item.model || item.name || "";
        })
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
}

function modelListBodyFromResult(result) {
  return {
    object: "list",
    provider: providerId,
    source: result.source,
    error: result.error || null,
    fetched_at: result.fetchedAt,
    data: result.models.map((model) => ({ id: model, object: "model", owned_by: providerId })),
  };
}

function writeModelListCache(result) {
  try {
    fs.mkdirSync(modelCacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(modelCacheDir, `${providerId}.json`),
      `${JSON.stringify(modelListBodyFromResult(result), null, 2)}\n`,
      "utf8"
    );
  } catch (error) {
    log("model cache write failed", { provider: providerId, error: error.message || String(error) });
  }
}

async function fetchProviderModels(apiKey, { force = false } = {}) {
  const cached = modelListCache.get(providerId);
  if (!force && cached && Date.now() - cached.fetchedAt < MODEL_LIST_CACHE_MS) {
    writeModelListCache(cached);
    return cached;
  }
  if (!apiKey) {
    const result = {
      source: "fallback",
      fetchedAt: Date.now(),
      models: provider.models,
      error: `Missing environment variable ${provider.envKey}`,
    };
    writeModelListCache(result);
    return result;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const upstream = await fetch(modelListUrl(), {
      method: "GET",
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        "accept-language": "en-US,en",
      },
      signal: controller.signal,
    });
    const text = await upstream.text();
    let payload = {};
    if (text.trim()) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }
    if (!upstream.ok) {
      throw new Error(payload?.error?.message || payload?.message || `HTTP ${upstream.status}`);
    }
    const models = modelIdsFromPayload(payload);
    if (!models.length) {
      throw new Error("Provider /models returned no model ids.");
    }
    const result = { source: "upstream", fetchedAt: Date.now(), models };
    modelListCache.set(providerId, result);
    writeModelListCache(result);
    return result;
  } catch (error) {
    const result = {
      source: "fallback",
      fetchedAt: Date.now(),
      models: provider.models,
      error: error.message || String(error),
    };
    modelListCache.set(providerId, result);
    writeModelListCache(result);
    log("model list fallback", { provider: providerId, error: result.error });
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

function scheduleModelCacheRefresh() {
  const refreshMs = Number(process.env.CODEX_PROXY_MODEL_LIST_REFRESH_MS || 10 * 60 * 1000);
  const refresh = () => {
    fetchProviderModels(process.env[provider.envKey], { force: true }).catch((error) => {
      log("model cache refresh failed", { provider: providerId, error: error.message || String(error) });
    });
  };
  setTimeout(refresh, 100).unref?.();
  if (Number.isFinite(refreshMs) && refreshMs > 0) {
    setInterval(refresh, refreshMs).unref?.();
  }
}

scheduleModelCacheRefresh();

async function forwardChat(chatRequest, apiKey) {
  const url = new URL(`${provider.baseUrl.replace(/\/+$/, "")}/${provider.chatPath.replace(/^\/+/, "")}`);
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(chatRequest),
  });
}

async function handleNonStreaming(reqBody, res, apiKey) {
  const chatRequest = buildChatRequest({ ...reqBody, stream: false });
  const upstream = await forwardChat(chatRequest, apiKey);
  const text = await upstream.text();
  if (!upstream.ok) {
    res.writeHead(upstream.status, corsHeaders({ "content-type": upstream.headers.get("content-type") || "text/plain" }));
    res.end(text);
    return;
  }
  const chatResponse = JSON.parse(text);
  const choice = chatResponse.choices?.[0] || {};
  const message = choice.message || {};
  const toolCalls = (message.tool_calls || []).map((call) => ({
    id: call.id,
    name: call.function?.name,
    arguments: call.function?.arguments || "",
  }));
  const reasoningContent =
    typeof message.reasoning_content === "string"
      ? message.reasoning_content
      : toolCalls.length && chatRequestRequiresReasoningContent(chatRequest)
        ? ""
        : null;
  rememberReasoningForToolCalls(toolCalls, reasoningContent);
  const response = responseShell(reqBody, "completed");
  response.output = finalOutputItems(message.content || "", toolCalls, reasoningContent);
  response.usage = chatResponse.usage || null;
  responseStore.set(response.id, {
    messages: [...chatRequest.messages, chatMessageFromAssistant(message.content || "", toolCalls, reasoningContent)],
  });
  json(res, 200, response);
}

async function handleStreaming(reqBody, res, apiKey) {
  const chatRequest = buildChatRequest({ ...reqBody, stream: true });
  const response = responseShell(reqBody, "in_progress");
  res.writeHead(200, corsHeaders({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  }));
  sse(res, "response.created", { type: "response.created", response });
  sse(res, "response.in_progress", { type: "response.in_progress", response });

  let messageStarted = false;
  let contentPartStarted = false;
  let fullText = "";
  let fullReasoning = "";
  let sawReasoning = false;
  const toolCalls = {};
  const messageItemId = `msg_${Date.now().toString(36)}`;

  try {
    const upstream = await forwardChat(chatRequest, apiKey);
    if (!upstream.ok || !upstream.body) {
      const errorText = await upstream.text().catch(() => "");
      throw new Error(`Upstream ${provider.label} error ${upstream.status}: ${errorText.slice(0, 500)}`);
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLines = raw
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        if (!dataLines.length) continue;
        const data = dataLines.join("\n");
        if (data === "[DONE]") continue;
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = chunk.choices?.[0]?.delta || {};
        if (typeof delta.reasoning_content === "string") {
          sawReasoning = true;
          fullReasoning += delta.reasoning_content;
        }
        const textDelta = delta.content || "";
        if (textDelta) {
          if (!messageStarted) {
            messageStarted = true;
            sse(res, "response.output_item.added", {
              type: "response.output_item.added",
              output_index: 0,
              item: { id: messageItemId, type: "message", status: "in_progress", role: "assistant", content: [] },
            });
          }
          if (!contentPartStarted) {
            contentPartStarted = true;
            sse(res, "response.content_part.added", {
              type: "response.content_part.added",
              item_id: messageItemId,
              output_index: 0,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            });
          }
          fullText += textDelta;
          sse(res, "response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: messageItemId,
            output_index: 0,
            content_index: 0,
            delta: textDelta,
          });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            const index = call.index ?? 0;
            toolCalls[index] ||= { index, id: call.id || `call_${index}`, name: "", arguments: "" };
            if (call.id) toolCalls[index].id = call.id;
            if (call.function?.name) toolCalls[index].name += call.function.name;
            if (call.function?.arguments) toolCalls[index].arguments += call.function.arguments;
          }
        }
      }
    }

    if (contentPartStarted) {
      sse(res, "response.output_text.done", {
        type: "response.output_text.done",
        item_id: messageItemId,
        output_index: 0,
        content_index: 0,
        text: fullText,
      });
      sse(res, "response.content_part.done", {
        type: "response.content_part.done",
        item_id: messageItemId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: fullText, annotations: [] },
      });
      sse(res, "response.output_item.done", {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: messageItemId,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: fullText, annotations: [] }],
        },
      });
    }

    const calls = normalizeToolCalls(toolCalls);
    const reasoningContent =
      sawReasoning || fullReasoning
        ? fullReasoning
        : calls.length && chatRequestRequiresReasoningContent(chatRequest)
          ? ""
          : null;
    rememberReasoningForToolCalls(calls, reasoningContent);
    let outputIndex = contentPartStarted ? 1 : 0;
    for (const [index, call] of calls.entries()) {
      const item = {
        id: `fc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        type: "function_call",
        status: "completed",
        call_id: call.id,
        name: call.name,
        arguments: call.arguments || "{}",
      };
      if (index === 0 && typeof reasoningContent === "string") {
        item.reasoning_content = reasoningContent;
      }
      sse(res, "response.output_item.added", { type: "response.output_item.added", output_index: outputIndex, item });
      sse(res, "response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index: outputIndex,
        arguments: item.arguments,
      });
      sse(res, "response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item });
      outputIndex += 1;
    }

    const completed = {
      ...response,
      status: "completed",
      output: finalOutputItems(fullText, calls, reasoningContent),
    };
    responseStore.set(completed.id, {
      messages: [...chatRequest.messages, chatMessageFromAssistant(fullText, calls, reasoningContent)],
    });
    sse(res, "response.completed", { type: "response.completed", response: completed });
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    log("stream error", { message: error.message });
    errorSse(res, response, error);
  }
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${host}:${port}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      json(res, 200, healthBody());
      return;
    }
    if (req.method === "GET" && url.pathname === "/models") {
      const apiKey = process.env[provider.envKey];
      const result = await fetchProviderModels(apiKey, { force: url.searchParams.get("refresh") === "1" });
      json(res, 200, modelListBodyFromResult(result));
      return;
    }
    if (req.method === "POST" && url.pathname === "/admin/env") {
      const body = await readBody(req);
      const envKey = String(body.envKey || provider.envKey).trim();
      const value = typeof body.value === "string" ? body.value.trim() : "";
      if (!value) {
        json(res, 400, { error: { message: "API key value is required." } });
        return;
      }
      setUserEnvironmentVariable(envKey, value);
      log("provider env updated", { provider: providerId, envKey });
      json(res, 200, {
        ok: true,
        provider: providerId,
        envKey,
        hasApiKey: true,
        restartRecommended: true,
      });
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/responses") {
      json(res, 404, { error: { message: `No route for ${req.method} ${url.pathname}` } });
      return;
    }
    const apiKey = process.env[provider.envKey];
    if (!apiKey) {
      json(res, 401, { error: { message: `Missing environment variable ${provider.envKey}` } });
      return;
    }
    const body = await readBody(req);
    log("responses request", {
      model: body.model,
      stream: body.stream !== false,
      previous_response_id: body.previous_response_id || null,
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    });
    if (body.stream === false) {
      await handleNonStreaming(body, res, apiKey);
    } else {
      await handleStreaming(body, res, apiKey);
    }
  } catch (error) {
    log("request error", { message: error.message });
    if (!res.headersSent) {
      const status = /request body too large/i.test(error.message || "") ? 413 : 500;
      json(res, status, { error: { message: error.message || String(error) } });
    } else {
      res.end();
    }
  }
}

const server = http.createServer(handleRequest);
server.listen(port, host, () => {
  log("proxy listening", { host, port, provider: providerId, upstream: provider.baseUrl });
  console.log(`Codex provider proxy listening at http://${host}:${port} for ${provider.label}`);
});
