const state = {
  exports: [],
  selectedExportId: null,
  conversations: [],
  selectedConversationId: null,
  selectedConversation: null,
  sourceFilter: "all",
  filter: "all",
  query: "",
  showRaw: false,
  selectedKeys: new Set(),
  selectedProjectIds: new Set(),
  projectConversationCache: new Map(),
  lastJob: null,
  jobPollTimer: null,
  codexProjects: [],
  selectedCodexProjectPath: "",
  codexMovePreview: null,
  codexMoveJob: null,
};

const elements = {
  exportSummary: document.querySelector("#exportSummary"),
  exportSelect: document.querySelector("#exportSelect"),
  projectCountBadge: document.querySelector("#projectCountBadge"),
  projectList: document.querySelector("#projectList"),
  searchInput: document.querySelector("#searchInput"),
  conversationList: document.querySelector("#conversationList"),
  conversationKicker: document.querySelector("#conversationKicker"),
  conversationTitle: document.querySelector("#conversationTitle"),
  conversationMeta: document.querySelector("#conversationMeta"),
  conversationBody: document.querySelector("#conversationBody"),
  refreshButton: document.querySelector("#refreshButton"),
  exportAllButton: document.querySelector("#exportAllButton"),
  selectShownButton: document.querySelector("#selectShownButton"),
  clearSelectionButton: document.querySelector("#clearSelectionButton"),
  importSelectedButton: document.querySelector("#importSelectedButton"),
  importAllButton: document.querySelector("#importAllButton"),
  importProjectButton: document.querySelector("#importProjectButton"),
  importCurrentButton: document.querySelector("#importCurrentButton"),
  copyIdButton: document.querySelector("#copyIdButton"),
  rawToggleButton: document.querySelector("#rawToggleButton"),
  jobStatus: document.querySelector("#jobStatus"),
  codexProjectSelect: document.querySelector("#codexProjectSelect"),
  reloadCodexProjectsButton: document.querySelector("#reloadCodexProjectsButton"),
  codexProjectStatus: document.querySelector("#codexProjectStatus"),
  codexMoveDestination: document.querySelector("#codexMoveDestination"),
  previewCodexMoveButton: document.querySelector("#previewCodexMoveButton"),
  scheduleCodexMoveButton: document.querySelector("#scheduleCodexMoveButton"),
  codexMoveStatus: document.querySelector("#codexMoveStatus"),
  filterButtons: Array.from(document.querySelectorAll(".filter-button")),
  sourceButtons: Array.from(document.querySelectorAll(".source-filter-button")),
};

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return response.json();
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return response.json();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(value) {
  if (!value) return "Unknown date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function compactDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString([], { year: "numeric", month: "short", day: "2-digit" });
}

function compactDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function titleFor(conversation) {
  return (conversation.name || conversation.id || "Untitled").trim();
}

function conversationKey(exportId, conversationId) {
  return `${exportId}:${conversationId}`;
}

function currentConversationKey(conversation) {
  return conversationKey(state.selectedExportId, conversation.id);
}

function splitConversationKey(key) {
  const index = key.indexOf(":");
  return index >= 0
    ? { exportId: key.slice(0, index), conversationId: key.slice(index + 1) }
    : { exportId: "", conversationId: key };
}

function isImported(conversation) {
  return Boolean(conversation?.importStatus?.imported);
}

function isViewOnlyExport(exportId) {
  const entry = exportForId(exportId);
  return Boolean(entry?.viewOnly || entry?.sourceType === "codex");
}

function isViewOnlyConversation(conversation, exportId = state.selectedExportId) {
  return Boolean(conversation?.viewOnly || conversation?.sourceType === "codex" || isViewOnlyExport(exportId));
}

function isEmptyConversation(conversation) {
  return Number(conversation?.chatHistoryCount) === 0 || Number(conversation?.exchangeCount) === 0 || Number(conversation?.levelExchangeCount) === 0;
}

function conversationsForProject(exportId) {
  if (exportId === state.selectedExportId) {
    return state.conversations;
  }
  return state.projectConversationCache.get(exportId) || null;
}

function unimportedConversations(conversations, exportId = state.selectedExportId) {
  return (conversations || []).filter((conversation) => {
    return !isViewOnlyConversation(conversation, exportId) && !isImported(conversation) && !isEmptyConversation(conversation);
  });
}

function selectedCountForProject(exportId) {
  const prefix = `${exportId}:`;
  return [...state.selectedKeys].filter((key) => key.startsWith(prefix)).length;
}

function selectProjectConversations(exportId, conversations) {
  const prefix = `${exportId}:`;
  for (const key of [...state.selectedKeys]) {
    if (key.startsWith(prefix)) {
      state.selectedKeys.delete(key);
    }
  }
  for (const conversation of conversations || []) {
    if (!isViewOnlyConversation(conversation, exportId) && !isImported(conversation) && !isEmptyConversation(conversation)) {
      state.selectedKeys.add(conversationKey(exportId, conversation.id));
    }
  }
  if (unimportedConversations(conversations, exportId).length) {
    state.selectedProjectIds.add(exportId);
  } else {
    state.selectedProjectIds.delete(exportId);
  }
}

function clearProjectSelection(exportId) {
  const prefix = `${exportId}:`;
  for (const key of [...state.selectedKeys]) {
    if (key.startsWith(prefix)) {
      state.selectedKeys.delete(key);
    }
  }
  state.selectedProjectIds.delete(exportId);
}

function syncProjectSelectionState(exportId) {
  const conversations = conversationsForProject(exportId);
  if (!conversations) {
    return;
  }
  const unimported = unimportedConversations(conversations, exportId).length;
  const selected = selectedCountForProject(exportId);
  if (unimported > 0 && selected === unimported) {
    state.selectedProjectIds.add(exportId);
  } else {
    state.selectedProjectIds.delete(exportId);
  }
}

function selectedProjectCount() {
  return state.conversations.filter((conversation) => {
    return !isViewOnlyConversation(conversation) && !isImported(conversation) && state.selectedKeys.has(currentConversationKey(conversation));
  }).length;
}

function selectedTotalCount() {
  return state.selectedKeys.size;
}

function selectedCodexProject() {
  return state.codexProjects.find((project) => project.path === state.selectedCodexProjectPath) || null;
}

function exportForId(exportId) {
  return state.exports.find((entry) => entry.id === exportId) || null;
}

function targetCwdForExport(exportId) {
  const match = exportForId(exportId)?.codexProjectMatch;
  return match?.matchType === "exact" && match.matchedPath ? match.matchedPath : "";
}

