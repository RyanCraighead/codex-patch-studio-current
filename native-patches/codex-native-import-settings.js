(function () {
  const STORAGE_KEY = "codex-native-import-settings:v2";
  const PATCHER_STORAGE_KEY = "codex-native-patcher-settings:v1";
  const IMPORT_API_BASE = "http://127.0.0.1:4577";

  const state = {
    open: false,
    busy: false,
    status: "Loading imports",
    error: "",
    exports: [],
    conversations: [],
    selectedConversationDetail: null,
    jobs: [],
    selectedExportId: "",
    selectedConversationId: "",
    selectedKeys: new Set(),
    lastJob: null,
    activeJobStatus: null,
  };

  let pollTimer = null;
  let jobPollTimer = null;
  let routeObserver = null;
  let currentRouteHost = null;
  let lastRefreshAt = 0;

  function patcherFeatureEnabled(featureId, fallback = true) {
    try {
      const api = window.__codexNativePatcherSettings;
      if (api && typeof api.isEnabled === "function") {
        return api.isEnabled(featureId, fallback);
      }
    } catch {
      // Fall through to localStorage.
    }
    try {
      const stored = JSON.parse(localStorage.getItem(PATCHER_STORAGE_KEY) || "{}");
      const runtimeFeatures = stored && typeof stored.runtimeFeatures === "object" ? stored.runtimeFeatures : {};
      return Object.prototype.hasOwnProperty.call(runtimeFeatures, featureId) ? runtimeFeatures[featureId] !== false : fallback;
    } catch {
      return fallback;
    }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function compact(value, limit = 120) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
  }

  function numberValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function formatNumber(value) {
    return new Intl.NumberFormat().format(numberValue(value));
  }

  function displayProjectLabel(entry) {
    const label = String(entry?.label || entry?.id || "Source project");
    const source = entry?.sourceName ? ` (${entry.sourceName})` : "";
    return source && label.endsWith(source) ? label.slice(0, -source.length) : label;
  }

  function sourceDisplayName(entryOrConversation) {
    const sourceType = String(entryOrConversation?.sourceType || entryOrConversation?.exchangeSource || "").toLowerCase();
    const sourceName = entryOrConversation?.sourceName || entryOrConversation?.exchangeSourceLabel || "";
    if (sourceName) return sourceName.replace(/\s+(Code|IDE)$/i, "");
    if (sourceType === "roo-code") return "Roo";
    if (sourceType === "augment") return "Augment";
    if (sourceType === "cline") return "Cline";
    if (sourceType === "kiro") return "Kiro";
    if (sourceType === "codex") return "Codex";
    return sourceType || "Source";
  }

  function sourceClass(entryOrConversation) {
    return `source-${String(entryOrConversation?.sourceType || entryOrConversation?.exchangeSource || "unknown")
      .replace(/[^a-z0-9_-]/gi, "-")
      .toLowerCase()}`;
  }

  function sourceInitial(entryOrConversation) {
    return sourceDisplayName(entryOrConversation).slice(0, 1).toUpperCase() || "S";
  }

  function codexMatchLabel(entry) {
    const match = entry?.codexProjectMatch;
    if (isViewOnlyExport(entry)) return "View only";
    if (match?.matchType === "exact") return "Matched";
    if (match?.status === "matched") return "Matched";
    if (match?.status) return "Needs repair";
    return "No Codex project";
  }

  function exportNeedsRepair(entry) {
    const match = entry?.codexProjectMatch;
    return !isViewOnlyExport(entry) && match && match.status !== "matched";
  }

  function formatDate(value) {
    if (!value) return "Unknown";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString([], {
      month: "short",
      day: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  async function fetchJson(path, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${IMPORT_API_BASE}${path}`, {
        cache: "no-store",
        ...options,
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`${response.status} ${response.statusText}${text ? `: ${text}` : ""}`);
      }
      return response.json();
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function postJson(path, body, timeoutMs = 60000) {
    return fetchJson(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      },
      timeoutMs
    );
  }

  function loadDraft() {
    try {
      const draft = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      state.selectedExportId = String(draft.selectedExportId || "");
    } catch {
      // Ignore malformed local state.
    }
  }

  function saveDraft() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ selectedExportId: state.selectedExportId }));
    } catch {
      // Ignore storage failures.
    }
  }

  function selectedExport() {
    return state.exports.find((entry) => entry.id === state.selectedExportId) || null;
  }

  function isImportSource(entry) {
    return !isViewOnlyExport(entry);
  }

  function preferredExport() {
    return (
      state.exports.find((entry) => isImportSource(entry) && numberValue(entry.unimportedCount) > 0 && !exportNeedsRepair(entry)) ||
      state.exports.find((entry) => isImportSource(entry) && numberValue(entry.unimportedCount) > 0) ||
      state.exports.find((entry) => isImportSource(entry)) ||
      state.exports[0] ||
      null
    );
  }

  function orderedExports() {
    return [...state.exports].sort((a, b) => {
      const aImport = isImportSource(a) ? 0 : 1;
      const bImport = isImportSource(b) ? 0 : 1;
      if (aImport !== bImport) return aImport - bImport;
      const aReady = numberValue(a.unimportedCount) > 0 && !exportNeedsRepair(a) ? 0 : 1;
      const bReady = numberValue(b.unimportedCount) > 0 && !exportNeedsRepair(b) ? 0 : 1;
      if (aReady !== bReady) return aReady - bReady;
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });
  }

  function conversationKey(exportId, conversationId) {
    return `${exportId}:${conversationId}`;
  }

  function isViewOnlyExport(entry) {
    return Boolean(entry?.viewOnly || entry?.sourceType === "codex");
  }

  function isConversationImported(conversation) {
    return Boolean(conversation?.importStatus?.imported);
  }

  function isEmptyConversation(conversation) {
    return (
      Number(conversation?.chatHistoryCount) === 0 ||
      Number(conversation?.exchangeCount) === 0 ||
      Number(conversation?.levelExchangeCount) === 0
    );
  }

  function isImportableConversation(conversation, entry = selectedExport()) {
    return !isViewOnlyExport(entry) && !isConversationImported(conversation) && !isEmptyConversation(conversation);
  }

  function isRepairableConversation(conversation, entry = selectedExport()) {
    return !isViewOnlyExport(entry) && isConversationImported(conversation) && !isEmptyConversation(conversation);
  }

  function isSelectableConversation(conversation, entry = selectedExport()) {
    return isImportableConversation(conversation, entry) || isRepairableConversation(conversation, entry);
  }

  function importableConversations() {
    const entry = selectedExport();
    return state.conversations.filter((conversation) => isImportableConversation(conversation, entry));
  }

  function repairableConversations() {
    const entry = selectedExport();
    return state.conversations.filter((conversation) => isRepairableConversation(conversation, entry));
  }

  function selectedItems(filter = "all") {
    const entry = selectedExport();
    if (!entry) return [];
    return [...state.selectedKeys]
      .map((key) => {
        const separator = key.indexOf(":");
        if (separator < 0) return null;
        const exportId = key.slice(0, separator);
        const conversationId = key.slice(separator + 1);
        if (exportId !== entry.id) return null;
        const conversation = state.conversations.find((item) => item.id === conversationId);
        if (!conversation) return null;
        const importable = isImportableConversation(conversation, entry);
        const repairable = isRepairableConversation(conversation, entry);
        if (filter === "import" && !importable) return null;
        if (filter === "repair" && !repairable) return null;
        return {
          exportId,
          conversationId,
          title: conversation.name || conversation.title || "",
          threadId: repairable ? conversation.importStatus?.threadId || "" : "",
          targetCwd: conversation.importStatus?.cwd || entry.codexProjectMatch?.matchedPath || entry.workspacePath || "",
        };
      })
      .filter(Boolean);
  }

  function statusClass(kind) {
    if (kind === "failed" || kind === "bad") return "bad";
    if (kind === "running" || kind === "pending" || kind === "warn") return "warn";
    return "good";
  }

  function renderStatusBadge(label, value, kind = "good") {
    return `<span class="cni-badge ${statusClass(kind)}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></span>`;
  }

  function selectedConversation() {
    return state.conversations.find((conversation) => conversation.id === state.selectedConversationId) || null;
  }

  function selectedConversationRecord() {
    return state.selectedConversationDetail || selectedConversation();
  }

  function conversationNeedsRepair(conversation, entry = selectedExport()) {
    return !isViewOnlyExport(entry) && !isConversationImported(conversation) && exportNeedsRepair(entry);
  }

  function conversationStatus(conversation, entry = selectedExport()) {
    if (isConversationImported(conversation)) {
      const mode = conversation.importStatus?.importMode;
      if (mode === "full") return { label: "Full import", kind: "imported" };
      if (mode === "no-cards") return { label: "Needs full fix", kind: "repair" };
      if (mode === "turbo") return { label: "Needs full fix", kind: "repair" };
      return { label: "Imported", kind: "imported" };
    }
    if (isEmptyConversation(conversation)) return { label: "Empty", kind: "empty" };
    if (isViewOnlyExport(entry)) return { label: "View only", kind: "view" };
    if (conversationNeedsRepair(conversation, entry)) return { label: "Needs repair", kind: "repair" };
    return { label: "Importable", kind: "ready" };
  }

  function artifactCounts(conversation) {
    const detail = state.selectedConversationDetail && state.selectedConversationDetail.id === conversation?.id
      ? state.selectedConversationDetail
      : conversation || {};
    const exchanges = Array.isArray(detail.exchanges) ? detail.exchanges : [];
    const user = exchanges.length
      ? exchanges.reduce((sum, exchange) => sum + (exchange.request ? 1 : 0), 0)
      : numberValue(detail.userCount || detail.chatHistoryCount || detail.exchangeCount || 0);
    const assistant = exchanges.length
      ? exchanges.reduce((sum, exchange) => sum + (exchange.response ? 1 : 0), 0)
      : numberValue(detail.assistantCount || detail.chatHistoryCount || detail.exchangeCount || 0);
    return {
      user,
      assistant,
      messages: user + assistant || numberValue(detail.chatHistoryCount || detail.exchangeCount || 0),
      tools: numberValue(detail.visibleToolCallCount || detail.toolUseCount || detail.levelToolUseCount || 0),
      diffs: numberValue(detail.editDiffCount || detail.checkpointDiffCount || 0),
      thoughts: numberValue(detail.thinkingCount || detail.reasoningSummaryCount || 0),
    };
  }

  function sourceStatus(entry) {
    if (isViewOnlyExport(entry)) return { label: "View only", kind: "view" };
    if (exportNeedsRepair(entry)) return { label: "Needs repair", kind: "repair" };
    const imported = numberValue(entry?.importedCount);
    const total = numberValue(entry?.conversationCount);
    const importable = Math.max(0, total - imported);
    if (total > 0 && imported >= total) return { label: "Imported", kind: "imported" };
    if (imported > 0) return { label: "Partially imported", kind: "partial" };
    if (importable > 0) return { label: "Importable", kind: "ready" };
    return { label: "No chats", kind: "view" };
  }

  function renderMetricIcon(label, value, className = "") {
    return `<span class="cni-mini-metric ${escapeHtml(className)}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(formatNumber(value))}</strong></span>`;
  }

  function renderExports() {
    if (!state.exports.length) {
      return `<div class="cni-empty">No source chat exports found. Run a source refresh to scan Augment, Kiro, Roo Code, and Cline.</div>`;
    }
    return orderedExports()
      .map((entry) => {
        const active = entry.id === state.selectedExportId ? " is-active" : "";
        const imported = Number(entry.importedCount || 0);
        const total = Number(entry.conversationCount || 0);
        const unimported = Math.max(0, Number(entry.unimportedCount || 0));
        const status = sourceStatus(entry);
        return `
          <button class="cni-source${active}" type="button" data-import-export-id="${escapeHtml(entry.id)}">
            <span class="cni-source-avatar ${escapeHtml(sourceClass(entry))}">${escapeHtml(sourceInitial(entry))}</span>
            <span class="cni-source-main">
              <span class="cni-source-title">${escapeHtml(displayProjectLabel(entry))}</span>
              <span class="cni-source-path">${escapeHtml(compact(entry.workspacePath || entry.metadata?.workspace?.path || "", 54))}</span>
              <span class="cni-source-meta">
                <span>${escapeHtml(formatNumber(total))} chats</span>
                <span>${escapeHtml(formatNumber(imported))} imported</span>
                ${unimported ? `<span>${escapeHtml(formatNumber(unimported))} new</span>` : ""}
              </span>
            </span>
            <span class="cni-pill ${escapeHtml(status.kind)}">${escapeHtml(status.label)}</span>
            <span class="cni-chevron">&gt;</span>
          </button>
        `;
      })
      .join("");
  }

  function renderConversations() {
    const entry = selectedExport();
    if (!entry) {
      return `<div class="cni-empty">Select a source project.</div>`;
    }
    if (!state.conversations.length) {
      return `<div class="cni-empty">No conversations found in this source.</div>`;
    }
    return state.conversations
      .slice(0, 300)
      .map((conversation) => {
        const key = conversationKey(entry.id, conversation.id);
        const active = conversation.id === state.selectedConversationId ? " is-active" : "";
        const importable = isImportableConversation(conversation, entry);
        const selectable = isSelectableConversation(conversation, entry);
        const checked = state.selectedKeys.has(key) ? " checked" : "";
        const status = conversationStatus(conversation, entry);
        const counts = artifactCounts(conversation);
        return `
          <div class="cni-chat${active}" data-import-conversation-id="${escapeHtml(conversation.id)}">
            <label class="cni-check">
              <input type="checkbox" data-import-select-conversation="${escapeHtml(conversation.id)}"${checked}${selectable ? "" : " disabled"}>
            </label>
            <button class="cni-chat-main" type="button" data-import-conversation-id="${escapeHtml(conversation.id)}">
              <span class="cni-chat-title">${escapeHtml(conversation.name || conversation.title || conversation.id || "Untitled")}</span>
              <span class="cni-chat-meta">${escapeHtml(formatDate(conversation.lastInteractedAtIso || conversation.createdAtIso))}</span>
              <span class="cni-chat-counts">
                ${renderMetricIcon("user", counts.user)}
                ${renderMetricIcon("assistant", counts.assistant)}
                ${renderMetricIcon("tools", counts.tools)}
                ${renderMetricIcon("diffs", counts.diffs)}
              </span>
            </button>
            <span class="cni-pill ${escapeHtml(status.kind)}">${escapeHtml(status.label)}</span>
          </div>
        `;
      })
      .join("");
  }

  function renderJobs() {
    if (!state.jobs.length) {
      return `<div class="cni-empty">No import job logs yet.</div>`;
    }
    return state.jobs
      .slice(0, 5)
      .map((job) => `
        <details class="cni-job">
          <summary>
            <span>${escapeHtml(job.name)}</span>
            <small>${escapeHtml(formatDate(job.updatedAt))} · ${escapeHtml(Math.round(Number(job.size || 0) / 1024))} KB</small>
          </summary>
          <pre>${escapeHtml(job.tail || "")}</pre>
        </details>
      `)
      .join("");
  }

  function pageStats() {
    const uniqueSources = new Set(state.exports.map((entry) => entry.sourceType || entry.sourceName || "source"));
    const totalImported = state.exports.reduce((sum, entry) => sum + numberValue(entry.importedCount), 0);
    const totalChats = state.exports.reduce((sum, entry) => sum + numberValue(entry.conversationCount), 0);
    const totalImportable = state.exports.reduce((sum, entry) => {
      if (isViewOnlyExport(entry) || exportNeedsRepair(entry)) return sum;
      return sum + Math.max(0, numberValue(entry.unimportedCount));
    }, 0);
    const needsRepair = state.exports.filter((entry) => exportNeedsRepair(entry)).length;
    const activeErrors = state.activeJobStatus?.phase === "failed" ? 1 : 0;
    const selectedTotal = state.conversations.length;
    return {
      sources: uniqueSources.size,
      projects: state.exports.length,
      selectedTotal,
      totalChats,
      totalImported,
      totalImportable,
      needsRepair,
      activeErrors,
    };
  }

  function renderTopStats() {
    const stats = pageStats();
    return `
      <div class="cni-statbar">
        ${renderStatusBadge("Sources", stats.sources)}
        ${renderStatusBadge("Source projects", stats.projects)}
        ${renderStatusBadge("Selectable", stats.selectedTotal, stats.selectedTotal ? "warn" : "good")}
        ${renderStatusBadge("Importable", stats.totalImportable, stats.totalImportable ? "good" : "warn")}
        ${renderStatusBadge("Already imported", stats.totalImported, "warn")}
        ${renderStatusBadge("Needs repair", stats.needsRepair, stats.needsRepair ? "warn" : "good")}
        ${renderStatusBadge("Errors", stats.activeErrors, stats.activeErrors ? "bad" : "good")}
      </div>
    `;
  }

  function renderLogTail() {
    const status = state.activeJobStatus || state.lastJob?.jobStatus || null;
    const tail = status?.importLogTail || status?.schedulerLogTail || state.jobs[0]?.tail || "";
    if (!tail) {
      return `<div class="cni-log-empty">No import log lines yet.</div>`;
    }
    return String(tail)
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .slice(-8)
      .map((line) => {
        const match = line.match(/^(\d{4}-\d{2}-\d{2}T[^ ]+)\s+(.*)$/);
        if (match) {
          const time = new Date(match[1]);
          const label = Number.isNaN(time.getTime())
            ? match[1]
            : time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
          return `<div class="cni-log-line"><span>${escapeHtml(label)}</span><code>${escapeHtml(match[2])}</code></div>`;
        }
        return `<div class="cni-log-line"><span>log</span><code>${escapeHtml(line)}</code></div>`;
      })
      .join("");
  }

  function renderConversationPreview() {
    const conversation = selectedConversationRecord();
    if (!conversation) {
      return `<div class="cni-empty">Select a conversation to inspect its summary before importing.</div>`;
    }
    const baseConversation = selectedConversation() || conversation;
    const entry = selectedExport();
    const imported = baseConversation.importStatus?.imported || conversation.importStatus?.imported;
    const status = conversationStatus(baseConversation, entry);
    const counts = artifactCounts(baseConversation);
    const source = sourceDisplayName(conversation);
    const workspace = conversation.workspacePath || entry?.workspacePath || "";
    const summary = compact(
      conversation.summary ||
        conversation.description ||
        conversation.exchanges?.find((exchange) => exchange.response)?.response ||
        conversation.exchanges?.find((exchange) => exchange.request)?.request ||
        "No text preview is available for this source record.",
      210
    );
    const dedupeText = imported
      ? `Already imported as ${conversation.importStatus?.threadId || baseConversation.importStatus?.threadId || "a Codex thread"}.`
      : isImportableConversation(baseConversation, entry)
        ? "No existing match found. Safe to import."
        : status.label === "Needs repair"
          ? "Project mapping needs repair before this chat can be imported cleanly."
          : `${status.label}.`;
    return `
      <div class="cni-preview-title-row">
        <span class="cni-preview-pin">pin</span>
        <div class="cni-preview-title">${escapeHtml(conversation.name || conversation.title || conversation.id)}</div>
      </div>
      <div class="cni-preview-meta">
        <span class="cni-tag">${escapeHtml(displayProjectLabel(entry))}</span>
        <span class="cni-tag">${escapeHtml(source)}</span>
        <span class="cni-pill ${escapeHtml(status.kind)}">${escapeHtml(status.label)}</span>
      </div>
      <div class="cni-preview-date">
        ${escapeHtml(formatDate(conversation.lastInteractedAtIso || conversation.createdAtIso))}
        <br>ID: ${escapeHtml(conversation.id || baseConversation.id || "")}
      </div>
      <div class="cni-preview-summary">
        <strong>Summary</strong>
        <p>${escapeHtml(summary)}</p>
      </div>
      <div class="cni-dedupe">
        <div>
          <strong>Deduplication</strong>
          <p>${escapeHtml(dedupeText)}</p>
        </div>
        <span class="cni-pill ${imported ? "imported" : isImportableConversation(baseConversation, entry) ? "ready" : "repair"}">${escapeHtml(imported ? "Imported" : isImportableConversation(baseConversation, entry) ? "OK" : "Check")}</span>
      </div>
      <div class="cni-artifacts">
        <strong>Reconstructed artifacts</strong>
        <div>${renderMetricIcon("Messages", counts.messages)}</div>
        <div>${renderMetricIcon("Tool cards", counts.tools)}</div>
        <div>${renderMetricIcon("File change cards", counts.diffs)}</div>
        <div>${renderMetricIcon("Thoughts", counts.thoughts)}</div>
      </div>
      <div class="cni-preview-path">${escapeHtml(workspace)}</div>
      <button class="cni-button cni-wide" type="button" data-import-action="preview-selected">Preview</button>
    `;
  }

  function phaseLabel(phase) {
    return (
      {
        queued: "Queued",
        "preflight-running": "Preflight",
        "preflight-passed": "Preflight complete",
        "importer-started": "Importing",
        complete: "Complete",
        failed: "Failed",
      }[phase] || phase || "Queued"
    );
  }

  function renderJobProgress() {
    const status = state.activeJobStatus || state.lastJob?.jobStatus || null;
    const progress = status?.progress || null;
    const job = state.lastJob || null;
    const hasJob = Boolean(job || status);
    const total = Number(progress?.total || job?.count || job?.collectedCount || 0);
    const done = Number(progress?.done || 0);
    const percent = total > 0 ? Math.max(0, Math.min(100, Number(progress?.percent || Math.round((done / total) * 100)))) : 0;
    const phase = phaseLabel(status?.phase || progress?.phase || (job?.scheduled ? "queued" : ""));
    const skipped = Number(progress?.skipped || job?.skipped?.length || 0);
    const details = [
      total ? `${done}/${total}` : "",
      total ? `${percent}%` : "",
      skipped ? `${skipped} skipped` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return `
      <div class="cni-footer">
        <section class="cni-progress-card">
          <div class="cni-progress-head">
            <strong>Import progress</strong>
            <span>${escapeHtml(hasJob ? `${progress?.stage || phase}${details ? ` · ${details}` : ""}` : "No import running")}</span>
          </div>
          <div class="cni-progress-line">
            <div class="cni-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${escapeHtml(percent)}">
              <div class="cni-progress-fill" style="width:${escapeHtml(percent)}%"></div>
            </div>
            <strong>${escapeHtml(hasJob ? `${percent}%` : "0%")}</strong>
          </div>
          <div class="cni-progress-chips">
            <span class="cni-pill ready">fast preflight</span>
            <span class="cni-pill imported">hidden background job</span>
            <span class="cni-pill ready">dedupe enabled</span>
          </div>
          <div class="cni-apply-warning">
            <span>!</span>
            <strong>Codex will close and relaunch during apply</strong>
            <button class="cni-link-button" type="button" data-import-action="open-full">Learn more</button>
          </div>
          ${status?.preflightPath ? `<div class="cni-job-path">Preflight: ${escapeHtml(status.preflightPath)}</div>` : ""}
          ${status?.importLogPath ? `<div class="cni-job-path">Importer: ${escapeHtml(status.importLogPath)}</div>` : ""}
        </section>
        <section class="cni-log-card">
          <div class="cni-log-head">
            <strong>Log tail</strong>
            <button class="cni-button" type="button" data-import-action="open-full">View full log</button>
          </div>
          <div class="cni-log-lines">${renderLogTail()}</div>
        </section>
        <div class="cni-footnote">Imports run through Codex app-server. You can keep working while preflight runs in the background.</div>
      </div>
    `;
  }

  function render() {
    const host = document.getElementById("codex-native-imports-settings-route");
    if (!host) return;
    if (!patcherFeatureEnabled("imports", true)) {
      host.innerHTML = `<div class="cni-root"><div class="cni-empty">Imports are disabled in Patcher settings.</div></div>`;
      return;
    }
    const entry = selectedExport();
    const selected = selectedItems().length;
    const selectedImport = selectedItems("import").length;
    const selectedRepair = selectedItems("repair").length;
    const importable = importableConversations().length;
    const repairable = repairableConversations().length;
    const bridgeKind = state.error ? "bad" : state.busy ? "warn" : "good";
    host.innerHTML = `
      <div class="cni-root">
        <div class="cni-header">
          <div>
            <h1>Imports</h1>
            <p>Bring chats from Augment, Kiro, Roo Code, and Cline into Codex using the same validated close/import/relaunch workflow.</p>
          </div>
          <div class="cni-actions">
            <button class="cni-button" type="button" data-import-action="refresh" ${state.busy ? "disabled" : ""}>Refresh</button>
            <button class="cni-button" type="button" data-import-action="rescan" ${state.busy ? "disabled" : ""}>Scan Sources</button>
            <button class="cni-button cni-primary" type="button" data-import-action="import-all" ${state.busy || !state.exports.length ? "disabled" : ""}>Import All</button>
            <button class="cni-button" type="button" data-import-action="open-full">Open Manager</button>
          </div>
        </div>

        <div class="cni-status">
          ${renderStatusBadge("bridge", state.error ? "offline" : "ready", bridgeKind)}
          ${renderStatusBadge("selected", selected, selected ? "warn" : "good")}
          ${renderStatusBadge("importable here", importable, importable ? "warn" : "good")}
          ${renderStatusBadge("fixable here", repairable, repairable ? "warn" : "good")}
        </div>
        ${renderTopStats()}
        ${state.error ? `<div class="cni-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="cni-message">${escapeHtml(state.status || "")}</div>

        <div class="cni-grid">
          <section class="cni-panel">
            <div class="cni-panel-head">
              <span>Source Projects</span>
              <small>${escapeHtml(state.exports.length)} found</small>
            </div>
            <div class="cni-list">${renderExports()}</div>
          </section>

          <section class="cni-panel">
            <div class="cni-panel-head">
              <span>${escapeHtml(entry?.label || "Conversations")}</span>
              <small>${escapeHtml(state.conversations.length)} shown</small>
            </div>
            <div class="cni-toolbar">
              <button class="cni-button" type="button" data-import-action="select-project" ${!importable ? "disabled" : ""}>Select New</button>
              <button class="cni-button" type="button" data-import-action="select-repairable" ${!repairable ? "disabled" : ""}>Select Imported</button>
              <button class="cni-button" type="button" data-import-action="clear-selection" ${!selected ? "disabled" : ""}>Clear</button>
              <button class="cni-button cni-primary" type="button" data-import-action="import-selected" ${!selectedImport || state.busy ? "disabled" : ""}>Import Selected</button>
              <button class="cni-button cni-primary" type="button" data-import-action="repair-selected" ${!selectedRepair || state.busy ? "disabled" : ""}>Fix Selected</button>
              <button class="cni-button cni-primary" type="button" data-import-action="import-project" ${!importable || state.busy ? "disabled" : ""}>Import Project</button>
            </div>
            <div class="cni-list cni-chat-list">${renderConversations()}</div>
          </section>

          <section class="cni-panel">
            <div class="cni-panel-head">
              <span>Selected Chat</span>
              <small>${escapeHtml(state.selectedConversationId || "")}</small>
            </div>
            <div class="cni-preview">${renderConversationPreview()}</div>
          </section>
        </div>
        ${renderJobProgress()}
      </div>
    `;
  }

  async function loadJobs() {
    try {
      const data = await fetchJson("/api/jobs", {}, 8000);
      state.jobs = Array.isArray(data.jobs) ? data.jobs : [];
    } catch {
      // Import status is useful even if logs cannot be read.
    }
  }

  async function loadConversations(exportId) {
    if (!exportId) {
      state.conversations = [];
      state.selectedConversationId = "";
      state.selectedConversationDetail = null;
      return;
    }
    const data = await fetchJson(`/api/exports/${encodeURIComponent(exportId)}`, {}, 20000);
    state.conversations = Array.isArray(data.conversations) ? data.conversations : Array.isArray(data) ? data : [];
    if (!state.conversations.some((conversation) => conversation.id === state.selectedConversationId)) {
      state.selectedConversationId = state.conversations[0]?.id || "";
    }
    state.selectedConversationDetail = null;
    await loadSelectedConversationDetail();
  }

  async function loadSelectedConversationDetail() {
    const entry = selectedExport();
    const base = selectedConversation();
    if (!entry || !base?.id) {
      state.selectedConversationDetail = null;
      return;
    }
    try {
      const detail = await fetchJson(
        `/api/exports/${encodeURIComponent(entry.id)}/conversations/${encodeURIComponent(base.id)}`,
        {},
        20000
      );
      const indexRecord = detail?.indexRecord || {};
      state.selectedConversationDetail = {
        ...base,
        ...detail,
        id: detail?.id || detail?.conversationId || indexRecord.id || base.id,
        name: detail?.name || detail?.title || indexRecord.name || indexRecord.title || base.name || base.title,
        title: detail?.title || detail?.name || indexRecord.title || indexRecord.name || base.title || base.name,
        createdAtIso: detail?.createdAtIso || indexRecord.createdAtIso || base.createdAtIso,
        lastInteractedAtIso: detail?.lastInteractedAtIso || indexRecord.lastInteractedAtIso || base.lastInteractedAtIso,
        workspacePath: detail?.workspacePath || indexRecord.workspacePath || base.workspacePath,
        sourceType: detail?.sourceType || indexRecord.sourceType || base.sourceType,
        sourceName: detail?.sourceName || indexRecord.sourceName || base.sourceName,
      };
    } catch {
      state.selectedConversationDetail = base;
    }
  }

  async function refreshAll({ keepSelection = true } = {}) {
    state.busy = true;
    state.error = "";
    state.status = "Loading import sources";
    render();
    try {
      const data = await fetchJson("/api/exports", {}, 20000);
      state.exports = Array.isArray(data.exports) ? data.exports : [];
      const currentSelection = state.exports.find((entry) => entry.id === state.selectedExportId) || null;
      if (!keepSelection || !currentSelection || isViewOnlyExport(currentSelection)) {
        state.selectedExportId = preferredExport()?.id || "";
      }
      saveDraft();
      await Promise.all([loadConversations(state.selectedExportId), loadJobs()]);
      state.status = `Loaded ${state.exports.length} source project${state.exports.length === 1 ? "" : "s"}.`;
    } catch (error) {
      state.error = `Import manager is not reachable at ${IMPORT_API_BASE}. Relaunch Codex Patch Studio Current or run npm run dev from the patcher repository. ${error.message || error}`;
      state.status = "Native import settings are waiting for the local import manager bridge.";
      state.exports = [];
      state.conversations = [];
    } finally {
      state.busy = false;
      render();
    }
  }

  async function rescanSources() {
    state.busy = true;
    state.error = "";
    state.status = "Scanning source applications in the background";
    render();
    try {
      const result = await postJson("/api/exports/refresh", {}, 30000);
      state.status = `Source scan queued. PID ${result.pid || "unknown"}. Refresh again after it finishes.`;
      await loadJobs();
    } catch (error) {
      state.error = error.message || String(error);
      state.status = "Could not start source scan.";
    } finally {
      state.busy = false;
      render();
    }
  }

  async function selectExport(exportId) {
    state.selectedExportId = exportId;
    state.selectedConversationId = "";
    saveDraft();
    state.busy = true;
    state.error = "";
    state.status = "Loading conversations";
    render();
    try {
      await loadConversations(exportId);
      state.status = `Loaded ${state.conversations.length} conversation${state.conversations.length === 1 ? "" : "s"}.`;
    } catch (error) {
      state.error = error.message || String(error);
      state.status = "Could not load conversations.";
      state.conversations = [];
    } finally {
      state.busy = false;
      render();
    }
  }

  function selectProjectImportables() {
    const entry = selectedExport();
    if (!entry) return;
    for (const conversation of importableConversations()) {
      state.selectedKeys.add(conversationKey(entry.id, conversation.id));
    }
    state.status = `Selected ${selectedItems().length} conversation${selectedItems().length === 1 ? "" : "s"}.`;
    render();
  }

  function selectProjectRepairables() {
    const entry = selectedExport();
    if (!entry) return;
    for (const conversation of repairableConversations()) {
      state.selectedKeys.add(conversationKey(entry.id, conversation.id));
    }
    const count = selectedItems("repair").length;
    state.status = `Selected ${count} imported chat${count === 1 ? "" : "s"} for full-fidelity repair.`;
    render();
  }

  function clearSelection() {
    const entry = selectedExport();
    if (!entry) return;
    const prefix = `${entry.id}:`;
    for (const key of [...state.selectedKeys]) {
      if (key.startsWith(prefix)) state.selectedKeys.delete(key);
    }
    state.status = "Selection cleared.";
    render();
  }

  async function scheduleImport(items) {
    if (!items.length) {
      state.status = "No conversations selected for import.";
      render();
      return;
    }
    state.busy = true;
    state.error = "";
    state.status = `Queueing ${items.length} import${items.length === 1 ? "" : "s"}.`;
    render();
    try {
      state.lastJob = await postJson(
        "/api/imports/schedule",
        { items, skipImported: true, fastPreflight: true, validateImports: false },
        30000
      );
      state.activeJobStatus = null;
      state.status = state.lastJob.scheduled
        ? `Import queued. Close Codex when prompted by the background job.`
        : state.lastJob.message || "No import was scheduled.";
      state.selectedKeys.clear();
      startJobPolling(state.lastJob);
      await loadJobs();
    } catch (error) {
      state.error = error.message || String(error);
      state.status = "Could not schedule import.";
    } finally {
      state.busy = false;
      render();
    }
  }

  async function scheduleRepair(items) {
    if (!items.length) {
      state.status = "No imported conversations selected for repair.";
      render();
      return;
    }
    state.busy = true;
    state.error = "";
    state.status = `Queueing ${items.length} full-fidelity repair${items.length === 1 ? "" : "s"}.`;
    render();
    try {
      state.lastJob = await postJson(
        "/api/imports/schedule",
        { items, skipImported: false, fastPreflight: true, validateImports: false },
        30000
      );
      state.activeJobStatus = null;
      state.status = state.lastJob.scheduled
        ? `Full-fidelity repair queued for ${state.lastJob.count || items.length} chat${Number(state.lastJob.count || items.length) === 1 ? "" : "s"}. Close Codex when prompted by the background job.`
        : state.lastJob.message || "No repair was scheduled.";
      state.selectedKeys.clear();
      startJobPolling(state.lastJob);
      await loadJobs();
    } catch (error) {
      state.error = error.message || String(error);
      state.status = "Could not schedule full-fidelity repair.";
    } finally {
      state.busy = false;
      render();
    }
  }

  async function scheduleAllImports() {
    state.busy = true;
    state.error = "";
    state.status = "Collecting every importable source chat.";
    render();
    try {
      state.lastJob = await postJson(
        "/api/imports/schedule-all",
        { skipImported: true, fastPreflight: true, validateImports: false },
        60000
      );
      state.activeJobStatus = null;
      state.status = state.lastJob.scheduled
        ? `Import queued for ${state.lastJob.count || state.lastJob.collectedCount || 0} chat${Number(state.lastJob.count || state.lastJob.collectedCount || 0) === 1 ? "" : "s"}. Close Codex when prompted by the background job.`
        : state.lastJob.message || "No importable chats were found.";
      state.selectedKeys.clear();
      startJobPolling(state.lastJob);
      await loadJobs();
    } catch (error) {
      state.error = error.message || String(error);
      state.status = "Could not schedule all imports.";
    } finally {
      state.busy = false;
      render();
    }
  }

  function stopJobPolling() {
    if (jobPollTimer) {
      window.clearInterval(jobPollTimer);
      jobPollTimer = null;
    }
  }

  function startJobPolling(job) {
    stopJobPolling();
    if (!job?.jobName) return;
    const poll = async () => {
      try {
        const status = await fetchJson(`/api/imports/job-status?job=${encodeURIComponent(job.jobName)}`, {}, 12000);
        if (!state.lastJob || state.lastJob.jobName !== job.jobName) {
          stopJobPolling();
          return;
        }
        state.activeJobStatus = status;
        state.lastJob = { ...state.lastJob, jobStatus: status };
        const progress = status.progress || {};
        state.status =
          status.phase === "complete"
            ? "Import completed."
            : status.phase === "failed"
              ? "Import failed. Check the log tail below."
              : `${progress.stage || phaseLabel(status.phase)}${progress.total ? `: ${progress.done}/${progress.total}` : ""}`;
        render();
        if (status.phase === "complete" || status.phase === "failed") {
          stopJobPolling();
          await Promise.all([loadJobs(), refreshAll()]);
        }
      } catch (error) {
        if (state.lastJob?.jobName === job.jobName) {
          state.status = `Could not poll import progress: ${error.message || error}`;
          render();
        }
      }
    };
    poll();
    jobPollTimer = window.setInterval(poll, 2000);
  }

  function handleClick(event) {
    const exportButton = event.target.closest("[data-import-export-id]");
    if (exportButton) {
      selectExport(exportButton.dataset.importExportId);
      return;
    }

    const conversationButton = event.target.closest("[data-import-conversation-id]");
    if (conversationButton && !event.target.closest("input")) {
      state.selectedConversationId = conversationButton.dataset.importConversationId || "";
      state.selectedConversationDetail = null;
      render();
      loadSelectedConversationDetail().then(render).catch(() => render());
      return;
    }

    const checkbox = event.target.closest("[data-import-select-conversation]");
    if (checkbox) {
      const entry = selectedExport();
      if (!entry) return;
      const key = conversationKey(entry.id, checkbox.dataset.importSelectConversation || "");
      if (checkbox.checked) state.selectedKeys.add(key);
      else state.selectedKeys.delete(key);
      render();
      return;
    }

    const action = event.target.closest("[data-import-action]")?.dataset.importAction;
    if (!action) return;
    if (action === "refresh") refreshAll();
    if (action === "rescan") rescanSources();
    if (action === "open-full") window.open(IMPORT_API_BASE, "_blank", "noopener,noreferrer");
    if (action === "preview-selected") {
      const entry = selectedExport();
      const conversation = selectedConversation();
      const url = entry && conversation
        ? `${IMPORT_API_BASE}/?export=${encodeURIComponent(entry.id)}&conversation=${encodeURIComponent(conversation.id)}`
        : IMPORT_API_BASE;
      window.open(url, "_blank", "noopener,noreferrer");
    }
    if (action === "import-all") scheduleAllImports();
    if (action === "select-project") selectProjectImportables();
    if (action === "select-repairable") selectProjectRepairables();
    if (action === "clear-selection") clearSelection();
    if (action === "import-selected") scheduleImport(selectedItems("import"));
    if (action === "repair-selected") scheduleRepair(selectedItems("repair"));
    if (action === "import-project") {
      const entry = selectedExport();
      scheduleImport(importableConversations().map((conversation) => ({ exportId: entry.id, conversationId: conversation.id })));
    }
  }

  function handleChange(event) {
    void event;
  }

  function installStyles() {
    if (document.getElementById("codex-native-import-settings-style")) return;
    const style = document.createElement("style");
    style.id = "codex-native-import-settings-style";
    style.textContent = `
      .cni-root {
        box-sizing: border-box;
        color: var(--color-token-text-primary, #1f2328);
        display: flex;
        flex-direction: column;
        gap: var(--padding-panel, 16px);
        height: 100%;
        margin: 0 auto;
        max-width: min(672px, 100%);
        min-height: 0;
        overflow: auto;
        padding: var(--padding-panel, 16px);
        scrollbar-gutter: stable;
        width: 100%;
      }
      .cni-root * { box-sizing: border-box; }
      .cni-header {
        align-items: flex-start;
        display: flex;
        gap: 16px;
        justify-content: space-between;
      }
      .cni-header h1 {
        font-size: 20px;
        font-weight: 650;
        line-height: 1.25;
        margin: 0;
      }
      .cni-header p {
        color: var(--color-token-text-secondary, #6b7280);
        font-size: 13px;
        line-height: 1.4;
        margin: 5px 0 0;
        max-width: 760px;
      }
      .cni-actions,
      .cni-toolbar,
      .cni-status,
      .cni-preview-meta,
      .cni-progress-chips {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .cni-actions { justify-content: flex-end; }
      .cni-status { display: none; }
      .cni-statbar {
        align-items: center;
        border: 1px solid var(--color-token-border-default, rgba(0, 0, 0, 0.12));
        border-radius: var(--radius-lg, 8px);
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        padding: 12px;
      }
      .cni-button {
        align-items: center;
        background: transparent;
        border: 1px solid var(--color-token-border-default, rgba(0, 0, 0, 0.14));
        border-radius: var(--radius-lg, 8px);
        color: inherit;
        cursor: pointer;
        display: inline-flex;
        font: inherit;
        font-size: 13px;
        font-weight: 560;
        justify-content: center;
        min-height: 32px;
        padding: 6px 11px;
      }
      .cni-button:hover:not(:disabled) {
        background: var(--color-token-bg-tertiary, rgba(0, 0, 0, 0.07));
      }
      .cni-button:disabled {
        cursor: default;
        opacity: 0.45;
      }
      .cni-primary {
        background: var(--color-token-text-primary, #111827);
        color: var(--color-token-main-surface-primary, #ffffff);
      }
      .cni-wide { width: 100%; }
      .cni-link-button {
        background: transparent;
        border: 0;
        color: #2563eb;
        cursor: pointer;
        font: inherit;
        font-size: 12px;
        margin-left: auto;
        padding: 0;
      }
      .cni-badge,
      .cni-pill {
        align-items: center;
        background: rgba(255, 255, 255, 0.4);
        border: 1px solid var(--color-token-border-default, rgba(0, 0, 0, 0.13));
        border-radius: 999px;
        color: var(--color-token-text-secondary, #4b5563);
        display: inline-flex;
        font-size: 12px;
        gap: 6px;
        min-height: 24px;
        padding: 3px 8px;
        white-space: nowrap;
      }
      .cni-badge.good,
      .cni-pill.good,
      .cni-pill.ready { background: rgba(22, 163, 74, 0.08); border-color: rgba(22, 163, 74, 0.42); color: #15803d; }
      .cni-badge.warn,
      .cni-pill.warn,
      .cni-pill.partial,
      .cni-pill.repair { background: rgba(245, 158, 11, 0.08); border-color: rgba(245, 158, 11, 0.48); color: #b45309; }
      .cni-badge.bad,
      .cni-pill.bad,
      .cni-pill.empty { background: rgba(239, 68, 68, 0.08); border-color: rgba(239, 68, 68, 0.52); color: #dc2626; }
      .cni-pill.imported { background: rgba(37, 99, 235, 0.08); border-color: rgba(37, 99, 235, 0.38); color: #2563eb; }
      .cni-pill.view { background: rgba(107, 114, 128, 0.08); border-color: rgba(107, 114, 128, 0.32); color: #6b7280; }
      .cni-badge strong { color: inherit; font-weight: 700; }
      .cni-error {
        border: 1px solid rgba(239, 68, 68, 0.5);
        border-radius: 8px;
        color: #dc2626;
        font-size: 13px;
        line-height: 1.45;
        padding: 10px 12px;
      }
      .cni-message {
        color: var(--color-token-text-secondary, #6b7280);
        font-size: 13px;
        min-height: 17px;
      }
      .cni-progress-head {
        align-items: center;
        display: flex;
        gap: 10px;
        justify-content: space-between;
      }
      .cni-progress-head strong {
        font-size: 13px;
        font-weight: 700;
      }
      .cni-progress-head span {
        color: var(--color-token-text-secondary, #6b7280);
        font-size: 12px;
        text-align: right;
      }
      .cni-progress-line {
        align-items: center;
        display: grid;
        gap: 14px;
        grid-template-columns: minmax(0, 1fr) auto;
      }
      .cni-progress-track {
        background: var(--color-token-bg-secondary, rgba(0, 0, 0, 0.06));
        border-radius: 999px;
        height: 10px;
        overflow: hidden;
      }
      .cni-progress-fill {
        background: var(--color-token-accent-bg, #2563eb);
        border-radius: inherit;
        height: 100%;
        min-width: 0;
        transition: width 180ms ease;
      }
      .cni-job-path {
        color: var(--color-token-text-secondary, #6b7280);
        font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cni-job-tail {
        background: rgba(0, 0, 0, 0.06);
        border-radius: 6px;
        font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        margin: 0;
        max-height: 170px;
        overflow: auto;
        padding: 8px;
        white-space: pre-wrap;
      }
      .cni-grid {
        display: grid;
        gap: var(--padding-panel, 16px);
        grid-template-columns: 1fr;
        flex: 0 0 auto;
        min-height: auto;
      }
      .cni-panel {
        background: var(--color-background-panel, var(--color-token-bg-fog, var(--color-token-main-surface-primary)));
        border: 1px solid var(--color-token-border-default, rgba(0, 0, 0, 0.12));
        border-radius: var(--radius-lg, 8px);
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
      }
      .cni-panel-head {
        align-items: center;
        border-bottom: 1px solid var(--color-token-border-default, rgba(0, 0, 0, 0.1));
        display: flex;
        gap: 10px;
        justify-content: space-between;
        min-height: 40px;
        padding: 9px 12px;
      }
      .cni-panel-head span {
        font-size: 13px;
        font-weight: 700;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cni-panel-head small {
        color: var(--color-token-text-secondary, #6b7280);
        font-size: 11px;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cni-toolbar {
        border-bottom: 1px solid var(--color-token-border-default, rgba(0, 0, 0, 0.1));
        padding: 8px 10px;
      }
      .cni-list,
      .cni-jobs {
        display: flex;
        flex-direction: column;
        gap: 0;
        min-height: 0;
        overflow: auto;
        overflow-x: hidden;
        padding: 0;
      }
      .cni-source,
      .cni-chat {
        background: transparent;
        border: 0;
        border-bottom: 1px solid var(--color-token-border-default, rgba(0, 0, 0, 0.08));
        border-radius: 0;
        color: inherit;
        min-width: 0;
        width: 100%;
      }
      .cni-source {
        align-items: center;
        cursor: pointer;
        display: grid;
        gap: 10px;
        grid-template-columns: 36px minmax(0, 1fr) auto 14px;
        min-height: 72px;
        padding: 10px 12px;
        text-align: left;
      }
      .cni-source:hover,
      .cni-chat:hover { background: rgba(0, 0, 0, 0.025); }
      .cni-source.is-active,
      .cni-chat.is-active {
        background: rgba(37, 99, 235, 0.055);
        border-color: var(--color-token-accent-border, #3b82f6);
        box-shadow: inset 0 0 0 1px rgba(59, 130, 246, 0.36);
      }
      .cni-source-avatar {
        align-items: center;
        border-radius: 9px;
        color: #fff;
        display: flex;
        font-size: 17px;
        font-weight: 760;
        height: 34px;
        justify-content: center;
        width: 34px;
      }
      .cni-source-avatar.source-augment { background: #6545c7; }
      .cni-source-avatar.source-cline { background: #2563eb; }
      .cni-source-avatar.source-roo-code { background: #16a34a; }
      .cni-source-avatar.source-kiro { background: #9333ea; }
      .cni-source-avatar.source-codex { background: #111827; }
      .cni-source-avatar.source-unknown { background: #6b7280; }
      .cni-source-main {
        display: grid;
        gap: 4px;
        min-width: 0;
      }
      .cni-source-title,
      .cni-chat-title {
        font-size: 13px;
        font-weight: 700;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .cni-source-title { white-space: nowrap; }
      .cni-chat-title {
        white-space: nowrap;
      }
      .cni-source-path,
      .cni-chat-meta,
      .cni-source-meta,
      .cni-preview-path {
        color: var(--color-token-text-secondary, #6b7280);
        font-size: 11px;
        line-height: 1.35;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .cni-source-path,
      .cni-chat-meta { white-space: nowrap; }
      .cni-source-meta {
        align-items: center;
        display: flex;
        flex-wrap: nowrap;
        gap: 7px;
      }
      .cni-source-meta span { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      .cni-chevron {
        color: var(--color-token-text-secondary, #6b7280);
        font-size: 18px;
      }
      .cni-chat {
        align-items: center;
        display: grid;
        gap: 8px;
        grid-template-columns: 22px minmax(0, 1fr) auto;
        min-height: 60px;
        padding: 8px 12px;
      }
      .cni-check {
        align-items: center;
        display: flex;
        justify-content: center;
      }
      .cni-chat-main {
        background: transparent;
        border: 0;
        color: inherit;
        cursor: pointer;
        display: grid;
        gap: 3px;
        min-width: 0;
        padding: 0;
        text-align: left;
      }
      .cni-chat-counts {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 11px;
        margin-top: 2px;
      }
      .cni-mini-metric {
        align-items: center;
        color: var(--color-token-text-secondary, #6b7280);
        display: inline-flex;
        font-size: 11px;
        gap: 4px;
      }
      .cni-mini-metric strong {
        color: inherit;
        font-weight: 680;
      }
      .cni-preview {
        display: grid;
        gap: 13px;
        overflow: auto;
        padding: 14px;
      }
      .cni-preview-title-row {
        align-items: start;
        display: grid;
        gap: 9px;
        grid-template-columns: auto minmax(0, 1fr);
      }
      .cni-preview-pin {
        border: 1px solid rgba(101, 69, 199, 0.34);
        border-radius: 999px;
        color: #6545c7;
        font-size: 10px;
        line-height: 1;
        padding: 4px 6px;
        text-transform: uppercase;
      }
      .cni-preview-title {
        font-size: 15px;
        font-weight: 730;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }
      .cni-tag {
        border: 1px solid rgba(59, 130, 246, 0.3);
        border-radius: 6px;
        color: #2563eb;
        font-size: 12px;
        padding: 4px 8px;
      }
      .cni-preview-date,
      .cni-preview-summary p,
      .cni-dedupe p {
        color: var(--color-token-text-secondary, #6b7280);
        font-size: 12px;
        line-height: 1.45;
        margin: 0;
      }
      .cni-preview-summary,
      .cni-dedupe,
      .cni-artifacts {
        border-top: 1px solid var(--color-token-border-default, rgba(0, 0, 0, 0.1));
        display: grid;
        gap: 7px;
        padding-top: 12px;
      }
      .cni-preview-summary strong,
      .cni-dedupe strong,
      .cni-artifacts strong {
        font-size: 13px;
      }
      .cni-dedupe {
        align-items: start;
        grid-template-columns: minmax(0, 1fr) auto;
      }
      .cni-artifacts div {
        align-items: center;
        display: flex;
        justify-content: space-between;
      }
      .cni-job {
        border: 1px solid var(--color-token-border-default, rgba(0, 0, 0, 0.12));
        border-radius: 8px;
        padding: 8px;
      }
      .cni-job summary {
        cursor: pointer;
        display: grid;
        gap: 3px;
      }
      .cni-job summary span { font-size: 12px; font-weight: 650; overflow-wrap: anywhere; }
      .cni-job summary small { color: var(--color-token-text-secondary, #6b7280); font-size: 11px; }
      .cni-job pre {
        background: rgba(0, 0, 0, 0.06);
        border-radius: 6px;
        font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        margin: 8px 0 0;
        max-height: 180px;
        overflow: auto;
        padding: 8px;
        white-space: pre-wrap;
      }
      .cni-empty {
        color: var(--color-token-text-secondary, #6b7280);
        font-size: 13px;
        line-height: 1.45;
        padding: 12px;
      }
      .cni-footer {
        background: var(--color-background-panel, var(--color-token-bg-fog, var(--color-token-main-surface-primary)));
        border: 1px solid var(--color-token-border-default, rgba(0, 0, 0, 0.12));
        border-radius: var(--radius-lg, 8px);
        display: grid;
        flex: 0 0 auto;
        grid-template-columns: 1fr;
        max-height: none;
        min-height: 180px;
        overflow: hidden;
      }
      .cni-progress-card,
      .cni-log-card {
        display: grid;
        gap: 12px;
        min-height: 0;
        padding: 12px 14px;
      }
      .cni-progress-card {
        border-bottom: 1px solid var(--color-token-border-default, rgba(0, 0, 0, 0.1));
      }
      .cni-apply-warning {
        align-items: center;
        background: rgba(245, 158, 11, 0.09);
        border: 1px solid rgba(245, 158, 11, 0.28);
        border-radius: 8px;
        color: #92400e;
        display: flex;
        gap: 10px;
        padding: 10px 12px;
      }
      .cni-apply-warning span {
        align-items: center;
        border: 1px solid rgba(245, 158, 11, 0.46);
        border-radius: 999px;
        display: inline-flex;
        font-size: 11px;
        height: 18px;
        justify-content: center;
        width: 18px;
      }
      .cni-apply-warning strong {
        font-size: 13px;
        font-weight: 560;
      }
      .cni-log-head {
        align-items: center;
        display: flex;
        justify-content: space-between;
      }
      .cni-log-head strong { font-size: 13px; }
      .cni-log-lines {
        display: grid;
        gap: 6px;
        min-height: 0;
        overflow: auto;
      }
      .cni-log-line {
        display: grid;
        gap: 12px;
        grid-template-columns: 58px minmax(0, 1fr);
      }
      .cni-log-line span,
      .cni-log-empty {
        color: var(--color-token-text-secondary, #6b7280);
        font-size: 12px;
      }
      .cni-log-line code {
        color: var(--color-token-text-primary, #1f2328);
        font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cni-footnote {
        border-top: 1px solid var(--color-token-border-default, rgba(0, 0, 0, 0.1));
        color: var(--color-token-text-secondary, #6b7280);
        font-size: 12px;
        grid-column: 1 / -1;
        padding: 10px 16px;
      }
      @media (max-width: 980px) {
        .cni-root { padding: 12px; }
        .cni-header,
        .cni-actions,
        .cni-progress-line,
        .cni-log-head {
          align-items: stretch;
          flex-direction: column;
        }
        .cni-actions { justify-content: stretch; }
        .cni-actions .cni-button,
        .cni-log-head .cni-button {
          width: 100%;
        }
        .cni-progress-line {
          grid-template-columns: 1fr;
        }
        .cni-grid { grid-template-columns: 1fr; overflow: visible; }
        .cni-panel { min-height: 260px; }
        .cni-footer { grid-template-columns: 1fr; overflow: visible; }
        .cni-progress-card { border-right: 0; border-bottom: 1px solid var(--color-token-border-default, rgba(0, 0, 0, 0.1)); }
      }
    `;
    document.head.appendChild(style);
  }

  function isImportsSettingsRoute() {
    if (document.getElementById("codex-native-imports-settings-route")) {
      return true;
    }
    return window.location.pathname.replace(/\/+$/, "") === "/settings/imports";
  }

  function mountImportsSettingsRoute() {
    const host = document.getElementById("codex-native-imports-settings-route");
    if (!host) {
      return false;
    }
    if (host === currentRouteHost && host.dataset.codexNativeImportMounted === "1") {
      return true;
    }
    currentRouteHost = host;
    host.dataset.codexNativeImportMounted = "1";
    openImportsSettingsRoutePanel();
    return true;
  }

  function scheduleImportsRouteRecovery() {
    for (const delay of [0, 50, 150, 400, 1000, 2000, 3500]) {
      window.setTimeout(() => {
        if (isImportsSettingsRoute()) {
          mountImportsSettingsRoute();
        }
      }, delay);
    }
  }

  function startImportsRouteObserver() {
    const start = () => {
      if (!document.body || routeObserver) {
        return;
      }
      routeObserver = new MutationObserver(() => {
        if (!isImportsSettingsRoute()) {
          return;
        }
        const host = document.getElementById("codex-native-imports-settings-route");
        if (host && host.dataset.codexNativeImportMounted !== "1") {
          mountImportsSettingsRoute();
        }
      });
      routeObserver.observe(document.body, { childList: true, subtree: true });
      scheduleImportsRouteRecovery();
    };

    if (document.body) {
      start();
    } else {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    }
  }

  function openImportsSettingsRoutePanel() {
    state.open = true;
    installStyles();
    const host = document.getElementById("codex-native-imports-settings-route");
    if (!host) {
      scheduleImportsRouteRecovery();
      return;
    }
    host.dataset.codexNativeImportMounted = "1";
    if (host && !host.dataset.codexNativeImportBound) {
      host.dataset.codexNativeImportBound = "1";
      host.addEventListener("click", handleClick);
      host.addEventListener("change", handleChange);
    }
    render();
    if (!state.busy && (Date.now() - lastRefreshAt > 30000 || (!state.exports.length && !state.error))) {
      lastRefreshAt = Date.now();
      refreshAll().catch(() => {});
    }
    if (!pollTimer) {
      pollTimer = window.setInterval(() => {
        if (state.open) loadJobs().then(render).catch(() => {});
      }, 5000);
    }
  }

  function handleNativeSettingsTabEvent(event) {
    if (event?.detail?.id === "imports") {
      if (!mountImportsSettingsRoute()) {
        scheduleImportsRouteRecovery();
      }
    }
  }

  loadDraft();
  window.addEventListener("codex-native-settings-route", handleNativeSettingsTabEvent);
  window.addEventListener("codex-native-patcher-settings-changed", () => {
    render();
  });
  window.addEventListener("popstate", scheduleImportsRouteRecovery);
  window.addEventListener("focus", scheduleImportsRouteRecovery);
  window.__codexNativeImportSettings = {
    openSettingsRoute: openImportsSettingsRoutePanel,
    refresh: refreshAll,
  };
  startImportsRouteObserver();
})();
