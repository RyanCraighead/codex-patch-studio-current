(function () {
  "use strict";

  const ROOT_ID = "codex-native-patcher-settings";
  const ROUTE_HOST_ID = "codex-native-patcher-settings-route";
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
        throw new Error(`${response.status} ${response.statusText}${text ? `: ${text}` : ""}`);
      }
      return response.json();
    } finally {
      window.clearTimeout(timeout);
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
      if (defaults?.features && typeof defaults.features === "object") {
        for (const feature of BUILD_FEATURES) {
          if (Object.prototype.hasOwnProperty.call(defaults.features, feature.id)) {
            state.buildFeatures[feature.id] = defaults.features[feature.id] !== false;
          }
        }
      }
      const stored = readStoredSettings();
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
            body: "{}",
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
          body: "{}",
        },
        120000
      );
      state.updateCheckedAt = Date.now();
      state.status = state.updateState.needsBuild
        ? "A Codex or patch framework update requires a verified rebuild."
        : "The patched clone is current.";
    } catch (error) {
      state.updateStateError = error.message || String(error);
      state.error = state.updateStateError;
      state.status = state.error;
    } finally {
      state.busy = false;
      render();
    }
  }

  async function persistFeatureModule(id, enabled) {
    if (state.busy) return;
    state.busy = true;
    state.error = "";
    state.status = `${enabled ? "Enabling" : "Disabling"} ${id}...`;
    render();
    try {
      state.featureModules = await fetchPatchManager("/api/patch/feature-module", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, enabled }),
      });
      state.status = `${id} ${enabled ? "enabled" : "disabled"}. Rebuild to apply this module.`;
    } catch (error) {
      state.error = error.message || String(error);
      state.status = state.error;
    } finally {
      state.busy = false;
      render();
    }
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
      if (document.getElementById(ROUTE_HOST_ID)) {
        render();
      }
    }, 60);
  }

  function activeRoute() {
    return Boolean(document.getElementById(ROUTE_HOST_ID) || window.location.pathname.replace(/\/+$/, "") === "/settings/patcher");
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
    return `
      <div class="cpx-config-grid">
        <span>Installed Codex</span><strong>${escapeHtml(state.updateState.installedVersion || "Unknown")}</strong>
        <span>Patched Codex</span><strong>${escapeHtml(state.updateState.patchedVersion || "Not built")}</strong>
        <span>Build state</span><strong>${state.updateState.needsBuild ? "Rebuild required" : "Current"}</strong>
        <span>Reason</span><strong>${escapeHtml(reasons.join(", ") || "No changes detected")}</strong>
      </div>
    `;
  }

  function featureModuleRows() {
    const modules = (state.featureModules?.modules || []).filter((feature) => feature.configurable);
    if (!state.featureModules?.ok) {
      return `<div class="cpx-note cpx-note-bad">${escapeHtml(state.featureModules?.error || "Feature catalog is invalid.")}</div>`;
    }
    if (!modules.length) {
      return `<div class="cpx-empty">No contribution or local modules are installed. Core features remain available above.</div>`;
    }
    return `<div class="cpx-list">${modules.map((feature) => `
      <label class="cpx-toggle-row">
        <span class="cpx-toggle-copy">
          <span>${escapeHtml(feature.name)} <small>${escapeHtml(feature.kind)} · ${escapeHtml(feature.version)}</small></span>
          <small>${escapeHtml(feature.description || feature.id)}</small>
        </span>
        <input type="checkbox" data-feature-module="${escapeHtml(feature.id)}"${feature.enabled ? " checked" : ""}>
      </label>
    `).join("")}</div>`;
  }

  function render() {
    const host = document.getElementById(ROUTE_HOST_ID);
    applySettingsNavVisibility();
    if (!host) return;
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
                <strong>Codex updates</strong>
                <small>Codex updates can change internal patch anchors. Checks are one-shot at launch or when you press Check now.</small>
              </div>
              <div class="cpx-band-actions">
                <button class="cpx-button" type="button" data-action="check-update" ${state.busy || state.bridge !== "online" ? "disabled" : ""}>Check now</button>
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
                <strong>Feature modules</strong>
                <small>Source-only contribution and personal modules are disabled until selected and are verified again after packing.</small>
              </div>
            </div>
            ${featureModuleRows()}
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
    bind(host);
  }

  function bind(host) {
    host.querySelectorAll("[data-update-policy]").forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) persistUpdatePolicy(input.value);
      });
    });
    host.querySelector('[data-action="check-update"]')?.addEventListener("click", checkForCodexUpdate);
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
      }
    `;
    document.head.append(style);
  }

  function openSettingsRoute() {
    if (!activeRoute()) {
      navigateNativeRoute("/settings/patcher");
    }
    render();
  }

  function startObserver() {
    if (!document.body || routeObserver) return;
    routeObserver = new MutationObserver(scheduleSync);
    routeObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("popstate", scheduleSync);
    window.addEventListener("codex-native-settings-route", (event) => {
      if (event.detail?.id === "patcher") {
        openSettingsRoute();
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