function codexMatchLabel(entry) {
  if (entry?.sourceType === "codex") {
    return Number(entry.conversationCount) ? "Codex native" : "No Codex chats";
  }
  const match = entry?.codexProjectMatch;
  if (!match) return "Codex unknown";
  if (match.matchType === "exact") return "Codex project exists";
  if (match.status === "candidates") return `${match.candidateCount} possible Codex matches`;
  if (match.status === "nonlocal") return "Non-local workspace";
  return "No Codex project";
}

function sourceDisplayName(entryOrConversation) {
  const sourceType = entryOrConversation?.sourceType || entryOrConversation?.exchangeSource || "";
  const sourceName = entryOrConversation?.sourceName || entryOrConversation?.exchangeSourceLabel || "";
  if (sourceName) return sourceName.replace(" Code", "");
  if (sourceType === "roo-code") return "Roo";
  if (sourceType === "kiro") return "Kiro";
  if (sourceType === "cline") return "Cline";
  if (sourceType === "augment") return "Augment";
  if (sourceType === "codex") return "Codex";
  return sourceType || "Source";
}

function sourceClass(sourceType) {
  return `source-${String(sourceType || "unknown").replace(/[^a-z0-9_-]/gi, "-").toLowerCase()}`;
}

function filteredExports() {
  if (state.sourceFilter === "all") {
    return state.exports;
  }
  return state.exports.filter((entry) => entry.sourceType === state.sourceFilter);
}

function projectDisplayName(entry) {
  const label = String(entry?.label || entry?.id || "Untitled");
  const sourceName = entry?.sourceName ? ` (${entry.sourceName})` : "";
  return sourceName && label.endsWith(sourceName) ? label.slice(0, -sourceName.length) : label;
}

function sourceLabelForConversation(conversation) {
  if (conversation?.exchangeSourceLabel) return conversation.exchangeSourceLabel;
  if (conversation?.sourceName) return conversation.sourceName;
  if (conversation?.exchangeSource === "webview") return "webview state";
  if (conversation?.exchangeSource === "leveldb") return "LevelDB";
  return conversation?.exchangeSource || "conversation export";
}

