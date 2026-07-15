(function () {
  "use strict";

  const ROOT_ID = "codex-native-orchestrator";
  const HOST_ID = "local";
  const STORAGE_KEY = "codex-native-orchestrator:v1";
  const CHILD_THREADS_KEY = "codex-native-orchestrator:child-threads:v1";
  const SWARM_RUNS_KEY = "codex-native-swarm-runs:v1";
  const PATCHER_STORAGE_KEY = "codex-native-patcher-settings:v1";
  const DEFAULT_MAX_CHATS = 1000;
  const PATCH_MANAGER_BASE = "http://127.0.0.1:4590";
  let resolvedOrchestrationCwd = "";

  const state = {
    open: false,
    page: "orchestrator",
    busy: false,
    childThreads: [],
    projects: [],
    selected: new Set(),
    log: [],
    lastError: null,
    startTurns: true,
    title: "",
    task: "",
    filter: "",
    maxChats: DEFAULT_MAX_CHATS,
    promptTemplate: "",
    orchestrationsExpanded: true,
    swarmExpanded: true,
    swarmGoal: "",
    swarmRuns: [],
    settingsTabActive: false,
    pendingSettingsOpen: false,
  };

  let requestSeq = 0;
  const pendingRequests = new Map();

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

  function nowTime() {
    return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function pushLog(message, level = "info") {
    state.log.push({ at: nowTime(), message, level });
    if (state.log.length > 200) {
      state.log = state.log.slice(-200);
    }
    renderLog();
  }

  function compactText(value, limit) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
  }

  function normalizePath(value) {
    return String(value || "").replace(/^\\\\\?\\/, "").replace(/\//g, "\\").replace(/[\\]+$/, "");
  }

  function projectLabel(cwd) {
    const normalized = normalizePath(cwd);
    const parts = normalized.split("\\").filter(Boolean);
    return parts[parts.length - 1] || normalized || "Project";
  }

  function isLocalPath(cwd) {
    return /^[a-z]:\\/i.test(cwd) || /^\\\\/.test(cwd);
  }

  function safeJson(value) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  async function orchestrationCwd() {
    if (resolvedOrchestrationCwd) return resolvedOrchestrationCwd;
    try {
      const response = await fetch(`${PATCH_MANAGER_BASE}/api/patch/status`, { method: "GET", cache: "no-store" });
      if (response.ok) {
        const body = await response.json();
        const runtimePath = normalizePath(body?.runtimePaths?.orchestrationRoot || "");
        if (runtimePath && isLocalPath(runtimePath)) {
          resolvedOrchestrationCwd = runtimePath;
          return resolvedOrchestrationCwd;
        }
      }
    } catch {
      // A selected project remains a valid fallback if the local bridge is unavailable.
    }
    const selectedProject = state.projects.find((project) => state.selected.has(project.cwd)) || state.projects[0];
    const fallback = normalizePath(selectedProject?.cwd || "C:\\");
    resolvedOrchestrationCwd = fallback;
    return resolvedOrchestrationCwd;
  }

  function saveDraft() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          title: state.title,
          task: state.task,
          filter: state.filter,
          startTurns: state.startTurns,
          maxChats: state.maxChats,
          promptTemplate: state.promptTemplate,
          orchestrationsExpanded: state.orchestrationsExpanded,
          swarmExpanded: state.swarmExpanded,
          swarmGoal: state.swarmGoal,
          selected: Array.from(state.selected),
        })
      );
    } catch {
      // Ignore localStorage failures in the native webview.
    }
  }

  function loadDraft() {
    try {
      const draft = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      state.title = typeof draft.title === "string" ? draft.title : "";
      state.task = typeof draft.task === "string" ? draft.task : "";
      state.filter = typeof draft.filter === "string" ? draft.filter : "";
      state.startTurns = draft.startTurns !== false;
      state.maxChats = Number.isInteger(draft.maxChats) ? draft.maxChats : DEFAULT_MAX_CHATS;
      state.promptTemplate = typeof draft.promptTemplate === "string" ? draft.promptTemplate : "";
      state.orchestrationsExpanded = draft.orchestrationsExpanded !== false;
      state.swarmExpanded = draft.swarmExpanded !== false;
      state.swarmGoal = typeof draft.swarmGoal === "string" ? draft.swarmGoal : "";
      state.selected = new Set(Array.isArray(draft.selected) ? draft.selected.filter((item) => typeof item === "string") : []);
    } catch {
      // Ignore malformed old drafts.
    }
  }

  function normalizeChildThread(item) {
    return {
      project: typeof item.project === "string" ? item.project : "",
      cwd: typeof item.cwd === "string" ? item.cwd : "",
      threadId: typeof item.threadId === "string" ? item.threadId : "",
      parentThreadId: typeof item.parentThreadId === "string" ? item.parentThreadId : "",
      parentTitle: typeof item.parentTitle === "string" ? item.parentTitle : "",
      turnId: typeof item.turnId === "string" ? item.turnId : "",
      status: typeof item.status === "string" ? item.status : "created",
      createdAt: Number(item.createdAt || 0),
    };
  }

  function saveChildThreads() {
    try {
      localStorage.setItem(CHILD_THREADS_KEY, JSON.stringify({ items: state.childThreads.slice(-1000) }));
    } catch {
      // Ignore localStorage failures in the native webview.
    }
  }

  function loadChildThreads() {
    try {
      const stored = JSON.parse(localStorage.getItem(CHILD_THREADS_KEY) || "{}");
      state.childThreads = Array.isArray(stored.items)
        ? stored.items.filter((item) => item && typeof item === "object").map(normalizeChildThread)
        : [];
    } catch {
      state.childThreads = [];
    }
  }

  function normalizeSwarmRun(item) {
    return {
      id: typeof item.id === "string" ? item.id : `swarm-${Date.now()}`,
      title: typeof item.title === "string" ? item.title : "Swarm run",
      goal: typeof item.goal === "string" ? item.goal : "",
      parentThreadId: typeof item.parentThreadId === "string" ? item.parentThreadId : "",
      parentTurnId: typeof item.parentTurnId === "string" ? item.parentTurnId : "",
      status: typeof item.status === "string" ? item.status : "planned",
      settings: item.settings && typeof item.settings === "object" ? item.settings : {},
      managers: Array.isArray(item.managers) ? item.managers : [],
      createdAt: Number(item.createdAt || 0),
      error: typeof item.error === "string" ? item.error : "",
    };
  }

  function saveSwarmRuns() {
    try {
      localStorage.setItem(SWARM_RUNS_KEY, JSON.stringify({ items: state.swarmRuns.slice(0, 100) }));
    } catch {
      // Ignore localStorage failures in the native webview.
    }
  }

  function loadSwarmRuns() {
    try {
      const stored = JSON.parse(localStorage.getItem(SWARM_RUNS_KEY) || "{}");
      state.swarmRuns = Array.isArray(stored.items)
        ? stored.items.filter((item) => item && typeof item === "object").map(normalizeSwarmRun)
        : [];
    } catch {
      state.swarmRuns = [];
    }
  }

  function makeRequestId(method) {
    requestSeq += 1;
    const suffix =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${requestSeq}`;
    return `native-orchestrator:${method}:${suffix}`;
  }

  function requestAppServer(method, params, timeoutMs = 60000) {
    const bridge = window.electronBridge;
    if (!bridge || typeof bridge.sendMessageFromView !== "function") {
      return Promise.reject(new Error("Codex Electron bridge is not available."));
    }

    const id = makeRequestId(method);
    const request = { id, method, params };
    const started = Date.now();

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`Timed out waiting for ${method} after ${Math.round((Date.now() - started) / 1000)}s.`));
      }, timeoutMs);

      pendingRequests.set(id, {
        method,
        resolve: (result) => {
          window.clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          window.clearTimeout(timeout);
          reject(error);
        },
      });

      bridge
        .sendMessageFromView({ type: "mcp-request", hostId: HOST_ID, request })
        .catch((error) => {
          pendingRequests.delete(id);
          window.clearTimeout(timeout);
          reject(error);
        });
    });
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.type !== "mcp-response" || data.hostId !== HOST_ID || !data.message) {
      return;
    }
    const message = data.message;
    const pending = pendingRequests.get(message.id);
    if (!pending) {
      return;
    }
    pendingRequests.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || safeJson(message.error)));
      return;
    }
    pending.resolve(message.result);
  });

  function buildChildPrompt(project, task) {
    const template = state.promptTemplate.trim();
    if (template) {
      return template
        .replaceAll("{project}", project.label)
        .replaceAll("{cwd}", project.cwd)
        .replaceAll("{task}", task.trim());
    }
    return [
      "You are a child Codex agent launched from a native multi-project orchestration.",
      "",
      `Target project: ${project.label}`,
      `Workspace: ${project.cwd}`,
      "",
      "User request:",
      task.trim(),
      "",
      "Stay scoped to this project unless the request explicitly requires coordination. Report concise progress, concrete changes, blockers, and verification.",
    ].join("\n");
  }

  function buildChildTitle(project, taskTitle) {
    const base = taskTitle.trim() || compactText(state.task, 48) || "Multi-project task";
    return `[${project.label}] ${base}`.slice(0, 120);
  }

  function buildOrchestrationTitle(taskTitle, task) {
    const base = taskTitle.trim() || compactText(task, 64) || "New orchestration";
    return base.startsWith("[Orchestration]") ? base.slice(0, 120) : `[Orchestration] ${base}`.slice(0, 120);
  }

  function makeTextInput(text) {
    return [{ type: "text", text, text_elements: [] }];
  }

  function swarmSettings() {
    const settings = window.__codexNativeProviderSettings?.getSwarmSettings?.();
    return settings && typeof settings === "object"
      ? settings
      : {
          enabled: true,
          providerId: "cerebras",
          orchestratorModelKey: "cerebras:gemma-4-31b",
          managerModelKey: "cerebras:gemma-4-31b",
          workerModelKey: "cerebras:gemma-4-31b",
          maxManagers: 4,
          maxWorkersPerManager: 6,
          maxParallelWorkers: 12,
          isolatedWorkspaces: true,
          interAgentMessaging: true,
          autoTests: true,
          autoReview: true,
          defaultDepartments: "Discovery\nImplementation\nTesting\nReview",
        };
  }

  function modelNameFromKey(key) {
    const parts = String(key || "").split(":");
    return parts.length > 1 ? parts.slice(1).join(":") : String(key || "");
  }

  function swarmDepartments(settings) {
    const raw = String(settings.defaultDepartments || "Discovery\nImplementation\nTesting\nReview")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const unique = [];
    for (const item of raw) {
      if (!unique.some((existing) => existing.toLowerCase() === item.toLowerCase())) {
        unique.push(item);
      }
    }
    return unique.slice(0, Math.max(1, Math.min(16, Number(settings.maxManagers || 4))));
  }

  function swarmRunTitle(goal) {
    const base = compactText(goal, 68) || "New swarm run";
    return base.startsWith("[Swarm]") ? base.slice(0, 120) : `[Swarm] ${base}`.slice(0, 120);
  }

  function buildSwarmParentPrompt(run) {
    const settings = run.settings || swarmSettings();
    const departments = (run.managers || []).map((manager) => `- ${manager.name}: ${manager.workers} worker slots`).join("\n");
    return [
      "You are the top-level Codex orchestrator for a hierarchical multi-agent Swarm run.",
      "",
      `Swarm goal: ${run.goal}`,
      "",
      "Configured hierarchy:",
      `- Provider: ${settings.providerId || "cerebras"}`,
      `- Orchestrator model: ${modelNameFromKey(settings.orchestratorModelKey) || "gemma-4-31b"}`,
      `- Manager model: ${modelNameFromKey(settings.managerModelKey) || "gemma-4-31b"}`,
      `- Worker model: ${modelNameFromKey(settings.workerModelKey) || "gemma-4-31b"}`,
      `- Max managers: ${settings.maxManagers || 4}`,
      `- Workers per manager: ${settings.maxWorkersPerManager || 6}`,
      `- Max parallel workers: ${settings.maxParallelWorkers || 12}`,
      `- Isolated workspaces: ${settings.isolatedWorkspaces ? "yes" : "no"}`,
      `- Inter-agent communication: ${settings.interAgentMessaging ? "yes" : "no"}`,
      `- Testing manager enabled: ${settings.autoTests ? "yes" : "no"}`,
      `- Review manager enabled: ${settings.autoReview ? "yes" : "no"}`,
      "",
      "Manager lanes:",
      departments || "- Discovery\n- Implementation\n- Testing\n- Review",
      "",
      "First produce the manager plan, dependency boundaries, workspace/file ownership rules, communication protocol, and verification gates. Then spawn manager and worker subagents as separate chats where supported, using the configured Cerebras Gemma subagent template for fast workers.",
    ].join("\n");
  }

  async function createSwarmParentThread(run) {
    const title = swarmRunTitle(run.goal);
    const orchestrationRoot = await orchestrationCwd();
    renderStatus("Creating Swarm parent chat...");
    let started;
    try {
      started = await requestAppServer(
        "thread/start",
        {
          input: [],
          cwd: orchestrationRoot,
          workspaceRoots: [orchestrationRoot],
          workspaceKind: "projectless",
          projectlessOutputDirectory: orchestrationRoot,
          threadSource: "user",
        },
        90000
      );
    } catch (error) {
      pushLog(`Projectless Swarm chat failed, falling back to orchestration folder: ${error.message || error}`, "warn");
      started = await requestAppServer(
        "thread/start",
        {
          input: [],
          cwd: orchestrationRoot,
          workspaceRoots: [orchestrationRoot],
          workspaceKind: "project",
          threadSource: "user",
        },
        90000
      );
    }
    const threadId = started?.thread?.id;
    if (!threadId) {
      throw new Error("thread/start returned no Swarm parent thread id.");
    }
    await requestAppServer("thread/name/set", { threadId, name: title }, 30000);
    const turn = await requestAppServer(
      "turn/start",
      {
        threadId,
        input: makeTextInput(buildSwarmParentPrompt({ ...run, parentThreadId: threadId })),
        cwd: orchestrationRoot,
      },
      90000
    );
    return { threadId, turnId: turn?.turn?.id || "" };
  }

  async function startSwarmRun() {
    const goal = state.swarmGoal.trim();
    if (!goal) {
      pushLog("Enter a Swarm goal.", "warn");
      return;
    }
    const settings = swarmSettings();
    const departments = swarmDepartments(settings);
    const run = normalizeSwarmRun({
      id: `swarm-${Date.now()}`,
      title: swarmRunTitle(goal),
      goal,
      status: "starting",
      settings,
      managers: departments.map((name) => ({ name, status: "planned", workers: Math.max(1, Number(settings.maxWorkersPerManager || 6)) })),
      createdAt: Date.now(),
    });

    setBusy(true);
    state.swarmRuns = [run, ...state.swarmRuns].slice(0, 100);
    saveSwarmRuns();
    renderSwarmChildren();
    renderSwarmPage();
    pushLog(`Starting Swarm run with ${run.managers.length} manager lane${run.managers.length === 1 ? "" : "s"} using ${modelNameFromKey(settings.workerModelKey) || "gemma-4-31b"}.`);
    try {
      const parent = await createSwarmParentThread(run);
      run.parentThreadId = parent.threadId;
      run.parentTurnId = parent.turnId;
      run.status = parent.turnId ? "parent-started" : "parent-created";
      saveSwarmRuns();
      pushLog(`Swarm parent chat created: ${parent.threadId}${parent.turnId ? `, turn ${parent.turnId}` : ""}.`, "success");
      openLocalThread(parent.threadId);
    } catch (error) {
      run.status = "failed";
      run.error = error.message || String(error);
      state.lastError = run.error;
      saveSwarmRuns();
      pushLog(run.error, "error");
      renderAll();
    } finally {
      setBusy(false);
    }
  }

  async function createOrchestrationThread(task) {
    const title = buildOrchestrationTitle(state.title, task);
    const orchestrationRoot = await orchestrationCwd();
    renderStatus("Creating parent orchestration chat...");
    let started;
    try {
      started = await requestAppServer(
        "thread/start",
        {
          input: [],
          cwd: orchestrationRoot,
          workspaceRoots: [orchestrationRoot],
          workspaceKind: "projectless",
          projectlessOutputDirectory: orchestrationRoot,
          threadSource: "user",
        },
        90000
      );
    } catch (error) {
      pushLog(`Projectless parent chat failed, falling back to orchestration folder: ${error.message || error}`, "warn");
      started = await requestAppServer(
        "thread/start",
        {
          input: [],
          cwd: orchestrationRoot,
          workspaceRoots: [orchestrationRoot],
          workspaceKind: "project",
          threadSource: "user",
        },
        90000
      );
    }

    const threadId = started && started.thread && started.thread.id;
    if (!threadId) {
      throw new Error("thread/start returned no parent orchestration thread id.");
    }
    await requestAppServer("thread/name/set", { threadId, name: title }, 30000);
    pushLog(`Parent orchestration chat created: ${threadId}.`, "success");
    return threadId;
  }

  async function refreshProjects() {
    setBusy(true);
    state.lastError = null;
    renderStatus("Loading native Codex projects...");
    try {
      const rows = [];
      let cursor = null;
      let pageCount = 0;
      const maxChats = Math.max(100, Math.min(5000, Number(state.maxChats) || DEFAULT_MAX_CHATS));
      do {
        const response = await requestAppServer(
          "thread/list",
          {
            limit: 100,
            cursor,
            sortKey: "updated_at",
            modelProviders: null,
            sourceKinds: [],
            archived: false,
          },
          90000
        );
        const pageRows = Array.isArray(response && response.data) ? response.data : [];
        rows.push(...pageRows);
        cursor = response && response.nextCursor ? response.nextCursor : null;
        pageCount += 1;
      } while (cursor && rows.length < maxChats && pageCount < Math.ceil(maxChats / 100));
      const byCwd = new Map();
      for (const row of rows) {
        const cwd = normalizePath(row && row.cwd);
        if (!cwd || !isLocalPath(cwd)) {
          continue;
        }
        const existing = byCwd.get(cwd);
        const updatedAt = Number(row.updatedAt || row.updated_at || 0);
        if (!existing) {
          byCwd.set(cwd, {
            cwd,
            label: projectLabel(cwd),
            count: 1,
            latestTitle: row.name || row.title || row.preview || "",
            updatedAt,
          });
        } else {
          existing.count += 1;
          if (updatedAt > existing.updatedAt) {
            existing.updatedAt = updatedAt;
            existing.latestTitle = row.name || row.title || row.preview || existing.latestTitle;
          }
        }
      }
      state.projects = Array.from(byCwd.values()).sort((a, b) => b.updatedAt - a.updatedAt || a.label.localeCompare(b.label));
      for (const item of Array.from(state.selected)) {
        if (!byCwd.has(item)) {
          state.selected.delete(item);
        }
      }
      pushLog(`Loaded ${state.projects.length} projects from ${rows.length} recent Codex chats.`);
      renderAll();
    } catch (error) {
      state.lastError = error.message || String(error);
      pushLog(state.lastError, "error");
      renderAll();
    } finally {
      setBusy(false);
    }
  }

  async function startOrchestration() {
    const selectedProjects = state.projects.filter((project) => state.selected.has(project.cwd));
    const task = state.task.trim();
    if (!selectedProjects.length) {
      pushLog("Select at least one project.", "warn");
      return;
    }
    if (!task) {
      pushLog("Enter the task to send to each child chat.", "warn");
      return;
    }

    setBusy(true);
    pushLog(`Starting ${selectedProjects.length} child chat${selectedProjects.length === 1 ? "" : "s"}...`);
    const created = [];
    try {
      const parentTitle = buildOrchestrationTitle(state.title, task);
      const parentThreadId = await createOrchestrationThread(task);
      for (const project of selectedProjects) {
        renderStatus(`Creating child chat for ${project.label}...`);
        const started = await requestAppServer(
          "thread/start",
          {
            input: [],
            cwd: project.cwd,
            workspaceRoots: [project.cwd],
            workspaceKind: "project",
            threadSource: "subagent",
          },
          90000
        );
        const threadId = started && started.thread && started.thread.id;
        if (!threadId) {
          throw new Error(`thread/start returned no thread id for ${project.cwd}`);
        }

        const childTitle = buildChildTitle(project, state.title);
        await requestAppServer("thread/name/set", { threadId, name: childTitle }, 30000);

        let turnId = null;
        if (state.startTurns) {
          const turn = await requestAppServer(
            "turn/start",
            {
              threadId,
              input: makeTextInput(buildChildPrompt(project, task)),
              cwd: project.cwd,
            },
            90000
          );
          turnId = (turn && turn.turn && turn.turn.id) || null;
        }

        const childRecord = {
          project: project.label,
          cwd: project.cwd,
          threadId,
          parentThreadId,
          parentTitle,
          turnId: turnId || "",
          status: state.startTurns ? "started" : "created",
          createdAt: Date.now(),
        };
        created.push({ project, threadId, turnId });
        state.childThreads = [...state.childThreads, childRecord];
        saveChildThreads();
        renderOrchestrationChildren();
        pushLog(`${project.label}: created ${threadId}${turnId ? `, turn ${turnId}` : ""}.`, "success");
      }

      saveDraft();
      renderStatus(`Created ${created.length} child chat${created.length === 1 ? "" : "s"}.`);
      await refreshProjects();
    } catch (error) {
      state.lastError = error.message || String(error);
      pushLog(state.lastError, "error");
      renderAll();
    } finally {
      setBusy(false);
    }
  }

  function setBusy(next) {
    state.busy = next;
    const root = document.getElementById(ROOT_ID);
    if (root) {
      root.classList.toggle("is-busy", next);
    }
    renderControls();
  }

  function filteredProjects() {
    const q = state.filter.trim().toLowerCase();
    if (!q) {
      return state.projects;
    }
    return state.projects.filter(
      (project) =>
        project.label.toLowerCase().includes(q) ||
        project.cwd.toLowerCase().includes(q) ||
        String(project.latestTitle || "").toLowerCase().includes(q)
    );
  }

  function selectVisible() {
    for (const project of filteredProjects()) {
      state.selected.add(project.cwd);
    }
    saveDraft();
    renderProjectList();
    renderStatus();
  }

  function clearSelected() {
    state.selected.clear();
    saveDraft();
    renderProjectList();
    renderStatus();
  }

  function renderStatus(text) {
    const node = document.querySelector(`#${ROOT_ID} [data-role="status"]`);
    if (!node) {
      return;
    }
    const selectedCount = state.selected.size;
    node.textContent =
      text ||
      `${selectedCount} selected. ${state.projects.length} projects loaded.` +
        (state.lastError ? ` Last error: ${state.lastError}` : "");
  }

  function renderControls() {
    const root = document.getElementById(ROOT_ID);
    if (!root) {
      return;
    }
    const buttons = root.querySelectorAll("button, input, textarea");
    buttons.forEach((button) => {
      if (button.hasAttribute("data-allow-while-busy")) {
        return;
      }
      button.disabled = state.busy;
    });
  }

  function renderProjectList() {
    const list = document.querySelector(`#${ROOT_ID} [data-role="project-list"]`);
    if (!list) {
      return;
    }
    const projects = filteredProjects();
    if (!state.projects.length) {
      list.innerHTML = '<div class="cno-empty">No projects loaded.</div>';
      return;
    }
    if (!projects.length) {
      list.innerHTML = '<div class="cno-empty">No matching projects.</div>';
      return;
    }
    list.innerHTML = "";
    for (const project of projects) {
      const row = document.createElement("label");
      row.className = "cno-project";
      row.title = project.cwd;

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = state.selected.has(project.cwd);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          state.selected.add(project.cwd);
        } else {
          state.selected.delete(project.cwd);
        }
        saveDraft();
        renderStatus();
      });

      const text = document.createElement("span");
      text.className = "cno-project-text";
      const label = document.createElement("span");
      label.className = "cno-project-label";
      label.textContent = project.label;
      const meta = document.createElement("span");
      meta.className = "cno-project-meta";
      meta.textContent = `${project.count} chat${project.count === 1 ? "" : "s"} · ${project.cwd}`;
      text.append(label, meta);
      row.append(checkbox, text);
      list.append(row);
    }
  }

  function renderLog() {
    const log = document.querySelector(`#${ROOT_ID} [data-role="log"]`);
    if (!log) {
      return;
    }
    log.innerHTML = "";
    for (const item of state.log) {
      const line = document.createElement("div");
      line.className = `cno-log-line cno-log-${item.level}`;
      line.textContent = `${item.at} ${item.message}`;
      log.append(line);
    }
    log.scrollTop = log.scrollHeight;
  }

  function renderSwarmPage() {
    const root = document.getElementById(ROOT_ID);
    if (!root) {
      return;
    }
    const goal = root.querySelector('[data-role="swarm-goal"]');
    if (goal && goal.value !== state.swarmGoal) goal.value = state.swarmGoal;
    const settings = swarmSettings();
    const model = modelNameFromKey(settings.workerModelKey) || "gemma-4-31b";
    const departments = swarmDepartments(settings);
    const list = root.querySelector('[data-role="swarm-run-list"]');
    const topology = root.querySelector('[data-role="swarm-topology"]');
    if (topology) {
      topology.innerHTML = `
        <div class="cno-swarm-topology-node is-root">Orchestrator<br><span>${compactText(modelNameFromKey(settings.orchestratorModelKey), 34) || "gemma-4-31b"}</span></div>
        <div class="cno-swarm-topology-lanes">
          ${departments
            .map((department) => `<div class="cno-swarm-topology-node">${department}<br><span>${compactText(modelNameFromKey(settings.managerModelKey), 30) || "gemma-4-31b"}</span></div>`)
            .join("")}
        </div>
        <div class="cno-swarm-workers">${Math.max(1, Number(settings.maxParallelWorkers || 12))} parallel ${model} worker slots</div>
      `;
    }
    if (list) {
      list.innerHTML = "";
      if (!state.swarmRuns.length) {
        const empty = document.createElement("div");
        empty.className = "cno-orchestration-empty";
        empty.textContent = "No swarm runs yet";
        list.append(empty);
      } else {
        for (const run of state.swarmRuns.slice(0, 20)) {
          list.append(
            makeChatLikeRow({
              className: "is-swarm-run",
              title: run.title || "Swarm run",
              meta: `${run.status || "planned"} · ${run.managers?.length || 0} managers${run.parentThreadId ? ` · ${run.parentThreadId.slice(0, 8)}` : ""}`,
              onClick: () => (run.parentThreadId ? openLocalThread(run.parentThreadId) : showPage("swarm")),
            })
          );
        }
      }
    }
  }

  function renderAll() {
    const root = document.getElementById(ROOT_ID);
    if (!root) {
      return;
    }
    root.classList.toggle("is-open", state.open);
    root.dataset.page = state.page;
    const title = root.querySelector('[data-role="title"]');
    const task = root.querySelector('[data-role="task"]');
    const filter = root.querySelector('[data-role="filter"]');
    const startTurns = root.querySelector('[data-role="start-turns"]');
    const heading = root.querySelector('[data-role="page-heading"]');
    if (title && title.value !== state.title) title.value = state.title;
    if (task && task.value !== state.task) task.value = state.task;
    if (filter && filter.value !== state.filter) filter.value = state.filter;
    if (startTurns) startTurns.checked = state.startTurns;
    if (heading) heading.textContent = state.page === "swarm" ? "Swarm" : "Orchestrations";
    renderProjectList();
    renderSwarmPage();
    renderLog();
    renderStatus();
    renderControls();
    syncSidebarActive();
    updateMainBounds();
  }

  function showPage(page) {
    if (page === "settings") {
      openNativeSettings();
      return;
    }
    state.page = page;
    state.open = true;
    state.settingsTabActive = false;
    removeNativeSettingsPanel();
    renderAll();
    if (page === "orchestrator" && !state.projects.length && !state.busy) {
      refreshProjects();
    }
  }

  function closePage() {
    state.open = false;
    renderAll();
  }

  function normalizedText(element) {
    return String(element && element.textContent ? element.textContent : "").replace(/\s+/g, " ").trim();
  }

  function textCandidates(root = document) {
    return Array.from(root.querySelectorAll("button, a, [role='button'], [role='tab'], [role='menuitem'], span"));
  }

  function findExactTextElement(root, text) {
    const target = text.toLowerCase();
    return textCandidates(root).find((element) => normalizedText(element).toLowerCase() === target) || null;
  }

  function findSidebarRowByText(text) {
    const target = text.toLowerCase();
    const candidates = Array.from(document.querySelectorAll("button, a, [role='button'], div, span")).filter((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.left > 520 || rect.width < 20 || rect.height < 8) {
        return false;
      }
      return normalizedText(element).toLowerCase() === target;
    });

    for (const candidate of candidates) {
      let node = candidate;
      while (node && node !== document.body) {
        const rect = node.getBoundingClientRect();
        if (rect.left < 520 && rect.width >= 120 && rect.width <= 420 && rect.height >= 24 && rect.height <= 56) {
          return node;
        }
        node = node.parentElement;
      }
    }
    return null;
  }

  function findSidebarRowStartingWith(text) {
    const target = text.toLowerCase();
    const candidates = Array.from(document.querySelectorAll("button, a, [role='button'], div, span")).filter((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.left > 520 || rect.width < 20 || rect.height < 8) {
        return false;
      }
      return normalizedText(element).toLowerCase().startsWith(target);
    });

    for (const candidate of candidates) {
      let node = candidate;
      while (node && node !== document.body) {
        const rect = node.getBoundingClientRect();
        if (rect.left < 520 && rect.width >= 120 && rect.width <= 420 && rect.height >= 24 && rect.height <= 56) {
          return node;
        }
        node = node.parentElement;
      }
    }
    return null;
  }

  function findSidebarRegion() {
    const row = findSidebarRowByText("New chat") || findSidebarRowByText("Search") || findSidebarRowByText("Automations");
    if (!row) {
      return null;
    }
    let node = row;
    let best = row;
    while (node && node !== document.body) {
      const rect = node.getBoundingClientRect();
      if (rect.left < 80 && rect.width >= 160 && rect.width <= 520 && rect.height >= window.innerHeight * 0.55) {
        best = node;
      }
      node = node.parentElement;
    }
    return best;
  }

  function updateMainBounds() {
    const root = document.getElementById(ROOT_ID);
    if (!root) {
      return;
    }
    const sidebar = findSidebarRegion();
    const rect = sidebar ? sidebar.getBoundingClientRect() : null;
    const left = rect ? Math.max(220, Math.min(Math.round(rect.right), Math.max(220, window.innerWidth - 420))) : 320;
    root.style.left = `${left}px`;
  }

  function makeSidebarButton(id, label, page) {
    let button = document.getElementById(id);
    if (button) {
      return button;
    }
    button = document.createElement("button");
    button.id = id;
    button.type = "button";
    button.className = "cno-sidebar-entry";
    button.dataset.pageTarget = page;
    button.innerHTML = `
      <span class="cno-sidebar-icon" aria-hidden="true">
        <svg viewBox="0 0 20 20" fill="none">
          <path d="M5 6.5h3.5M11.5 6.5H15M5 13.5h3.5M11.5 13.5H15M8.5 6.5l3 7M11.5 6.5l-3 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </span>
      <span class="cno-sidebar-label">${label}</span>
    `;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showPage(page);
    });
    return button;
  }

  function openLocalThread(threadId) {
    if (!threadId) {
      showPage("orchestrator");
      return;
    }
    closePage();
    window.location.assign(`/local/${encodeURIComponent(threadId)}`);
  }

  function makeOrchestrationSidebarGroup() {
    let group = document.getElementById("cno-orchestration-sidebar-group");
    if (group) {
      return group;
    }

    group = document.createElement("div");
    group.id = "cno-orchestration-sidebar-group";
    group.className = "px-row-x cno-orchestration-sidebar-group";
    group.innerHTML = `
      <div class="cno-orchestration-section-stack flex flex-col gap-1">
        <div class="flex items-center justify-between gap-2 pr-0.5 pl-2">
          <div class="min-w-0 flex-1 text-base text-token-input-placeholder-foreground opacity-75">
            <div class="flex min-w-0 flex-1">
              <button class="cno-orchestration-section-toggle group/section-toggle flex min-w-0 flex-1 cursor-interaction items-center gap-1 rounded-md py-0.5 pr-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" type="button" aria-expanded="true">
                <span class="cno-sidebar-label min-w-0 truncate">Orchestrations</span>
                <span class="cno-orchestration-chevron" aria-hidden="true">›</span>
              </button>
            </div>
          </div>
        </div>
        <div class="cno-orchestration-child-sidebar-list" data-role="sidebar-child-list"></div>
      </div>
    `;

    group.querySelector(".cno-orchestration-section-toggle").addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.orchestrationsExpanded = !state.orchestrationsExpanded;
      saveDraft();
      renderOrchestrationChildren();
    });

    renderOrchestrationChildren();
    return group;
  }

  function makeSwarmSidebarGroup() {
    let group = document.getElementById("cno-swarm-sidebar-group");
    if (group) {
      return group;
    }

    group = document.createElement("div");
    group.id = "cno-swarm-sidebar-group";
    group.className = "px-row-x cno-orchestration-sidebar-group cno-swarm-sidebar-group";
    group.innerHTML = `
      <div class="cno-orchestration-section-stack flex flex-col gap-1">
        <div class="flex items-center justify-between gap-2 pr-0.5 pl-2">
          <div class="min-w-0 flex-1 text-base text-token-input-placeholder-foreground opacity-75">
            <div class="flex min-w-0 flex-1">
              <button class="cno-orchestration-section-toggle group/section-toggle flex min-w-0 flex-1 cursor-interaction items-center gap-1 rounded-md py-0.5 pr-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" type="button" aria-expanded="true">
                <span class="cno-sidebar-label min-w-0 truncate">Swarm</span>
                <span class="cno-orchestration-chevron" aria-hidden="true">›</span>
              </button>
            </div>
          </div>
        </div>
        <div class="cno-orchestration-child-sidebar-list" data-role="sidebar-swarm-list"></div>
      </div>
    `;

    group.querySelector(".cno-orchestration-section-toggle").addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.swarmExpanded = !state.swarmExpanded;
      saveDraft();
      renderSwarmChildren();
    });

    renderSwarmChildren();
    return group;
  }

  function findSidebarSectionWrapper(text) {
    const row = findSidebarRowStartingWith(text);
    let node = row;
    while (node && node !== document.body) {
      if (String(node.className || "").split(/\s+/).includes("px-row-x")) {
        return node;
      }
      node = node.parentElement;
    }
    return row;
  }

  function orchestrationGroups() {
    const grouped = new Map();
    for (const child of state.childThreads.slice(-1000).reverse()) {
      const key = child.parentThreadId || child.threadId || `${child.cwd}:${child.createdAt}`;
      const existing =
        grouped.get(key) ||
        {
          parentThreadId: child.parentThreadId || "",
          title: child.parentTitle || "Orchestration chat",
          createdAt: child.createdAt || 0,
          children: [],
        };
      existing.createdAt = Math.max(existing.createdAt || 0, child.createdAt || 0);
      if (child.parentTitle && existing.title === "Orchestration chat") {
        existing.title = child.parentTitle;
      }
      existing.children.push(child);
      grouped.set(key, existing);
    }
    return Array.from(grouped.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  function makeChatLikeRow({ className, title, meta, indent = false, onClick }) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `cno-orchestration-chatlike-row ${indent ? "is-child" : ""} ${className || ""}`;
    row.title = meta || title || "";
    row.innerHTML = `
      <span class="cno-sidebar-icon" aria-hidden="true">
        <svg viewBox="0 0 20 20" fill="none">
          <path d="M4.5 6.5h11v7h-4.25L8 16v-2.5H4.5v-7Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" />
        </svg>
      </span>
      <span class="cno-orchestration-chat-copy">
        <span class="cno-orchestration-chat-title"></span>
        <span class="cno-orchestration-chat-meta"></span>
      </span>
    `;
    row.querySelector(".cno-orchestration-chat-title").textContent = title || "Untitled";
    row.querySelector(".cno-orchestration-chat-meta").textContent = meta || "";
    row.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick?.();
    });
    return row;
  }

  function renderOrchestrationChildren() {
    const group = document.getElementById("cno-orchestration-sidebar-group");
    const list = document.querySelector("#cno-orchestration-sidebar-group [data-role='sidebar-child-list']");
    if (!group || !list) {
      return;
    }
    group.classList.toggle("is-expanded", state.orchestrationsExpanded);
    const toggle = group.querySelector(".cno-orchestration-section-toggle");
    if (toggle) {
      toggle.setAttribute("aria-expanded", String(state.orchestrationsExpanded));
    }
    list.innerHTML = "";
    list.hidden = !state.orchestrationsExpanded;
    if (!state.orchestrationsExpanded) {
      return;
    }

    list.append(
      makeChatLikeRow({
        className: "is-new",
        title: "New orchestration",
        meta: "Configure and create in Settings",
        onClick: openNativeSettings,
      })
    );

    const groups = orchestrationGroups();
    if (!groups.length) {
      const empty = document.createElement("div");
      empty.className = "cno-orchestration-empty";
      empty.textContent = "No orchestration chats";
      list.append(empty);
      return;
    }

    for (const groupItem of groups.slice(0, 12)) {
      const parentTarget = groupItem.parentThreadId || groupItem.children[0]?.threadId || "";
      list.append(
        makeChatLikeRow({
          className: "is-parent",
          title: groupItem.title || "Orchestration chat",
          meta: `${groupItem.children.length} project chat${groupItem.children.length === 1 ? "" : "s"}`,
          onClick: () => openLocalThread(parentTarget),
        })
      );

      for (const child of groupItem.children.slice(0, 8)) {
        list.append(
          makeChatLikeRow({
            className: "is-project-chat",
            title: child.project || projectLabel(child.cwd),
            meta: `${child.status || "created"} · ${child.threadId ? child.threadId.slice(0, 8) : "pending"}`,
            indent: true,
            onClick: () => openLocalThread(child.threadId),
          })
        );
      }
    }
  }

  function renderSwarmChildren() {
    const group = document.getElementById("cno-swarm-sidebar-group");
    const list = document.querySelector("#cno-swarm-sidebar-group [data-role='sidebar-swarm-list']");
    if (!group || !list) {
      return;
    }
    group.classList.toggle("is-expanded", state.swarmExpanded);
    const toggle = group.querySelector(".cno-orchestration-section-toggle");
    if (toggle) {
      toggle.setAttribute("aria-expanded", String(state.swarmExpanded));
    }
    list.innerHTML = "";
    list.hidden = !state.swarmExpanded;
    if (!state.swarmExpanded) {
      return;
    }

    list.append(
      makeChatLikeRow({
        className: "is-new is-swarm-new",
        title: "New swarm",
        meta: "Cerebras Gemma manager/worker run",
        onClick: () => showPage("swarm"),
      })
    );

    if (!state.swarmRuns.length) {
      const empty = document.createElement("div");
      empty.className = "cno-orchestration-empty";
      empty.textContent = "No swarm runs";
      list.append(empty);
      return;
    }

    for (const run of state.swarmRuns.slice(0, 12)) {
      list.append(
        makeChatLikeRow({
          className: "is-swarm-run",
          title: run.title || "Swarm run",
          meta: `${run.status || "planned"} · ${run.managers?.length || 0} managers`,
          onClick: () => (run.parentThreadId ? openLocalThread(run.parentThreadId) : showPage("swarm")),
        })
      );
    }
  }

  function installSidebarButtons() {
    const orchestratorGroup = makeOrchestrationSidebarGroup();
    const swarmGroup = makeSwarmSidebarGroup();
    const showOrchestrations = patcherFeatureEnabled("orchestrations", true);
    const showSwarm = patcherFeatureEnabled("swarm", true);

    if (!showOrchestrations && orchestratorGroup.parentElement) {
      orchestratorGroup.remove();
    }
    if (!showSwarm && swarmGroup.parentElement) {
      swarmGroup.remove();
    }
    if (!showOrchestrations && !showSwarm) {
      syncSidebarActive();
      syncNativeSettingsIntegration();
      updateMainBounds();
      return;
    }

    const pinnedRow = findSidebarSectionWrapper("Pinned");
    const chatRow = findSidebarSectionWrapper("Chats");
    const projectsRow = findSidebarSectionWrapper("Projects");
    const automationRow = findSidebarRowByText("Automations");
    const anchor = pinnedRow || projectsRow || chatRow || automationRow;
    if (anchor && anchor.parentElement) {
      if (showOrchestrations && (orchestratorGroup.parentElement !== anchor.parentElement || anchor.previousSibling !== orchestratorGroup)) {
        anchor.parentElement.insertBefore(orchestratorGroup, anchor);
      }
      if (showSwarm) {
        const swarmAnchor = showOrchestrations && orchestratorGroup.parentElement === anchor.parentElement ? orchestratorGroup.nextSibling : anchor;
        if (swarmGroup.parentElement !== anchor.parentElement || swarmAnchor !== swarmGroup) {
          anchor.parentElement.insertBefore(swarmGroup, swarmAnchor);
        }
      }
    }

    syncSidebarActive();
    syncNativeSettingsIntegration();
    updateMainBounds();
  }

  function syncSidebarActive() {
    for (const button of document.querySelectorAll(".cno-sidebar-entry")) {
      button.classList.toggle("is-active", state.open && button.dataset.pageTarget === state.page);
    }
  }

  function isSettingsRoute() {
    return window.location.pathname.startsWith("/settings") || !!findSettingsNavigation();
  }

  function navigateNativeRoute(path, options = {}) {
    const navigate = globalThis.__codexNativeNavigate;
    if (typeof navigate === "function") {
      navigate(path, options);
      return true;
    }
    window.history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
    return false;
  }

  function isOrchestrationsSettingsRoute() {
    if (document.getElementById("codex-native-orchestrations-settings-route")) {
      return true;
    }
    return window.location.pathname.replace(/\/+$/, "") === "/settings/orchestrations";
  }

  function openOrchestrationsSettingsRoutePanel() {
    state.settingsTabActive = true;
    state.pendingSettingsOpen = false;
    renderNativeSettingsPanel();
    for (const delay of [0, 50, 150, 400]) {
      window.setTimeout(renderNativeSettingsPanel, delay);
    }
  }

  function openNativeSettings() {
    state.open = false;
    state.settingsTabActive = true;
    state.pendingSettingsOpen = true;
    renderAll();

    const nativeSettingsRow = findSidebarRowByText("Settings");
    if (!isSettingsRoute() && typeof globalThis.__codexNativeNavigate === "function") {
      navigateNativeRoute("/settings/orchestrations");
    } else if (nativeSettingsRow && !isSettingsRoute()) {
      nativeSettingsRow.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    } else if (!isSettingsRoute()) {
      navigateNativeRoute("/settings/orchestrations");
    }

    window.setTimeout(() => {
      if (!isOrchestrationsSettingsRoute()) {
        navigateNativeRoute("/settings/orchestrations");
      }
      state.pendingSettingsOpen = false;
      syncNativeSettingsIntegration();
      renderNativeSettingsPanel();
      if (state.settingsTabActive && !findSettingsNavigation()) {
        window.setTimeout(() => {
          syncNativeSettingsIntegration();
          renderNativeSettingsPanel();
        }, 250);
      }
    }, 120);
  }

  function findSettingsNavigation() {
    const explicit = document.querySelector('nav[aria-label="Settings"]');
    if (explicit) {
      return explicit;
    }

    const anchor = findExactTextElement(document, "General") || findExactTextElement(document, "Back to app");
    const candidates = [];
    let node = anchor;
    while (node && node !== document.body) {
      const rect = node.getBoundingClientRect();
      if (rect.left <= 420 && rect.width >= 180 && rect.width <= 420 && rect.height >= window.innerHeight * 0.45) {
        const text = normalizedText(node);
        if (text.includes("General") && text.includes("Appearance")) {
          candidates.push(node);
        }
      }
      node = node.parentElement;
    }

    return (
      candidates.sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return aRect.width * aRect.height - bRect.width * bRect.height;
      })[0] || null
    );
  }

  function findSettingsNavBody(nav) {
    const navRect = nav.getBoundingClientRect();
    const candidates = Array.from(nav.querySelectorAll("div")).filter((node) => {
      const rect = node.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 80 || rect.left < navRect.left - 2 || rect.right > navRect.right + 2) {
        return false;
      }
      const style = window.getComputedStyle(node);
      return style.display === "flex" && style.flexDirection === "column";
    });
    return candidates.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0] || nav;
  }

  function findSettingsContentHost(nav) {
    const routeHost = document.getElementById("codex-native-orchestrations-settings-route");
    if (routeHost) {
      return routeHost;
    }

    const navRect = nav ? nav.getBoundingClientRect() : { right: 320 };
    let node = nav ? nav.parentElement : null;
    while (node && node !== document.body) {
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child !== node);
        const content = siblings.find((child) => {
          const rect = child.getBoundingClientRect();
          return rect.left >= navRect.right - 4 && rect.width >= 260 && rect.height >= window.innerHeight * 0.45;
        });
        if (content) {
          return content;
        }
      }
      node = parent;
    }
    const candidates = Array.from(document.querySelectorAll("main, [role='main'], section")).filter((element) => {
      if (element.id === ROOT_ID || element.closest(`#${ROOT_ID}`)) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.left >= navRect.right - 12 && rect.width >= 420 && rect.height >= window.innerHeight * 0.45;
    });
    return (
      candidates.sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return bRect.width * bRect.height - aRect.width * aRect.height;
      })[0] || null
    );
  }

  function syncNativeSettingsIntegration() {
    const routeActive = isOrchestrationsSettingsRoute();
    if (!isSettingsRoute() && !routeActive) {
      state.settingsTabActive = false;
      removeNativeSettingsPanel();
      const settingsButton = document.getElementById("cno-settings-nav-button");
      if (settingsButton) {
        settingsButton.remove();
      }
      return;
    }
    if (routeActive) {
      state.settingsTabActive = true;
    } else if (!state.pendingSettingsOpen && state.settingsTabActive) {
      state.settingsTabActive = false;
      removeNativeSettingsPanel();
    }
    const shouldRenderPanel = routeActive || state.pendingSettingsOpen || state.settingsTabActive;
    state.pendingSettingsOpen = false;
    if (state.open) {
      state.open = false;
      const root = document.getElementById(ROOT_ID);
      if (root) {
        root.classList.remove("is-open");
      }
      syncSidebarActive();
    }

    const nav = findSettingsNavigation();
    installNativeSettingsNav(nav);
    if (shouldRenderPanel) {
      renderNativeSettingsPanel();
    } else if (!state.settingsTabActive) {
      removeNativeSettingsPanel();
    }
  }

  function installNativeSettingsNav(nav) {
    for (const button of document.querySelectorAll("#cno-settings-nav-button")) {
      button.remove();
    }
  }

  function findTextRowIn(root, text) {
    const target = text.toLowerCase();
    const matches = textCandidates(root).filter((element) => normalizedText(element).toLowerCase() === target);
    for (const match of matches) {
      let node = match;
      while (node && node !== root.parentElement && node !== document.body) {
        const rect = node.getBoundingClientRect();
        if (rect.width >= 120 && rect.height >= 24 && rect.height <= 52) {
          return node;
        }
        node = node.parentElement;
      }
    }
    return null;
  }

  function insertSettingsNavButton(button, nav) {
    const usageRow = nav ? findTextRowIn(nav, "Usage & billing") : null;
    const parent = usageRow?.parentElement || nav;
    if (!parent) {
      return false;
    }

    const orderedRows = [button, document.getElementById("cps-settings-nav-button")].filter(Boolean);
    let cursor = usageRow ? usageRow.nextSibling : parent.firstChild;
    for (const row of orderedRows) {
      if (row.parentElement !== parent || row !== cursor) {
        parent.insertBefore(row, cursor);
      }
      cursor = row.nextSibling;
    }
    for (const row of orderedRows) {
      row.style.left = "";
      row.style.top = "";
      row.style.width = "";
      row.style.height = "";
    }
    return true;
  }

  function renderNativeSettingsPanel() {
    const nav = findSettingsNavigation();
    const routeHost = document.getElementById("codex-native-orchestrations-settings-route");
    if (!nav && !routeHost) {
      return;
    }
    const host = findSettingsContentHost(nav);
    if (!host) {
      return;
    }

    let panel = document.getElementById("cno-native-settings-content");
    try {
      host.classList.add("cno-settings-content-host");
      if (!panel || panel.parentElement !== host) {
        removeNativeSettingsPanel();
        panel = document.createElement("section");
        panel.id = "cno-native-settings-content";
        panel.className = "cno-native-settings-panel main-surface flex h-full min-h-0 flex-col";
        panel.setAttribute("aria-label", "Orchestrations settings");
        panel.innerHTML = `
        <div class="draggable flex items-center px-panel electron:h-toolbar extension:h-toolbar-sm"></div>
        <div class="scrollbar-stable flex-1 overflow-y-auto p-panel">
          <div class="mx-auto flex w-full max-w-2xl electron:min-w-[calc(320px*var(--codex-window-zoom))] flex-col">
            <div class="flex items-center justify-between gap-3 pb-panel">
              <div class="flex min-w-0 flex-1 flex-col gap-1.5 pb-panel">
                <div class="electron:heading-lg heading-base truncate">Orchestrations</div>
                <div class="text-base text-token-text-secondary truncate">Configure multi-project child chat creation.</div>
              </div>
            </div>
            <div class="flex flex-col gap-[var(--padding-panel)]">
              <section class="flex flex-col">
                <div class="flex h-toolbar items-center justify-between gap-2 px-0 py-0">
                  <div class="flex min-w-0 flex-1 flex-col gap-1">
                    <div class="text-base font-medium text-token-text-primary">Defaults</div>
                  </div>
                </div>
                <div class="cno-settings-surface">
                  <div class="cno-settings-row">
                    <div class="cno-settings-row-copy">
                      <div class="cno-settings-label">Max recent chats scanned</div>
                      <div class="cno-settings-description">Used when building the project picker from native Codex chat history.</div>
                    </div>
                    <div class="cno-settings-control">
                      <input class="cno-input cno-number-input" type="text" data-role="native-max-chats" />
                    </div>
                  </div>
                  <label class="cno-settings-row cno-settings-row-clickable">
                    <div class="cno-settings-row-copy">
                      <div class="cno-settings-label">Start turns by default</div>
                      <div class="cno-settings-description">Create each child chat and immediately send the orchestration prompt.</div>
                    </div>
                    <div class="cno-settings-control">
                      <input type="checkbox" data-role="native-start-turns" />
                    </div>
                  </label>
                  <div class="cno-settings-row cno-settings-row-stacked">
                    <div class="cno-settings-row-copy">
                      <div class="cno-settings-label">Child prompt template</div>
                      <div class="cno-settings-description">Available placeholders: {project}, {cwd}, {task}.</div>
                    </div>
                    <textarea class="cno-input cno-template-input" data-role="native-prompt-template" placeholder="{task}"></textarea>
                  </div>
                </div>
              </section>
              <section class="flex flex-col">
                <div class="flex h-toolbar items-center justify-between gap-2 px-0 py-0">
                  <div class="flex min-w-0 flex-1 flex-col gap-1">
                    <div class="text-base font-medium text-token-text-primary">Actions</div>
                  </div>
                </div>
                <div class="cno-settings-surface">
                  <div class="cno-settings-row">
                    <div class="cno-settings-row-copy">
                      <div class="cno-settings-label">Show sidebar section</div>
                      <div class="cno-settings-description">Expands Orchestrations in the app sidebar and returns to Codex.</div>
                    </div>
                    <div class="cno-settings-control">
                      <button class="cno-button cno-secondary" type="button" data-role="native-open-orchestrator">Open</button>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      `;
        host.append(panel);
        bindNativeSettingsPanel(panel);
      }

      syncNativeSettingsControls(panel);
      installNativeSettingsNav(nav);
    } catch (error) {
      console.error("[native-orchestrator] settings render failed", error);
      removeNativeSettingsPanel();
    }
  }

  function bindNativeSettingsPanel(panel) {
    panel.querySelector('[data-role="native-max-chats"]').addEventListener("input", (event) => {
      const value = Number(event.target.value);
      if (Number.isInteger(value)) {
        state.maxChats = Math.max(100, Math.min(5000, value));
        saveDraft();
      }
    });
    panel.querySelector('[data-role="native-start-turns"]').addEventListener("change", (event) => {
      state.startTurns = event.target.checked;
      saveDraft();
      renderAll();
      syncNativeSettingsControls(panel);
    });
    panel.querySelector('[data-role="native-prompt-template"]').addEventListener("input", (event) => {
      state.promptTemplate = event.target.value;
      saveDraft();
    });
    panel.querySelector('[data-role="native-open-orchestrator"]').addEventListener("click", () => {
      state.orchestrationsExpanded = true;
      state.settingsTabActive = false;
      saveDraft();
      removeNativeSettingsPanel();
      renderOrchestrationChildren();
      const back = findExactTextElement(document, "Back to app");
      if (back) {
        back.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      } else {
        window.history.back();
      }
      scheduleNativeIntegrationBurst();
    });
  }

  function syncNativeSettingsControls(panel) {
    const maxChats = panel.querySelector('[data-role="native-max-chats"]');
    const startTurns = panel.querySelector('[data-role="native-start-turns"]');
    const promptTemplate = panel.querySelector('[data-role="native-prompt-template"]');
    if (maxChats && maxChats.value !== String(state.maxChats)) maxChats.value = String(state.maxChats);
    if (startTurns) startTurns.checked = state.startTurns;
    if (promptTemplate && promptTemplate.value !== state.promptTemplate) promptTemplate.value = state.promptTemplate;
  }

  function removeNativeSettingsPanel() {
    const panel = document.getElementById("cno-native-settings-content");
    if (panel) {
      panel.remove();
    }
    for (const button of document.querySelectorAll("#cno-settings-nav-button")) {
      button.classList.remove("is-active");
    }
  }

  function handleNativeSettingsTabEvent(event) {
    if (event.detail?.id === "orchestrations") {
      openOrchestrationsSettingsRoutePanel();
      return;
    }
    if (state.settingsTabActive) {
      state.settingsTabActive = false;
      removeNativeSettingsPanel();
    }
  }

  function tickNativeIntegration() {
    try {
      installSidebarButtons();
      syncNativeSettingsIntegration();
    } catch (error) {
      // Keep Codex usable if an injected native integration probe fails.
      console.warn("[native-orchestrator] integration tick failed", error);
    }
  }

  let nativeIntegrationTimer = null;
  let nativeSettingsRouteObserver = null;
  let sidebarObserver = null;
  function scheduleNativeIntegration() {
    if (nativeIntegrationTimer) {
      return;
    }
    nativeIntegrationTimer = window.setTimeout(() => {
      nativeIntegrationTimer = null;
      tickNativeIntegration();
    }, 150);
  }

  function scheduleNativeIntegrationBurst() {
    for (const delay of [0, 120, 350, 900]) {
      window.setTimeout(scheduleNativeIntegration, delay);
    }
  }

  function startNativeSettingsRouteObserver() {
    if (!document.body || nativeSettingsRouteObserver) {
      return;
    }
    nativeSettingsRouteObserver = new MutationObserver(() => {
      if (!isOrchestrationsSettingsRoute() || document.getElementById("cno-native-settings-content")) {
        return;
      }
      if (document.getElementById("codex-native-orchestrations-settings-route") || findSettingsNavigation()) {
        scheduleNativeIntegration();
      }
    });
    nativeSettingsRouteObserver.observe(document.body, { childList: true, subtree: true });
  }

  function startSidebarObserver() {
    if (!document.body || sidebarObserver) {
      return;
    }
    sidebarObserver = new MutationObserver(() => {
      const group = document.getElementById("cno-orchestration-sidebar-group");
      const pinned = findSidebarSectionWrapper("Pinned");
      if (!pinned) {
        return;
      }
      if (!group || group.parentElement !== pinned.parentElement || group.nextSibling !== pinned) {
        scheduleNativeIntegration();
      }
    });
    sidebarObserver.observe(document.body, { childList: true, subtree: true });
  }

  function recoverSidebarIntegration() {
    for (const delay of [0, 75, 200, 500, 1000, 2000]) {
      window.setTimeout(scheduleNativeIntegration, delay);
    }
  }

  function recoverActiveNativeSettingsRoute() {
    const recover = () => {
      if (!isOrchestrationsSettingsRoute() || document.getElementById("cno-native-settings-content")) {
        return;
      }
      if (document.getElementById("codex-native-orchestrations-settings-route") || findSettingsNavigation()) {
        openOrchestrationsSettingsRoutePanel();
      }
    };
    for (const delay of [0, 50, 150, 400, 1000]) {
      window.setTimeout(recover, delay);
    }
  }

  function createStyle() {
    const style = document.createElement("style");
    style.textContent = `
      #${ROOT_ID} {
        background: var(--color-token-main-surface-primary);
        border-left: 1px solid var(--color-token-border);
        color: var(--color-token-text-primary);
        font: var(--text-sm, 14px)/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        position: fixed;
        inset: 0 0 0 320px;
        z-index: 2147483000;
        display: none;
      }
      #${ROOT_ID}.is-open { display: block; }
      #${ROOT_ID} * { box-sizing: border-box; }
      .cno-sidebar-entry {
        align-items: center;
        background: transparent;
        border: 0;
        border-radius: var(--radius-lg, 8px);
        color: var(--color-token-text-secondary);
        cursor: pointer;
        display: flex;
        gap: 8px;
        min-height: 30px;
        padding: var(--padding-row-y, 5px) var(--padding-row-x, 10px);
        text-align: left;
        width: 100%;
      }
      .cno-sidebar-entry:hover,
      .cno-sidebar-entry.is-active {
        background: var(--color-token-list-hover-background);
        color: var(--color-token-text-primary);
      }
      .cno-sidebar-icon {
        align-items: center;
        display: inline-flex;
        height: 18px;
        justify-content: center;
        width: 18px;
      }
      .cno-sidebar-icon svg { height: 16px; width: 16px; }
      .cno-sidebar-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cno-orchestration-sidebar-group {
        display: flex;
        flex-direction: column;
        gap: 0;
        margin: 0;
        min-width: 0;
        width: 100%;
      }
      .cno-orchestration-section-toggle {
        align-items: center;
        background: transparent;
        border: 0;
        color: inherit;
        cursor: pointer;
        display: flex;
        font: inherit;
        gap: 5px;
        justify-content: flex-start;
        min-height: 25px;
        padding: 2px 4px 2px 0;
        text-align: left;
        width: 100%;
      }
      .cno-orchestration-section-toggle:hover {
        color: var(--color-token-text-primary);
      }
      .cno-orchestration-chevron {
        align-items: center;
        display: inline-flex;
        flex: 0 0 auto;
        height: 16px;
        justify-content: center;
        transform: rotate(0deg);
        transition: transform .12s ease;
        width: 10px;
      }
      .cno-orchestration-sidebar-group.is-expanded .cno-orchestration-chevron {
        transform: rotate(90deg);
      }
      .cno-orchestration-chat-row {
        min-height: 38px;
      }
      .cno-orchestration-child-sidebar-list {
        display: grid;
        gap: 1px;
        margin: 0 0 8px;
        min-width: 0;
      }
      .cno-orchestration-chatlike-row {
        align-items: center;
        background: transparent;
        border: 0;
        border-radius: var(--radius-lg, 8px);
        color: var(--color-token-text-secondary);
        cursor: pointer;
        display: flex;
        font: inherit;
        gap: 8px;
        min-height: 34px;
        min-width: 0;
        padding: 4px var(--padding-row-x, 14px);
        text-align: left;
        width: 100%;
      }
      .cno-orchestration-chatlike-row.is-child {
        min-height: 30px;
        padding-left: calc(var(--padding-row-x, 14px) + 22px);
      }
      .cno-orchestration-chatlike-row:hover {
        background: var(--color-token-list-hover-background);
        color: var(--color-token-text-primary);
      }
      .cno-orchestration-chatlike-row.is-new {
        color: var(--color-token-text-primary);
      }
      .cno-orchestration-empty {
        color: var(--color-token-text-tertiary, var(--color-token-text-secondary));
        font-size: 13px;
        min-height: 28px;
        padding: 5px var(--padding-row-x, 14px) 7px calc(var(--padding-row-x, 14px) + 20px);
      }
      .cno-orchestration-parent-sidebar-row {
        align-items: center;
        background: transparent;
        border: 0;
        border-radius: var(--radius-lg, 8px);
        color: var(--color-token-text-secondary);
        cursor: pointer;
        display: flex;
        gap: 8px;
        min-height: 34px;
        min-width: 0;
        padding: 4px var(--padding-row-x, 10px);
        text-align: left;
        width: 100%;
      }
      .cno-orchestration-child-sidebar-row {
        align-items: center;
        background: transparent;
        border: 0;
        border-radius: var(--radius-lg, 8px);
        color: var(--color-token-text-secondary);
        cursor: pointer;
        display: flex;
        gap: 8px;
        min-height: 30px;
        min-width: 0;
        padding: 4px var(--padding-row-x, 10px) 4px 28px;
        text-align: left;
        width: 100%;
      }
      .cno-orchestration-child-sidebar-row:hover {
        background: var(--color-token-list-hover-background);
        color: var(--color-token-text-primary);
      }
      .cno-orchestration-parent-sidebar-row:hover {
        background: var(--color-token-list-hover-background);
        color: var(--color-token-text-primary);
      }
      .cno-orchestration-chat-copy {
        display: grid;
        gap: 1px;
        min-width: 0;
      }
      .cno-orchestration-chat-title,
      .cno-orchestration-chat-meta {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cno-orchestration-chat-title {
        color: inherit;
        font-size: var(--text-sm, 13px);
        font-weight: 500;
      }
      .cno-orchestration-chat-meta {
        color: var(--color-token-text-tertiary, var(--color-token-text-secondary));
        font-size: 11px;
      }
      #${ROOT_ID} .cno-shell {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
        width: 100%;
      }
      #${ROOT_ID} .cno-header {
        align-items: center;
        border-bottom: 1px solid var(--color-token-border);
        display: flex;
        gap: 10px;
        justify-content: space-between;
        min-height: var(--height-toolbar, 46px);
        padding: 0 var(--padding-panel, 18px);
      }
      #${ROOT_ID} .cno-heading {
        color: var(--color-token-text-primary);
        font-size: var(--text-heading-md, 16px);
        font-weight: 500;
      }
      #${ROOT_ID} .cno-close {
        align-items: center;
        background: transparent;
        border: 1px solid transparent;
        border-radius: var(--radius-md, 6px);
        color: var(--color-token-text-secondary);
        cursor: pointer;
        display: inline-flex;
        height: 26px;
        justify-content: center;
        width: 26px;
      }
      #${ROOT_ID} .cno-close:hover {
        background: var(--color-token-list-hover-background);
        color: var(--color-token-text-primary);
      }
      #${ROOT_ID} .cno-page {
        display: none;
        grid-template-columns: minmax(360px, 720px) minmax(260px, 1fr);
        gap: var(--padding-panel, 18px);
        height: calc(100% - var(--height-toolbar, 46px));
        overflow: auto;
        padding: var(--padding-panel, 18px);
      }
      #${ROOT_ID}[data-page="orchestrator"] .cno-page-orchestrator {
        display: grid;
      }
      #${ROOT_ID}[data-page="swarm"] .cno-page-swarm {
        display: grid;
      }
      #${ROOT_ID} .cno-section {
        display: grid;
        align-content: start;
        gap: 10px;
        min-width: 0;
      }
      #${ROOT_ID} .cno-grid {
        display: grid;
        gap: 8px;
      }
      #${ROOT_ID} input[type="text"],
      #${ROOT_ID} textarea {
        background: var(--color-token-input-background);
        border: 1px solid var(--color-token-input-border, var(--color-token-border));
        border-radius: var(--radius-lg, 8px);
        color: var(--color-token-input-foreground, var(--color-token-text-primary));
        font: inherit;
        outline: none;
        padding: 8px 10px;
        width: 100%;
      }
      #${ROOT_ID} textarea {
        min-height: 92px;
        max-height: 190px;
        resize: vertical;
      }
      #${ROOT_ID} input[type="text"]:focus,
      #${ROOT_ID} textarea:focus {
        border-color: var(--color-token-focus-border);
      }
      #${ROOT_ID} .cno-row {
        align-items: center;
        display: flex;
        gap: 8px;
        justify-content: space-between;
      }
      #${ROOT_ID} .cno-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      #${ROOT_ID} .cno-button {
        align-items: center;
        background: var(--color-token-bg-fog);
        border: 1px solid var(--color-token-border);
        border-radius: var(--radius-lg, 8px);
        color: var(--color-token-button-tertiary-foreground, var(--color-token-text-primary));
        cursor: pointer;
        display: inline-flex;
        font: inherit;
        gap: 4px;
        justify-content: center;
        min-height: 30px;
        padding: 4px 10px;
        white-space: nowrap;
      }
      .cno-native-settings-panel .cno-button {
        align-items: center;
        background: var(--color-token-bg-fog);
        border: 1px solid var(--color-token-border);
        border-radius: var(--radius-lg, 8px);
        color: var(--color-token-button-tertiary-foreground, var(--color-token-text-primary));
        cursor: pointer;
        display: inline-flex;
        font: inherit;
        gap: 4px;
        justify-content: center;
        min-height: 30px;
        padding: 4px 10px;
        white-space: nowrap;
      }
      #${ROOT_ID} .cno-button:hover,
      .cno-native-settings-panel .cno-button:hover {
        background: var(--color-token-list-hover-background);
      }
      #${ROOT_ID} .cno-primary {
        background: var(--color-token-foreground);
        border-color: var(--color-token-foreground);
        color: var(--color-token-dropdown-background);
      }
      #${ROOT_ID} .cno-secondary,
      .cno-native-settings-panel .cno-secondary {
        background: transparent;
        border-color: var(--color-token-border);
        color: var(--color-token-text-primary);
      }
      #${ROOT_ID} button:disabled,
      #${ROOT_ID} input:disabled,
      #${ROOT_ID} textarea:disabled {
        cursor: wait;
        opacity: .62;
      }
      #${ROOT_ID} .cno-check {
        align-items: center;
        color: var(--color-token-text-secondary);
        display: inline-flex;
        gap: 7px;
        min-height: 30px;
      }
      #${ROOT_ID} .cno-project-list {
        background: var(--color-background-panel, var(--color-token-bg-fog));
        border: 1px solid var(--color-token-border);
        border-radius: var(--radius-lg, 8px);
        height: min(460px, calc(100vh - 330px));
        min-height: 180px;
        overflow: auto;
      }
      #${ROOT_ID} .cno-project {
        align-items: flex-start;
        border-bottom: 0.5px solid var(--color-token-border);
        cursor: pointer;
        display: flex;
        gap: 8px;
        padding: 10px 12px;
      }
      #${ROOT_ID} .cno-project:last-child { border-bottom: 0; }
      #${ROOT_ID} .cno-project:hover { background: var(--color-token-list-hover-background); }
      #${ROOT_ID} .cno-project input { margin-top: 2px; }
      #${ROOT_ID} .cno-project-text {
        display: grid;
        gap: 2px;
        min-width: 0;
      }
      #${ROOT_ID} .cno-project-label {
        color: var(--color-token-text-primary);
        font-weight: 650;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${ROOT_ID} .cno-project-meta {
        color: var(--color-token-text-secondary);
        font-size: 11px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${ROOT_ID} .cno-status {
        color: var(--color-token-text-secondary);
        min-height: 17px;
      }
      #${ROOT_ID} .cno-swarm-topology {
        background: var(--color-background-panel, var(--color-token-bg-fog));
        border: 1px solid var(--color-token-border);
        border-radius: var(--radius-lg, 8px);
        display: grid;
        gap: 12px;
        padding: 14px;
      }
      #${ROOT_ID} .cno-swarm-topology-node {
        background: var(--color-token-main-surface-primary);
        border: 1px solid var(--color-token-border);
        border-radius: var(--radius-lg, 8px);
        color: var(--color-token-text-primary);
        font-size: 13px;
        font-weight: 600;
        min-height: 44px;
        padding: 8px 10px;
        text-align: center;
      }
      #${ROOT_ID} .cno-swarm-topology-node span {
        color: var(--color-token-text-secondary);
        font-size: 11px;
        font-weight: 400;
      }
      #${ROOT_ID} .cno-swarm-topology-node.is-root {
        justify-self: center;
        width: min(100%, 320px);
      }
      #${ROOT_ID} .cno-swarm-topology-lanes {
        display: grid;
        gap: 8px;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      }
      #${ROOT_ID} .cno-swarm-workers {
        color: var(--color-token-text-secondary);
        font-size: 12px;
        text-align: center;
      }
      #${ROOT_ID} .cno-swarm-run-list {
        background: var(--color-background-panel, var(--color-token-bg-fog));
        border: 1px solid var(--color-token-border);
        border-radius: var(--radius-lg, 8px);
        height: min(520px, calc(100vh - 180px));
        min-height: 220px;
        overflow: auto;
        padding: 6px;
      }
      #${ROOT_ID} .cno-log {
        background: var(--color-token-bg-secondary);
        border: 1px solid var(--color-token-border);
        border-radius: var(--radius-lg, 8px);
        color: var(--color-token-text-primary);
        font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
        font-size: 11px;
        height: min(260px, calc(100vh - 260px));
        min-height: 120px;
        overflow: auto;
        padding: 7px;
        white-space: pre-wrap;
      }
      #${ROOT_ID} .cno-log-error { color: var(--color-token-charts-red); }
      #${ROOT_ID} .cno-log-warn { color: var(--color-token-charts-yellow); }
      #${ROOT_ID} .cno-log-success { color: var(--color-token-charts-green); }
      #${ROOT_ID} .cno-empty {
        color: var(--color-token-text-secondary);
        padding: 12px;
      }
      #${ROOT_ID} .cno-field {
        display: grid;
        gap: 6px;
      }
      #${ROOT_ID} .cno-field-label {
        color: var(--color-token-text-secondary);
        font-size: 11px;
        font-weight: 600;
      }
      .cno-settings-content-host {
        position: relative;
      }
      .cno-native-settings-panel {
        background: var(--color-token-main-surface-primary);
        color: var(--color-token-text-primary);
        inset: 0;
        position: absolute;
        z-index: 20;
      }
      .cno-settings-nav-row {
        align-items: center;
        background: transparent;
        border: 0;
        border-radius: var(--radius-lg, 8px);
        color: var(--color-token-text-secondary);
        cursor: pointer;
        display: flex;
        font: inherit;
        gap: 8px;
        min-height: 34px;
        padding: var(--padding-row-y, 5px) var(--padding-row-x, 10px);
        position: relative;
        text-align: left;
        width: 100%;
      }
      .cno-settings-nav-row:hover,
      .cno-settings-nav-row.is-active {
        background: var(--color-token-list-active-selection-background, var(--color-token-list-hover-background));
        color: var(--color-token-text-primary);
      }
      .cno-settings-surface {
        background: var(--color-background-panel, var(--color-token-bg-fog));
        border: 1px solid var(--color-token-border);
        border-radius: var(--radius-lg, 8px);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .cno-settings-row {
        align-items: center;
        border-bottom: 0.5px solid var(--color-token-border);
        display: flex;
        gap: 16px;
        justify-content: space-between;
        padding: 12px;
      }
      .cno-settings-row:last-child {
        border-bottom: 0;
      }
      .cno-settings-row-clickable {
        cursor: pointer;
      }
      .cno-settings-row-clickable:hover {
        background: var(--color-token-list-hover-background);
      }
      .cno-settings-row-stacked {
        align-items: stretch;
        flex-direction: column;
      }
      .cno-settings-row-copy {
        display: flex;
        flex: 1;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }
      .cno-settings-label {
        color: var(--color-token-text-primary);
        font-size: var(--text-sm, 14px);
      }
      .cno-settings-description {
        color: var(--color-token-text-secondary);
        font-size: var(--text-sm, 14px);
      }
      .cno-settings-control {
        align-items: center;
        display: flex;
        flex-shrink: 0;
        justify-content: flex-end;
      }
      .cno-native-settings-panel .cno-input {
        background: var(--color-token-input-background);
        border: 1px solid var(--color-token-input-border, var(--color-token-border));
        border-radius: var(--radius-lg, 8px);
        color: var(--color-token-input-foreground, var(--color-token-text-primary));
        font: inherit;
        outline: none;
        padding: 8px 10px;
      }
      .cno-native-settings-panel .cno-input:focus {
        border-color: var(--color-token-focus-border);
      }
      .cno-native-settings-panel .cno-number-input {
        width: 120px;
      }
      .cno-native-settings-panel .cno-template-input {
        min-height: 132px;
        resize: vertical;
        width: 100%;
      }
      @media (max-width: 900px) {
        #${ROOT_ID} .cno-page {
          grid-template-columns: 1fr;
        }
        .cno-settings-row {
          align-items: stretch;
          flex-direction: column;
        }
        .cno-settings-control {
          justify-content: stretch;
        }
        .cno-native-settings-panel .cno-number-input {
          width: 100%;
        }
      }
    `;
    document.head.append(style);
  }

  function createRoot() {
    if (document.getElementById(ROOT_ID)) {
      return;
    }
    createStyle();
    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = `
      <section class="cno-shell" aria-label="Orchestrations">
        <div class="cno-header">
          <div class="cno-heading" data-role="page-heading">Orchestrations</div>
          <button class="cno-close" type="button" data-role="close" data-allow-while-busy="true" title="Close">x</button>
        </div>
        <div class="cno-page cno-page-orchestrator">
          <div class="cno-section">
            <div class="cno-grid">
              <input type="text" data-role="title" placeholder="Orchestration title" />
              <textarea data-role="task" placeholder="Task to send to each selected project"></textarea>
              <input type="text" data-role="filter" placeholder="Filter projects by name or path" />
            </div>
            <div class="cno-row">
              <label class="cno-check"><input type="checkbox" data-role="start-turns" /> Start turns</label>
              <div class="cno-actions">
                <button class="cno-button" type="button" data-role="refresh">Refresh</button>
                <button class="cno-button" type="button" data-role="select-visible">Select visible</button>
                <button class="cno-button" type="button" data-role="clear">Clear</button>
              </div>
            </div>
            <div class="cno-project-list" data-role="project-list"></div>
            <div class="cno-status" data-role="status"></div>
            <div class="cno-actions">
              <button class="cno-button cno-primary" type="button" data-role="start">Create child chats</button>
              <button class="cno-button" type="button" data-role="open-settings">Settings</button>
            </div>
          </div>
          <div class="cno-section">
            <div class="cno-log" data-role="log"></div>
          </div>
        </div>
        <div class="cno-page cno-page-swarm">
          <div class="cno-section">
            <div class="cno-grid">
              <textarea data-role="swarm-goal" placeholder="Swarm goal or project creation request"></textarea>
            </div>
            <div class="cno-swarm-topology" data-role="swarm-topology"></div>
            <div class="cno-status" data-role="swarm-status">Swarm uses the configured Cerebras Gemma manager and worker defaults.</div>
            <div class="cno-actions">
              <button class="cno-button cno-primary" type="button" data-role="start-swarm">Start swarm parent chat</button>
              <button class="cno-button" type="button" data-role="open-swarm-settings">Swarm settings</button>
            </div>
          </div>
          <div class="cno-section">
            <div class="cno-swarm-run-list" data-role="swarm-run-list"></div>
          </div>
        </div>
      </section>
    `;
    document.body.append(root);

    root.querySelector('[data-role="close"]').addEventListener("click", closePage);
    root.querySelector('[data-role="refresh"]').addEventListener("click", refreshProjects);
    root.querySelector('[data-role="select-visible"]').addEventListener("click", selectVisible);
    root.querySelector('[data-role="clear"]').addEventListener("click", clearSelected);
    root.querySelector('[data-role="start"]').addEventListener("click", startOrchestration);
    root.querySelector('[data-role="open-settings"]').addEventListener("click", () => showPage("settings"));
    root.querySelector('[data-role="start-swarm"]').addEventListener("click", startSwarmRun);
    root.querySelector('[data-role="open-swarm-settings"]').addEventListener("click", () => {
      navigateNativeRoute("/settings/swarm");
      window.dispatchEvent(new CustomEvent("codex-native-settings-route", { detail: { id: "swarm" } }));
    });
    root.querySelector('[data-role="title"]').addEventListener("input", (event) => {
      state.title = event.target.value;
      saveDraft();
    });
    root.querySelector('[data-role="task"]').addEventListener("input", (event) => {
      state.task = event.target.value;
      saveDraft();
    });
    root.querySelector('[data-role="filter"]').addEventListener("input", (event) => {
      state.filter = event.target.value;
      saveDraft();
      renderProjectList();
    });
    root.querySelector('[data-role="swarm-goal"]').addEventListener("input", (event) => {
      state.swarmGoal = event.target.value;
      saveDraft();
    });
    root.querySelector('[data-role="start-turns"]').addEventListener("change", (event) => {
      state.startTurns = event.target.checked;
      saveDraft();
      renderAll();
    });
    renderAll();
    installSidebarButtons();
    window.addEventListener("resize", updateMainBounds);
    window.addEventListener("codex-native-settings-tab", handleNativeSettingsTabEvent);
    window.addEventListener("codex-native-settings-route", handleNativeSettingsTabEvent);
    window.addEventListener("codex-native-patcher-settings-changed", () => {
      installSidebarButtons();
      if (state.open && state.page === "orchestrator" && !patcherFeatureEnabled("orchestrations", true)) {
        closePage();
      }
      if (state.open && state.page === "swarm" && !patcherFeatureEnabled("swarm", true)) {
        closePage();
      }
    });
    window.addEventListener("popstate", scheduleNativeIntegrationBurst);
    window.addEventListener("hashchange", scheduleNativeIntegrationBurst);
    document.addEventListener("click", scheduleNativeIntegrationBurst, true);
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" || event.key === "Enter") {
          scheduleNativeIntegrationBurst();
        }
      },
      true
    );
    startSidebarObserver();
    startNativeSettingsRouteObserver();
    tickNativeIntegration();
    recoverSidebarIntegration();
    recoverActiveNativeSettingsRoute();
    pushLog("Native orchestrations loaded.");
  }

  function init() {
    loadDraft();
    loadChildThreads();
    loadSwarmRuns();
    if (document.body) {
      createRoot();
      return;
    }
    window.addEventListener("DOMContentLoaded", createRoot, { once: true });
  }

  window.__codexNativeOrchestrator = {
    refreshProjects,
    startOrchestration,
    startSwarmRun,
    openSwarm: () => showPage("swarm"),
    openSettingsRoute: openOrchestrationsSettingsRoutePanel,
    state,
  };

  init();
})();
