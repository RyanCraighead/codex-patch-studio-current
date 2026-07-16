(function () {
  "use strict";

  const ROOT_ID = "codex-native-patcher-settings";
  const PATCHER_ROUTE_HOST_ID = "codex-native-patcher-settings-route";
  const FEATURE_ROUTE_HOST_ID = "codex-native-feature-development-settings-route";
  const STORAGE_KEY = "codex-native-patcher-settings:v1";
  const PATCH_MANAGER_BASE = "http://127.0.0.1:4590";

  const RUNTIME_FEATURES = [
    {
      id: "providers",
      label: "Providers",
      description: "Show the native Providers settings page and provider/model controls.",
      navLabel: "Providers",
      defaultEnabled: true,
    },
    {
      id: "autoRouter",
      label: "Auto Router",
      description: "Show Auto in the chat model picker and enable automatic model routing controls.",
      navLabel: "Auto Router",
      defaultEnabled: true,
    },
    {
      id: "promptTools",
      label: "Prompt Tools",
      description: "Show prompt inspection, review prompt, and default prompt modifier controls.",
      navLabel: "Prompt Tools",
      defaultEnabled: true,
    },
    {
      id: "personas",
      label: "Personas",
      description: "Show reusable persona settings and runtime persona injection controls.",
      navLabel: "Personas",
      defaultEnabled: true,
    },
    {
      id: "orchestrations",
      label: "Orchestrations",
      description: "Show the Orchestrations sidebar group and settings page.",
      navLabel: "Orchestrations",
      defaultEnabled: true,
    },
    {
      id: "swarm",
      label: "Swarm",
      description: "Show the Swarm sidebar group and hierarchical agent settings.",
      navLabel: "Swarm",
      defaultEnabled: true,
    },
    {
      id: "imports",
      label: "Imports",
      description: "Show the native Imports settings page for Augment, Kiro, Roo Code, and Cline.",
      navLabel: "Imports",
      defaultEnabled: true,
    },
    {
      id: "modelPickerEnhancer",
      label: "Model picker enhancer",
      description: "Add configured third-party provider models to the chat model picker.",
      defaultEnabled: true,
    },
  ];

  const BUILD_FEATURES = [
    {
      id: "catalogShim",
      label: "All chats performance shim",
      description: "Load the complete lightweight task catalog while hydrating old conversation bodies only when opened.",
      defaultEnabled: true,
    },
    {
      id: "chatLimit",
      label: "Legacy eager history hydration",
      description: "Hydrate a large native sidebar window eagerly. This can lag badly and cannot be combined with the shim.",
      defaultEnabled: false,
    },
    {
      id: "remoteControl",
      label: "Enable remote control",
      description: "Keep app-server remote_control enabled.",
      defaultEnabled: true,
    },
    {
      id: "remoteControlSettings",
      label: "Show remote control setting",
      description: "Expose the remote_control feature in native settings.",
      defaultEnabled: true,
    },
    {
      id: "nativeOrchestrator",
      label: "Native orchestrations",
      description: "Inject the Orchestrations sidebar/settings patch.",
      defaultEnabled: true,
    },
    {
      id: "providerSettings",
      label: "Provider/model settings",
      description: "Inject provider settings and model picker integration.",
      defaultEnabled: true,
    },
    {
      id: "importSettings",
      label: "Native chat imports",
      description: "Inject the native Imports settings page.",
      defaultEnabled: true,
    },
    {
      id: "patcherSettings",
      label: "Native patcher controls",
      description: "Inject this Patcher settings page and Help menu entry.",
      defaultEnabled: true,
    },
    {
      id: "forceMainWindowStartup",
      label: "Force main window on launch",
      description: "Force-open a visible main Codex window on startup.",
      defaultEnabled: false,
    },
    {
      id: "shortcut",
      label: "Desktop shortcut",
      description: "Create or refresh the patched Codex shortcut.",
      defaultEnabled: true,
    },
  ];

  const FEATURE_ALIASES = {
    providerSettings: "providers",
    nativeOrchestrator: "orchestrations",
    importSettings: "imports",
  };

  const state = {
    status: "Patcher controls loaded.",
    error: "",
    busy: false,
    bridge: "unknown",
    bridgeMessage: "Patch Manager not checked yet.",
    patchStatus: null,
    updatePolicy: "notify",
    updatePolicyConfigured: false,
    updateState: null,
    updateStateError: "",
    updateCheckedAt: 0,
    featureModules: { ok: true, modules: [] },
    featureDevelopment: { ok: true, modules: [] },
    featureDevelopmentError: "",
    featureAction: null,
    featureBusy: false,
    localFeatureId: "local.",
    conversionSourceId: "",
    contributionFeatureId: "",
    worktreeFeatureId: "",
    lastJob: null,
    runtimeFeatures: Object.fromEntries(RUNTIME_FEATURES.map((feature) => [feature.id, feature.defaultEnabled])),
    buildFeatures: Object.fromEntries(BUILD_FEATURES.map((feature) => [feature.id, feature.defaultEnabled])),
    limit: 1000,
    sourceMode: "current",
    outputRoot: "",
    shortcutName: "Codex Patch Studio Current",
    shortcutDir: "",
    keepWork: false,
  };

  let syncTimer = null;
  let routeObserver = null;

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function defaultRuntimeFeatures() {
    return Object.fromEntries(RUNTIME_FEATURES.map((feature) => [feature.id, feature.defaultEnabled]));
  }

  function defaultBuildFeatures() {
    return Object.fromEntries(BUILD_FEATURES.map((feature) => [feature.id, feature.defaultEnabled]));
  }

  function readStoredSettings() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
    } catch {
      return {};
    }
  }

  function loadSettings() {
    const stored = readStoredSettings();
    if (stored.runtimeFeatures && typeof stored.runtimeFeatures === "object") {
      state.runtimeFeatures = { ...defaultRuntimeFeatures(), ...stored.runtimeFeatures };
    }
    if (stored.buildFeatures && typeof stored.buildFeatures === "object") {
      state.buildFeatures = { ...defaultBuildFeatures(), ...stored.buildFeatures };
    }
    state.limit = clampNumber(stored.limit, 50, 10000, state.limit);
    state.sourceMode = "current";
    const storedOutputRoot = typeof stored.outputRoot === "string" ? stored.outputRoot.trim() : "";
    state.outputRoot = storedOutputRoot || state.outputRoot;
    state.shortcutName = typeof stored.shortcutName === "string" && stored.shortcutName.trim() ? stored.shortcutName : state.shortcutName;
    state.shortcutDir = typeof stored.shortcutDir === "string" ? stored.shortcutDir : state.shortcutDir;
    state.keepWork = stored.keepWork === true;
    state.updatePolicy = ["off", "notify", "auto"].includes(stored.updatePolicy) ? stored.updatePolicy : state.updatePolicy;
  }

  function saveSettings() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          runtimeFeatures: state.runtimeFeatures,
          buildFeatures: state.buildFeatures,
          limit: state.limit,
          sourceMode: state.sourceMode,
          outputRoot: state.outputRoot,
          shortcutName: state.shortcutName,
          shortcutDir: state.shortcutDir,
          keepWork: state.keepWork,
          updatePolicy: state.updatePolicy,
        })
      );
    } catch {
      // Ignore localStorage failures in the native webview.
    }
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.round(number)));
  }

  function isEnabled(featureId, fallback = true) {
    const mapped = FEATURE_ALIASES[featureId] || featureId;
    if (Object.prototype.hasOwnProperty.call(state.runtimeFeatures, mapped)) {
      return state.runtimeFeatures[mapped] !== false;
    }
    return fallback;
  }

  function featureCount(features) {
    return Object.values(features).filter((value) => value !== false).length;
  }

  function statusKind() {
    if (state.error) return "bad";
    if (state.busy) return "pending";
    return "ok";
  }

  function bridgeKind() {
    if (state.bridge === "online") return "ok";
    if (state.bridge === "offline") return "bad";
    return "muted";
  }

  async function fetchPatchManager(path, options = {}, timeoutMs = 12000) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${PATCH_MANAGER_BASE}${path}`, {
        cache: "no-store",
        ...options,
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        let detail = text;
        try {
          const parsed = JSON.parse(text);
          const logs = Array.isArray(parsed.logs) ? `\n${parsed.logs.join("\n")}` : "";
          detail = `${parsed.error || text}${logs}`;
        } catch {
          // Keep the plain response body when it is not JSON.
        }
        throw new Error(`${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`);
      }
      return response.json();
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function applyFeatureDevelopmentSnapshot(snapshot) {
    state.featureDevelopment = snapshot || { ok: false, error: "Feature Development returned no status.", modules: [] };
    state.featureModules = state.featureDevelopment;
    state.featureDevelopmentError = state.featureDevelopment.ok ? "" : state.featureDevelopment.error || "Feature catalog is invalid.";
    const modules = Array.isArray(state.featureDevelopment.modules) ? state.featureDevelopment.modules : [];
    const localModules = modules.filter((feature) => feature.kind === "local");
    if (!localModules.some((feature) => feature.id === state.conversionSourceId)) {
      state.conversionSourceId = localModules[0]?.id || "";
    }
    if (!modules.some((feature) => feature.id === state.worktreeFeatureId)) {
      state.worktreeFeatureId = localModules[0]?.id || modules.find((feature) => feature.kind === "contribution")?.id || modules[0]?.id || "";
    }
  }

  async function refreshFeatureDevelopment({ renderAfter = true, showBusy = true } = {}) {
    if (showBusy) state.featureBusy = true;
    state.featureDevelopmentError = "";
    if (renderAfter) render();
    try {
      const snapshot = await fetchPatchManager("/api/patch/feature-development", {}, 30000);
      applyFeatureDevelopmentSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      state.featureDevelopmentError = error.message || String(error);
      state.featureDevelopment = { ok: false, error: state.featureDevelopmentError, modules: [] };
      throw error;
    } finally {
      if (showBusy) state.featureBusy = false;
      if (renderAfter) render();
    }
  }

  async function refreshBridge({ renderAfter = true } = {}) {
    state.busy = true;
    state.error = "";
    state.status = "Checking Patch Manager bridge...";
    if (renderAfter) render();
    try {
      state.patchStatus = await fetchPatchManager("/api/patch/status");
      state.featureModules = state.patchStatus?.featureModules || { ok: true, modules: [] };
      state.bridge = "online";
      state.bridgeMessage = "Patch Manager bridge is online.";
      const updatePolicy = state.patchStatus?.updatePolicy;
      if (updatePolicy) {
        state.updatePolicy = ["off", "notify", "auto"].includes(updatePolicy.policy) ? updatePolicy.policy : "notify";
        state.updatePolicyConfigured = updatePolicy.configured === true;
      }
      const defaults = state.patchStatus?.defaults;
      const stored = readStoredSettings();
      if (!stored.buildFeatures && defaults?.features && typeof defaults.features === "object") {
        for (const feature of BUILD_FEATURES) {
          if (Object.prototype.hasOwnProperty.call(defaults.features, feature.id)) {
            state.buildFeatures[feature.id] = defaults.features[feature.id] !== false;
          }
        }
      }
      if (!state.outputRoot && defaults?.outputRoot) state.outputRoot = String(defaults.outputRoot);
      if (!stored.shortcutName && defaults?.shortcutName) state.shortcutName = String(defaults.shortcutName);
      if (!stored.limit && defaults?.limit) state.limit = clampNumber(defaults.limit, 50, 10000, state.limit);
      state.status = "Patch Manager bridge online.";
      saveSettings();
      if (state.updatePolicy !== "off") try {
        state.updateState = await fetchPatchManager(
          "/api/patch/update/check",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refreshRemote: false }),
          },
          120000
        );
        state.updateStateError = "";
        state.updateCheckedAt = Date.now();
      } catch (updateError) {
        state.updateStateError = updateError.message || String(updateError);
      } else {
        state.updateState = null;
        state.updateStateError = "";
      }
      try {
        await refreshFeatureDevelopment({ renderAfter: false, showBusy: false });
      } catch (featureError) {
        state.featureDevelopmentError = featureError.message || String(featureError);
      }
    } catch (error) {
      state.bridge = "offline";
      state.bridgeMessage = `Patch Manager is not reachable at ${PATCH_MANAGER_BASE}. Relaunch Codex Patch Studio Current or run npm run dev:codex from the patcher repository. ${error.message || error}`;
      state.status = state.bridgeMessage;
    } finally {
      state.busy = false;
      if (renderAfter) render();
    }
  }

  function patchPayload() {
    return {
      limit: state.limit,
      sourceMode: state.sourceMode,
      outputRoot: state.outputRoot,
      shortcutName: state.shortcutName,
      shortcutDir: state.shortcutDir,
      keepWork: state.keepWork,
      features: { ...state.buildFeatures },
    };
  }

  async function persistUpdatePolicy(policy) {
    if (!["off", "notify", "auto"].includes(policy) || state.busy) return;
    state.busy = true;
    state.error = "";
    state.status = "Saving Codex update policy...";
    render();
    try {
      const result = await fetchPatchManager("/api/patch/update-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy }),
      });
      state.updatePolicy = result.policy || policy;
      state.updatePolicyConfigured = result.configured === true;
      state.status = `Update policy saved: ${state.updatePolicy}.`;
      saveSettings();
    } catch (error) {
      state.error = error.message || String(error);
      state.status = state.error;
    } finally {
      state.busy = false;
      render();
    }
  }

  async function checkForCodexUpdate() {
    if (state.busy) return;
    state.busy = true;
    state.error = "";
    state.updateStateError = "";
    state.status = "Checking the installed Codex build...";
    render();
    try {
      state.updateState = await fetchPatchManager(
        "/api/patch/update/check",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshRemote: true }),
        },
        120000
      );
      state.updateCheckedAt = Date.now();
      try {
        await refreshFeatureDevelopment({ renderAfter: false, showBusy: false });
      } catch (featureError) {
        state.featureDevelopmentError = featureError.message || String(featureError);
      }
      state.status = state.updateState.remotePatcherUpdateAvailable
        ? "A newer patcher source release is available on GitHub."
        : state.updateState.needsBuild
          ? "A Codex or patch framework update requires a verified rebuild."
          : "The patched clone and repository channel are current.";
    } catch (error) {
      state.updateStateError = error.message || String(error);
      state.error = state.updateStateError;
      state.status = state.error;
    } finally {
      state.busy = false;
      render();
    }
  }

  function featureRequestId(action) {
    const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `feature-${action}-${random}`;
  }

  async function runFeatureDevelopmentAction(action, payload = {}) {
    if (state.featureBusy || state.busy) return null;
    state.featureBusy = true;
    state.error = "";
    state.featureDevelopmentError = "";
    state.status = `Running Feature Development command: ${action}...`;
    render();
    try {
      const result = await fetchPatchManager(
        "/api/patch/feature-development/action",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: featureRequestId(action), action, ...payload }),
        },
        ["create-local", "convert-contribution"].includes(action) ? 130000 : 30000
      );
      state.featureAction = result;
      state.status = result.message || `Feature Development command ${action} completed.`;
      if (result.status) applyFeatureDevelopmentSnapshot(result.status);
      if (result.job) state.lastJob = result.job;
      return result;
    } catch (error) {
      state.error = error.message || String(error);
      state.status = state.error;
      state.featureAction = { ok: false, action, message: state.error, logs: [state.error] };
      return null;
    } finally {
      state.featureBusy = false;
      render();
    }
  }

  async function persistFeatureModule(id, enabled) {
    return runFeatureDevelopmentAction("set-enabled", { id, enabled });
  }

  async function applyCodexUpdate() {
    if (state.busy) return;
    if (!window.confirm("Build and verify a new patched clone now? The current verified clone remains available if the build fails.")) return;
    state.busy = true;
    state.error = "";
    state.status = "Queueing a verified rebuild. This patched window will close and relaunch if validation succeeds.";
    render();
    try {
      const job = await fetchPatchManager(
        "/api/patch/update/apply",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
        30000
      );
      state.lastJob = job;
      state.status = `Verified update job started: ${job.id || "job"}.`;
    } catch (error) {
      state.error = error.message || String(error);
      state.status = state.error;
    } finally {
      state.busy = false;
      render();
    }
  }

  async function startPatchBuild() {
    if (state.busy) return;
    if (!window.confirm("Build and verify a new patched Codex clone with these feature settings?")) return;
    state.busy = true;
    state.error = "";
    state.status = "Starting native patch build...";
    render();
    try {
      const job = await fetchPatchManager(
        "/api/patch/build",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patchPayload()),
        },
        30000
      );
      state.lastJob = job;
      state.bridge = "online";
      state.status = `Patch build started: ${job.id || "job"}`;
    } catch (error) {
      state.error = error.message || String(error);
      state.status = state.error;
    } finally {
      state.busy = false;
      render();
    }
  }

  async function launchCurrentPatchedCodex() {
    state.busy = true;
    state.error = "";
    state.status = "Launching current patched Codex...";
    render();
    try {
      const result = await fetchPatchManager(
        "/api/patch/launch",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        30000
      );
      state.status = `Launch requested. PID ${result.pid || "unknown"}.`;
      state.bridge = "online";
    } catch (error) {
      state.error = error.message || String(error);
      state.status = state.error;
    } finally {
      state.busy = false;
      render();
    }
  }

  function openPatchManager() {
    window.open(PATCH_MANAGER_BASE, "_blank", "noopener,noreferrer");
  }

  function dispatchSettingsChanged() {
    window.dispatchEvent(
      new CustomEvent("codex-native-patcher-settings-changed", {
        detail: {
          runtimeFeatures: { ...state.runtimeFeatures },
          buildFeatures: { ...state.buildFeatures },
        },
      })
    );
  }

  function findSettingsNavigation() {
    const explicit = document.querySelector('nav[aria-label="Settings"]');
    if (explicit) return explicit;
    const matches = Array.from(document.querySelectorAll("aside, nav, div")).filter((element) => {
      const text = normalizedText(element);
      if (!text.includes("General") || !text.includes("Appearance") || !text.includes("Configuration")) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.left <= 430 && rect.width >= 180 && rect.width <= 430 && rect.height >= window.innerHeight * 0.4;
    });
    return (
      matches.sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.width * ar.height - br.width * br.height;
      })[0] || null
    );
  }

  function normalizedText(element) {
    return String(element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function textCandidates(root) {
    return Array.from(root.querySelectorAll("button, a, [role='button'], [role='tab'], [role='menuitem'], span, div"));
  }

  function findTextRowIn(root, text) {
    const target = text.toLowerCase();
    const matches = textCandidates(root).filter((element) => normalizedText(element).toLowerCase() === target);
    for (const match of matches) {
      let node = match;
      while (node && node !== root.parentElement && node !== document.body) {
        const rect = node.getBoundingClientRect();
        if (rect.width >= 120 && rect.height >= 24 && rect.height <= 56) {
          return node;
        }
        node = node.parentElement;
      }
    }
    return null;
  }

  function applySettingsNavVisibility() {
    const nav = findSettingsNavigation();
    if (!nav) return;
    for (const feature of RUNTIME_FEATURES) {
      if (!feature.navLabel) continue;
      const row = findTextRowIn(nav, feature.navLabel);
      if (!row) continue;
      const enabled = isEnabled(feature.id, true);
      row.dataset.codexPatcherFeature = feature.id;
      row.hidden = !enabled;
      row.style.display = enabled ? "" : "none";
    }
  }

  function scheduleSync() {
    window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(() => {
      applySettingsNavVisibility();
      const host = routeHost();
      if (host && host.dataset.cpxRendered !== "1") {
        render();
      }
    }, 60);
  }

  function activeRouteId() {
    if (document.getElementById(FEATURE_ROUTE_HOST_ID) || window.location.pathname.replace(/\/+$/, "") === "/settings/feature-development") {
      return "feature-development";
    }
    if (document.getElementById(PATCHER_ROUTE_HOST_ID) || window.location.pathname.replace(/\/+$/, "") === "/settings/patcher") {
      return "patcher";
    }
    return "";
  }

  function routeHost(routeId = activeRouteId()) {
    return document.getElementById(routeId === "feature-development" ? FEATURE_ROUTE_HOST_ID : PATCHER_ROUTE_HOST_ID);
  }

  function activeRoute() {
    return Boolean(activeRouteId());
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

  function pill(label, value, kind = "muted") {
    return `
      <span class="cpx-pill is-${escapeHtml(kind)}">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </span>
    `;
  }

  function toggleRow(feature, group) {
    const enabled = group === "runtime" ? isEnabled(feature.id, feature.defaultEnabled) : state.buildFeatures[feature.id] !== false;
    const attr = group === "runtime" ? "data-runtime-feature" : "data-build-feature";
    return `
      <label class="cpx-toggle-row">
        <span class="cpx-toggle-copy">
          <span>${escapeHtml(feature.label)}</span>
          <small>${escapeHtml(feature.description)}</small>
        </span>
        <input type="checkbox" ${attr}="${escapeHtml(feature.id)}"${enabled ? " checked" : ""}>
      </label>
    `;
  }

  function buildManagerSummary() {
    const config = state.patchStatus?.launcherConfig;
    const features = config?.features || {};
    const enabled = Object.entries(features).filter(([, value]) => value !== false).map(([key]) => key);
    if (!config) {
      return `<div class="cpx-empty">No launcher config loaded from Patch Manager yet.</div>`;
    }
    return `
      <div class="cpx-config-grid">
        <span>Clone</span><strong>${escapeHtml(config.cloneRoot || "Unknown")}</strong>
        <span>Desktop executable</span><strong>${escapeHtml(config.codexExe || "Unknown")}</strong>
        <span>Built</span><strong>${escapeHtml(config.builtAt || "Unknown")}</strong>
        <span>Features</span><strong>${escapeHtml(enabled.join(", ") || "None")}</strong>
      </div>
    `;
  }

  function updatePolicyOption(id, label, description) {
    const selected = state.updatePolicy === id;
    return `
      <label class="cpx-policy-option${selected ? " is-selected" : ""}">
        <input type="radio" name="cpx-update-policy" value="${escapeHtml(id)}" data-update-policy${selected ? " checked" : ""}>
        <span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(description)}</small></span>
      </label>
    `;
  }

  function updateStateSummary() {
    if (state.updateStateError) {
      return `<div class="cpx-note cpx-note-bad">${escapeHtml(state.updateStateError)}</div>`;
    }
    if (!state.updateState) {
      return `<div class="cpx-note">Update state has not been checked yet.</div>`;
    }
    const reasons = Array.isArray(state.updateState.reasons) ? state.updateState.reasons : [];
    const remote = state.updateState.remoteUpdate;
    const repository = remote?.repository || {};
    const compatibility = remote?.compatibility || {};
    const network = remote?.network || {};
    const repositoryState = repository.updateAvailable
      ? `Update available (${repository.remoteVersion || "new source"})`
      : repository.diverged
        ? "Local source differs"
      : network.source === "policy-off" || network.source === "channel-disabled"
        ? "Check disabled"
        : network.reachable || String(network.source || "").startsWith("cache")
          ? "Current"
          : "Unavailable";
    const compatibilityLabels = {
      verified: "Verified exact build",
      "fingerprint-mismatch": "Version known, fingerprint differs",
      pending: "Not yet repository-verified",
      "not-checked": "Not checked",
      unknown: "Unknown",
    };
    return `
      <div class="cpx-config-grid">
        <span>Installed Codex</span><strong>${escapeHtml(state.updateState.installedVersion || "Unknown")}</strong>
        <span>Patched Codex</span><strong>${escapeHtml(state.updateState.patchedVersion || "Not built")}</strong>
        <span>Build state</span><strong>${state.updateState.needsBuild ? "Rebuild required" : "Current"}</strong>
        <span>Reason</span><strong>${escapeHtml(reasons.join(", ") || "No changes detected")}</strong>
        <span>GitHub patcher</span><strong>${escapeHtml(repositoryState)}</strong>
        <span>Repository Codex support</span><strong>${escapeHtml(compatibilityLabels[compatibility.status] || compatibility.status || "Unknown")}</strong>
        <span>Channel source</span><strong>${escapeHtml(network.source || "Not checked")}</strong>
      </div>
      ${network.warning ? `<div class="cpx-note">${escapeHtml(network.warning)} Local validation and the last-known-good clone remain available.</div>` : ""}
    `;
  }

  function featureResultKind(status) {
    if (["passed", "compatible", "completed"].includes(status)) return "ok";
    if (["failed", "incompatible"].includes(status)) return "bad";
    if (["pending", "running"].includes(status)) return "pending";
    return "muted";
  }

  function featureBadge(label, status, detail = "") {
    const value = String(status || "unknown");
    return `<span class="cpx-feature-badge is-${featureResultKind(value)}"${detail ? ` title="${escapeHtml(detail)}"` : ""}><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></span>`;
  }

  function featureModuleEnabled(feature) {
    const settingIds = Array.isArray(feature.legacyFeatureIds) ? feature.legacyFeatureIds : [];
    if (feature.kind === "core" && settingIds.length) {
      return settingIds.every((id) => state.buildFeatures[id] !== false);
    }
    return feature.enabled !== false;
  }

  function featureModuleToggle(feature) {
    const checked = featureModuleEnabled(feature) ? " checked" : "";
    const disabled = state.featureBusy || state.busy ? " disabled" : "";
    if (feature.configurable) {
      return `<label class="cpx-feature-toggle"><span>Enabled</span><input type="checkbox" data-feature-module="${escapeHtml(feature.id)}"${checked}${disabled}></label>`;
    }
    if (feature.kind === "core" && feature.legacyFeatureIds?.length) {
      return `<label class="cpx-feature-toggle"><span>Enabled</span><input type="checkbox" data-core-feature-module="${escapeHtml(feature.id)}"${checked}${disabled}></label>`;
    }
    return `<label class="cpx-feature-toggle" title="Required framework module"><span>Required</span><input type="checkbox" checked disabled></label>`;
  }

  function featureModuleRow(feature) {
    const source = feature.source || {};
    const repository = source.repository || source.modulePath || "Unknown source";
    const commit = source.commit ? `${String(source.commit).slice(0, 10)}${source.dirty ? " (dirty)" : ""}` : "Uncommitted";
    const compatibility = feature.compatibility || {};
    const supportedVersions = Array.isArray(compatibility.versions) ? compatibility.versions : [];
    const compatibilityTitle = compatibility.sourceVersion
      ? supportedVersions.length
        ? `Codex ${compatibility.sourceVersion}; exact adapters: ${supportedVersions.join(", ")}`
        : `Codex ${compatibility.sourceVersion}; supported ${compatibility.minimum || "any"} through ${compatibility.maximum || "current"}`
      : "Build Codex once to determine compatibility.";
    return `
      <div class="cpx-feature-row">
        <div class="cpx-feature-copy">
          <div class="cpx-feature-title">
            <strong>${escapeHtml(feature.name || feature.id)}</strong>
            <span>${escapeHtml(feature.kind)}</span>
            <span>v${escapeHtml(feature.version || "0.0.0")}</span>
          </div>
          <small>${escapeHtml(feature.description || feature.id)}</small>
          <div class="cpx-feature-meta">
            <span title="${escapeHtml(repository)}"><b>Source</b> ${escapeHtml(repository)}</span>
            <span title="${escapeHtml(source.commit || "")}"><b>Commit</b> ${escapeHtml(commit)}</span>
          </div>
          <div class="cpx-feature-results">
            ${featureBadge("Compatibility", compatibility.status, compatibilityTitle)}
            ${featureBadge("Build", feature.build?.status, feature.build?.detail)}
            ${featureBadge("Test", feature.test?.status, feature.test?.detail)}
          </div>
        </div>
        ${featureModuleToggle(feature)}
      </div>
    `;
  }

  function featureModuleGroup(kind, label) {
    const modules = (state.featureDevelopment?.modules || []).filter((feature) => feature.kind === kind);
    return `
      <div class="cpx-feature-group">
        <div class="cpx-feature-group-head"><strong>${escapeHtml(label)}</strong><span>${modules.length}</span></div>
        ${modules.length ? modules.map(featureModuleRow).join("") : `<div class="cpx-empty">No ${escapeHtml(label.toLowerCase())} modules installed.</div>`}
      </div>
    `;
  }

  function featureOptions(modules, selectedId) {
    if (!modules.length) return `<option value="">No modules available</option>`;
    return modules.map((feature) => `<option value="${escapeHtml(feature.id)}"${feature.id === selectedId ? " selected" : ""}>${escapeHtml(feature.name || feature.id)} (${escapeHtml(feature.id)})</option>`).join("");
  }

  function featureActionLog() {
    if (!state.featureAction) return "";
    const logs = Array.isArray(state.featureAction.logs) ? state.featureAction.logs : [];
    return `
      <div class="cpx-feature-log-head"><strong>${escapeHtml(state.featureAction.message || "Feature command result")}</strong></div>
      <pre class="cpx-feature-log">${escapeHtml(logs.join("\n") || "Command completed without additional output.")}</pre>
    `;
  }

  function featureDevelopmentPanel() {
    const snapshot = state.featureDevelopment || { modules: [] };
    const modules = Array.isArray(snapshot.modules) ? snapshot.modules : [];
    const localModules = modules.filter((feature) => feature.kind === "local");
    const actionableModules = modules.filter((feature) => feature.source?.worktree || feature.source?.modulePath);
    const lastBuild = snapshot.lastBuild;
    return `
      <section class="cpx-band cpx-wide">
        <div class="cpx-band-head">
          <div>
            <strong>Feature Development</strong>
            <small>Installed source modules, compatibility, provenance, and packed verification results.</small>
          </div>
          <button class="cpx-button cpx-button-sm" type="button" data-action="refresh-features" ${state.featureBusy || state.busy || state.bridge !== "online" ? "disabled" : ""}>Refresh modules</button>
        </div>
        ${state.featureDevelopmentError || snapshot.ok === false ? `<div class="cpx-note cpx-note-bad">${escapeHtml(state.featureDevelopmentError || snapshot.error || "Feature catalog is invalid.")}</div>` : `
          <div class="cpx-feature-overview">
            ${pill("Installed", modules.length, "accent")}
            ${pill("Codex", snapshot.sourceVersion || "Unknown", snapshot.sourceVersion ? "ok" : "muted")}
            ${pill("Last build", lastBuild?.status || "Not run", featureResultKind(lastBuild?.status || "unknown"))}
          </div>
          <div class="cpx-feature-groups">
            ${featureModuleGroup("core", "Core")}
            ${featureModuleGroup("contribution", "Community")}
            ${featureModuleGroup("local", "Local")}
          </div>
        `}
        <div class="cpx-feature-commands">
          <div class="cpx-command-row">
            <div><strong>Create local feature</strong><small>Scaffold a private module in a dedicated local worktree pinned to the current Codex version.</small></div>
            <div class="cpx-command-controls">
              <input class="cpx-input" type="text" data-local-feature-id value="${escapeHtml(state.localFeatureId)}" placeholder="local.my-feature" aria-label="Local feature ID">
              <button class="cpx-button" type="button" data-action="create-local-feature" ${state.featureBusy || state.busy || state.bridge !== "online" ? "disabled" : ""}>Create local feature</button>
            </div>
          </div>
          <div class="cpx-command-row">
            <div><strong>Convert to contribution</strong><small>Create a reviewable contribution worktree from a clean local feature workflow.</small></div>
            <div class="cpx-command-controls cpx-command-controls-three">
              <select class="cpx-input" data-conversion-source aria-label="Local feature">${featureOptions(localModules, state.conversionSourceId)}</select>
              <input class="cpx-input" type="text" data-contribution-feature-id value="${escapeHtml(state.contributionFeatureId)}" placeholder="publisher.my-feature" aria-label="Contribution feature ID">
              <button class="cpx-button" type="button" data-action="convert-contribution" ${state.featureBusy || state.busy || state.bridge !== "online" || !localModules.length ? "disabled" : ""}>Convert to contribution</button>
            </div>
          </div>
          <div class="cpx-command-row">
            <div><strong>Open worktree</strong><small>Open the selected module's validated Git worktree or source directory.</small></div>
            <div class="cpx-command-controls">
              <select class="cpx-input" data-worktree-feature aria-label="Feature worktree">${featureOptions(actionableModules, state.worktreeFeatureId)}</select>
              <button class="cpx-button" type="button" data-action="open-worktree" ${state.featureBusy || state.busy || state.bridge !== "online" || !actionableModules.length ? "disabled" : ""}>Open worktree</button>
            </div>
          </div>
          <div class="cpx-command-row">
            <div><strong>Rebuild patched Codex</strong><small>Start a new immutable clone build and keep the last verified clone on failure.</small></div>
            <div class="cpx-command-controls cpx-command-controls-button">
              <button class="cpx-button cpx-primary" type="button" data-action="rebuild-feature-codex" ${state.featureBusy || state.busy || state.bridge !== "online" ? "disabled" : ""}>Rebuild patched Codex</button>
            </div>
          </div>
        </div>
        ${featureActionLog()}
      </section>
    `;
  }

  function render() {
    const routeId = activeRouteId();
    const host = routeHost(routeId);
    applySettingsNavVisibility();
    if (!host) return;
    if (routeId === "feature-development") {
      host.innerHTML = `
        <section class="cpx-patcher-page">
          <header class="cpx-header">
            <div>
              <h1>Feature Development</h1>
              <p>Manage source modules and run the guarded Git, build, and verification workflows.</p>
            </div>
            <div class="cpx-header-actions">
              <button class="cpx-button" type="button" data-action="refresh-features" ${state.featureBusy || state.busy ? "disabled" : ""}>Refresh</button>
            </div>
          </header>
          <div class="cpx-summary">
            ${pill("Modules", (state.featureDevelopment?.modules || []).length, "accent")}
            ${pill("Codex", state.featureDevelopment?.sourceVersion || "Unknown", state.featureDevelopment?.sourceVersion ? "ok" : "muted")}
            ${pill("Patch Manager", state.bridge === "online" ? "Online" : state.bridge === "offline" ? "Offline" : "Unknown", bridgeKind())}
            ${pill("Status", state.featureBusy || state.busy ? "Working" : state.error ? "Error" : "Ready", statusKind())}
          </div>
          <div class="cpx-grid">${featureDevelopmentPanel()}</div>
        </section>
      `;
      host.dataset.cpxRendered = "1";
      bind(host);
      return;
    }
    const defaults = state.patchStatus?.defaults || {};
    host.innerHTML = `
      <section class="cpx-patcher-page">
        <header class="cpx-header">
          <div>
            <h1>Patcher</h1>
            <p>Control runtime visibility and build a user-controlled patched Codex clone.</p>
          </div>
          <div class="cpx-header-actions">
            <button class="cpx-button" type="button" data-action="refresh-bridge" ${state.busy ? "disabled" : ""}>Refresh</button>
            <button class="cpx-button" type="button" data-action="open-manager">Open Manager</button>
          </div>
        </header>

        <div class="cpx-summary">
          ${pill("Runtime features", `${featureCount(state.runtimeFeatures)} / ${RUNTIME_FEATURES.length}`, "ok")}
          ${pill("Build features", `${featureCount(state.buildFeatures)} / ${BUILD_FEATURES.length}`, "accent")}
          ${pill("Patch Manager", state.bridge === "online" ? "Online" : state.bridge === "offline" ? "Offline" : "Unknown", bridgeKind())}
          ${pill("Status", state.busy ? "Working" : state.error ? "Error" : "Ready", statusKind())}
        </div>

        <div class="cpx-grid">
          <section class="cpx-band cpx-wide">
            <div class="cpx-band-head">
              <div>
                <strong>Codex and patcher updates</strong>
                <small>Checks compare the installed Codex build locally and consult the cached GitHub compatibility channel. GitHub is force-refreshed only when you press Check now.</small>
              </div>
              <div class="cpx-band-actions">
                ${state.updateState?.remoteUpdate?.repository?.updateAvailable ? `<button class="cpx-button" type="button" data-action="open-patcher-release">Open release</button>` : ""}
                <button class="cpx-button" type="button" data-action="check-update" ${state.busy || state.bridge !== "online" ? "disabled" : ""}>Check Codex + GitHub</button>
                <button class="cpx-button cpx-primary" type="button" data-action="apply-update" ${state.busy || state.bridge !== "online" || !state.updateState?.needsBuild ? "disabled" : ""}>Rebuild now</button>
              </div>
            </div>
            ${!state.updatePolicyConfigured ? `<div class="cpx-update-callout"><strong>Choose an update policy</strong><span>Notify is recommended so updates cannot silently invalidate the patch while you remain in control of rebuilds.</span></div>` : ""}
            <div class="cpx-policy-grid">
              ${updatePolicyOption("off", "Off", "Do not check for installed Codex updates when this clone launches.")}
              ${updatePolicyOption("notify", "Notify", "Check on launch and ask before running a verified rebuild. Recommended.")}
              ${updatePolicyOption("auto", "Auto rebuild", "Check on launch and rebuild automatically when validation is required.")}
            </div>
            ${updateStateSummary()}
          </section>

          <section class="cpx-band">
            <div class="cpx-band-head">
              <div>
                <strong>Runtime visibility</strong>
                <small>These toggles update this patched app immediately. They hide or disable surfaces without rebuilding.</small>
              </div>
              <button class="cpx-button cpx-button-sm" type="button" data-action="runtime-all">All on</button>
            </div>
            <div class="cpx-list">${RUNTIME_FEATURES.map((feature) => toggleRow(feature, "runtime")).join("")}</div>
          </section>

          <section class="cpx-band">
            <div class="cpx-band-head">
              <div>
                <strong>Build features</strong>
                <small>These are passed to the external Patch Manager build job. A rebuild and relaunch applies them fully.</small>
              </div>
              <button class="cpx-button cpx-button-sm" type="button" data-action="build-defaults">Defaults</button>
            </div>
            <div class="cpx-list">${BUILD_FEATURES.map((feature) => toggleRow(feature, "build")).join("")}</div>
          </section>

          <section class="cpx-band cpx-wide">
            <div class="cpx-band-head">
              <div>
                <strong>Build and launch</strong>
                <small>${escapeHtml(state.bridgeMessage)}</small>
              </div>
              <div class="cpx-band-actions">
                <button class="cpx-button" type="button" data-action="launch-current" ${state.busy || state.bridge !== "online" ? "disabled" : ""}>Launch current</button>
                <button class="cpx-button cpx-primary" type="button" data-action="build-patch" ${state.busy || state.bridge !== "online" ? "disabled" : ""}>Build patch</button>
              </div>
            </div>
            <div class="cpx-build-form">
              <label>Chat limit<input class="cpx-input" type="number" min="50" max="10000" step="50" data-patch-limit value="${escapeHtml(state.limit)}"></label>
              <label>Source<input class="cpx-input" type="text" value="Current installed Codex" readonly></label>
              <label>Shortcut<input class="cpx-input" type="text" data-shortcut-name value="${escapeHtml(state.shortcutName)}"></label>
              <label>Output root<input class="cpx-input" type="text" data-output-root value="${escapeHtml(state.outputRoot)}"></label>
              <label>Shortcut dir<input class="cpx-input" type="text" data-shortcut-dir value="${escapeHtml(state.shortcutDir)}" placeholder="Desktop by default"></label>
              <label class="cpx-check"><input type="checkbox" data-keep-work${state.keepWork ? " checked" : ""}> Keep work folder</label>
            </div>
            ${buildManagerSummary()}
            ${state.lastJob ? `<div class="cpx-job">Last job: ${escapeHtml(state.lastJob.id || "unknown")} - ${escapeHtml(state.lastJob.status || "queued")}</div>` : ""}
          </section>

          <section class="cpx-band cpx-wide">
            <div class="cpx-band-head">
              <div>
                <strong>About Patcher</strong>
                <small>Created by Ryan Craighead. This patch layer is a local, user-controlled clone builder and native Codex feature switchboard.</small>
              </div>
            </div>
            <div class="cpx-note">${escapeHtml(state.status)}</div>
          </section>
        </div>
      </section>
    `;
    host.dataset.cpxRendered = "1";
    bind(host);
  }

  function bind(host) {
    host.querySelectorAll("[data-update-policy]").forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) persistUpdatePolicy(input.value);
      });
    });
    host.querySelector('[data-action="check-update"]')?.addEventListener("click", checkForCodexUpdate);
    host.querySelector('[data-action="open-patcher-release"]')?.addEventListener("click", () => {
      const releaseUrl = state.updateState?.remoteUpdate?.repository?.releaseUrl;
      if (releaseUrl) window.open(releaseUrl, "_blank", "noopener");
    });
    host.querySelector('[data-action="apply-update"]')?.addEventListener("click", applyCodexUpdate);
    host.querySelectorAll("[data-runtime-feature]").forEach((input) => {
      input.addEventListener("change", () => {
        state.runtimeFeatures[input.dataset.runtimeFeature] = Boolean(input.checked);
        saveSettings();
        applySettingsNavVisibility();
        dispatchSettingsChanged();
        render();
      });
    });
    host.querySelectorAll("[data-build-feature]").forEach((input) => {
      input.addEventListener("change", () => {
        state.buildFeatures[input.dataset.buildFeature] = Boolean(input.checked);
        if (input.checked && input.dataset.buildFeature === "catalogShim") state.buildFeatures.chatLimit = false;
        if (input.checked && input.dataset.buildFeature === "chatLimit") state.buildFeatures.catalogShim = false;
        saveSettings();
        render();
      });
    });
    host.querySelector('[data-action="runtime-all"]')?.addEventListener("click", () => {
      state.runtimeFeatures = defaultRuntimeFeatures();
      saveSettings();
      applySettingsNavVisibility();
      dispatchSettingsChanged();
      render();
    });
    host.querySelector('[data-action="build-defaults"]')?.addEventListener("click", () => {
      state.buildFeatures = defaultBuildFeatures();
      if (defaultsFromBridge()) {
        state.buildFeatures = { ...state.buildFeatures, ...defaultsFromBridge() };
      }
      saveSettings();
      render();
    });
    host.querySelector('[data-action="refresh-bridge"]')?.addEventListener("click", () => {
      refreshBridge();
    });
    host.querySelector('[data-action="refresh-features"]')?.addEventListener("click", () => {
      refreshFeatureDevelopment().catch(() => {});
    });
    host.querySelector('[data-action="open-manager"]')?.addEventListener("click", openPatchManager);
    host.querySelector('[data-action="build-patch"]')?.addEventListener("click", startPatchBuild);
    host.querySelector('[data-action="launch-current"]')?.addEventListener("click", launchCurrentPatchedCodex);
    host.querySelector("[data-patch-limit]")?.addEventListener("change", (event) => {
      state.limit = clampNumber(event.currentTarget.value, 50, 10000, 1000);
      saveSettings();
      render();
    });
    host.querySelectorAll("[data-feature-module]").forEach((input) => {
      input.addEventListener("change", () => persistFeatureModule(input.dataset.featureModule, Boolean(input.checked)));
    });
    host.querySelectorAll("[data-core-feature-module]").forEach((input) => {
      input.addEventListener("change", () => {
        const feature = (state.featureDevelopment?.modules || []).find((candidate) => candidate.id === input.dataset.coreFeatureModule);
        const settingIds = Array.isArray(feature?.legacyFeatureIds) ? feature.legacyFeatureIds : [];
        for (const id of settingIds) state.buildFeatures[id] = Boolean(input.checked);
        if (input.checked && settingIds.includes("catalogShim")) state.buildFeatures.chatLimit = false;
        if (input.checked && settingIds.includes("chatLimit")) state.buildFeatures.catalogShim = false;
        saveSettings();
        render();
      });
    });
    host.querySelector("[data-local-feature-id]")?.addEventListener("input", (event) => {
      state.localFeatureId = String(event.currentTarget.value || "");
    });
    host.querySelector("[data-conversion-source]")?.addEventListener("change", (event) => {
      state.conversionSourceId = String(event.currentTarget.value || "");
    });
    host.querySelector("[data-contribution-feature-id]")?.addEventListener("input", (event) => {
      state.contributionFeatureId = String(event.currentTarget.value || "");
    });
    host.querySelector("[data-worktree-feature]")?.addEventListener("change", (event) => {
      state.worktreeFeatureId = String(event.currentTarget.value || "");
    });
    host.querySelector('[data-action="create-local-feature"]')?.addEventListener("click", () => {
      runFeatureDevelopmentAction("create-local", { id: state.localFeatureId.trim() });
    });
    host.querySelector('[data-action="convert-contribution"]')?.addEventListener("click", () => {
      runFeatureDevelopmentAction("convert-contribution", {
        id: state.conversionSourceId,
        targetId: state.contributionFeatureId.trim(),
      });
    });
    host.querySelector('[data-action="open-worktree"]')?.addEventListener("click", () => {
      runFeatureDevelopmentAction("open-worktree", { id: state.worktreeFeatureId });
    });
    host.querySelector('[data-action="rebuild-feature-codex"]')?.addEventListener("click", () => {
      if (!window.confirm("Rebuild and verify a new patched Codex clone with the selected modules?")) return;
      runFeatureDevelopmentAction("rebuild", { build: patchPayload() });
    });
    host.querySelector("[data-output-root]")?.addEventListener("input", (event) => {
      state.outputRoot = String(event.currentTarget.value || "");
      saveSettings();
    });
    host.querySelector("[data-shortcut-name]")?.addEventListener("input", (event) => {
      state.shortcutName = String(event.currentTarget.value || "");
      saveSettings();
    });
    host.querySelector("[data-shortcut-dir]")?.addEventListener("input", (event) => {
      state.shortcutDir = String(event.currentTarget.value || "");
      saveSettings();
    });
    host.querySelector("[data-keep-work]")?.addEventListener("change", (event) => {
      state.keepWork = Boolean(event.currentTarget.checked);
      saveSettings();
    });
  }

  function defaultsFromBridge() {
    const features = state.patchStatus?.defaults?.features;
    return features && typeof features === "object" ? features : null;
  }

  function createStyle() {
    const style = document.createElement("style");
    style.id = `${ROOT_ID}-style`;
    style.textContent = `
      .cpx-patcher-page {
        color: var(--color-token-text-primary);
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
      .cpx-patcher-page * { box-sizing: border-box; }
      .cpx-header {
        align-items: flex-start;
        display: flex;
        gap: 18px;
        justify-content: space-between;
      }
      .cpx-header h1 {
        font-size: 20px;
        font-weight: 650;
        line-height: 1.25;
        margin: 0;
      }
      .cpx-header p,
      .cpx-band-head small,
      .cpx-toggle-row small {
        color: var(--color-token-text-secondary);
      }
      .cpx-header p {
        font-size: 13px;
        line-height: 1.35;
        margin: 5px 0 0;
        max-width: 700px;
      }
      .cpx-header-actions,
      .cpx-band-actions {
        align-items: center;
        display: flex;
        gap: 8px;
      }
      .cpx-button {
        background: transparent;
        border: 1px solid var(--color-token-border-default, var(--color-token-border));
        border-radius: 8px;
        color: var(--color-token-text-primary);
        cursor: pointer;
        font: inherit;
        font-size: 13px;
        min-height: 32px;
        padding: 6px 11px;
      }
      .cpx-button:disabled {
        cursor: default;
        opacity: .55;
      }
      .cpx-button-sm {
        min-height: 28px;
        padding: 4px 9px;
      }
      .cpx-primary {
        background: var(--color-token-text-primary);
        color: var(--color-token-main-surface-primary);
      }
      .cpx-summary {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .cpx-pill {
        align-items: center;
        border: 1px solid var(--color-token-border-default, var(--color-token-border));
        border-radius: var(--radius-lg, 8px);
        display: inline-flex;
        gap: 10px;
        min-height: 34px;
        min-width: min(142px, 100%);
        padding: 6px 10px;
      }
      .cpx-pill span {
        color: var(--color-token-text-secondary);
        font-size: 12px;
      }
      .cpx-pill strong {
        font-size: 13px;
        font-weight: 650;
      }
      .cpx-pill.is-ok { border-color: rgba(34,197,94,.34); }
      .cpx-pill.is-accent { border-color: rgba(37,99,235,.28); }
      .cpx-pill.is-pending { border-color: rgba(245,158,11,.34); }
      .cpx-pill.is-bad { border-color: rgba(239,68,68,.34); }
      .cpx-grid {
        display: grid;
        flex: 0 0 auto;
        gap: var(--padding-panel, 16px);
        grid-template-columns: 1fr;
        min-height: auto;
        overflow: visible;
      }
      .cpx-band {
        background: var(--color-background-panel, var(--color-token-bg-fog, var(--color-token-main-surface-primary)));
        border: 1px solid var(--color-token-border-default, var(--color-token-border));
        border-radius: var(--radius-lg, 8px);
        display: flex;
        flex-direction: column;
        min-width: 0;
        overflow: hidden;
      }
      .cpx-wide {
        grid-column: 1 / -1;
      }
      .cpx-band-head {
        align-items: flex-start;
        border-bottom: 1px solid var(--color-token-border-default, var(--color-token-border));
        display: flex;
        gap: 14px;
        justify-content: space-between;
        min-height: 48px;
        padding: 12px 14px;
      }
      .cpx-band-head strong {
        display: block;
        font-size: 14px;
        font-weight: 650;
        margin-bottom: 3px;
      }
      .cpx-band-head small {
        display: block;
        font-size: 12px;
        line-height: 1.35;
      }
      .cpx-list {
        display: flex;
        flex-direction: column;
      }
      .cpx-toggle-row {
        align-items: center;
        border-bottom: 1px solid var(--color-token-border-subtle, rgba(0,0,0,.07));
        display: flex;
        gap: 14px;
        justify-content: space-between;
        min-height: 50px;
        padding: 10px 14px;
      }
      .cpx-toggle-row:last-child { border-bottom: 0; }
      .cpx-toggle-copy {
        display: grid;
        gap: 3px;
        min-width: 0;
      }
      .cpx-toggle-copy span {
        font-size: 13px;
        font-weight: 560;
      }
      .cpx-toggle-copy small {
        font-size: 12px;
        line-height: 1.35;
      }
      .cpx-toggle-row input[type="checkbox"] {
        flex: 0 0 auto;
        margin: 0;
      }
      .cpx-feature-overview {
        border-bottom: 1px solid var(--color-token-border-default, var(--color-token-border));
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        padding: 10px 14px;
      }
      .cpx-feature-groups,
      .cpx-feature-group {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .cpx-feature-group + .cpx-feature-group {
        border-top: 1px solid var(--color-token-border-default, var(--color-token-border));
      }
      .cpx-feature-group-head {
        align-items: center;
        background: var(--color-token-background-secondary, rgba(127, 127, 127, 0.05));
        border-bottom: 1px solid var(--color-token-border-subtle, rgba(0,0,0,.07));
        display: flex;
        justify-content: space-between;
        min-height: 32px;
        padding: 6px 14px;
      }
      .cpx-feature-group-head strong,
      .cpx-feature-group-head span {
        font-size: 12px;
        font-weight: 650;
      }
      .cpx-feature-group-head span { color: var(--color-token-text-secondary); }
      .cpx-feature-row {
        align-items: flex-start;
        border-bottom: 1px solid var(--color-token-border-subtle, rgba(0,0,0,.07));
        display: flex;
        gap: 14px;
        justify-content: space-between;
        min-width: 0;
        padding: 11px 14px;
      }
      .cpx-feature-row:last-child { border-bottom: 0; }
      .cpx-feature-copy {
        display: grid;
        flex: 1 1 auto;
        gap: 6px;
        min-width: 0;
      }
      .cpx-feature-copy > small {
        color: var(--color-token-text-secondary);
        font-size: 12px;
        line-height: 1.35;
      }
      .cpx-feature-title {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .cpx-feature-title strong { font-size: 13px; font-weight: 650; }
      .cpx-feature-title span {
        border: 1px solid var(--color-token-border-default, var(--color-token-border));
        border-radius: 4px;
        color: var(--color-token-text-secondary);
        font-size: 11px;
        padding: 1px 5px;
      }
      .cpx-feature-meta {
        display: grid;
        gap: 4px 12px;
        grid-template-columns: minmax(0, 1fr) minmax(118px, auto);
      }
      .cpx-feature-meta span {
        color: var(--color-token-text-secondary);
        font-size: 11px;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cpx-feature-meta b { color: var(--color-token-text-primary); font-weight: 600; }
      .cpx-feature-results {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
      }
      .cpx-feature-badge {
        align-items: center;
        border: 1px solid var(--color-token-border-default, var(--color-token-border));
        border-radius: 4px;
        display: inline-flex;
        font-size: 10px;
        gap: 4px;
        min-height: 20px;
        padding: 2px 5px;
      }
      .cpx-feature-badge span { color: var(--color-token-text-secondary); }
      .cpx-feature-badge strong { font-size: 10px; font-weight: 650; }
      .cpx-feature-badge.is-ok { border-color: rgba(34,197,94,.34); }
      .cpx-feature-badge.is-pending { border-color: rgba(245,158,11,.34); }
      .cpx-feature-badge.is-bad { border-color: rgba(239,68,68,.34); }
      .cpx-feature-toggle {
        align-items: center;
        color: var(--color-token-text-secondary);
        display: flex;
        flex: 0 0 auto;
        font-size: 11px;
        gap: 7px;
        min-height: 24px;
      }
      .cpx-feature-toggle input { margin: 0; }
      .cpx-feature-commands {
        border-top: 1px solid var(--color-token-border-default, var(--color-token-border));
        display: flex;
        flex-direction: column;
      }
      .cpx-command-row {
        border-bottom: 1px solid var(--color-token-border-subtle, rgba(0,0,0,.07));
        display: grid;
        gap: 9px;
        padding: 11px 14px;
      }
      .cpx-command-row > div:first-child { display: grid; gap: 3px; }
      .cpx-command-row strong { font-size: 13px; font-weight: 650; }
      .cpx-command-row small { color: var(--color-token-text-secondary); font-size: 11px; line-height: 1.35; }
      .cpx-command-controls {
        display: grid;
        gap: 8px;
        grid-template-columns: minmax(0, 1fr) auto;
        min-width: 0;
      }
      .cpx-command-controls-three { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; }
      .cpx-command-controls-button { display: flex; justify-content: flex-end; }
      .cpx-feature-log-head {
        border-top: 1px solid var(--color-token-border-default, var(--color-token-border));
        padding: 10px 14px 0;
      }
      .cpx-feature-log-head strong { font-size: 12px; }
      .cpx-feature-log {
        color: var(--color-token-text-secondary);
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 11px;
        line-height: 1.4;
        margin: 0;
        max-height: 220px;
        overflow: auto;
        padding: 9px 14px 12px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .cpx-build-form {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr));
        padding: 12px 14px;
      }
      .cpx-build-form label {
        color: var(--color-token-text-secondary);
        display: grid;
        font-size: 12px;
        gap: 5px;
        min-width: 0;
      }
      .cpx-build-form .cpx-check {
        align-items: center;
        display: flex;
        gap: 8px;
        padding-top: 22px;
      }
      .cpx-input {
        background: var(--color-token-input-surface, var(--color-token-main-surface-primary));
        border: 1px solid var(--color-token-border-default, var(--color-token-border));
        border-radius: 8px;
        color: var(--color-token-text-primary);
        font: inherit;
        min-height: 32px;
        min-width: 0;
        padding: 5px 9px;
        width: 100%;
      }
      .cpx-config-grid {
        border-top: 1px solid var(--color-token-border-default, var(--color-token-border));
        display: grid;
        gap: 6px 12px;
        grid-template-columns: minmax(76px, auto) minmax(0, 1fr);
        padding: 12px 14px;
      }
      .cpx-config-grid span {
        color: var(--color-token-text-secondary);
        font-size: 12px;
      }
      .cpx-config-grid strong {
        font-size: 12px;
        font-weight: 560;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cpx-empty,
      .cpx-job,
      .cpx-note {
        color: var(--color-token-text-secondary);
        font-size: 13px;
        line-height: 1.45;
        padding: 12px 14px;
      }
      .cpx-empty,
      .cpx-job {
        border-top: 1px solid var(--color-token-border-default, var(--color-token-border));
      }
      .cpx-policy-grid {
        display: grid;
        gap: 8px;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        padding: 12px 14px;
      }
      .cpx-policy-option {
        align-items: flex-start;
        border: 1px solid var(--color-token-border-default, var(--color-token-border));
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        gap: 9px;
        min-width: 0;
        padding: 10px;
      }
      .cpx-policy-option.is-selected {
        background: var(--color-token-background-secondary, rgba(127, 127, 127, 0.08));
        border-color: var(--color-token-text-primary);
      }
      .cpx-policy-option input { margin: 2px 0 0; }
      .cpx-policy-option span { display: grid; gap: 3px; min-width: 0; }
      .cpx-policy-option strong { font-size: 13px; }
      .cpx-policy-option small { color: var(--color-token-text-secondary); font-size: 12px; line-height: 1.35; }
      .cpx-update-callout {
        align-items: flex-start;
        background: var(--color-token-background-secondary, rgba(127, 127, 127, 0.08));
        border-bottom: 1px solid var(--color-token-border-default, var(--color-token-border));
        display: grid;
        gap: 3px;
        padding: 11px 14px;
      }
      .cpx-update-callout span { color: var(--color-token-text-secondary); font-size: 12px; line-height: 1.4; }
      .cpx-note-bad { color: var(--color-token-text-error, #dc2626); }
      @media (max-width: 980px) {
        .cpx-patcher-page {
          padding: 12px;
        }
        .cpx-header,
        .cpx-band-head {
          align-items: stretch;
          flex-direction: column;
        }
        .cpx-header-actions,
        .cpx-band-actions {
          justify-content: stretch;
        }
        .cpx-header-actions .cpx-button,
        .cpx-band-actions .cpx-button {
          width: 100%;
        }
        .cpx-policy-grid { grid-template-columns: 1fr; }
        .cpx-feature-row { align-items: stretch; flex-direction: column; }
        .cpx-feature-toggle { justify-content: flex-end; }
        .cpx-feature-meta { grid-template-columns: 1fr; }
        .cpx-command-controls,
        .cpx-command-controls-three { grid-template-columns: 1fr; }
        .cpx-command-controls .cpx-button { width: 100%; }
        .cpx-command-controls-button { display: grid; }
      }
    `;
    document.head.append(style);
  }

  function openSettingsRoute(routeId = "patcher") {
    const targetRoute = routeId === "feature-development" ? "feature-development" : "patcher";
    if (activeRouteId() !== targetRoute) {
      navigateNativeRoute(`/settings/${targetRoute}`);
    }
    render();
    if (targetRoute === "feature-development") {
      refreshFeatureDevelopment({ showBusy: false }).catch(() => {});
    }
  }

  function startObserver() {
    if (!document.body || routeObserver) return;
    routeObserver = new MutationObserver(scheduleSync);
    routeObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("popstate", scheduleSync);
    window.addEventListener("codex-native-settings-route", (event) => {
      if (["patcher", "feature-development"].includes(event.detail?.id)) {
        openSettingsRoute(event.detail.id);
      }
    });
  }

  function init() {
    if (document.getElementById(`${ROOT_ID}-style`)) return;
    loadSettings();
    createStyle();
    window.__codexNativePatcherSettings = {
      isEnabled,
      getSettings: () => ({
        runtimeFeatures: { ...state.runtimeFeatures },
        buildFeatures: { ...state.buildFeatures },
      }),
      openSettingsRoute,
      refreshBridge,
      state,
    };
    startObserver();
    applySettingsNavVisibility();
    render();
    setTimeout(() => refreshBridge({ renderAfter: activeRoute() }), 1200);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