function conversationHaystack(conversation) {
  return [
    conversation.id,
    conversation.name,
    conversation.createdAtIso,
    conversation.lastInteractedAtIso,
    conversation.rootTaskUuid,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function filteredConversations() {
  const query = state.query.trim().toLowerCase();
  return state.conversations.filter((conversation) => {
    if (state.filter === "unimported" && isImported(conversation)) return false;
    if (state.filter === "imported" && !isImported(conversation)) return false;
    if (state.filter === "pinned" && !conversation.isPinned) return false;
    if (state.filter === "forked" && !conversation.isForked) return false;
    if (query && !conversationHaystack(conversation).includes(query)) return false;
    return true;
  });
}

function highlight(text) {
  const query = state.query.trim();
  const safe = escapeHtml(text);
  if (!query) return safe;

  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return safe.replace(new RegExp(escapedQuery, "ig"), (match) => `<mark>${match}</mark>`);
}

function renderExportSelect() {
  elements.exportSelect.innerHTML = state.exports
    .map((entry) => {
      const count = entry.conversationCount ?? 0;
      const level = entry.hasLevelDbExport ? "with message bodies" : "index only";
      const imported = `${entry.importedCount ?? 0}/${count} imported`;
      return `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.label)} (${count}, ${level}, ${imported}, ${codexMatchLabel(entry)})</option>`;
    })
    .join("");
  elements.exportSelect.value = state.selectedExportId || "";
}

function renderProjectList() {
  const projects = filteredExports();
  if (elements.projectCountBadge) {
    elements.projectCountBadge.textContent = String(projects.length);
  }
  if (!projects.length) {
    elements.projectList.innerHTML = `<div class="empty-state empty-state--compact">No chat exports found.</div>`;
    return;
  }

  elements.projectList.innerHTML = projects
    .map((entry) => {
      const active = entry.id === state.selectedExportId ? " is-active" : "";
      const conversations = conversationsForProject(entry.id);
      const total = conversations ? conversations.length : entry.conversationCount ?? 0;
      const imported = conversations ? conversations.filter(isImported).length : null;
      const viewOnly = Boolean(entry.viewOnly || entry.sourceType === "codex");
      const unimported = conversations ? unimportedConversations(conversations, entry.id).length : null;
      const selected = selectedCountForProject(entry.id);
      const checked =
        conversations && unimported !== null
          ? selected > 0 && selected === unimported
          : state.selectedProjectIds.has(entry.id);
      const disabled = viewOnly || total === 0 || (unimported !== null && unimported === 0);
      const status =
        viewOnly
          ? `${total} threads · view only`
          : imported !== null
          ? `${selected}/${unimported} selected · ${imported} imported · ${codexMatchLabel(entry)}`
          : `${selected ? `${selected} selected · ` : ""}${total} threads · ${codexMatchLabel(entry)}`;
      const projectPath = entry.workspacePath || entry.codexProjectMatch?.sourcePath || entry.codexProjectMatch?.augmentPath || "";
      const sourceType = entry.sourceType || "augment";
      return `
        <div class="project-row${active}" data-id="${escapeHtml(entry.id)}">
          <input class="project-check" type="checkbox" data-id="${escapeHtml(entry.id)}"${checked ? " checked" : ""}${disabled ? " disabled" : ""} aria-label="Select project">
          <span class="folder-glyph" aria-hidden="true"></span>
          <span class="project-main">
            <span class="project-title">${escapeHtml(projectDisplayName(entry))}</span>
            <span class="project-meta">${escapeHtml(projectPath || entry.id)}</span>
            <span class="project-submeta">${escapeHtml(status)}</span>
          </span>
          <span class="project-badges">
            <span class="source-badge ${escapeHtml(sourceClass(sourceType))}">${escapeHtml(sourceDisplayName(entry))}</span>
            <span class="status-badge status-badge--neutral">${escapeHtml(codexMatchLabel(entry))}</span>
          </span>
        </div>
      `;
    })
    .join("");

  for (const checkbox of elements.projectList.querySelectorAll(".project-check")) {
    const conversations = conversationsForProject(checkbox.dataset.id);
    if (!conversations) {
      checkbox.indeterminate = selectedCountForProject(checkbox.dataset.id) > 0 && !checkbox.checked;
      continue;
    }
    const unimported = unimportedConversations(conversations, checkbox.dataset.id).length;
    const selected = selectedCountForProject(checkbox.dataset.id);
    checkbox.indeterminate = selected > 0 && selected < unimported;
  }
  elements.projectList.querySelector(".project-row.is-active")?.scrollIntoView({ block: "center" });
}

function renderConversationList() {
  const list = filteredConversations();
  const imported = state.conversations.filter(isImported).length;
  const selected = selectedProjectCount();
  const totalSelected = selectedTotalCount();
  const selectedProjects = state.selectedProjectIds.size;
  const sourceCount = new Set(state.exports.map((entry) => entry.sourceType || "augment")).size;
  const clineChats = state.exports
    .filter((entry) => entry.sourceType === "cline")
    .reduce((sum, entry) => sum + (Number(entry.conversationCount) || 0), 0);
  const codexChats = state.exports
    .filter((entry) => entry.sourceType === "codex")
    .reduce((sum, entry) => sum + (Number(entry.conversationCount) || 0), 0);
  elements.exportSummary.textContent = `${state.exports.length} projects · ${sourceCount} sources · ${clineChats} Cline chats · ${codexChats} Codex chats`;
  elements.importSelectedButton.disabled = totalSelected === 0;
  elements.importProjectButton.disabled = !unimportedConversations(state.conversations).length;
  elements.importSelectedButton.textContent = totalSelected ? `Import selected (${totalSelected})` : "Import selected";
  elements.importProjectButton.textContent = `Import current project (${unimportedConversations(state.conversations).length})`;

  if (!list.length) {
    elements.conversationList.innerHTML = `<div class="empty-state">No conversations match the current filters.</div>`;
    return;
  }

  elements.conversationList.innerHTML = list
    .map((conversation) => {
      const active = conversation.id === state.selectedConversationId ? " is-active" : "";
      const key = currentConversationKey(conversation);
      const checked = state.selectedKeys.has(key) ? " checked" : "";
      const importedStatus = isImported(conversation);
      const emptyStatus = isEmptyConversation(conversation);
      const viewOnly = isViewOnlyConversation(conversation);
      const importedClass = importedStatus ? " is-imported" : "";
      const viewOnlyClass = viewOnly ? " is-view-only" : "";
      const toolCount = Number(conversation.toolUseCount) || 0;
      const diffCount = Number(conversation.editDiffCount) || 0;
      const badges = [
        conversation.isPinned ? "Pinned" : null,
        conversation.isForked ? "Fork" : null,
        conversation.isShareable ? "Shareable" : null,
      ]
        .filter(Boolean)
        .join(" · ");
      const disabled = viewOnly || importedStatus || emptyStatus;
      return `
        <div class="thread-row${active}${importedClass}${viewOnlyClass}" data-id="${escapeHtml(conversation.id)}">
          <input class="thread-check" type="checkbox" data-id="${escapeHtml(conversation.id)}"${checked} ${disabled ? "disabled" : ""} aria-label="Select thread">
          <span class="thread-main">
            <span class="thread-title">${highlight(titleFor(conversation))}</span>
            <span class="thread-meta">${escapeHtml(conversation.id)}${badges ? ` · ${escapeHtml(badges)}` : ""}</span>
          </span>
          <span class="thread-date">${escapeHtml(compactDateTime(conversation.lastInteractedAtIso || conversation.createdAtIso))}</span>
          <span class="thread-metric">${toolCount}</span>
          <span class="thread-metric">${diffCount}</span>
          <span class="thread-status ${viewOnly || importedStatus ? "thread-status--imported" : "thread-status--new"}">${viewOnly ? "View only" : importedStatus ? "Imported" : emptyStatus ? "Empty" : "Not imported"}</span>
        </div>
      `;
    })
    .join("");
  elements.conversationList.querySelector(".thread-row.is-active")?.scrollIntoView({ block: "center" });
}

function renderInlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function renderMarkdownish(text) {
  const value = String(text || "");
  if (!value.trim()) return `<span class="source-note">(empty)</span>`;

  const segments = value.split(/```/);
  return segments
    .map((segment, index) => {
      if (index % 2 === 1) {
        const lines = segment.replace(/^\w+\n/, "");
        return `<pre><code>${escapeHtml(lines.trim())}</code></pre>`;
      }

      return segment
        .split(/\n{2,}/)
        .map((block) => {
          const trimmed = block.trim();
          if (!trimmed) return "";
          if (trimmed.startsWith("### ")) return `<h4>${renderInlineMarkdown(trimmed.slice(4))}</h4>`;
          if (trimmed.startsWith("## ")) return `<h3>${renderInlineMarkdown(trimmed.slice(3))}</h3>`;
          if (trimmed.startsWith("# ")) return `<h3>${renderInlineMarkdown(trimmed.slice(2))}</h3>`;
          return `<p>${renderInlineMarkdown(trimmed).replace(/\n/g, "<br>")}</p>`;
        })
        .join("");
    })
    .join("");
}

function messageHtml(role, text, meta) {
  const className = role === "User" ? "message--user" : "message--assistant";
  return `
    <article class="message ${className}">
      <div class="message__header">
        <span class="message__role">${role}</span>
        <span>${escapeHtml(meta || "")}</span>
      </div>
      <div class="message__body">${renderMarkdownish(text)}</div>
    </article>
  `;
}

function titleFromSummary(summary) {
  const firstLine = String(summary || "")
    .trim()
    .split(/\n+/)
    .find(Boolean) || "Reasoning summary";
  const firstSentence = firstLine.match(/^(.{24,120}?[.!?])\s/)?.[1] || firstLine;
  return firstSentence.length > 110 ? `${firstSentence.slice(0, 107)}...` : firstSentence;
}

function reasoningCardHtml(event, meta) {
  const body = event.summary
    ? renderMarkdownish(event.summary)
    : `<p class="tool-empty">This turn has an encrypted reasoning body, but no plaintext summary was exported.</p>`;
  return `
    <details class="reasoning-card" open>
      <summary>
        <span class="reasoning-title">${escapeHtml(titleFromSummary(event.summary))}</span>
        <span class="reasoning-meta">Reasoning summary${event.hasEncryptedContent ? " · encrypted body saved" : ""}${meta ? ` · ${escapeHtml(meta)}` : ""}</span>
      </summary>
      <div class="reasoning-card__body">${body}</div>
    </details>
  `;
}

function metricBadges(metrics) {
  const items = [];
  if (Number.isFinite(metrics?.tool_lines_added)) {
    items.push(`+${metrics.tool_lines_added}`);
  }
  if (Number.isFinite(metrics?.tool_lines_deleted)) {
    items.push(`-${metrics.tool_lines_deleted}`);
  }
  return items.join(" ");
}

function diffLines(text, sign, className) {
  const value = String(text || "");
  if (!value.length) return "";

  const lines = value.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  return lines
    .map(
      (line) => `
        <div class="diff-line ${className}">
          <span class="diff-sign">${sign}</span>
          <code>${escapeHtml(line || " ")}</code>
        </div>
      `
    )
    .join("");
}

function renderDiffs(diffs) {
  if (!Array.isArray(diffs) || !diffs.length) return "";

  return diffs
    .map((diff) => {
      const edits = Array.isArray(diff.edits) ? diff.edits : [];
      const label =
        diff.changeKind === "created"
          ? "Created file"
          : diff.changeKind === "deleted"
            ? "Deleted file"
            : "Edited file";
      const editHtml = edits
        .map((edit) => {
          const line = edit.lineStart ? `line ${edit.lineStart}` : "line ?";
          return `
            <div class="diff-hunk">
              <div class="diff-hunk__header">@@ ${escapeHtml(line)} @@</div>
              ${diffLines(edit.beforeText, "-", "diff-line--delete")}
              ${diffLines(edit.afterText, "+", "diff-line--add")}
            </div>
          `;
        })
        .join("");

      return `
        <div class="diff-card">
          <div class="diff-card__header">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(diff.path || "unknown file")}</strong>
          </div>
          ${editHtml || `<pre class="tool-result"><code>${escapeHtml(JSON.stringify(diff, null, 2))}</code></pre>`}
        </div>
      `;
    })
    .join("");
}

function toolCardHtml(tool) {
  const hasDiffs = Array.isArray(tool.diffs) && tool.diffs.length > 0;
  const editCount = hasDiffs
    ? tool.diffs.reduce((sum, diff) => sum + (Array.isArray(diff.edits) ? diff.edits.length : 0), 0)
    : 0;
  const metrics = metricBadges(tool.metrics || {});
  const statusClass = tool.isError ? "tool-card--error" : "tool-card--ok";
  const name = tool.toolName || "tool";
  const iconClass = /edit|replace|write|patch/i.test(name)
    ? "tool-icon--edit"
    : /create|new|file/i.test(name)
      ? "tool-icon--file"
      : /search|grep|find/i.test(name)
        ? "tool-icon--search"
        : /command|terminal|exec/i.test(name)
          ? "tool-icon--terminal"
          : "tool-icon--read";
  const resultText = tool.text
    ? `<pre class="tool-result"><code>${escapeHtml(tool.text)}</code></pre>`
    : `<p class="tool-empty">No result text saved for this tool call.</p>`;

  return `
    <details class="tool-card ${statusClass}" ${hasDiffs ? "open" : ""}>
      <summary>
        <span class="tool-icon ${iconClass}" aria-hidden="true"></span>
        <span class="tool-name">${escapeHtml(name)}</span>
        <span class="tool-summary">${escapeHtml(tool.inputSummary || tool.inputJson || tool.toolUseId || "")}</span>
        <span class="tool-status">${tool.isError ? "Error" : "Success"}${metrics ? ` ${escapeHtml(metrics)}` : ""}${editCount ? ` · ${editCount} edits` : ""}</span>
      </summary>
      <div class="tool-card__body">
        ${renderDiffs(tool.diffs)}
        ${resultText}
      </div>
    </details>
  `;
}

function toolGroupHtml(tools, meta) {
  if (!Array.isArray(tools) || !tools.length) return "";
  return `
    <section class="tool-group">
      <div class="tool-group__header">
        <span>Actions</span>
        <span>${tools.length} tool call${tools.length === 1 ? "" : "s"}${meta ? ` · ${escapeHtml(meta)}` : ""}</span>
      </div>
      ${tools.map(toolCardHtml).join("")}
    </section>
  `;
}

function renderExchangeEvents(exchange, meta) {
  const rendered = [];
  let pendingTools = [];

  const flushTools = () => {
    if (pendingTools.length) {
      rendered.push(toolGroupHtml(pendingTools, meta));
      pendingTools = [];
    }
  };

  for (const event of exchange.events || []) {
    if (event.type === "tool" && event.tool) {
      pendingTools.push(event.tool);
      continue;
    }

    flushTools();
    if (event.type === "thinking") {
      rendered.push(reasoningCardHtml(event, meta));
    } else if (event.type === "assistant_text" && event.text && event.text.trim()) {
      rendered.push(messageHtml("Assistant", event.text, meta));
    }
  }

  flushTools();
  return rendered;
}

function renderRawPanel(conversation) {
  return `
    <div class="raw-panel">
      <p class="source-note">Raw merged payload. This includes decoded source data plus normalized exchange data when available.</p>
      <pre class="raw-block"><code>${escapeHtml(JSON.stringify(conversation, null, 2))}</code></pre>
    </div>
  `;
}

function fallbackWebviewMessages(conversation) {
  const items = conversation.webview?.chatHistory || [];
  return items
    .map((item, index) => {
      if (item.request_message) {
        return messageHtml("User", item.request_message, item.timestamp || `webview item ${index + 1}`);
      }
      if (item.response_text) {
        return messageHtml("Assistant", item.response_text, item.timestamp || `webview item ${index + 1}`);
      }
      if (item.summary) {
        return messageHtml("Assistant", item.summary, item.chatItemType || `summary ${index + 1}`);
      }
      return "";
    })
    .join("");
}

function renderConversationBody() {
  const conversation = state.selectedConversation;
  if (!conversation) {
    elements.conversationBody.innerHTML = `<div class="empty-state">Pick a thread on the left.</div>`;
    return;
  }

  if (state.showRaw) {
    elements.conversationBody.innerHTML = renderRawPanel(conversation);
    return;
  }

  const exchangeMessages = [];
  for (const exchange of conversation.exchanges || []) {
    const metaParts = [
      exchange.timestamp ? formatDate(exchange.timestamp) : null,
      exchange.model,
      exchange.status,
      exchange.exchangeId,
    ].filter(Boolean);
    const meta = metaParts.join(" · ");

    if (exchange.request && exchange.request.trim()) {
      exchangeMessages.push(messageHtml("User", exchange.request, meta));
    }
    const eventMessages = renderExchangeEvents(exchange, meta);
    if (eventMessages.length) {
      exchangeMessages.push(...eventMessages);
    } else {
      if (exchange.response && exchange.response.trim()) {
        exchangeMessages.push(messageHtml("Assistant", exchange.response, meta));
      }
      if (exchange.tools && exchange.tools.length) {
        exchangeMessages.push(toolGroupHtml(exchange.tools, meta));
      }
    }
  }

  const body = exchangeMessages.join("") || fallbackWebviewMessages(conversation);
  const sourceLabel = sourceLabelForConversation(conversation);
  const sourceFile = conversation.exchangeSource === "webview"
    ? conversation.sourceFiles?.webview
    : conversation.sourceFiles?.level || conversation.sourceFiles?.webview || "unknown";
  elements.conversationBody.innerHTML =
    `<p class="source-note">${conversation.exchanges?.length || 0} ${escapeHtml(sourceLabel)} exchanges, ${conversation.thinkingCount || 0} reasoning summaries, ${conversation.visibleToolCallCount || 0} visible action cards, ${conversation.toolUseCount || 0} saved tool-result records (${conversation.levelToolUseCount || 0} primary, ${conversation.webviewToolUseCount || 0} webview), ${conversation.editDiffCount || 0} checkpoint diffs. Source: ${escapeHtml(sourceFile)}</p>` +
    (body || `<div class="empty-state">This conversation only has metadata in the current exports.</div>`);
}

function renderConversationHeader() {
  const conversation = state.selectedConversation;
  if (!conversation) {
    elements.conversationKicker.textContent = "No conversation selected";
    elements.conversationTitle.textContent = "Select a conversation";
    elements.conversationMeta.innerHTML = "";
    elements.copyIdButton.disabled = true;
    elements.rawToggleButton.disabled = true;
    elements.importCurrentButton.disabled = true;
    return;
  }

  const record = conversation.indexRecord || conversation.webview || {};
  const importedStatus = conversation.importStatus || {};
  const viewOnly = isViewOnlyConversation(conversation);
  const exportEntry = exportForId(state.selectedExportId);
  const match = exportEntry?.codexProjectMatch;
  elements.conversationKicker.textContent = sourceDisplayName(conversation);
  elements.conversationTitle.textContent = titleFor(record);
  const metaItems = [
    { text: sourceDisplayName(conversation), className: `pill--source ${sourceClass(conversation.sourceType || conversation.exchangeSource)}` },
    { text: `${conversation.toolUseCount || 0} tools`, className: "pill--metric" },
    { text: `${conversation.editDiffCount || 0} diffs`, className: "pill--metric" },
    { text: viewOnly ? "View only" : importedStatus.imported ? `Imported ${importedStatus.threadId || ""}` : "Not imported", className: viewOnly || importedStatus.imported ? "pill--imported" : "pill--new" },
    { text: record.lastInteractedAtIso ? formatDate(record.lastInteractedAtIso) : null, className: "pill--muted" },
    { text: match?.matchType === "exact" ? `Codex project ${match.matchedPath}` : codexMatchLabel(exportEntry), className: "pill--muted" },
    { text: record.isPinned ? "Pinned" : null, className: "pill--muted" },
    { text: record.isForked ? "Forked" : null, className: "pill--muted" },
    { text: record.id, className: "pill--muted" },
  ];
  elements.conversationMeta.innerHTML = metaItems
    .filter((item) => item.text)
    .map((item) => `<span class="pill ${escapeHtml(item.className)}">${escapeHtml(item.text)}</span>`)
    .join("");
  elements.copyIdButton.disabled = false;
  elements.rawToggleButton.disabled = false;
  elements.importCurrentButton.disabled = viewOnly || Boolean(importedStatus.imported);
  elements.rawToggleButton.textContent = state.showRaw ? "Messages" : "Raw";
}

function renderJobStatus() {
  if (!state.lastJob) {
    elements.jobStatus.textContent = "No import job queued.";
    return;
  }
  const job = state.lastJob;
  if (job.type === "export") {
    elements.jobStatus.innerHTML = [
      "Chat source scan started.",
      job.logPath ? `<span class="job-path">${escapeHtml(job.logPath)}</span>` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return;
  }
  if (job.scheduled) {
    if (job.jobStatus) {
      const status = job.jobStatus;
      const phaseLabels = {
        queued: "Queued",
        "preflight-running": "Preflight running",
        "preflight-passed": "Preflight passed",
        "importer-started": "Importer started",
        complete: "Import complete",
        failed: "Import failed",
      };
      const preflight = status.preflight || {};
      const progress = status.progress || {};
      const progressTotal = Number(progress.total || 0);
      const progressDone = Number(progress.done || 0);
      const progressPercent = progressTotal ? Math.max(0, Math.min(100, Number(progress.percent || Math.round((progressDone / progressTotal) * 100)))) : 0;
      const progressHtml = progressTotal
        ? `
          <div class="job-progress">
            <div class="job-progress-head">
              <strong>${escapeHtml(progress.stage || phaseLabels[status.phase] || status.phase)}</strong>
              <span>${escapeHtml(`${progressDone}/${progressTotal} · ${progressPercent}%${progress.skipped ? ` · ${progress.skipped} skipped` : ""}`)}</span>
            </div>
            <div class="job-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${escapeHtml(progressPercent)}">
              <div class="job-progress-fill" style="width:${escapeHtml(progressPercent)}%"></div>
            </div>
          </div>
        `
        : "";
      const validationSummary = preflight.validations?.length
        ? preflight.validations
            .map((item) => {
              const counts = item.validation?.itemCounts || {};
              return `${item.title || item.conversationId}: ${item.turnCount || 0} turns, ${counts.mcpToolCall || 0} tool cards, ${counts.fileChange || 0} file cards`;
            })
            .join(" · ")
        : "";
      elements.jobStatus.innerHTML = [
        `<strong>${escapeHtml(phaseLabels[status.phase] || status.phase)}</strong>`,
        status.phase === "importer-started" ? `PowerShell PID ${escapeHtml(String(preflight.importerPid || ""))}` : "",
        status.phase === "complete" ? "Codex import finished." : "",
        status.phase === "failed" ? "Check the log tail below." : "",
        progressHtml,
        validationSummary ? `<span class="job-path">${escapeHtml(validationSummary)}</span>` : "",
        status.preflightPath ? `<span class="job-path">Preflight: ${escapeHtml(status.preflightPath)}</span>` : "",
        status.importLogPath ? `<span class="job-path">Importer: ${escapeHtml(status.importLogPath)}</span>` : "",
        status.logPath ? `<span class="job-path">Scheduler: ${escapeHtml(status.logPath)}</span>` : "",
        status.importLogTail ? `<pre class="job-log-tail">${escapeHtml(status.importLogTail.slice(-2000))}</pre>` : "",
        !status.importLogExists && status.phase === "importer-started" ? `<span class="job-path">Importer log has not appeared yet.</span>` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return;
    }
    if (job.preflightPending) {
      elements.jobStatus.innerHTML = [
        `<strong>${escapeHtml(String(job.count || 0))}</strong> import${job.count === 1 ? "" : "s"} queued for background preflight.`,
        `After validation the job stops Codex, imports the chats, and relaunches Codex.`,
        job.skipped?.length ? `${job.skipped.length} skipped as already imported.` : "",
        job.preflightPath ? `<span class="job-path">Preflight: ${escapeHtml(job.preflightPath)}</span>` : "",
        job.importLogPath ? `<span class="job-path">Importer: ${escapeHtml(job.importLogPath)}</span>` : "",
        job.logPath ? `<span class="job-path">${escapeHtml(job.logPath)}</span>` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return;
    }
    const validationSummary = job.validations?.length
      ? job.validations
          .map((item) => {
            const counts = item.validation?.itemCounts || {};
            const pieces = [
              `${item.turnCount || item.validation?.turnCount || 0} turns`,
              counts.mcpToolCall ? `${counts.mcpToolCall} tool cards` : null,
              counts.fileChange ? `${counts.fileChange} file cards` : null,
            ].filter(Boolean);
            return `${item.title || item.conversationId}: ${pieces.join(", ")}`;
          })
          .join(" · ")
      : "";
    elements.jobStatus.innerHTML = [
      `<strong>${escapeHtml(String(job.count || 0))}</strong> validated and queued for Codex import.`,
      `Codex will be stopped, imported, and relaunched by the job.`,
      job.skipped?.length ? `${job.skipped.length} skipped as already imported.` : "",
      validationSummary ? `<span class="job-path">${escapeHtml(validationSummary)}</span>` : "",
      job.preflightPath ? `<span class="job-path">Preflight: ${escapeHtml(job.preflightPath)}</span>` : "",
      job.importLogPath ? `<span class="job-path">Importer: ${escapeHtml(job.importLogPath)}</span>` : "",
      job.logPath ? `<span class="job-path">${escapeHtml(job.logPath)}</span>` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return;
  }
  elements.jobStatus.textContent = job.message || "Nothing queued.";
}

function stopJobPolling() {
  if (state.jobPollTimer) {
    clearInterval(state.jobPollTimer);
    state.jobPollTimer = null;
  }
}

function startJobPolling(job) {
  stopJobPolling();
  if (!job?.jobName) {
    return;
  }
  const poll = async () => {
    try {
      const status = await fetchJson(`/api/imports/job-status?job=${encodeURIComponent(job.jobName)}`);
      if (!state.lastJob || state.lastJob.jobName !== job.jobName) {
        stopJobPolling();
        return;
      }
      state.lastJob = {
        ...state.lastJob,
        jobStatus: status,
        preflightPending: !["complete", "failed"].includes(status.phase),
      };
      renderJobStatus();
      if (["complete", "failed"].includes(status.phase)) {
        stopJobPolling();
        state.projectConversationCache.clear();
        loadExports().catch(console.error);
      }
    } catch (error) {
      if (state.lastJob?.jobName === job.jobName) {
        state.lastJob = {
          ...state.lastJob,
          message: `Could not poll import job: ${error.message}`,
        };
        renderJobStatus();
      }
    }
  };
  poll();
  state.jobPollTimer = setInterval(poll, 2000);
}

function renderCodexProjectMover() {
  if (!elements.codexProjectSelect) return;
  if (!state.codexProjects.length) {
    elements.codexProjectSelect.innerHTML = `<option value="">No Codex projects found</option>`;
    elements.codexProjectSelect.disabled = true;
    elements.codexProjectStatus.textContent = "No Codex project paths were found in Codex state.";
    elements.previewCodexMoveButton.disabled = true;
    elements.scheduleCodexMoveButton.disabled = true;
  } else {
    elements.codexProjectSelect.disabled = false;
    elements.codexProjectSelect.innerHTML = state.codexProjects
      .map((project) => {
        const flags = [
          project.threadCount ? `${project.threadCount} threads` : "no threads",
          project.active ? "active" : null,
          project.pinned ? "pinned" : null,
          project.exists ? null : "missing",
        ]
          .filter(Boolean)
          .join(", ");
        return `<option value="${escapeHtml(project.path)}">${escapeHtml(project.label || project.path)} (${escapeHtml(flags)})</option>`;
      })
      .join("");
    elements.codexProjectSelect.value = state.selectedCodexProjectPath || state.codexProjects[0]?.path || "";
    state.selectedCodexProjectPath = elements.codexProjectSelect.value;
  }

  const project = selectedCodexProject();
  const destination = elements.codexMoveDestination.value.trim();
  const canRun = Boolean(project && destination);
  const previewBlocked = Boolean(
    state.codexMovePreview &&
      (state.codexMovePreview.newExists ||
        !state.codexMovePreview.oldExists ||
        (!state.codexMovePreview.threadCount && !state.codexMovePreview.globalStateChanged))
  );
  elements.previewCodexMoveButton.disabled = !canRun;
  elements.scheduleCodexMoveButton.disabled = !canRun || !state.codexMovePreview || previewBlocked;

  if (project) {
    const bits = [
      project.path,
      `${project.threadCount || 0} threads`,
      project.updatedAtIso ? `updated ${formatDate(project.updatedAtIso)}` : null,
      project.exists ? "folder exists" : "folder missing",
      project.sources?.length ? `sources: ${project.sources.join(", ")}` : null,
    ].filter(Boolean);
    elements.codexProjectStatus.textContent = bits.join(" · ");
  }

  if (!state.codexMoveJob && !state.codexMovePreview) {
    elements.codexMoveStatus.textContent = "No project move queued.";
    return;
  }
  if (state.codexMoveJob?.scheduled) {
    elements.codexMoveStatus.innerHTML = [
      "Project move queued.",
      "Close Codex to run it.",
      state.codexMoveJob.logPath ? `<span class="job-path">${escapeHtml(state.codexMoveJob.logPath)}</span>` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return;
  }
  if (state.codexMovePreview) {
    const preview = state.codexMovePreview;
    elements.codexMoveStatus.innerHTML = `
      <div class="move-stats">
        <span><strong>${escapeHtml(String(preview.threadCount || 0))}</strong> threads</span>
        <span><strong>${escapeHtml(String(preview.changedRolloutCount || 0))}</strong> rollout files</span>
        <span><strong>${preview.globalStateChanged ? "1" : "0"}</strong> global state</span>
        <span><strong>${preview.newExists ? "1" : "0"}</strong> conflicts</span>
      </div>
      <p>${preview.newExists ? "Destination already exists." : "Codex must be closed before moving."}</p>
    `;
  }
}

function renderAll() {
  renderExportSelect();
  renderProjectList();
  renderConversationList();
  renderConversationHeader();
  renderConversationBody();
  renderJobStatus();
  renderCodexProjectMover();
  elements.filterButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.filter === state.filter);
  });
  elements.sourceButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.source === state.sourceFilter);
  });
}

async function loadExports() {
  const data = await fetchJson("/api/exports");
  state.exports = data.exports || [];
  state.selectedExportId = state.selectedExportId || state.exports[0]?.id || null;
  if (!state.selectedExportId) {
    elements.exportSummary.textContent = "No exports found";
    return;
  }
  await loadIndex(state.selectedExportId);
}

async function loadCodexProjects() {
  const data = await fetchJson("/api/codex/projects");
  state.codexProjects = data.projects || [];
  if (!state.codexProjects.some((project) => project.path === state.selectedCodexProjectPath)) {
    state.selectedCodexProjectPath = state.codexProjects[0]?.path || "";
  }
  state.codexMovePreview = null;
  state.codexMoveJob = null;
  renderCodexProjectMover();
}

async function loadProjectConversations(exportId) {
  if (exportId === state.selectedExportId && state.conversations.length) {
    return state.conversations;
  }
  if (state.projectConversationCache.has(exportId)) {
    return state.projectConversationCache.get(exportId);
  }
  const data = await fetchJson(`/api/exports/${encodeURIComponent(exportId)}`);
  const conversations = data.conversations || [];
  state.projectConversationCache.set(exportId, conversations);
  return conversations;
}

async function loadIndex(exportId, options = {}) {
  const conversations = await loadProjectConversations(exportId);
  state.selectedExportId = exportId;
  state.conversations = conversations;
  state.projectConversationCache.set(exportId, conversations);
  if (options.selectProject) {
    selectProjectConversations(exportId, conversations);
  } else {
    syncProjectSelectionState(exportId);
  }
  state.selectedConversationId = state.conversations[0]?.id || null;
  state.selectedConversation = null;
  if (state.selectedConversationId) {
    await loadConversation(state.selectedConversationId);
  } else {
    renderAll();
  }
}

async function loadConversation(conversationId) {
  state.selectedConversationId = conversationId;
  state.showRaw = false;
  state.selectedConversation = await fetchJson(
    `/api/exports/${encodeURIComponent(state.selectedExportId)}/conversations/${encodeURIComponent(conversationId)}`
  );
  renderAll();
}

function itemForConversation(conversation) {
  if (isViewOnlyConversation(conversation)) {
    return null;
  }
  const targetCwd = targetCwdForExport(state.selectedExportId);
  return {
    exportId: state.selectedExportId,
    conversationId: conversation.id,
    title: titleFor(conversation),
    targetCwd,
  };
}

function selectedImportItems() {
  return [...state.selectedKeys]
    .map((key) => {
      const { exportId, conversationId } = splitConversationKey(key);
      if (isViewOnlyExport(exportId)) {
        return null;
      }
      const conversations = conversationsForProject(exportId) || [];
      const conversation = conversations.find((item) => item.id === conversationId);
      if (conversation && (isViewOnlyConversation(conversation, exportId) || isEmptyConversation(conversation))) {
        return null;
      }
      return {
        exportId,
        conversationId,
        title: conversation ? titleFor(conversation) : "",
        targetCwd: targetCwdForExport(exportId),
      };
    })
    .filter(Boolean);
}

async function scheduleImport(items) {
  if (!items.length) {
    state.lastJob = { scheduled: false, message: "No unimported conversations selected." };
    renderJobStatus();
    return;
  }
  elements.importSelectedButton.disabled = true;
  elements.importAllButton.disabled = true;
  elements.importProjectButton.disabled = true;
  elements.importCurrentButton.disabled = true;
  state.lastJob = { scheduled: false, message: `Queueing ${items.length} import${items.length === 1 ? "" : "s"} for direct Codex import...` };
  renderJobStatus();
  try {
    state.lastJob = await postJson("/api/imports/schedule", {
      items,
      skipImported: true,
      fastPreflight: true,
      validateImports: false,
    });
    startJobPolling(state.lastJob);
  } catch (error) {
    state.lastJob = { scheduled: false, message: `Import preflight failed: ${error.message}` };
    throw error;
  } finally {
    elements.importAllButton.disabled = false;
    renderAll();
  }
}

async function scheduleImportAll() {
  elements.importSelectedButton.disabled = true;
  elements.importAllButton.disabled = true;
  elements.importProjectButton.disabled = true;
  elements.importCurrentButton.disabled = true;
  state.lastJob = { scheduled: false, message: "Collecting every importable source chat..." };
  renderJobStatus();
  try {
    state.lastJob = await postJson("/api/imports/schedule-all", {
      skipImported: true,
      fastPreflight: true,
      validateImports: false,
    });
    startJobPolling(state.lastJob);
  } catch (error) {
    state.lastJob = { scheduled: false, message: `Import-all preflight failed: ${error.message}` };
    throw error;
  } finally {
    elements.importAllButton.disabled = false;
    renderAll();
  }
}

async function previewCodexProjectMove() {
  const project = selectedCodexProject();
  const newPath = elements.codexMoveDestination.value.trim();
  if (!project || !newPath) return;
  elements.previewCodexMoveButton.disabled = true;
  state.codexMoveJob = null;
  try {
    state.codexMovePreview = await postJson("/api/codex/projects/move/preview", {
      projectPath: project.path,
      newPath,
      moveFolder: true,
    });
  } finally {
    renderCodexProjectMover();
  }
}

async function scheduleCodexProjectMove() {
  const project = selectedCodexProject();
  const newPath = elements.codexMoveDestination.value.trim();
  if (!project || !newPath) return;
  elements.scheduleCodexMoveButton.disabled = true;
  state.codexMoveJob = await postJson("/api/codex/projects/move/schedule", {
    projectPath: project.path,
    newPath,
    moveFolder: true,
  });
  state.codexMovePreview = state.codexMoveJob.preview || state.codexMovePreview;
  renderCodexProjectMover();
}

async function refreshIndexPreservingSelection() {
  const selectedConversationId = state.selectedConversationId;
  state.projectConversationCache.delete(state.selectedExportId);
  await loadIndex(state.selectedExportId);
  if (selectedConversationId && state.conversations.some((conversation) => conversation.id === selectedConversationId)) {
    await loadConversation(selectedConversationId);
  }
}

elements.exportSelect.addEventListener("change", () => {
  loadIndex(elements.exportSelect.value, { selectProject: true }).catch(showFatalError);
});

elements.codexProjectSelect.addEventListener("change", () => {
  state.selectedCodexProjectPath = elements.codexProjectSelect.value;
  state.codexMovePreview = null;
  state.codexMoveJob = null;
  renderCodexProjectMover();
});

elements.codexMoveDestination.addEventListener("input", () => {
  state.codexMovePreview = null;
  state.codexMoveJob = null;
  renderCodexProjectMover();
});

elements.reloadCodexProjectsButton.addEventListener("click", () => {
  loadCodexProjects().catch(showFatalError);
});

elements.previewCodexMoveButton.addEventListener("click", () => {
  previewCodexProjectMove().catch(showFatalError);
});

elements.scheduleCodexMoveButton.addEventListener("click", () => {
  scheduleCodexProjectMove().catch(showFatalError);
});

elements.projectList.addEventListener("change", (event) => {
  const checkbox = event.target.closest(".project-check");
  if (!checkbox) return;
  const exportId = checkbox.dataset.id;
  const run = checkbox.checked
    ? loadIndex(exportId, { selectProject: true })
    : loadProjectConversations(exportId).then(() => {
        clearProjectSelection(exportId);
        return loadIndex(exportId);
      });
  run.catch(showFatalError);
});

elements.projectList.addEventListener("click", (event) => {
  if (event.target.closest(".project-check")) return;
  const row = event.target.closest(".project-row");
  if (!row) return;
  loadIndex(row.dataset.id).catch(showFatalError);
});

elements.searchInput.addEventListener("input", () => {
  state.query = elements.searchInput.value;
  renderConversationList();
});

elements.conversationList.addEventListener("change", (event) => {
  const checkbox = event.target.closest(".thread-check");
  if (!checkbox) return;
  const conversation = state.conversations.find((item) => item.id === checkbox.dataset.id);
  if (conversation && (isViewOnlyConversation(conversation) || isEmptyConversation(conversation))) {
    state.selectedKeys.delete(conversationKey(state.selectedExportId, checkbox.dataset.id));
    checkbox.checked = false;
    return;
  }
  const key = conversationKey(state.selectedExportId, checkbox.dataset.id);
  if (checkbox.checked) {
    state.selectedKeys.add(key);
  } else {
    state.selectedKeys.delete(key);
  }
  syncProjectSelectionState(state.selectedExportId);
  renderProjectList();
  renderConversationList();
});

elements.conversationList.addEventListener("click", (event) => {
  if (event.target.closest(".thread-check")) return;
  const row = event.target.closest(".thread-row");
  if (!row) return;
  loadConversation(row.dataset.id).catch(showFatalError);
});

elements.filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    renderAll();
  });
});

elements.sourceButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.sourceFilter = button.dataset.source;
    const visible = filteredExports();
    if (visible.length && !visible.some((entry) => entry.id === state.selectedExportId)) {
      loadIndex(visible[0].id).catch(showFatalError);
      return;
    }
    renderAll();
  });
});

elements.refreshButton.addEventListener("click", () => {
  refreshIndexPreservingSelection().catch(showFatalError);
});

elements.exportAllButton.addEventListener("click", async () => {
  elements.exportAllButton.disabled = true;
  try {
    const job = await postJson("/api/exports/refresh", {});
    state.lastJob = {
      type: "export",
      scheduled: true,
      count: "export",
      logPath: job.logPath,
      skipped: [],
    };
    renderJobStatus();
  } finally {
    elements.exportAllButton.disabled = false;
  }
});

elements.selectShownButton.addEventListener("click", () => {
  for (const conversation of filteredConversations()) {
    if (!isViewOnlyConversation(conversation) && !isImported(conversation) && !isEmptyConversation(conversation)) {
      state.selectedKeys.add(currentConversationKey(conversation));
    }
  }
  syncProjectSelectionState(state.selectedExportId);
  renderProjectList();
  renderConversationList();
});

elements.clearSelectionButton.addEventListener("click", () => {
  state.selectedKeys.clear();
  state.selectedProjectIds.clear();
  renderProjectList();
  renderConversationList();
});

elements.importSelectedButton.addEventListener("click", () => {
  scheduleImport(selectedImportItems()).catch(showFatalError);
});

elements.importAllButton.addEventListener("click", () => {
  scheduleImportAll().catch(showFatalError);
});

elements.importProjectButton.addEventListener("click", () => {
  const items = state.conversations
    .filter((conversation) => !isViewOnlyConversation(conversation) && !isImported(conversation) && !isEmptyConversation(conversation))
    .map(itemForConversation)
    .filter(Boolean);
  scheduleImport(items).catch(showFatalError);
});

elements.importCurrentButton.addEventListener("click", () => {
  if (!state.selectedConversation || isViewOnlyConversation(state.selectedConversation) || state.selectedConversation.importStatus?.imported) return;
  const record = state.selectedConversation.indexRecord || { id: state.selectedConversation.conversationId };
  scheduleImport([
    {
      exportId: state.selectedExportId,
      conversationId: state.selectedConversation.conversationId || record.id,
      title: titleFor(record),
      targetCwd: targetCwdForExport(state.selectedExportId),
    },
  ]).catch(showFatalError);
});

elements.copyIdButton.addEventListener("click", async () => {
  if (!state.selectedConversationId) return;
  await navigator.clipboard.writeText(state.selectedConversationId);
  elements.copyIdButton.textContent = "Copied";
  setTimeout(() => {
    elements.copyIdButton.textContent = "Copy ID";
  }, 1000);
});

elements.rawToggleButton.addEventListener("click", () => {
  state.showRaw = !state.showRaw;
  renderConversationHeader();
  renderConversationBody();
});

function showFatalError(error) {
  console.error(error);
  elements.conversationBody.innerHTML = `<div class="empty-state">Viewer error: ${escapeHtml(error.message)}</div>`;
}

Promise.all([loadExports(), loadCodexProjects()]).catch(showFatalError);
