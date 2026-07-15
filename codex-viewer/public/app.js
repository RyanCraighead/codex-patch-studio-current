const state = {
  view: "chats",
  summary: null,
  projects: [],
  threads: [],
  selectedProject: null,
  selectedThread: null,
  selectedDetail: null,
  projectQuery: "",
  threadQuery: "",
  projectSort: "recent",
  projectRenderLimit: 100,
  includeApprovals: false,
  includeSubagents: false,
  showReasoning: true,
  toolsExpanded: false,
  conversationRenderLimit: 40,
  conversationEventLimit: 240,
  focusMode: false,
  orchestratorOpen: false,
  orchestrationRuns: [],
  orchestrationSelection: new Set(),
  orchestrationPreview: null,
  patchStatus: null,
  patchJobs: [],
  selectedPatchJob: null,
  projectRequestController: null,
  threadRequestController: null,
  patchJobRequestId: 0,
  orchestrationLoading: false,
  patchLoading: false,
  lastRefreshAt: null,
};

const STORAGE_KEY = "codex-project-viewer:ui-v2";

const elements = {
  viewTabs: document.querySelectorAll("[data-view-target]"),
  chatView: document.querySelector("#chatView"),
  patchView: document.querySelector("#patchView"),
  connectionStatus: document.querySelector("#connectionStatus"),
  connectionStatusText: document.querySelector("#connectionStatusText"),
  shortcutsButton: document.querySelector("#shortcutsButton"),
  shortcutsDialog: document.querySelector("#shortcutsDialog"),
  shortcutsCloseButton: document.querySelector("#shortcutsCloseButton"),
  toastRegion: document.querySelector("#toastRegion"),
  summaryText: document.querySelector("#summaryText"),
  refreshButton: document.querySelector("#refreshButton"),
  orchestratorToggle: document.querySelector("#orchestratorToggle"),
  orchestratorClose: document.querySelector("#orchestratorClose"),
  orchestratorPanel: document.querySelector("#orchestratorPanel"),
  orchestrationTitle: document.querySelector("#orchestrationTitle"),
  orchestrationPrompt: document.querySelector("#orchestrationPrompt"),
  orchestrationStartTurns: document.querySelector("#orchestrationStartTurns"),
  orchestrationSelection: document.querySelector("#orchestrationSelection"),
  matchProjectsButton: document.querySelector("#matchProjectsButton"),
  previewOrchestrationButton: document.querySelector("#previewOrchestrationButton"),
  startOrchestrationButton: document.querySelector("#startOrchestrationButton"),
  selectVisibleProjectsButton: document.querySelector("#selectVisibleProjectsButton"),
  clearProjectSelectionButton: document.querySelector("#clearProjectSelectionButton"),
  orchestrationStatus: document.querySelector("#orchestrationStatus"),
  orchestrationRuns: document.querySelector("#orchestrationRuns"),
  orchestrationPreviewDialog: document.querySelector("#orchestrationPreviewDialog"),
  orchestrationPreviewBody: document.querySelector("#orchestrationPreviewBody"),
  orchestrationPreviewMeta: document.querySelector("#orchestrationPreviewMeta"),
  orchestrationPreviewClose: document.querySelector("#orchestrationPreviewClose"),
  orchestrationPreviewCancel: document.querySelector("#orchestrationPreviewCancel"),
  orchestrationPreviewConfirm: document.querySelector("#orchestrationPreviewConfirm"),
  projectSearch: document.querySelector("#projectSearch"),
  projectSearchClear: document.querySelector("#projectSearchClear"),
  projectSort: document.querySelector("#projectSort"),
  projectCountLabel: document.querySelector("#projectCountLabel"),
  threadSearch: document.querySelector("#threadSearch"),
  threadSearchClear: document.querySelector("#threadSearchClear"),
  threadCountLabel: document.querySelector("#threadCountLabel"),
  includeApprovals: document.querySelector("#includeApprovals"),
  includeSubagents: document.querySelector("#includeSubagents"),
  projectList: document.querySelector("#projectList"),
  threadList: document.querySelector("#threadList"),
  projectTitle: document.querySelector("#projectTitle"),
  projectPath: document.querySelector("#projectPath"),
  threadKicker: document.querySelector("#threadKicker"),
  threadTitle: document.querySelector("#threadTitle"),
  threadMeta: document.querySelector("#threadMeta"),
  conversationBody: document.querySelector("#conversationBody"),
  showReasoning: document.querySelector("#showReasoning"),
  conversationToolsToggle: document.querySelector("#conversationToolsToggle"),
  copyThreadButton: document.querySelector("#copyThreadButton"),
  focusModeButton: document.querySelector("#focusModeButton"),
  conversationTopButton: document.querySelector("#conversationTopButton"),
  conversationBottomButton: document.querySelector("#conversationBottomButton"),
  patchRefreshButton: document.querySelector("#patchRefreshButton"),
  patchResetButton: document.querySelector("#patchResetButton"),
  patchFeatureList: document.querySelector("#patchFeatureList"),
  patchFeatureCount: document.querySelector("#patchFeatureCount"),
  patchSelectAllButton: document.querySelector("#patchSelectAllButton"),
  patchDefaultsButton: document.querySelector("#patchDefaultsButton"),
  patchSelectNoneButton: document.querySelector("#patchSelectNoneButton"),
  patchLimit: document.querySelector("#patchLimit"),
  patchSourceMode: document.querySelector("#patchSourceMode"),
  patchManualFields: document.querySelector("#patchManualFields"),
  patchSourceAppDir: document.querySelector("#patchSourceAppDir"),
  patchSourceAsar: document.querySelector("#patchSourceAsar"),
  patchOutputRoot: document.querySelector("#patchOutputRoot"),
  patchShortcutName: document.querySelector("#patchShortcutName"),
  patchShortcutDir: document.querySelector("#patchShortcutDir"),
  patchKeepWork: document.querySelector("#patchKeepWork"),
  bundleOutputDirectory: document.querySelector("#bundleOutputDirectory"),
  bundleName: document.querySelector("#bundleName"),
  bundlePortableElectronProfile: document.querySelector("#bundlePortableElectronProfile"),
  bundleKeepWork: document.querySelector("#bundleKeepWork"),
  bundlePreviewButton: document.querySelector("#bundlePreviewButton"),
  bundleBuildButton: document.querySelector("#bundleBuildButton"),
  patchPreviewButton: document.querySelector("#patchPreviewButton"),
  patchBuildButton: document.querySelector("#patchBuildButton"),
  patchLaunchButton: document.querySelector("#patchLaunchButton"),
  patchStatusLine: document.querySelector("#patchStatusLine"),
  patchCurrentSummary: document.querySelector("#patchCurrentSummary"),
  patchCurrentConfig: document.querySelector("#patchCurrentConfig"),
  patchPreviewOutput: document.querySelector("#patchPreviewOutput"),
  copyPreviewButton: document.querySelector("#copyPreviewButton"),
  patchJobList: document.querySelector("#patchJobList"),
  patchJobCount: document.querySelector("#patchJobCount"),
  patchLogTitle: document.querySelector("#patchLogTitle"),
  patchLogMeta: document.querySelector("#patchLogMeta"),
  patchLogOutput: document.querySelector("#patchLogOutput"),
  copyLogButton: document.querySelector("#copyLogButton"),
};

async function fetchJson(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return response.json();
}

function readPreferences() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function savePreferences() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        view: state.view,
        selectedProjectId: state.selectedProject?.id || null,
        selectedThreadId: state.selectedThread?.id || null,
        includeApprovals: state.includeApprovals,
        includeSubagents: state.includeSubagents,
        projectSort: state.projectSort,
        showReasoning: state.showReasoning,
        focusMode: state.focusMode,
      })
    );
  } catch {
    // Storage can be unavailable in hardened browser profiles; the app still works in-memory.
  }
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function setConnectionState(stateName, label) {
  elements.connectionStatus.className = `connection-status is-${stateName}`;
  elements.connectionStatusText.textContent = label;
}

function notify(message, tone = "info") {
  const toast = document.createElement("div");
  toast.className = `toast is-${tone}`;
  toast.textContent = message;
  elements.toastRegion.append(toast);
  window.setTimeout(() => toast.classList.add("is-visible"), 10);
  window.setTimeout(() => {
    toast.classList.remove("is-visible");
    window.setTimeout(() => toast.remove(), 180);
  }, 2800);
}

async function copyText(text, successMessage) {
  const value = String(text || "");
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const helper = document.createElement("textarea");
    helper.value = value;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.append(helper);
    helper.select();
    document.execCommand("copy");
    helper.remove();
  }
  notify(successMessage || "Copied to clipboard", "success");
}

function setButtonBusy(button, busy, busyLabel) {
  if (!button) return;
  if (busy) {
    button.dataset.idleLabel = button.textContent.trim();
    if (busyLabel) button.textContent = busyLabel;
  } else if (button.dataset.idleLabel) {
    button.textContent = button.dataset.idleLabel;
    delete button.dataset.idleLabel;
  }
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
  if (!value) return "Unknown";
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

function compact(value, limit = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function boundedText(value, limit = 100000) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  const headLength = Math.floor(limit * 0.78);
  const tailLength = limit - headLength;
  return `${text.slice(0, headLength)}\n\n… ${text.length - limit} characters omitted for responsive display …\n\n${text.slice(-tailLength)}`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function statsBadges(stats) {
  const values = [];
  values.push(`<span class="badge good">${stats.userMessageCount || 0} user</span>`);
  values.push(`<span class="badge">${stats.assistantMessageCount || 0} assistant</span>`);
  values.push(`<span class="badge">${stats.toolCallCount || 0} tools</span>`);
  values.push(`<span class="badge">${stats.patchDiffCount || 0} diffs</span>`);
  if (stats.reasoningCount) values.push(`<span class="badge warn">${stats.reasoningCount} thoughts</span>`);
  if (!stats.exists) values.push(`<span class="badge bad">missing rollout</span>`);
  return values.join("");
}

function filteredProjects() {
  const query = state.projectQuery.trim().toLowerCase();
  const projects = state.projects.filter((project) => {
    if (!query) return true;
    return [project.label, project.path, project.sources.join(" ")].some((value) => String(value || "").toLowerCase().includes(query));
  });
  return projects.sort((left, right) => {
    if (state.projectSort === "name") {
      return String(left.label || "").localeCompare(String(right.label || ""), undefined, { sensitivity: "base" });
    }
    if (state.projectSort === "chats") {
      return (right.chatCount || 0) - (left.chatCount || 0) || String(left.label || "").localeCompare(String(right.label || ""));
    }
    if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
    return new Date(right.updatedAtIso || 0).getTime() - new Date(left.updatedAtIso || 0).getTime();
  });
}

function visibleProjects() {
  const allProjects = filteredProjects();
  let projects = allProjects.slice(0, state.projectRenderLimit);
  const selectedInResults = state.selectedProject && allProjects.find((project) => project.id === state.selectedProject.id);
  if (selectedInResults && !projects.some((project) => project.id === selectedInResults.id)) {
    projects = [selectedInResults, ...projects.slice(0, Math.max(0, state.projectRenderLimit - 1))];
  }
  return projects;
}

function filteredThreads() {
  const query = state.threadQuery.toLowerCase();
  return state.threads.filter((thread) => {
    if (!query) return true;
    return [thread.title, thread.preview, thread.id, thread.rolloutPath].some((value) => String(value || "").toLowerCase().includes(query));
  });
}

function renderSummary() {
  if (!state.summary) {
    elements.summaryText.textContent = "Loading Codex state";
    return;
  }
  elements.summaryText.textContent = `${state.summary.projectCount.toLocaleString()} projects · ${state.summary.chatCount.toLocaleString()} chats`;
}

function selectedOrchestrationProjects() {
  return state.projects.filter((project) => state.orchestrationSelection.has(project.id));
}

function runStatusCounts(run) {
  return (run.children || []).reduce((counts, child) => {
    counts[child.status || "unknown"] = (counts[child.status || "unknown"] || 0) + 1;
    return counts;
  }, {});
}

function renderOrchestrator() {
  const selected = selectedOrchestrationProjects();
  const hasText = Boolean(`${elements.orchestrationTitle.value} ${elements.orchestrationPrompt.value}`.trim());
  elements.orchestrationSelection.textContent = `${selected.length} selected`;
  elements.startOrchestrationButton.disabled = selected.length === 0 || !elements.orchestrationPrompt.value.trim();
  elements.previewOrchestrationButton.disabled = selected.length === 0 || !elements.orchestrationPrompt.value.trim();
  elements.matchProjectsButton.disabled = !hasText;
  elements.clearProjectSelectionButton.disabled = selected.length === 0;
  elements.selectVisibleProjectsButton.disabled = visibleProjects().length === 0;

  if (!state.orchestrationRuns.length) {
    elements.orchestrationRuns.innerHTML = `<div class="empty-mini">No orchestration runs yet.</div>`;
    return;
  }

  elements.orchestrationRuns.innerHTML = state.orchestrationRuns
    .slice(0, 6)
    .map((run) => {
      const counts = runStatusCounts(run);
      const childLinks = (run.children || [])
        .filter((child) => child.threadId)
        .slice(0, 8)
        .map(
          (child) => `
            <button class="thread-chip" type="button" data-project-id="${escapeHtml(child.projectId)}" data-thread-id="${escapeHtml(child.threadId)}">
              ${escapeHtml(child.projectLabel)}
            </button>
          `
        )
        .join("");
      return `
        <article class="run-card">
          <div class="run-head">
            <span>${escapeHtml(run.title)}</span>
            <span>${escapeHtml(run.status)}</span>
          </div>
          <div class="row-meta">${formatDate(run.createdAt)} · ${(run.children || []).length} child chats</div>
          <div class="badge-row">
            ${Object.entries(counts)
              .map(([status, count]) => `<span class="badge">${escapeHtml(status)} ${count}</span>`)
              .join("")}
          </div>
          ${childLinks ? `<div class="thread-chip-row">${childLinks}</div>` : ""}
        </article>
      `;
    })
    .join("");
}

function showView(view) {
  if (!['chats', 'patches'].includes(view)) view = "chats";
  state.view = view;
  elements.viewTabs.forEach((tab) => {
    const active = tab.dataset.viewTarget === view;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-pressed", String(active));
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  elements.chatView.classList.toggle("is-active", view === "chats");
  elements.patchView.classList.toggle("is-active", view === "patches");
  elements.chatView.setAttribute("aria-hidden", String(view !== "chats"));
  elements.patchView.setAttribute("aria-hidden", String(view !== "patches"));
  history.replaceState(null, "", `#${view}`);
  savePreferences();
  if (view === "patches") {
    loadPatchStatus().catch((error) => {
      elements.patchStatusLine.textContent = error.message;
    });
  }
}

function setOrchestratorOpen(open, options = {}) {
  state.orchestratorOpen = Boolean(open);
  elements.orchestratorPanel.classList.toggle("is-open", state.orchestratorOpen);
  elements.orchestratorPanel.setAttribute("aria-hidden", String(!state.orchestratorOpen));
  elements.orchestratorToggle.setAttribute("aria-expanded", String(state.orchestratorOpen));
  document.querySelector(".projects")?.classList.toggle("is-orchestrating", state.orchestratorOpen);
  if (state.orchestratorOpen && options.focus !== false) {
    window.setTimeout(() => elements.orchestrationTitle.focus(), 160);
  }
}

function setFocusMode(enabled) {
  state.focusMode = Boolean(enabled) && Boolean(state.selectedDetail);
  elements.chatView.classList.toggle("is-focus-mode", state.focusMode);
  elements.focusModeButton.setAttribute("aria-pressed", String(state.focusMode));
  elements.focusModeButton.querySelector("span").textContent = state.focusMode ? "Exit focus" : "Focus";
  savePreferences();
}

function patchFeatureDefinitions() {
  return state.patchStatus?.features || [];
}

function patchDefaults() {
  return state.patchStatus?.defaults || {};
}

function bundleDefaults() {
  return state.patchStatus?.bundleDefaults || {};
}

function applyPatchDefaults() {
  const defaults = patchDefaults();
  if (!defaults || !Object.keys(defaults).length) return;
  elements.patchLimit.value = defaults.limit || 1000;
  elements.patchSourceMode.value = defaults.sourceMode || "current";
  elements.patchSourceAppDir.value = defaults.sourceAppDir || "";
  elements.patchSourceAsar.value = defaults.sourceAsar || "";
  elements.patchOutputRoot.value = defaults.outputRoot || "";
  elements.patchShortcutName.value = defaults.shortcutName || "Codex Patch Studio Current";
  elements.patchShortcutDir.value = defaults.shortcutDir || "";
  elements.patchKeepWork.checked = Boolean(defaults.keepWork);

  const bundle = bundleDefaults();
  elements.bundleOutputDirectory.value = bundle.outputDirectory || "";
  elements.bundleName.value = bundle.bundleName || "";
  elements.bundlePortableElectronProfile.checked = Boolean(bundle.portableElectronProfile);
  elements.bundleKeepWork.checked = Boolean(bundle.keepWork);
  syncPatchSourceFields();
}

function syncPatchSourceFields() {
  const manual = elements.patchSourceMode.value === "manual";
  elements.patchManualFields.hidden = !manual;
  elements.patchSourceAppDir.disabled = !manual;
  elements.patchSourceAsar.disabled = !manual;
}

function renderPatchFeatureCount() {
  const inputs = [...elements.patchFeatureList.querySelectorAll("[data-patch-feature]")];
  const selected = inputs.filter((input) => input.checked).length;
  elements.patchFeatureCount.textContent = `${selected} of ${inputs.length} enabled`;
}

function renderPatchFeatures() {
  const features = patchFeatureDefinitions();
  const defaults = patchDefaults();
  if (!features.length) {
    elements.patchFeatureList.innerHTML = `<div class="empty-mini">Patch features are loading.</div>`;
    return;
  }
  elements.patchFeatureList.innerHTML = features
    .map((feature) => {
      const checked = (defaults.features?.[feature.id] ?? feature.defaultEnabled) !== false ? " checked" : "";
      return `
        <label class="patch-feature">
          <input type="checkbox" data-patch-feature="${escapeHtml(feature.id)}"${checked}>
          <span>
            <strong>${escapeHtml(feature.label)}</strong>
            <small>${escapeHtml(feature.description)}</small>
          </span>
        </label>
      `;
    })
    .join("");
  renderPatchFeatureCount();
}

function setPatchFeatureSelection(mode) {
  const defaults = patchDefaults().features || {};
  elements.patchFeatureList.querySelectorAll("[data-patch-feature]").forEach((input) => {
    if (mode === "all") input.checked = true;
    if (mode === "none") input.checked = false;
    if (mode === "defaults") {
      const definition = patchFeatureDefinitions().find((feature) => feature.id === input.dataset.patchFeature);
      input.checked = (defaults[input.dataset.patchFeature] ?? definition?.defaultEnabled) !== false;
    }
  });
  renderPatchFeatureCount();
  updatePatchActionState();
}

function patchPayload() {
  const features = {};
  elements.patchFeatureList.querySelectorAll("[data-patch-feature]").forEach((input) => {
    features[input.dataset.patchFeature] = input.checked;
  });
  return {
    limit: Number(elements.patchLimit.value || 1000),
    sourceMode: elements.patchSourceMode.value,
    sourceAppDir: elements.patchSourceAppDir.value.trim(),
    sourceAsar: elements.patchSourceAsar.value.trim(),
    outputRoot: elements.patchOutputRoot.value.trim(),
    shortcutName: elements.patchShortcutName.value.trim(),
    shortcutDir: elements.patchShortcutDir.value.trim(),
    keepWork: elements.patchKeepWork.checked,
    features,
  };
}

function bundlePayload() {
  const defaults = bundleDefaults();
  return {
    configPath: defaults.configPath || "",
    outputDirectory: elements.bundleOutputDirectory.value.trim(),
    bundleName: elements.bundleName.value.trim(),
    portableElectronProfile: elements.bundlePortableElectronProfile.checked,
    keepWork: elements.bundleKeepWork.checked,
  };
}

function featureBadges(features = {}) {
  return Object.entries(features)
    .filter(([, enabled]) => enabled)
    .map(([key]) => `<span class="badge good">${escapeHtml(key)}</span>`)
    .join("");
}

function renderPatchCurrent() {
  const config = state.patchStatus?.launcherConfig;
  if (!config) {
    elements.patchCurrentSummary.textContent = "No launcher config found yet.";
    elements.patchCurrentConfig.innerHTML = `<div class="empty-state">Build a patch to create codex-launcher.local.json.</div>`;
    updatePatchActionState();
    return;
  }
  elements.patchCurrentSummary.textContent = `${config.codexExe || "No desktop executable"} · built ${formatDate(config.builtAt)}`;
  elements.patchCurrentConfig.innerHTML = `
    <div class="patch-info-grid">
      <span>Desktop executable</span><strong>${escapeHtml(config.codexExe || "")}</strong>
      <span>Clone root</span><strong>${escapeHtml(config.cloneRoot || "")}</strong>
      <span>Source</span><strong>${escapeHtml(config.sourcePackageDirName || config.sourceAppDir || "")}</strong>
      <span>Limit</span><strong>${escapeHtml(config.limit || "")}</strong>
      <span>Shortcut</span><strong>${escapeHtml(config.shortcutPath || "Not configured")}</strong>
    </div>
    <div class="badge-row patch-feature-badges">${featureBadges(config.features || {})}</div>
  `;
  updatePatchActionState();
}

function renderPatchJobs() {
  elements.patchJobCount.textContent = plural(state.patchJobs.length, "job");
  if (!state.patchJobs.length) {
    elements.patchJobList.innerHTML = `<div class="empty-state">No patch jobs yet.</div>`;
    return;
  }
  elements.patchJobList.innerHTML = state.patchJobs
    .slice(0, 16)
    .map((job) => {
      const active = state.selectedPatchJob?.id === job.id ? " is-active" : "";
      const statusClass = job.status === "completed" ? "good" : job.status === "failed" ? "bad" : "warn";
      const isBundle = job.type === "bundle";
      const detailBadge = isBundle
        ? `<span class="badge">single exe</span>`
        : `<span class="badge">limit ${escapeHtml(job.options?.limit || "")}</span>`;
      const resultBadge =
        isBundle && job.result?.outputSizeMB
          ? `<span class="badge good">${escapeHtml(job.result.outputSizeMB)} MB</span>`
          : "";
      return `
        <button class="patch-job${active}" type="button" data-patch-job-id="${escapeHtml(job.id)}">
          <span class="row-title">${escapeHtml(job.id)}</span>
          <span class="row-meta">${formatDate(job.createdAt)} · PID ${escapeHtml(job.pid || "done")}</span>
          <span class="badge-row">
            <span class="badge ${statusClass}">${escapeHtml(job.status)}</span>
            ${detailBadge}
            ${resultBadge}
            ${isBundle ? "" : featureBadges(job.options?.features || {})}
          </span>
        </button>
      `;
    })
    .join("");
}

function renderPatchLog(job) {
  if (!job) {
    elements.patchLogTitle.textContent = "Job Log";
    elements.patchLogMeta.textContent = "Select or start a patch job to view logs.";
    elements.patchLogOutput.textContent = "No patch job selected.";
    elements.copyLogButton.disabled = true;
    return;
  }
  elements.patchLogTitle.textContent = job.id;
  const output = job.type === "bundle" && job.result?.outputExe ? ` · ${job.result.outputExe}` : "";
  elements.patchLogMeta.textContent = `${job.status} · ${job.logPath || ""}${output}`;
  elements.patchLogOutput.textContent = job.logTail || job.error || "Waiting for log output.";
  elements.copyLogButton.disabled = !elements.patchLogOutput.textContent.trim();
}

function validatePatchPayload(payload = patchPayload()) {
  if (!Number.isFinite(payload.limit) || payload.limit < 50 || payload.limit > 10000) {
    return "Chat load limit must be between 50 and 10,000.";
  }
  if (payload.sourceMode === "manual" && !payload.sourceAppDir) {
    return "Choose a source app directory for a manual build.";
  }
  if (!payload.outputRoot) return "Choose an output root for the patched build.";
  if (!Object.values(payload.features).some(Boolean)) return "Enable at least one patch feature.";
  return "";
}

function updatePatchActionState() {
  const hasLauncher = Boolean(state.patchStatus?.launcherConfig);
  const patchError = validatePatchPayload();
  const hasRunningJob = state.patchJobs.some((job) => job.status === "running");
  elements.patchPreviewButton.disabled = Boolean(patchError) || hasRunningJob;
  elements.patchBuildButton.disabled = Boolean(patchError) || hasRunningJob;
  elements.patchLaunchButton.disabled = !hasLauncher || hasRunningJob;
  elements.bundlePreviewButton.disabled = !hasLauncher || hasRunningJob;
  elements.bundleBuildButton.disabled = !hasLauncher || hasRunningJob;
  elements.patchBuildButton.title = patchError || (hasRunningJob ? "Wait for the running build to finish" : "");
  elements.bundleBuildButton.title = !hasLauncher ? "Build a patched Codex launcher first" : "";
}

async function loadPatchStatus() {
  if (state.patchLoading) return;
  state.patchLoading = true;
  try {
  const [status, jobsData] = await Promise.all([
    fetchJson("/api/patch/status"),
    fetchJson("/api/patch/jobs"),
  ]);
  const hadStatus = Boolean(state.patchStatus);
  state.patchStatus = status;
  state.patchJobs = jobsData.jobs || [];
  if (!hadStatus) {
    applyPatchDefaults();
    renderPatchFeatures();
  }
  renderPatchCurrent();
  renderPatchJobs();
  if (state.selectedPatchJob) {
    const same = state.patchJobs.find((job) => job.id === state.selectedPatchJob.id);
    if (same) await selectPatchJob(same.id, { quiet: true });
  }
  } finally {
    state.patchLoading = false;
  }
}

async function previewPatchBuild() {
  const validationError = validatePatchPayload();
  if (validationError) throw new Error(validationError);
  elements.patchStatusLine.textContent = "Building patch preview";
  const preview = await postJson("/api/patch/preview", patchPayload());
  elements.patchPreviewOutput.textContent = preview.command.join(" ");
  elements.copyPreviewButton.disabled = false;
  elements.patchStatusLine.textContent = `${preview.selectedFeatures.length} features selected.`;
}

async function previewBundleBuild() {
  if (!state.patchStatus?.launcherConfig) throw new Error("Build a patched Codex launcher before creating a bundle.");
  elements.patchStatusLine.textContent = "Building single-exe preview";
  const preview = await postJson("/api/patch/bundle/preview", bundlePayload());
  elements.patchPreviewOutput.textContent = preview.command.join(" ");
  elements.copyPreviewButton.disabled = false;
  elements.patchStatusLine.textContent = "Single-exe bundle preview ready.";
}

async function startPatchBuild() {
  const validationError = validatePatchPayload();
  if (validationError) throw new Error(validationError);
  if (!window.confirm("Start a patched Codex build with the current configuration?")) return;
  setButtonBusy(elements.patchBuildButton, true, "Starting…");
  elements.patchStatusLine.textContent = "Starting patch build";
  const job = await postJson("/api/patch/build", patchPayload());
  state.selectedPatchJob = job;
  elements.patchStatusLine.textContent = `Patch job started: ${job.id}`;
  await loadPatchStatus();
  await selectPatchJob(job.id);
  setButtonBusy(elements.patchBuildButton, false);
}

async function startBundleBuild() {
  if (!state.patchStatus?.launcherConfig) throw new Error("Build a patched Codex launcher before creating a bundle.");
  if (!window.confirm("Build a single EXE bundle from the current patched Codex?")) return;
  setButtonBusy(elements.bundleBuildButton, true, "Starting…");
  elements.patchStatusLine.textContent = "Starting single-exe bundle build";
  const job = await postJson("/api/patch/bundle/build", bundlePayload());
  state.selectedPatchJob = job;
  elements.patchStatusLine.textContent = `Bundle job started: ${job.id}`;
  await loadPatchStatus();
  await selectPatchJob(job.id);
  setButtonBusy(elements.bundleBuildButton, false);
}

async function launchPatchedCodex() {
  if (!state.patchStatus?.launcherConfig) throw new Error("No patched Codex launcher is configured yet.");
  if (!window.confirm("Launch the current patched Codex build?")) return;
  elements.patchStatusLine.textContent = "Launching current patched Codex";
  const result = await postJson("/api/patch/launch", {});
  elements.patchStatusLine.textContent = `Launch requested. PID ${result.pid || "unknown"}.`;
}

async function selectPatchJob(jobId, options = {}) {
  const requestId = ++state.patchJobRequestId;
  const job = await fetchJson(`/api/patch/jobs/${encodeURIComponent(jobId)}`);
  if (requestId !== state.patchJobRequestId) return;
  state.selectedPatchJob = job;
  renderPatchJobs();
  renderPatchLog(job);
  if (!options.quiet) {
    elements.patchStatusLine.textContent = `Selected ${job.id}`;
  }
}

function renderProjects() {
  const allProjects = filteredProjects();
  const projects = visibleProjects();
  elements.projectCountLabel.textContent = allProjects.length > projects.length
    ? `${projects.length.toLocaleString()} of ${allProjects.length.toLocaleString()}`
    : plural(allProjects.length, "project");
  elements.projectSearchClear.hidden = !state.projectQuery;
  if (!allProjects.length) {
    elements.projectList.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon" aria-hidden="true">⌕</span>
        <strong>No matching projects</strong>
        <span>Try a project name, path, or source.</span>
      </div>
    `;
    renderOrchestrator();
    return;
  }
  elements.projectList.innerHTML = projects
    .map((project) => {
      const active = state.selectedProject?.id === project.id ? " is-active" : "";
      const selected = state.orchestrationSelection.has(project.id) ? " checked" : "";
      const updated = formatDate(project.updatedAtIso);
      return `
        <article class="project-row${active}" role="listitem" data-project-row-id="${escapeHtml(project.id)}">
          <input class="project-orchestration-check" type="checkbox" data-project-id="${escapeHtml(project.id)}" aria-label="Select ${escapeHtml(project.label)} for orchestration" title="Select for orchestration"${selected}>
          <button class="project-open-button" type="button" data-project-open-id="${escapeHtml(project.id)}" aria-current="${active ? "true" : "false"}">
            <span class="project-title-line">
              <span class="row-title">${escapeHtml(project.label)}</span>
              ${project.pinned ? `<span class="pin-mark" aria-label="Pinned" title="Pinned">◆</span>` : ""}
              ${project.exists ? "" : `<span class="status-mark is-error">Missing</span>`}
            </span>
            <span class="row-path" title="${escapeHtml(project.path)}">${escapeHtml(project.path)}</span>
            <span class="row-meta">${plural(project.chatCount, "chat")} · ${plural(project.subagentCount, "subagent")} · ${plural(project.approvalCount, "approval")}</span>
            <span class="row-updated">${escapeHtml(updated)}</span>
          </button>
        </article>
      `;
    })
    .join("") + (allProjects.length > projects.length
      ? `<button class="show-more-button" type="button" data-show-more-projects>Show ${Math.min(100, allProjects.length - projects.length)} more projects</button>`
      : "");
  renderOrchestrator();
}

function renderProjectHeader() {
  if (!state.selectedProject) {
    elements.projectTitle.textContent = "Select a project";
    elements.projectPath.textContent = "No project selected";
    return;
  }
  elements.projectTitle.textContent = state.selectedProject.label;
  elements.projectPath.textContent = `${state.selectedProject.path} · ${state.selectedProject.chatCount} chats · ${state.selectedProject.subagentCount} subagents · ${state.selectedProject.approvalCount} approvals`;
}

function renderThreads() {
  renderProjectHeader();
  elements.threadSearchClear.hidden = !state.threadQuery;
  if (!state.selectedProject) {
    elements.threadCountLabel.textContent = "0 conversations";
    elements.threadList.innerHTML = `<div class="empty-state"><span class="empty-icon" aria-hidden="true">⌁</span><strong>Select a project</strong><span>Its conversations will appear here.</span></div>`;
    return;
  }
  const threads = filteredThreads();
  elements.threadCountLabel.textContent = plural(threads.length, "conversation");
  if (!threads.length) {
    elements.threadList.innerHTML = `<div class="empty-state"><span class="empty-icon" aria-hidden="true">⌕</span><strong>No matching conversations</strong><span>Clear the search or include more thread types.</span></div>`;
    return;
  }
  elements.threadList.innerHTML = threads
    .map((thread) => {
      const active = state.selectedThread?.id === thread.id ? " is-active" : "";
      const kindClass = thread.kind === "chat" ? " good" : " warn";
      return `
        <button class="thread-row${active}" type="button" role="listitem" data-thread-id="${escapeHtml(thread.id)}" aria-current="${active ? "true" : "false"}">
          <span class="thread-title-line">
            <span class="row-title">${escapeHtml(thread.title)}</span>
            <span class="thread-kind${kindClass}">${escapeHtml(thread.kind)}</span>
          </span>
          <span class="row-meta">${formatDate(thread.updatedAtIso)}</span>
          <span class="row-preview">${escapeHtml(compact(thread.preview, 220))}</span>
          <span class="thread-metrics">
            <span>${(thread.stats.userMessageCount || 0) + (thread.stats.assistantMessageCount || 0)} messages</span>
            <span>${thread.stats.toolCallCount || 0} tools</span>
            <span>${thread.stats.patchDiffCount || 0} diffs</span>
            ${thread.stats.partial ? `<span class="status-mark is-warning" title="Statistics are a bounded lower estimate">Partial stats</span>` : ""}
            ${thread.stats.exists ? "" : `<span class="status-mark is-error">Missing rollout</span>`}
          </span>
        </button>
      `;
    })
    .join("");
}

function renderThreadHeader() {
  const detail = state.selectedDetail;
  if (!detail) {
    elements.threadKicker.textContent = "No chat selected";
    elements.threadTitle.textContent = "Select a Codex chat";
    elements.threadMeta.textContent = "The viewer reads Codex project records and rollout logs locally.";
    updateConversationControls();
    return;
  }
  const thread = detail.thread;
  elements.threadKicker.textContent = `${thread.kind} · ${formatDate(thread.updatedAtIso)}`;
  elements.threadTitle.textContent = thread.title;
  elements.threadMeta.textContent = `${thread.cwd} · ${thread.stats.lineCount} rollout records · ${thread.stats.toolCallCount} tools · ${thread.stats.patchDiffCount} diffs · ${thread.rolloutPath || "no rollout path"}`;
  updateConversationControls();
}

function updateConversationControls() {
  const hasDetail = Boolean(state.selectedDetail);
  elements.conversationToolsToggle.disabled = !hasDetail;
  elements.copyThreadButton.disabled = !hasDetail;
  elements.focusModeButton.disabled = !hasDetail;
  elements.conversationTopButton.disabled = !hasDetail;
  elements.conversationBottomButton.disabled = !hasDetail;
  elements.conversationToolsToggle.textContent = state.toolsExpanded ? "Collapse tools" : "Expand tools";
  if (!hasDetail && state.focusMode) setFocusMode(false);
}

function renderPre(text) {
  return `<pre>${escapeHtml(boundedText(text, 80000))}</pre>`;
}

function renderMessage(kind, label, timestamp, text) {
  return `
    <article class="message ${kind}">
      <div class="block-head"><span>${escapeHtml(label)}</span><span>${formatDate(timestamp)}</span></div>
      <div class="message-content">${escapeHtml(boundedText(text, 100000))}</div>
    </article>
  `;
}

function renderThinking(event) {
  const encrypted = event.encryptedBytes ? `Encrypted payload: ${event.encryptedBytes.toLocaleString()} bytes` : "";
  const text = [event.text, encrypted].filter(Boolean).join("\n\n");
  return `
    <article class="event-card thinking">
      <div class="block-head"><span>Thinking</span><span>${formatDate(event.timestamp)}</span></div>
      ${renderPre(text || "Reasoning block with no visible summary.")}
    </article>
  `;
}

function diffText(diff) {
  if (diff.unifiedDiff) return diff.unifiedDiff;
  if (diff.changeKind === "created") {
    return String(diff.afterText || "")
      .split(/\r?\n/)
      .map((line) => `+${line}`)
      .join("\n");
  }
  if (diff.changeKind === "deleted") {
    return String(diff.beforeText || "")
      .split(/\r?\n/)
      .map((line) => `-${line}`)
      .join("\n");
  }
  return [
    "--- before",
    diff.beforeText || "",
    "+++ after",
    diff.afterText || "",
  ].join("\n");
}

function renderDiff(diff) {
  const lines = boundedText(diffText(diff), 100000)
    .split(/\r?\n/)
    .map((line) => {
      let cls = "diff-meta";
      if (line.startsWith("+") && !line.startsWith("+++")) cls = "diff-add";
      if (line.startsWith("-") && !line.startsWith("---")) cls = "diff-remove";
      return `<span class="${cls}">${escapeHtml(line)}</span>`;
    })
    .join("\n");
  return `
    <div class="diff">
      <div class="diff-title">
        <span>${escapeHtml(diff.changeKind)} · ${escapeHtml(diff.path)}</span>
        <span>+${diff.totalAddedLines || 0} -${diff.totalRemovedLines || 0}</span>
      </div>
      <pre>${lines}</pre>
    </div>
  `;
}

function renderTool(event) {
  const tool = event.tool;
  const statusClass = tool.isError ? "bad" : tool.hasResult ? "good" : "warn";
  return `
    <article class="tool-card">
      <details${state.toolsExpanded ? " open" : ""}>
        <summary class="tool-summary">
          <span>${escapeHtml(tool.name)}${tool.inputSummary ? ` · ${escapeHtml(tool.inputSummary)}` : ""}</span>
          <span class="${statusClass}">${escapeHtml(tool.phase || "called")}</span>
        </summary>
        <div class="tool-body">
          <div class="tool-section">
            <div class="section-label">Input</div>
            ${renderPre(tool.inputJson)}
          </div>
          ${tool.output ? `
            <div class="tool-section">
              <div class="section-label">Output</div>
              ${renderPre(tool.output)}
            </div>
          ` : ""}
          ${(tool.diffs || []).map(renderDiff).join("")}
        </div>
      </details>
    </article>
  `;
}

function renderConversation() {
  renderThreadHeader();
  const detail = state.selectedDetail;
  if (!detail) {
    elements.conversationBody.innerHTML = `<div class="empty-state"><span class="empty-icon" aria-hidden="true">⌁</span><strong>Choose a conversation</strong><span>Pick a project and chat to inspect messages, reasoning, tool calls, outputs, and saved patch diffs.</span></div>`;
    return;
  }
  const truncationNotice = (detail.metadata?.truncated || detail.metadata?.partial)
    ? `<div class="notice-strip is-warning">Showing a bounded portion of this unusually large rollout. Older records were omitted to keep the viewer responsive.</div>`
    : "";
  if (!detail.exchanges.length) {
    elements.conversationBody.innerHTML = `${truncationNotice}<div class="empty-state"><span class="empty-icon" aria-hidden="true">∅</span><strong>No visible exchanges</strong><span>This rollout does not contain a displayable conversation.</span></div>`;
    return;
  }
  const startIndex = Math.max(0, detail.exchanges.length - state.conversationRenderLimit);
  const visibleExchanges = detail.exchanges.slice(startIndex);
  const totalVisibleEvents = visibleExchanges.reduce((sum, exchange) => sum + exchange.events.length, 0);
  let eventsToSkip = Math.max(0, totalVisibleEvents - state.conversationEventLimit);
  const earlierControl = startIndex > 0
    ? `<button class="show-more-button transcript-more" type="button" data-load-earlier-exchanges>Load ${Math.min(40, startIndex)} earlier exchanges</button>`
    : "";
  const earlierEventsControl = eventsToSkip > 0
    ? `<button class="show-more-button transcript-more" type="button" data-load-earlier-events>Load ${Math.min(240, eventsToSkip)} earlier events</button>`
    : "";
  elements.conversationBody.innerHTML = truncationNotice + earlierControl + earlierEventsControl + visibleExchanges
    .map((exchange, index) => {
      const skippedHere = Math.min(eventsToSkip, exchange.events.length);
      eventsToSkip -= skippedHere;
      const visibleEvents = exchange.events.slice(skippedHere);
      const events = visibleEvents
        .map((event) => {
          if (event.type === "assistant") return renderMessage("assistant", "Assistant", event.timestamp, event.text);
          if (event.type === "thinking") return state.showReasoning ? renderThinking(event) : "";
          if (event.type === "tool") return renderTool(event);
          return "";
        })
        .join("");
      return `
        <section class="turn">
          ${exchange.request ? renderMessage("user", `User · Turn ${startIndex + index + 1}`, exchange.timestamp, exchange.request) : ""}
          ${events}
        </section>
      `;
    })
    .join("");
  updateConversationControls();
}

async function loadProjects() {
  const [summary, projectData] = await Promise.all([
    fetchJson("/api/summary"),
    fetchJson("/api/projects"),
  ]);
  state.summary = summary;
  state.projects = projectData.projects || [];
  for (const projectId of [...state.orchestrationSelection]) {
    if (!state.projects.some((project) => project.id === projectId)) {
      state.orchestrationSelection.delete(projectId);
    }
  }
  renderSummary();
  renderProjects();
  renderOrchestrator();
}

async function loadOrchestrations() {
  if (state.orchestrationLoading) return;
  state.orchestrationLoading = true;
  try {
    const data = await fetchJson("/api/orchestrations");
    state.orchestrationRuns = data.runs || [];
    renderOrchestrator();
  } finally {
    state.orchestrationLoading = false;
  }
}

function orchestrationPayload() {
  return {
    title: elements.orchestrationTitle.value.trim(),
    prompt: elements.orchestrationPrompt.value.trim(),
    projectIds: [...state.orchestrationSelection],
    startTurns: elements.orchestrationStartTurns.checked,
  };
}

function projectAliases(project) {
  const parts = [project.label, project.path.split(/[\\/]/).filter(Boolean).at(-1)];
  return [...new Set(parts.map((part) => String(part || "").trim().toLowerCase()).filter((part) => part.length >= 3))];
}

function matchProjectsFromText() {
  const text = `${elements.orchestrationTitle.value} ${elements.orchestrationPrompt.value}`.toLowerCase();
  let matched = 0;
  for (const project of state.projects) {
    if (projectAliases(project).some((alias) => text.includes(alias))) {
      state.orchestrationSelection.add(project.id);
      matched += 1;
    }
  }
  elements.orchestrationStatus.textContent = matched ? `Matched ${matched} project${matched === 1 ? "" : "s"} from text.` : "No project names matched.";
  renderProjects();
}

function renderOrchestrationPreview(preview) {
  state.orchestrationPreview = preview;
  elements.orchestrationPreviewMeta.textContent = `${plural(preview.projectCount, "project")} · ${preview.startTurns ? "child turns start immediately" : "child turns stay queued"}`;
  elements.orchestrationPreviewConfirm.textContent = `Create ${plural(preview.projectCount, "chat")}`;
  elements.orchestrationPreviewBody.innerHTML = preview.children
    .map((child) => `
      <article class="preview-child">
        <div class="preview-child-heading">
          <div>
            <span class="eyebrow">${escapeHtml(child.projectLabel)}</span>
            <h3>${escapeHtml(child.title)}</h3>
          </div>
          <span class="status-mark">Ready</span>
        </div>
        <p title="${escapeHtml(child.projectPath)}">${escapeHtml(child.projectPath)}</p>
        <details>
          <summary>Review generated prompt</summary>
          <pre>${escapeHtml(child.prompt)}</pre>
        </details>
      </article>
    `)
    .join("");
  elements.orchestrationPreviewDialog.showModal();
}

async function previewOrchestration() {
  setButtonBusy(elements.previewOrchestrationButton, true, "Preparing…");
  elements.orchestrationStatus.textContent = "Building a review";
  try {
    const preview = await postJson("/api/orchestrations/preview", orchestrationPayload());
    elements.orchestrationStatus.textContent = `${preview.projectCount} child chats are ready to review.`;
    renderOrchestrationPreview(preview);
  } finally {
    setButtonBusy(elements.previewOrchestrationButton, false);
    renderOrchestrator();
  }
}

async function startOrchestration() {
  setButtonBusy(elements.orchestrationPreviewConfirm, true, "Creating…");
  elements.orchestrationStatus.textContent = "Creating child chats through Codex app-server";
  try {
    const run = await postJson("/api/orchestrations/start", orchestrationPayload());
    elements.orchestrationPreviewDialog.close();
    elements.orchestrationStatus.textContent = `Queued ${run.children.length} child chats. Runner PID ${run.runnerPid || "unknown"}.`;
    notify(`${plural(run.children.length, "child chat")} queued`, "success");
    await Promise.all([loadOrchestrations(), loadProjects()]);
  } finally {
    setButtonBusy(elements.orchestrationPreviewConfirm, false);
    renderOrchestrator();
  }
}

async function selectProject(projectId, options = {}) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  state.projectRequestController?.abort();
  state.threadRequestController?.abort();
  const controller = new AbortController();
  state.projectRequestController = controller;
  const desiredThreadId = options.preserveThreadId || null;
  state.selectedProject = project;
  state.selectedThread = null;
  state.selectedDetail = null;
  state.threads = [];
  setFocusMode(false);
  renderProjects();
  renderThreads();
  renderConversation();
  elements.threadList.setAttribute("aria-busy", "true");
  elements.threadList.innerHTML = `<div class="loading-state"><span class="spinner" aria-hidden="true"></span><span>Loading conversations</span></div>`;
  const params = new URLSearchParams();
  if (state.includeApprovals) params.set("includeApprovals", "1");
  if (state.includeSubagents) params.set("includeSubagents", "1");
  const query = params.toString() ? `?${params}` : "";
  try {
    const data = await fetchJson(`/api/projects/${encodeURIComponent(project.id)}/threads${query}`, { signal: controller.signal });
    if (controller.signal.aborted || state.selectedProject?.id !== project.id) return;
    state.threads = data.threads || [];
    renderThreads();
    savePreferences();
    if (desiredThreadId && state.threads.some((thread) => thread.id === desiredThreadId)) {
      await selectThread(desiredThreadId);
    }
  } finally {
    if (state.projectRequestController === controller) {
      state.projectRequestController = null;
      elements.threadList.setAttribute("aria-busy", "false");
    }
  }
}

async function selectThread(threadId) {
  const thread = state.threads.find((item) => item.id === threadId);
  if (!thread) return;
  state.threadRequestController?.abort();
  const controller = new AbortController();
  state.threadRequestController = controller;
  state.conversationRenderLimit = 40;
  state.conversationEventLimit = 240;
  state.selectedThread = thread;
  state.selectedDetail = null;
  renderThreads();
  renderConversation();
  elements.conversationBody.setAttribute("aria-busy", "true");
  elements.conversationBody.innerHTML = `<div class="loading-state"><span class="spinner" aria-hidden="true"></span><span>Loading conversation</span></div>`;
  try {
    const detail = await fetchJson(`/api/threads/${encodeURIComponent(thread.id)}`, { signal: controller.signal });
    if (controller.signal.aborted || state.selectedThread?.id !== thread.id) return;
    state.selectedDetail = detail;
    renderConversation();
    savePreferences();
  } finally {
    if (state.threadRequestController === controller) {
      state.threadRequestController = null;
      elements.conversationBody.setAttribute("aria-busy", "false");
    }
  }
}

async function refreshAll() {
  const selectedProjectId = state.selectedProject?.id;
  const selectedThreadId = state.selectedThread?.id;
  setButtonBusy(elements.refreshButton, true);
  elements.summaryText.textContent = "Refreshing Codex state";
  setConnectionState("loading", "Refreshing");
  try {
    await Promise.all([loadProjects(), loadOrchestrations()]);
    const selectedStillExists = state.projects.find((item) => item.id === selectedProjectId);
    if (selectedStillExists) {
      await selectProject(selectedStillExists.id, { preserveThreadId: selectedThreadId });
    } else if (selectedProjectId) {
      state.selectedProject = null;
      state.selectedThread = null;
      state.selectedDetail = null;
      renderThreads();
      renderConversation();
    }
    state.lastRefreshAt = new Date();
    setConnectionState("online", "Local · just updated");
    notify("Workspace refreshed", "success");
  } finally {
    setButtonBusy(elements.refreshButton, false);
  }
}

function showInlineError(target, error) {
  if (isAbortError(error)) return;
  target.innerHTML = `<div class="empty-state is-error"><span class="empty-icon" aria-hidden="true">!</span><strong>Something went wrong</strong><span>${escapeHtml(error.message)}</span></div>`;
  setConnectionState("error", "Needs attention");
}

function closeOrchestrationPreview() {
  if (elements.orchestrationPreviewDialog.open) elements.orchestrationPreviewDialog.close();
}

elements.refreshButton.addEventListener("click", () => {
  refreshAll().catch((error) => {
    elements.summaryText.textContent = error.message;
    setConnectionState("error", "Refresh failed");
  });
});

elements.viewTabs.forEach((tab) => {
  tab.addEventListener("click", () => showView(tab.dataset.viewTarget));
});

elements.orchestratorToggle.addEventListener("click", () => setOrchestratorOpen(!state.orchestratorOpen));
elements.orchestratorClose.addEventListener("click", () => setOrchestratorOpen(false));

elements.projectSearch.addEventListener("input", () => {
  state.projectQuery = elements.projectSearch.value;
  state.projectRenderLimit = 100;
  renderProjects();
});

elements.projectSearchClear.addEventListener("click", () => {
  elements.projectSearch.value = "";
  state.projectQuery = "";
  state.projectRenderLimit = 100;
  renderProjects();
  elements.projectSearch.focus();
});

elements.projectSort.addEventListener("change", () => {
  state.projectSort = elements.projectSort.value;
  state.projectRenderLimit = 100;
  renderProjects();
  savePreferences();
});

elements.threadSearch.addEventListener("input", () => {
  state.threadQuery = elements.threadSearch.value;
  renderThreads();
});

elements.threadSearchClear.addEventListener("click", () => {
  elements.threadSearch.value = "";
  state.threadQuery = "";
  renderThreads();
  elements.threadSearch.focus();
});

elements.orchestrationPrompt.addEventListener("input", renderOrchestrator);
elements.orchestrationTitle.addEventListener("input", renderOrchestrator);
elements.orchestrationStartTurns.addEventListener("change", renderOrchestrator);
elements.matchProjectsButton.addEventListener("click", matchProjectsFromText);

elements.selectVisibleProjectsButton.addEventListener("click", () => {
  visibleProjects().forEach((project) => state.orchestrationSelection.add(project.id));
  renderProjects();
});

elements.clearProjectSelectionButton.addEventListener("click", () => {
  state.orchestrationSelection.clear();
  renderProjects();
});

for (const button of [elements.previewOrchestrationButton, elements.startOrchestrationButton]) {
  button.addEventListener("click", () => {
    previewOrchestration().catch((error) => {
      elements.orchestrationStatus.textContent = error.message;
      renderOrchestrator();
    });
  });
}

elements.orchestrationPreviewClose.addEventListener("click", closeOrchestrationPreview);
elements.orchestrationPreviewCancel.addEventListener("click", closeOrchestrationPreview);
elements.orchestrationPreviewConfirm.addEventListener("click", () => {
  startOrchestration().catch((error) => {
    elements.orchestrationStatus.textContent = error.message;
    notify(error.message, "error");
  });
});

elements.orchestrationPreviewDialog.addEventListener("click", (event) => {
  if (event.target === elements.orchestrationPreviewDialog) closeOrchestrationPreview();
});

elements.orchestrationRuns.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-thread-id]");
  if (!chip) return;
  selectProject(chip.dataset.projectId, { preserveThreadId: chip.dataset.threadId }).catch((error) => {
    if (!isAbortError(error)) elements.orchestrationStatus.textContent = error.message;
  });
});

async function reloadSelectedProject() {
  if (!state.selectedProject) return;
  const projectId = state.selectedProject.id;
  const threadId = state.selectedThread?.id;
  try {
    await selectProject(projectId, { preserveThreadId: threadId });
  } catch (error) {
    if (!isAbortError(error)) showInlineError(elements.threadList, error);
  }
}

elements.includeApprovals.addEventListener("change", () => {
  state.includeApprovals = elements.includeApprovals.checked;
  savePreferences();
  reloadSelectedProject();
});

elements.includeSubagents.addEventListener("change", () => {
  state.includeSubagents = elements.includeSubagents.checked;
  savePreferences();
  reloadSelectedProject();
});

elements.projectList.addEventListener("click", (event) => {
  const showMore = event.target.closest("[data-show-more-projects]");
  if (showMore) {
    state.projectRenderLimit += 100;
    renderProjects();
    return;
  }
  const checkbox = event.target.closest(".project-orchestration-check");
  if (checkbox) {
    const projectId = checkbox.dataset.projectId;
    if (checkbox.checked) state.orchestrationSelection.add(projectId);
    else state.orchestrationSelection.delete(projectId);
    renderProjects();
    return;
  }
  const button = event.target.closest("[data-project-open-id]");
  if (!button) return;
  selectProject(button.dataset.projectOpenId).catch((error) => {
    if (!isAbortError(error)) showInlineError(elements.threadList, error);
  });
});

elements.threadList.addEventListener("click", (event) => {
  const row = event.target.closest("[data-thread-id]");
  if (!row) return;
  selectThread(row.dataset.threadId).catch((error) => {
    if (!isAbortError(error)) showInlineError(elements.conversationBody, error);
  });
});

elements.showReasoning.addEventListener("change", () => {
  state.showReasoning = elements.showReasoning.checked;
  renderConversation();
  savePreferences();
});

elements.conversationToolsToggle.addEventListener("click", () => {
  state.toolsExpanded = !state.toolsExpanded;
  renderConversation();
});

elements.conversationBody.addEventListener("click", (event) => {
  const loadEarlierExchanges = event.target.closest("[data-load-earlier-exchanges]");
  const loadEarlierEvents = event.target.closest("[data-load-earlier-events]");
  if (!loadEarlierExchanges && !loadEarlierEvents) return;
  const previousHeight = elements.conversationBody.scrollHeight;
  const previousTop = elements.conversationBody.scrollTop;
  if (loadEarlierExchanges) state.conversationRenderLimit += 40;
  if (loadEarlierEvents) state.conversationEventLimit += 240;
  renderConversation();
  elements.conversationBody.scrollTop = previousTop + (elements.conversationBody.scrollHeight - previousHeight);
});

elements.copyThreadButton.addEventListener("click", () => {
  const thread = state.selectedDetail?.thread;
  if (!thread) return;
  copyText(`${thread.title}\n${thread.id}\n${thread.rolloutPath || ""}`, "Conversation details copied");
});

elements.focusModeButton.addEventListener("click", () => setFocusMode(!state.focusMode));
elements.conversationTopButton.addEventListener("click", () => elements.conversationBody.scrollTo({ top: 0, behavior: "smooth" }));
elements.conversationBottomButton.addEventListener("click", () => elements.conversationBody.scrollTo({ top: elements.conversationBody.scrollHeight, behavior: "smooth" }));

elements.patchRefreshButton.addEventListener("click", () => {
  loadPatchStatus().catch((error) => {
    elements.patchStatusLine.textContent = error.message;
  });
});

elements.patchResetButton.addEventListener("click", () => {
  applyPatchDefaults();
  renderPatchFeatures();
  updatePatchActionState();
  elements.patchStatusLine.textContent = "Defaults restored.";
});

elements.patchFeatureList.addEventListener("change", () => {
  renderPatchFeatureCount();
  updatePatchActionState();
});
elements.patchSelectAllButton.addEventListener("click", () => setPatchFeatureSelection("all"));
elements.patchDefaultsButton.addEventListener("click", () => setPatchFeatureSelection("defaults"));
elements.patchSelectNoneButton.addEventListener("click", () => setPatchFeatureSelection("none"));

elements.patchSourceMode.addEventListener("change", () => {
  syncPatchSourceFields();
  updatePatchActionState();
});

for (const control of [elements.patchLimit, elements.patchSourceAppDir, elements.patchOutputRoot]) {
  control.addEventListener("input", updatePatchActionState);
}

elements.patchPreviewButton.addEventListener("click", () => {
  previewPatchBuild().catch((error) => {
    elements.patchStatusLine.textContent = error.message;
  });
});
elements.bundlePreviewButton.addEventListener("click", () => {
  previewBundleBuild().catch((error) => {
    elements.patchStatusLine.textContent = error.message;
  });
});
elements.patchBuildButton.addEventListener("click", () => {
  startPatchBuild().catch((error) => {
    setButtonBusy(elements.patchBuildButton, false);
    elements.patchStatusLine.textContent = error.message;
    updatePatchActionState();
  });
});
elements.bundleBuildButton.addEventListener("click", () => {
  startBundleBuild().catch((error) => {
    setButtonBusy(elements.bundleBuildButton, false);
    elements.patchStatusLine.textContent = error.message;
    updatePatchActionState();
  });
});
elements.patchLaunchButton.addEventListener("click", () => {
  launchPatchedCodex().catch((error) => {
    elements.patchStatusLine.textContent = error.message;
  });
});

elements.copyPreviewButton.addEventListener("click", () => copyText(elements.patchPreviewOutput.textContent, "Command copied"));
elements.copyLogButton.addEventListener("click", () => copyText(elements.patchLogOutput.textContent, "Job log copied"));

elements.patchJobList.addEventListener("click", (event) => {
  const row = event.target.closest("[data-patch-job-id]");
  if (!row) return;
  selectPatchJob(row.dataset.patchJobId).catch((error) => {
    elements.patchStatusLine.textContent = error.message;
  });
});

elements.shortcutsButton.addEventListener("click", () => elements.shortcutsDialog.showModal());
elements.shortcutsCloseButton.addEventListener("click", () => elements.shortcutsDialog.close());
elements.shortcutsDialog.addEventListener("click", (event) => {
  if (event.target === elements.shortcutsDialog) elements.shortcutsDialog.close();
});

document.addEventListener("keydown", (event) => {
  const editing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  if (event.key === "?" && !editing) {
    event.preventDefault();
    elements.shortcutsDialog.showModal();
    return;
  }
  if (event.key === "/" && !editing) {
    event.preventDefault();
    (state.view === "patches" ? elements.patchLimit : state.selectedProject ? elements.threadSearch : elements.projectSearch).focus();
    return;
  }
  if (event.key.toLowerCase() === "f" && !editing && state.view === "chats" && state.selectedDetail) {
    event.preventDefault();
    setFocusMode(!state.focusMode);
    return;
  }
  if (event.key.toLowerCase() === "n" && !editing && state.view === "chats") {
    event.preventDefault();
    setOrchestratorOpen(!state.orchestratorOpen);
    return;
  }
  if (event.key === "Escape" && !elements.shortcutsDialog.open && !elements.orchestrationPreviewDialog.open) {
    if (document.activeElement === elements.projectSearch && elements.projectSearch.value) elements.projectSearchClear.click();
    else if (document.activeElement === elements.threadSearch && elements.threadSearch.value) elements.threadSearchClear.click();
    else if (state.orchestratorOpen) setOrchestratorOpen(false);
  }
});

async function initialize() {
  const preferences = readPreferences();
  state.includeApprovals = Boolean(preferences.includeApprovals);
  state.includeSubagents = Boolean(preferences.includeSubagents);
  state.projectSort = ["recent", "name", "chats"].includes(preferences.projectSort) ? preferences.projectSort : "recent";
  state.showReasoning = preferences.showReasoning !== false;
  elements.includeApprovals.checked = state.includeApprovals;
  elements.includeSubagents.checked = state.includeSubagents;
  elements.projectSort.value = state.projectSort;
  elements.showReasoning.checked = state.showReasoning;
  setOrchestratorOpen(false, { focus: false });
  const hashView = location.hash.replace("#", "");
  showView(["chats", "patches"].includes(hashView) ? hashView : preferences.view || "chats");
  setConnectionState("loading", "Loading workspace");
  try {
    await Promise.all([loadProjects(), loadOrchestrations()]);
    const projectId = preferences.selectedProjectId;
    if (projectId && state.projects.some((project) => project.id === projectId)) {
      await selectProject(projectId, { preserveThreadId: preferences.selectedThreadId });
    }
    if (preferences.focusMode && state.selectedDetail) setFocusMode(true);
    state.lastRefreshAt = new Date();
    setConnectionState("online", "Local · ready");
  } catch (error) {
    if (!isAbortError(error)) {
      elements.summaryText.textContent = error.message;
      setConnectionState("error", "Load failed");
    }
  }
  loadPatchStatus().catch((error) => {
    elements.patchStatusLine.textContent = error.message;
  });
}

initialize();

setInterval(() => {
  if (document.visibilityState === "visible") loadOrchestrations().catch(() => {});
}, 5000);

setInterval(() => {
  const hasRunningPatchJob = state.patchJobs.some((job) => job.status === "running");
  if (document.visibilityState === "visible" && (state.view === "patches" || hasRunningPatchJob)) {
    loadPatchStatus().catch(() => {});
  }
}, 3000);
