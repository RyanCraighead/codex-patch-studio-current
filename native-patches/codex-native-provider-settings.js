(function () {
  "use strict";

  const ROOT_ID = "codex-native-provider-settings";
  const HOST_ID = "local";
  const STORAGE_KEY = "codex-native-provider-settings:v1";
  const AUTO_ROUTER_STORAGE_KEY = "codex-native-auto-router-settings:v1";
  const PROMPT_TOOLS_STORAGE_KEY = "codex-native-prompt-tools-settings:v1";
  const PERSONA_SETTINGS_STORAGE_KEY = "codex-native-persona-settings:v1";
  const SWARM_SETTINGS_STORAGE_KEY = "codex-native-swarm-settings:v1";
  const PATCHER_STORAGE_KEY = "codex-native-patcher-settings:v1";
  const AUTO_ROUTER_MODEL_ID = "auto";
  const MENU_ENHANCER_ID = "codex-native-provider-menu-enhancer";
  const DEFAULT_AUTO_ROUTER_PROMPT = [
    "Choose the best configured model for the next Codex turn.",
    "Prefer fast and inexpensive models for small questions, stronger coding models for edits and debugging, and high-reasoning models for architecture, multi-file refactors, or unclear tasks.",
    "Return only JSON with keys model and reason. The model value must exactly match one eligible model id.",
  ].join(" ");
  const DEFAULT_REVIEW_PROMPT = [
    "Review the proposed Codex command, prompt, or action before it is used.",
    "Identify safety, data-loss, privacy, credential, cost, destructive, and scope risks.",
    "Return a concise decision with risk_level, reason, and safer_alternative when applicable.",
  ].join(" ");
  const DEFAULT_CODEX_PROMPT_MODIFIER = "";
  const DEFAULT_PERSONAS = [
    {
      id: "pragmatic-engineer",
      name: "Pragmatic engineer",
      description: "Direct senior engineering help for implementation, debugging, and verification.",
      context: "code, implement, fix, debug, refactor, test, build, repo, error, patch",
      prompt: "Act as a pragmatic senior software engineer. Be direct, implementation-focused, and careful with existing code. Prefer concrete changes, verification, and clear tradeoffs over broad explanation.",
    },
    {
      id: "teacher",
      name: "Teacher",
      description: "Explains concepts and decisions step by step without taking over the task.",
      context: "explain, teach, learn, why, how does, walkthrough, understand, describe",
      prompt: "Act as a patient technical teacher. Explain the reasoning, define terms when useful, and connect each step to the user's goal. Keep the explanation practical and avoid unnecessary detours.",
    },
    {
      id: "reviewer",
      name: "Reviewer",
      description: "Finds risks, bugs, regressions, missing tests, and unsafe assumptions.",
      context: "review, audit, check, risk, security, bug, regression, tests, verify",
      prompt: "Act as a rigorous code reviewer. Lead with bugs, risks, behavioral regressions, and missing tests. Ground findings in concrete evidence and keep summaries secondary.",
    },
    {
      id: "product-planner",
      name: "Product planner",
      description: "Turns broad feature ideas into scoped implementation steps and user-facing behavior.",
      context: "plan, feature, roadmap, product, workflow, ux, settings, design, spec",
      prompt: "Act as a product-minded technical planner. Clarify user workflows, split work into shippable slices, and preserve implementation detail where it affects the product behavior.",
    },
  ];
  const MANAGED_PROXY_PORTS = {
    deepseek: 47731,
    zai: 47732,
    dashscope: 47733,
    cerebras: 47734,
  };
  const PATCH_MANAGER_BASE = "http://127.0.0.1:4590";
  let patchRuntimePathsPromise = null;

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

  const PRESETS = {
    openai: {
      label: "OpenAI",
      providerId: "openai",
      displayName: "OpenAI",
      model: "gpt-5.5",
      baseUrl: "",
      envKey: "OPENAI_API_KEY",
      wireApi: "responses",
      builtIn: true,
      models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"],
      note: "Built-in OpenAI provider. No custom provider table is written.",
    },
    ollama: {
      label: "Ollama",
      providerId: "ollama",
      displayName: "Ollama",
      model: "",
      baseUrl: "http://localhost:11434/api",
      envKey: "",
      wireApi: "responses",
      builtIn: true,
      local: true,
      models: ["qwen3:4b", "gpt-oss:20b", "qwen3-coder:latest", "devstral:latest", "llama3.3:latest"],
      note: "Built-in local provider. Writes model_provider = ollama.",
    },
    lmstudio: {
      label: "LM Studio",
      providerId: "lmstudio",
      displayName: "LM Studio",
      model: "",
      baseUrl: "http://localhost:1234/v1",
      envKey: "",
      wireApi: "responses",
      builtIn: true,
      local: true,
      models: ["openai/gpt-oss-20b", "qwen/qwen3-coder", "devstral-small-2507"],
      note: "Built-in local provider. Writes model_provider = lmstudio.",
    },
    deepseek: {
      label: "DeepSeek",
      providerId: "deepseek",
      displayName: "DeepSeek",
      model: "deepseek-v4-flash",
      baseUrl: "http://127.0.0.1:47731",
      envKey: "DEEPSEEK_API_KEY",
      wireApi: "responses",
      models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
      note: "Uses the local Codex Responses-to-Chat proxy, which forwards to DeepSeek /chat/completions.",
    },
    zai: {
      label: "Z.ai GLM",
      providerId: "zai",
      displayName: "Z.ai",
      model: "glm-5.2",
      baseUrl: "http://127.0.0.1:47732",
      envKey: "ZAI_API_KEY",
      wireApi: "responses",
      models: ["glm-5.2", "glm-5.1", "glm-5", "glm-4.7", "glm-4.6", "glm-4.5"],
      note: "Uses the local Codex Responses-to-Chat proxy, which forwards to the Z.ai GLM Coding endpoint.",
    },
    dashscope: {
      label: "Alibaba Qwen",
      providerId: "dashscope",
      displayName: "Alibaba Qwen",
      model: "qwen3.7-plus",
      baseUrl: "http://127.0.0.1:47733",
      envKey: "DASHSCOPE_API_KEY",
      wireApi: "responses",
      models: DASHSCOPE_MODELS,
      note: "Uses the local Codex Responses-to-Chat proxy, which forwards to Alibaba Cloud Model Studio in US/Virginia by default.",
    },
    cerebras: {
      label: "Cerebras",
      providerId: "cerebras",
      displayName: "Cerebras",
      model: "gpt-oss-120b",
      baseUrl: "http://127.0.0.1:47734",
      envKey: "CEREBRAS_API_KEY",
      wireApi: "responses",
      models: CEREBRAS_MODELS,
      note: "Uses the local Codex Responses-to-Chat proxy, which forwards to the Cerebras OpenAI-compatible API.",
    },
    custom: {
      label: "Custom",
      providerId: "custom",
      displayName: "Custom provider",
      model: "",
      baseUrl: "",
      envKey: "",
      wireApi: "responses",
      models: [],
      note: "Use this for a Responses-compatible provider or local compatibility proxy.",
    },
  };

  const state = {
    settingsTabActive: false,
    pendingSettingsOpen: false,
    busy: false,
    status: "Providers settings loaded.",
    lastError: null,
    loadedConfig: null,
    ollamaModels: [],
    ollamaRunningModels: [],
    lmStudioModels: [],
    menuBusy: false,
    menuRefreshing: false,
    providers: {
      openai: {
        visibleModels: [...PRESETS.openai.models],
        availableModels: [],
        advancedOpen: false,
      },
      deepseek: {
        visibleModels: [...PRESETS.deepseek.models],
        availableModels: [],
        advancedOpen: false,
      },
      zai: {
        visibleModels: ["glm-5.2", "glm-5.1"],
        availableModels: [],
        advancedOpen: false,
      },
      dashscope: {
        visibleModels: [...PRESETS.dashscope.models],
        availableModels: [],
        advancedOpen: false,
      },
      cerebras: {
        visibleModels: [...PRESETS.cerebras.models],
        availableModels: [],
        advancedOpen: false,
      },
    },
    settingsRoute: "providers",
    providerStatus: {
      deepseek: {
        checked: false,
        checking: false,
        proxy: null,
        apiKey: null,
        config: false,
        active: false,
        message: "Not checked yet.",
      },
      zai: {
        checked: false,
        checking: false,
        proxy: null,
        apiKey: null,
        config: false,
        active: false,
        message: "Not checked yet.",
      },
      dashscope: {
        checked: false,
        checking: false,
        proxy: null,
        apiKey: null,
        config: false,
        active: false,
        message: "Not checked yet.",
      },
      cerebras: {
        checked: false,
        checking: false,
        proxy: null,
        apiKey: null,
        config: false,
        active: false,
        message: "Not checked yet.",
      },
    },
    fields: {
      preset: "openai",
      providerId: "openai",
      displayName: "OpenAI",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      reasoningSummary: "",
      baseUrl: "",
      envKey: "OPENAI_API_KEY",
      wireApi: "responses",
      profileName: "",
      activateProfile: false,
      writeProviderTable: false,
    },
    autoRouter: {
      enabled: true,
      selected: false,
      useRouterModel: true,
      routerModelKey: "openai:gpt-5.3-codex-spark",
      eligibleModelKeys: null,
      prompt: DEFAULT_AUTO_ROUTER_PROMPT,
      lastChoice: null,
      lastReason: "",
      lastTextPreview: "",
      lastError: "",
      lastRoutedAt: 0,
      routing: false,
      testInput: "",
      testResult: null,
      testBusy: false,
    },
    reviewPrompt: {
      enabled: false,
      prompt: DEFAULT_REVIEW_PROMPT,
      modelKey: "openai:gpt-5.3-codex-spark",
      testInput: "",
      testResult: null,
      testBusy: false,
      lastAppliedAt: 0,
      lastError: "",
    },
    promptModifier: {
      enabled: false,
      mode: "append",
      text: DEFAULT_CODEX_PROMPT_MODIFIER,
      observedText: "",
      observedBaseInstructions: "",
      observedTemplate: "",
      observedPath: "",
      observedSource: "",
      observedAt: 0,
      observedError: "",
      modelListBusy: false,
      lastAppliedAt: 0,
      lastError: "",
    },
    personas: {
      enabled: false,
      mode: "manual",
      activePersonaId: "pragmatic-engineer",
      defaultPersonaId: "pragmatic-engineer",
      autoFallbackToDefault: true,
      items: DEFAULT_PERSONAS.map((persona) => ({ ...persona })),
      testInput: "",
      testResult: null,
      lastAppliedAt: 0,
      lastAppliedPersonaId: "",
      lastError: "",
    },
    swarmSettings: {
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
      lastUpdatedAt: 0,
    },
  };

  let ollamaBackgroundRefreshPromise = null;
  let lastOllamaBackgroundRefreshAt = 0;

  let requestSeq = 0;
  let autoRouterBridgeHookInstalled = false;
  const pendingRequests = new Map();
  let menuEnhancerObserver = null;
  let menuEnhancerTimer = null;
  let nativeIntegrationTimer = null;
  let nativeSettingsRouteObserver = null;
  let deferredTextEntryRender = false;

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

  function safeJson(value) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function normalizedText(element) {
    return String(element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function textCandidates(root = document) {
    return Array.from(root.querySelectorAll("button, a, [role='button'], [role='tab'], [role='menuitem'], span"));
  }

  function findExactTextElement(root, text) {
    const target = text.toLowerCase();
    return textCandidates(root).find((element) => normalizedText(element).toLowerCase() === target) || null;
  }

  function compact(value, limit) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
  }

  function normalizeWireApi() {
    return "responses";
  }

  function makeRequestId(method) {
    requestSeq += 1;
    const suffix =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${requestSeq}`;
    return `native-provider-settings:${method}:${suffix}`;
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

  function installAutoRouterBridgeHook() {
    const bridge = window.electronBridge;
    if (!bridge || typeof bridge.sendMessageFromView !== "function") {
      window.setTimeout(installAutoRouterBridgeHook, 250);
      return;
    }
    if (autoRouterBridgeHookInstalled) {
      return;
    }

    const interceptMessage = async (message) => {
      const request = message?.request;
      if (message?.type === "mcp-request" && request?.method === "turn/start") {
        try {
          captureDefaultPromptFromTurnRequest(request);
          applyPromptModifierToTurnRequest(request);
        } catch (error) {
          console.warn("[native-provider-settings] turn/start prompt tools failed", error);
        }
        try {
          applyPersonaToTurnRequest(request);
        } catch (error) {
          console.warn("[native-provider-settings] persona injection failed", error);
        }
        try {
          await routeAutoBeforeTurn(request.params || {});
        } catch (error) {
          console.warn("[native-provider-settings] Auto Router failed", error);
          state.autoRouter.lastError = error.message || String(error);
          state.status = state.autoRouter.lastError;
          saveDraft();
          throw error;
        }
      }
      if (message?.type === "mcp-request" && request?.method === "review/start") {
        try {
          applyReviewPromptToReviewRequest(request);
        } catch (error) {
          console.warn("[native-provider-settings] review/start prompt tools failed", error);
        }
      }
      return message;
    };

    if (typeof bridge.registerSendMessageInterceptor === "function") {
      bridge.registerSendMessageInterceptor(interceptMessage);
      autoRouterBridgeHookInstalled = true;
      return;
    }

    const descriptor = Object.getOwnPropertyDescriptor(bridge, "sendMessageFromView");
    if (descriptor?.writable || descriptor?.set) {
      const originalSendMessageFromView = bridge.sendMessageFromView.bind(bridge);
      bridge.sendMessageFromView = async (message) => originalSendMessageFromView(await interceptMessage(message));
      autoRouterBridgeHookInstalled = true;
      return;
    }

    console.warn("[native-provider-settings] outbound message interception is unavailable in this Codex build");
  }

  function readConfigFromAppServer() {
    return requestAppServer("config/read", { includeLayers: true, cwd: null });
  }

  function writeConfigEdits(edits) {
    return requestAppServer(
      "config/batchWrite",
      {
        edits,
        filePath: null,
        expectedVersion: null,
        reloadUserConfig: true,
      },
      90000
    );
  }

  function decodeBase64Text(dataBase64) {
    if (!dataBase64) {
      return "";
    }
    const binary = atob(String(dataBase64));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder("utf-8").decode(bytes);
  }

  function patchRuntimePaths() {
    if (!patchRuntimePathsPromise) {
      patchRuntimePathsPromise = fetchJsonWithTimeout(`${PATCH_MANAGER_BASE}/api/patch/status`, {
        method: "GET",
        cache: "no-store",
      }, 3000)
        .then((body) => body?.runtimePaths || {})
        .catch(() => ({}));
    }
    return patchRuntimePathsPromise;
  }

  async function managedProviderModelCachePath(providerId) {
    const runtimePaths = await patchRuntimePaths();
    const cacheRoot = String(runtimePaths?.providerModelCacheRoot || "").replace(/[\\/]+$/, "");
    if (!cacheRoot) {
      throw new Error("Patch manager did not report a provider model cache directory.");
    }
    return `${cacheRoot}\\${providerId}.json`;
  }

  async function readManagedProviderModelCache(providerId) {
    const cachePath = await managedProviderModelCachePath(providerId);
    const result = await requestAppServer(
      "fs/readFile",
      { path: cachePath },
      15000
    );
    const text = decodeBase64Text(result?.dataBase64 || "");
    if (!text.trim()) {
      throw new Error(`No cached model data for ${providerId}.`);
    }
    return JSON.parse(text);
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

  function saveDraft() {
    try {
      const providers = {};
      for (const [providerId, setup] of Object.entries(state.providers || {})) {
        providers[providerId] = {
          visibleModels: Array.isArray(setup.visibleModels) ? uniqueModelNames(setup.visibleModels) : [],
          availableModels: Array.isArray(setup.availableModels) ? uniqueModelNames(setup.availableModels) : [],
          lastModelRefreshAt: Number(setup.lastModelRefreshAt || 0),
          lastModelRefreshSource: String(setup.lastModelRefreshSource || ""),
          lastModelRefreshError: String(setup.lastModelRefreshError || ""),
          advancedOpen: Boolean(setup.advancedOpen),
        };
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ fields: state.fields, providers }));
      localStorage.setItem(
        AUTO_ROUTER_STORAGE_KEY,
        JSON.stringify({
          enabled: Boolean(state.autoRouter.enabled),
          selected: Boolean(state.autoRouter.selected),
          useRouterModel: true,
          routerModelKey: String(state.autoRouter.routerModelKey || ""),
          eligibleModelKeys: Array.isArray(state.autoRouter.eligibleModelKeys)
            ? state.autoRouter.eligibleModelKeys.map((value) => String(value || "").trim()).filter(Boolean)
            : null,
          prompt: String(state.autoRouter.prompt || DEFAULT_AUTO_ROUTER_PROMPT),
          lastChoice: state.autoRouter.lastChoice || null,
          lastReason: String(state.autoRouter.lastReason || ""),
          lastTextPreview: String(state.autoRouter.lastTextPreview || ""),
          lastError: String(state.autoRouter.lastError || ""),
          lastRoutedAt: Number(state.autoRouter.lastRoutedAt || 0),
          testInput: String(state.autoRouter.testInput || ""),
          testResult: state.autoRouter.testResult || null,
        })
      );
      localStorage.setItem(
        PROMPT_TOOLS_STORAGE_KEY,
        JSON.stringify({
          reviewPrompt: {
            enabled: Boolean(state.reviewPrompt.enabled),
            prompt: String(state.reviewPrompt.prompt || DEFAULT_REVIEW_PROMPT),
            modelKey: String(state.reviewPrompt.modelKey || ""),
            testInput: String(state.reviewPrompt.testInput || ""),
            testResult: state.reviewPrompt.testResult || null,
            lastAppliedAt: Number(state.reviewPrompt.lastAppliedAt || 0),
            lastError: String(state.reviewPrompt.lastError || ""),
          },
          promptModifier: {
            enabled: Boolean(state.promptModifier.enabled),
            mode: String(state.promptModifier.mode || "append"),
            text: String(state.promptModifier.text || ""),
            observedText: String(state.promptModifier.observedText || ""),
            observedBaseInstructions: String(state.promptModifier.observedBaseInstructions || ""),
            observedTemplate: String(state.promptModifier.observedTemplate || ""),
            observedPath: String(state.promptModifier.observedPath || ""),
            observedSource: String(state.promptModifier.observedSource || ""),
            observedAt: Number(state.promptModifier.observedAt || 0),
            observedError: String(state.promptModifier.observedError || ""),
            lastAppliedAt: Number(state.promptModifier.lastAppliedAt || 0),
            lastError: String(state.promptModifier.lastError || ""),
          },
        })
      );
      localStorage.setItem(
        PERSONA_SETTINGS_STORAGE_KEY,
        JSON.stringify({
          enabled: Boolean(state.personas.enabled),
          mode: String(state.personas.mode || "manual"),
          activePersonaId: String(state.personas.activePersonaId || ""),
          defaultPersonaId: String(state.personas.defaultPersonaId || ""),
          autoFallbackToDefault: state.personas.autoFallbackToDefault !== false,
          items: Array.isArray(state.personas.items)
            ? state.personas.items.map((persona) => ({
                id: String(persona.id || ""),
                name: String(persona.name || ""),
                description: String(persona.description || ""),
                context: String(persona.context || ""),
                prompt: String(persona.prompt || ""),
                enabled: persona.enabled !== false,
              }))
            : [],
          testInput: String(state.personas.testInput || ""),
          testResult: state.personas.testResult || null,
          lastAppliedAt: Number(state.personas.lastAppliedAt || 0),
          lastAppliedPersonaId: String(state.personas.lastAppliedPersonaId || ""),
          lastError: String(state.personas.lastError || ""),
        })
      );
      localStorage.setItem(
        SWARM_SETTINGS_STORAGE_KEY,
        JSON.stringify({
          enabled: Boolean(state.swarmSettings.enabled),
          providerId: String(state.swarmSettings.providerId || "cerebras"),
          orchestratorModelKey: String(state.swarmSettings.orchestratorModelKey || "cerebras:gemma-4-31b"),
          managerModelKey: String(state.swarmSettings.managerModelKey || "cerebras:gemma-4-31b"),
          workerModelKey: String(state.swarmSettings.workerModelKey || "cerebras:gemma-4-31b"),
          maxManagers: Number(state.swarmSettings.maxManagers || 4),
          maxWorkersPerManager: Number(state.swarmSettings.maxWorkersPerManager || 6),
          maxParallelWorkers: Number(state.swarmSettings.maxParallelWorkers || 12),
          isolatedWorkspaces: Boolean(state.swarmSettings.isolatedWorkspaces),
          interAgentMessaging: Boolean(state.swarmSettings.interAgentMessaging),
          autoTests: Boolean(state.swarmSettings.autoTests),
          autoReview: Boolean(state.swarmSettings.autoReview),
          defaultDepartments: String(state.swarmSettings.defaultDepartments || ""),
          lastUpdatedAt: Number(state.swarmSettings.lastUpdatedAt || 0),
        })
      );
    } catch {
      // Ignore storage failures in the native webview.
    }
  }

  function loadDraft() {
    try {
      const draft = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      if (draft && typeof draft.fields === "object") {
        state.fields = { ...state.fields, ...draft.fields };
        state.fields.wireApi = normalizeWireApi(state.fields.wireApi);
      }
      if (draft && draft.providers && typeof draft.providers === "object") {
        for (const [providerId, setup] of Object.entries(draft.providers)) {
          if (!setup || typeof setup !== "object") {
            continue;
          }
          const existing = state.providers[providerId] || {};
          const storedVisibleModels = Array.isArray(setup.visibleModels)
            ? uniqueModelNames(setup.visibleModels)
            : Array.isArray(existing.visibleModels)
              ? existing.visibleModels
              : [];
          const visibleModels =
            providerId === "dashscope"
              ? uniqueModelNames([...storedVisibleModels, ...PRESETS.dashscope.models])
              : providerId === "cerebras"
                ? uniqueModelNames([...storedVisibleModels, ...PRESETS.cerebras.models])
              : storedVisibleModels;
          state.providers[providerId] = {
            ...existing,
            visibleModels,
            availableModels: Array.isArray(setup.availableModels)
              ? uniqueModelNames(setup.availableModels)
              : Array.isArray(existing.availableModels)
                ? existing.availableModels
                : [],
            lastModelRefreshAt: Number(setup.lastModelRefreshAt || existing.lastModelRefreshAt || 0),
            lastModelRefreshSource: String(setup.lastModelRefreshSource || existing.lastModelRefreshSource || ""),
            lastModelRefreshError: String(setup.lastModelRefreshError || existing.lastModelRefreshError || ""),
            advancedOpen: Boolean(setup.advancedOpen),
          };
        }
      }
      const autoDraft = JSON.parse(localStorage.getItem(AUTO_ROUTER_STORAGE_KEY) || "{}");
      if (autoDraft && typeof autoDraft === "object") {
        state.autoRouter = {
          ...state.autoRouter,
          enabled: autoDraft.enabled !== false,
          selected: Boolean(autoDraft.selected),
          useRouterModel: true,
          routerModelKey: String(autoDraft.routerModelKey || state.autoRouter.routerModelKey || "openai:gpt-5.3-codex-spark"),
          eligibleModelKeys: Array.isArray(autoDraft.eligibleModelKeys)
            ? autoDraft.eligibleModelKeys.map((value) => String(value || "").trim()).filter(Boolean)
            : null,
          prompt: String(autoDraft.prompt || DEFAULT_AUTO_ROUTER_PROMPT),
          lastChoice: autoDraft.lastChoice || null,
          lastReason: String(autoDraft.lastReason || ""),
          lastTextPreview: String(autoDraft.lastTextPreview || ""),
          lastError: String(autoDraft.lastError || ""),
          lastRoutedAt: Number(autoDraft.lastRoutedAt || 0),
          routing: false,
          testInput: String(autoDraft.testInput || ""),
          testResult: autoDraft.testResult || null,
          testBusy: false,
        };
      }
      const promptToolsDraft = JSON.parse(localStorage.getItem(PROMPT_TOOLS_STORAGE_KEY) || "{}");
      if (promptToolsDraft && typeof promptToolsDraft === "object") {
        if (promptToolsDraft.reviewPrompt && typeof promptToolsDraft.reviewPrompt === "object") {
          state.reviewPrompt = {
            ...state.reviewPrompt,
            enabled: Boolean(promptToolsDraft.reviewPrompt.enabled),
            prompt: String(promptToolsDraft.reviewPrompt.prompt || DEFAULT_REVIEW_PROMPT),
            modelKey: String(promptToolsDraft.reviewPrompt.modelKey || state.reviewPrompt.modelKey || "openai:gpt-5.3-codex-spark"),
            testInput: String(promptToolsDraft.reviewPrompt.testInput || ""),
            testResult: promptToolsDraft.reviewPrompt.testResult || null,
            testBusy: false,
            lastAppliedAt: Number(promptToolsDraft.reviewPrompt.lastAppliedAt || 0),
            lastError: String(promptToolsDraft.reviewPrompt.lastError || ""),
          };
        }
        if (promptToolsDraft.promptModifier && typeof promptToolsDraft.promptModifier === "object") {
          state.promptModifier = {
            ...state.promptModifier,
            enabled: Boolean(promptToolsDraft.promptModifier.enabled),
            mode: String(promptToolsDraft.promptModifier.mode || "append") === "replace" ? "replace" : "append",
            text: String(promptToolsDraft.promptModifier.text || DEFAULT_CODEX_PROMPT_MODIFIER),
            observedText: String(promptToolsDraft.promptModifier.observedText || ""),
            observedBaseInstructions: String(promptToolsDraft.promptModifier.observedBaseInstructions || ""),
            observedTemplate: String(promptToolsDraft.promptModifier.observedTemplate || ""),
            observedPath: String(promptToolsDraft.promptModifier.observedPath || ""),
            observedSource: String(promptToolsDraft.promptModifier.observedSource || ""),
            observedAt: Number(promptToolsDraft.promptModifier.observedAt || 0),
            observedError: String(promptToolsDraft.promptModifier.observedError || ""),
            modelListBusy: false,
            lastAppliedAt: Number(promptToolsDraft.promptModifier.lastAppliedAt || 0),
            lastError: String(promptToolsDraft.promptModifier.lastError || ""),
          };
        }
      }
      const personaDraft = JSON.parse(localStorage.getItem(PERSONA_SETTINGS_STORAGE_KEY) || "{}");
      if (personaDraft && typeof personaDraft === "object") {
        state.personas = normalizePersonasSettings({
          ...state.personas,
          enabled: Boolean(personaDraft.enabled),
          mode: String(personaDraft.mode || state.personas.mode || "manual"),
          activePersonaId: String(personaDraft.activePersonaId || state.personas.activePersonaId || ""),
          defaultPersonaId: String(personaDraft.defaultPersonaId || state.personas.defaultPersonaId || ""),
          autoFallbackToDefault: personaDraft.autoFallbackToDefault !== false,
          items: Array.isArray(personaDraft.items) ? personaDraft.items : state.personas.items,
          testInput: String(personaDraft.testInput || ""),
          testResult: personaDraft.testResult || null,
          lastAppliedAt: Number(personaDraft.lastAppliedAt || 0),
          lastAppliedPersonaId: String(personaDraft.lastAppliedPersonaId || ""),
          lastError: String(personaDraft.lastError || ""),
        });
      } else {
        state.personas = normalizePersonasSettings(state.personas);
      }
      const swarmDraft = JSON.parse(localStorage.getItem(SWARM_SETTINGS_STORAGE_KEY) || "{}");
      if (swarmDraft && typeof swarmDraft === "object") {
        state.swarmSettings = {
          ...state.swarmSettings,
          enabled: swarmDraft.enabled !== false,
          providerId: String(swarmDraft.providerId || state.swarmSettings.providerId || "cerebras"),
          orchestratorModelKey: String(swarmDraft.orchestratorModelKey || state.swarmSettings.orchestratorModelKey || "cerebras:gemma-4-31b"),
          managerModelKey: String(swarmDraft.managerModelKey || state.swarmSettings.managerModelKey || "cerebras:gemma-4-31b"),
          workerModelKey: String(swarmDraft.workerModelKey || state.swarmSettings.workerModelKey || "cerebras:gemma-4-31b"),
          maxManagers: Number(swarmDraft.maxManagers || state.swarmSettings.maxManagers || 4),
          maxWorkersPerManager: Number(swarmDraft.maxWorkersPerManager || state.swarmSettings.maxWorkersPerManager || 6),
          maxParallelWorkers: Number(swarmDraft.maxParallelWorkers || state.swarmSettings.maxParallelWorkers || 12),
          isolatedWorkspaces: swarmDraft.isolatedWorkspaces !== false,
          interAgentMessaging: swarmDraft.interAgentMessaging !== false,
          autoTests: swarmDraft.autoTests !== false,
          autoReview: swarmDraft.autoReview !== false,
          defaultDepartments: String(swarmDraft.defaultDepartments || state.swarmSettings.defaultDepartments || ""),
          lastUpdatedAt: Number(swarmDraft.lastUpdatedAt || 0),
        };
      }
    } catch {
      // Ignore malformed drafts.
    }
  }

  function presetForConfig(config) {
    const provider = String(config?.model_provider || "openai").trim();
    const ossProvider = String(config?.oss_provider || "").trim();
    if (provider === "oss") {
      if (ossProvider === "lmstudio") return "lmstudio";
      return "ollama";
    }
    if (provider === "ollama") return "ollama";
    if (provider === "lmstudio") return "lmstudio";
    if (provider === "deepseek") return "deepseek";
    if (provider === "zai" || provider === "zhipu" || provider === "glm") return "zai";
    if (provider === "dashscope" || provider === "qwen" || provider === "alibaba") return "dashscope";
    if (provider === "cerebras") return "cerebras";
    if (provider === "openai" || provider.length === 0) return "openai";
    return "custom";
  }

  function providerConfig(config, providerId) {
    const providers = config?.model_providers;
    if (!providers || typeof providers !== "object") {
      return null;
    }
    return providers[providerId] && typeof providers[providerId] === "object" ? providers[providerId] : null;
  }

  function clearEdit(keyPath) {
    return { keyPath, value: null, mergeStrategy: "replace" };
  }

  function providerTableFromPreset(presetId) {
    const preset = PRESETS[presetId] || PRESETS.custom;
    const provider = {
      name: preset.displayName || preset.label || preset.providerId,
      base_url: preset.baseUrl,
      wire_api: normalizeWireApi(preset.wireApi),
    };
    if (preset.envKey) {
      provider.env_key = preset.envKey;
    }
    return provider;
  }

  function providerTableMatchesPreset(config, presetId) {
    const preset = PRESETS[presetId] || PRESETS.custom;
    const provider = providerConfig(config, preset.providerId);
    if (!provider) {
      return false;
    }
    return (
      String(provider.base_url || "") === String(preset.baseUrl || "") &&
      normalizeWireApi(provider.wire_api || preset.wireApi) === "responses" &&
      String(provider.env_key || preset.envKey || "") === String(preset.envKey || "")
    );
  }

  function managedProviderActivationModel(presetId) {
    const preset = PRESETS[presetId] || PRESETS.custom;
    const providerId = preset.providerId || presetId;
    const visible = providerModelsForPreset(presetId);
    if (state.fields.providerId === providerId && state.fields.model && visible.includes(state.fields.model)) {
      return state.fields.model;
    }
    return visible[0] || preset.model;
  }

  function deepSeekActivationModel() {
    return managedProviderActivationModel("deepseek");
  }

  function managedProviderSetupEdits(presetId, { activate = false } = {}) {
    const preset = PRESETS[presetId] || PRESETS.custom;
    const providerId = preset.providerId || presetId;
    const model = managedProviderActivationModel(presetId);
    const reasoningEffort = bestReasoningForModel(model, state.fields.reasoningEffort || "low", providerId);
    const edits = [
      {
        keyPath: `model_providers.${providerId}`,
        value: providerTableFromPreset(presetId),
        mergeStrategy: "upsert",
      },
    ];
    if (activate) {
      edits.push({ keyPath: "model_provider", value: providerId, mergeStrategy: "upsert" });
      edits.push(clearEdit("oss_provider"));
      edits.push({ keyPath: "model", value: model, mergeStrategy: "upsert" });
      edits.push({ keyPath: "model_reasoning_effort", value: reasoningEffort, mergeStrategy: "upsert" });
      edits.push(clearEdit("model_reasoning_summary"));
    }
    return edits;
  }

  function deepSeekSetupEdits({ activate = false } = {}) {
    return managedProviderSetupEdits("deepseek", { activate });
  }

  function updateManagedProviderStatusFromConfig(presetId) {
    const preset = PRESETS[presetId] || PRESETS.custom;
    const providerId = preset.providerId || presetId;
    const status = state.providerStatus[providerId];
    if (!status) {
      return;
    }
    const config = state.loadedConfig || {};
    status.config = providerTableMatchesPreset(config, presetId);
    status.active = String(config.model_provider || "") === providerId;
  }

  function updateDeepSeekStatusFromConfig() {
    updateManagedProviderStatusFromConfig("deepseek");
  }

  async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 2500) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      let body = {};
      if (text.trim()) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { raw: text };
        }
      }
      if (!response.ok) {
        throw new Error(body?.error?.message || body?.message || `HTTP ${response.status}`);
      }
      return body;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function ollamaModelNamesFromList(data) {
    return Array.isArray(data?.models)
      ? data.models
          .map((model) => model?.model || model?.name)
          .filter(Boolean)
      : [];
  }

  function updateOllamaModelDiscovery({ runningModels = [], installedModels = [], source = "ollama" } = {}) {
    const running = uniqueModelNames(runningModels);
    const installed = uniqueModelNames(installedModels).sort((a, b) => a.localeCompare(b));
    const discovered = uniqueModelNames([...running, ...installed]);
    state.ollamaRunningModels = running;
    state.ollamaModels = discovered;

    const setup = providerSetup("ollama");
    const previousVisible = uniqueModelNames(setup.visibleModels || []);
    setup.availableModels = discovered;
    setup.visibleModels = uniqueModelNames([...previousVisible, ...discovered]);
    setup.lastModelRefreshAt = Date.now();
    setup.lastModelRefreshSource = source;
    setup.lastModelRefreshError = "";

    if (discovered.length && state.fields.providerId === "ollama" && !state.fields.model) {
      state.fields.model = discovered[0];
    }
    saveDraft();
    enhanceOpenModelMenus();
    return discovered;
  }

  function refreshOllamaModelsInBackground({ force = false } = {}) {
    const now = Date.now();
    if (!force && state.ollamaModels.length && now - lastOllamaBackgroundRefreshAt < 15000) {
      return Promise.resolve(state.ollamaModels);
    }
    if (ollamaBackgroundRefreshPromise) {
      return ollamaBackgroundRefreshPromise;
    }
    lastOllamaBackgroundRefreshAt = now;
    ollamaBackgroundRefreshPromise = refreshOllamaModels({ render: false }).finally(() => {
      ollamaBackgroundRefreshPromise = null;
    });
    return ollamaBackgroundRefreshPromise;
  }

  async function refreshDeepSeekStatus({ render = true } = {}) {
    return refreshManagedProviderStatus("deepseek", { render });
  }

  async function refreshManagedProviderStatus(presetId, { render = true } = {}) {
    const preset = PRESETS[presetId] || PRESETS.custom;
    const providerId = preset.providerId || presetId;
    const status = state.providerStatus[providerId];
    const port = MANAGED_PROXY_PORTS[providerId];
    const label = preset.label || providerId;
    if (!status || !port) {
      return;
    }
    status.checking = true;
    status.checked = true;
    updateManagedProviderStatusFromConfig(presetId);
    if (render) {
      state.status = `Checking ${label} setup...`;
      state.lastError = null;
      renderNativeSettingsPanel();
    }
    try {
      const cachedModels = await readManagedProviderModelCache(providerId);
      status.proxy = cachedModels?.provider === providerId ? "managed" : Boolean(cachedModels?.provider);
      status.apiKey = cachedModels?.source === "upstream" || (cachedModels?.error && !/missing environment variable/i.test(cachedModels.error)) ? "env" : false;
      status.message = status.proxy
        ? status.apiKey
          ? `${label} proxy cache is ready and has API-backed model data.`
          : `${label} proxy cache is ready, but the API key is missing.`
        : `${label} proxy cache did not report ready.`;
    } catch (error) {
      try {
        const health = await fetchJsonWithTimeout(`http://127.0.0.1:${port}/health`, { method: "GET", cache: "no-store" });
        status.proxy = Boolean(health?.ok && health?.provider === providerId);
        status.apiKey = Boolean(health?.hasApiKey);
        status.message = status.proxy
          ? status.apiKey
            ? `${label} proxy is running and has an API key.`
            : `${label} proxy is running, but the API key is missing.`
          : `${label} proxy did not report ready.`;
      } catch (healthError) {
        status.proxy = status.config ? "managed" : null;
        status.apiKey = status.config ? "env" : null;
        status.message = status.config
          ? `${label} is configured for the launcher-managed local proxy. Renderer health fetch is blocked here.`
          : `Could not verify local proxy cache: ${error.message || String(error)}; renderer health fetch: ${healthError.message || String(healthError)}`;
      }
    } finally {
      status.checking = false;
      if (render) {
        state.status = status.message;
        renderNativeSettingsPanel();
      }
    }
  }

  async function applyDeepSeekSetup({ activate = false } = {}) {
    return applyManagedProviderSetup("deepseek", { activate });
  }

  async function applyManagedProviderSetup(presetId, { activate = false } = {}) {
    const preset = PRESETS[presetId] || PRESETS.custom;
    const providerId = preset.providerId || presetId;
    const label = preset.label || providerId;
    state.busy = true;
    state.lastError = null;
    state.status = activate ? `Making ${label} active...` : `Writing ${label} provider table...`;
    renderNativeSettingsPanel();
    try {
      await writeConfigEdits(managedProviderSetupEdits(presetId, { activate }));
      if (activate) {
        applyPresetFields(presetId, true);
        state.fields.model = managedProviderActivationModel(presetId);
        state.fields.reasoningEffort = bestReasoningForModel(state.fields.model, state.fields.reasoningEffort, providerId);
      }
      state.status = activate ? `${label} is now the active provider.` : `${label} provider table is configured.`;
      await loadConfig();
    } catch (error) {
      state.lastError = error.message || String(error);
      state.status = state.lastError;
    } finally {
      state.busy = false;
      renderNativeSettingsPanel();
    }
  }

  async function saveProviderApiKey(providerId, value) {
    const preset = PRESETS[presetIdForProviderId(providerId)] || PRESETS.custom;
    if (!preset.envKey) {
      throw new Error("This provider does not use an API-key environment variable.");
    }
    if (!String(value || "").trim()) {
      throw new Error("API key value is required.");
    }
    if (!MANAGED_PROXY_PORTS[providerId]) {
      throw new Error(`Inline API-key setup is not available for ${providerId}.`);
    }
    return fetchJsonWithTimeout(
      `http://127.0.0.1:${MANAGED_PROXY_PORTS[providerId]}/admin/env`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envKey: preset.envKey, value: String(value).trim() }),
      },
      15000
    );
  }

  function applyPresetFields(presetId, keepManualModel = false) {
    const preset = PRESETS[presetId] || PRESETS.custom;
    state.fields.preset = presetId;
    state.fields.providerId = preset.providerId;
    state.fields.displayName = preset.displayName;
    if (!keepManualModel || !state.fields.model) {
      state.fields.model = preset.model || "";
    }
    state.fields.baseUrl = preset.baseUrl;
    state.fields.envKey = preset.envKey;
    state.fields.wireApi = normalizeWireApi(preset.wireApi);
    state.fields.writeProviderTable = !preset.builtIn;
    saveDraft();
  }

  function currentPreset() {
    return PRESETS[state.fields.preset] || PRESETS.custom;
  }

  function currentProviderId() {
    return state.fields.providerId || currentPreset().providerId || "openai";
  }

  function presetIdForProviderId(providerId) {
    const target = String(providerId || "").trim();
    const entry = Object.entries(PRESETS).find(([presetId, preset]) => presetId === target || preset.providerId === target);
    return entry?.[0] || "custom";
  }

  function providerLabel(providerId = currentProviderId()) {
    const entry = Object.entries(PRESETS).find(([presetId, preset]) => presetId === providerId || preset.providerId === providerId);
    if (!entry) {
      return state.fields.displayName || providerId;
    }
    const [presetId, preset] = entry;
    if (presetId === state.fields.preset || preset.providerId === state.fields.providerId) {
      return state.fields.displayName || preset.label;
    }
    return preset.label;
  }

  function syncFieldsFromConfig(config) {
    const presetId = presetForConfig(config);
    const preset = PRESETS[presetId] || PRESETS.custom;
    const activeProvider = String(config?.model_provider || "").trim();
    const providerId =
      activeProvider === "oss"
        ? String(config?.oss_provider || preset.providerId || "ollama")
        : String(activeProvider || preset.providerId || "openai");
    const provider = providerConfig(config, providerId) || providerConfig(config, preset.providerId) || {};
    state.fields = {
      ...state.fields,
      preset: presetId,
      providerId,
      displayName: provider.name || preset.displayName,
      model: config?.model || preset.model || "",
      reasoningEffort: config?.model_reasoning_effort || state.fields.reasoningEffort || "medium",
      reasoningSummary: config?.model_reasoning_summary || "",
      baseUrl: provider.base_url || preset.baseUrl || "",
      envKey: provider.env_key || preset.envKey || "",
      wireApi: normalizeWireApi(provider.wire_api || preset.wireApi),
      profileName: config?.profile || state.fields.profileName || "",
      activateProfile: Boolean(config?.profile),
      writeProviderTable: !preset.builtIn,
    };
    state.fields.reasoningEffort = bestReasoningForModel(state.fields.model, state.fields.reasoningEffort, providerId);
    saveDraft();
  }

  async function loadConfig() {
    state.busy = true;
    state.lastError = null;
    state.status = "Reading Codex config...";
    renderNativeSettingsPanel();
    try {
      const result = await readConfigFromAppServer();
      state.loadedConfig = result?.config || {};
      syncFieldsFromConfig(state.loadedConfig);
      await refreshDeepSeekStatus({ render: false });
      await refreshManagedProviderStatus("zai", { render: false });
      await refreshManagedProviderStatus("dashscope", { render: false });
      await refreshManagedProviderStatus("cerebras", { render: false });
      refreshOllamaModelsInBackground({ force: true });
      await refreshManagedProviderModels("deepseek", { render: false, force: false });
      await refreshManagedProviderModels("zai", { render: false, force: false });
      await refreshManagedProviderModels("dashscope", { render: false, force: false });
      await refreshManagedProviderModels("cerebras", { render: false, force: false });
      state.status = `Loaded ${state.fields.providerId || "openai"} / ${state.fields.model || "no model selected"}.`;
    } catch (error) {
      state.lastError = error.message || String(error);
      state.status = state.lastError;
    } finally {
      state.busy = false;
      renderNativeSettingsPanel();
    }
  }

  async function refreshOllamaModels({ render = true } = {}) {
    if (render) {
      state.busy = true;
      state.lastError = null;
      state.status = "Checking running Ollama models at localhost:11434...";
      renderNativeSettingsPanel();
    }
    try {
      const [runningResult, installedResult] = await Promise.allSettled([
        fetchJsonWithTimeout("http://localhost:11434/api/ps", { method: "GET", cache: "no-store" }, 2500),
        fetchJsonWithTimeout("http://localhost:11434/api/tags", { method: "GET", cache: "no-store" }, 3500),
      ]);
      const runningModels = runningResult.status === "fulfilled" ? ollamaModelNamesFromList(runningResult.value) : [];
      const installedModels = installedResult.status === "fulfilled" ? ollamaModelNamesFromList(installedResult.value) : [];
      if (!runningModels.length && !installedModels.length) {
        const reason =
          runningResult.status === "rejected"
            ? runningResult.reason?.message || String(runningResult.reason)
            : installedResult.status === "rejected"
              ? installedResult.reason?.message || String(installedResult.reason)
              : "Ollama responded but returned no models.";
        throw new Error(reason);
      }
      const discovered = updateOllamaModelDiscovery({
        runningModels,
        installedModels,
        source: runningModels.length ? "ollama-running" : "ollama-installed",
      });
      if (render) {
        state.status = `Found ${runningModels.length} running and ${installedModels.length} installed Ollama model${
          discovered.length === 1 ? "" : "s"
        }.`;
      }
    } catch (error) {
      const setup = providerSetup("ollama");
      setup.lastModelRefreshAt = Date.now();
      setup.lastModelRefreshSource = "error";
      setup.lastModelRefreshError = error.message || String(error);
      if (render) {
        state.lastError = error.message || String(error);
        state.status = "Could not read Ollama local models.";
      }
      return [];
    } finally {
      if (render) {
        state.busy = false;
        renderNativeSettingsPanel();
      }
    }
    return state.ollamaModels;
  }

  async function refreshLmStudioModels({ render = true } = {}) {
    if (render) {
      state.busy = true;
      state.lastError = null;
      state.status = "Checking LM Studio at localhost:1234...";
      renderNativeSettingsPanel();
    }
    try {
      const response = await fetch("http://localhost:1234/v1/models", { method: "GET" });
      if (!response.ok) {
        throw new Error(`LM Studio returned HTTP ${response.status}.`);
      }
      const data = await response.json();
      state.lmStudioModels = Array.isArray(data.data)
        ? data.data
            .map((model) => model.id)
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b))
        : [];
      const setup = providerSetup("lmstudio");
      const previousVisible = uniqueModelNames(setup.visibleModels || []);
      setup.availableModels = uniqueModelNames(state.lmStudioModels);
      setup.visibleModels = uniqueModelNames([...previousVisible, ...state.lmStudioModels]);
      setup.lastModelRefreshAt = Date.now();
      setup.lastModelRefreshSource = "lmstudio";
      setup.lastModelRefreshError = "";
      if (state.lmStudioModels.length && !state.fields.model) {
        state.fields.model = state.lmStudioModels[0];
      }
      if (render) {
        state.status = state.lmStudioModels.length
          ? `Found ${state.lmStudioModels.length} LM Studio model${state.lmStudioModels.length === 1 ? "" : "s"}.`
          : "LM Studio responded but no local models were returned.";
      }
      saveDraft();
    } catch (error) {
      if (render) {
        state.lastError = error.message || String(error);
        state.status = "Could not read LM Studio local models.";
      }
    } finally {
      if (render) {
        state.busy = false;
        renderNativeSettingsPanel();
      }
    }
  }

  function validateFields() {
    const fields = state.fields;
    if (!fields.providerId.trim()) {
      throw new Error("Provider id is required.");
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(fields.providerId.trim())) {
      throw new Error("Provider id can only contain letters, numbers, dot, underscore, and dash.");
    }
    if (!fields.model.trim()) {
      throw new Error("Model is required.");
    }
    if (fields.writeProviderTable && !fields.baseUrl.trim()) {
      throw new Error("Base URL is required for custom providers.");
    }
    if (normalizeWireApi(fields.wireApi) !== "responses") {
      throw new Error("Wire API must be responses.");
    }
    if (fields.profileName.trim() && !/^[A-Za-z0-9_.-]+$/.test(fields.profileName.trim())) {
      throw new Error("Profile name can only contain letters, numbers, dot, underscore, and dash.");
    }
  }

  async function refreshManagedProviderModels(presetId, { render = true, force = true } = {}) {
    const preset = PRESETS[presetId] || PRESETS.custom;
    const providerId = preset.providerId || presetId;
    const port = MANAGED_PROXY_PORTS[providerId];
    const setup = providerSetup(providerId);
    const label = preset.label || providerId;
    if (!port) {
      return [];
    }
    if (render) {
      state.busy = true;
      state.lastError = null;
      state.status = `Reading ${label} models...`;
      renderNativeSettingsPanel();
    }
    try {
      let body;
      try {
        body = await readManagedProviderModelCache(providerId);
      } catch (cacheError) {
        const suffix = force ? "?refresh=1" : "";
        try {
          body = await fetchJsonWithTimeout(`http://127.0.0.1:${port}/models${suffix}`, { method: "GET", cache: "no-store" }, 12000);
        } catch (fetchError) {
          throw new Error(`${cacheError.message || String(cacheError)}; renderer fetch failed: ${fetchError.message || String(fetchError)}`);
        }
      }
      const models = uniqueModelNames(
        (Array.isArray(body?.data) ? body.data : [])
          .map((model) => (typeof model === "string" ? model : model?.id || model?.model || model?.name))
          .filter(Boolean)
      );
      if (!models.length) {
        throw new Error(`${label} did not return any model ids.`);
      }
      const previousVisible = uniqueModelNames(setup.visibleModels || []);
      setup.availableModels = models;
      setup.visibleModels = uniqueModelNames([...previousVisible, ...models]);
      setup.lastModelRefreshAt = Date.now();
      setup.lastModelRefreshSource = String(body?.source || "unknown");
      setup.lastModelRefreshError = String(body?.error || "");
      if (state.fields.providerId === providerId && !setup.visibleModels.includes(state.fields.model)) {
        state.fields.model = setup.visibleModels[0] || state.fields.model;
        state.fields.reasoningEffort = bestReasoningForModel(state.fields.model, state.fields.reasoningEffort, providerId);
      }
      if (render) {
        const suffixText = body?.source === "fallback" && body?.error ? ` Fallback used: ${body.error}` : "";
        state.status = `Found ${models.length} ${label} model${models.length === 1 ? "" : "s"}.${suffixText}`;
      }
      saveDraft();
      enhanceOpenModelMenus();
      return models;
    } catch (error) {
      setup.lastModelRefreshAt = Date.now();
      setup.lastModelRefreshSource = "error";
      setup.lastModelRefreshError = error.message || String(error);
      if (render) {
        state.lastError = error.message || String(error);
        state.status = `Could not read ${label} models.`;
      }
      return [];
    } finally {
      if (render) {
        state.busy = false;
        renderNativeSettingsPanel();
      }
    }
  }

  function configEdits() {
    validateFields();
    const fields = {
      ...state.fields,
      providerId: state.fields.providerId.trim(),
      displayName: state.fields.displayName.trim(),
      model: state.fields.model.trim(),
      baseUrl: state.fields.baseUrl.trim(),
      envKey: state.fields.envKey.trim(),
      profileName: state.fields.profileName.trim(),
      wireApi: normalizeWireApi(state.fields.wireApi),
    };
    fields.reasoningEffort = bestReasoningForModel(fields.model, fields.reasoningEffort, fields.providerId);
    const edits = [];
    const clearEdit = (keyPath) => ({ keyPath, value: null, mergeStrategy: "replace" });
    const isOssProvider = fields.providerId === "ollama" || fields.providerId === "lmstudio";
    const isOpenAiProvider = fields.providerId === "openai" && !fields.writeProviderTable;

    if (fields.writeProviderTable) {
      const provider = {
        name: fields.displayName || fields.providerId,
        base_url: fields.baseUrl,
        wire_api: normalizeWireApi(fields.wireApi),
      };
      if (fields.envKey) {
        provider.env_key = fields.envKey;
      }
      edits.push({ keyPath: `model_providers.${fields.providerId}`, value: provider, mergeStrategy: "upsert" });
      edits.push({ keyPath: "model_provider", value: fields.providerId, mergeStrategy: "upsert" });
      edits.push(clearEdit("oss_provider"));
    } else if (isOssProvider) {
      edits.push({ keyPath: "model_provider", value: fields.providerId, mergeStrategy: "upsert" });
      edits.push(clearEdit("oss_provider"));
    } else if (isOpenAiProvider) {
      edits.push(clearEdit("model_provider"));
      edits.push(clearEdit("oss_provider"));
    } else {
      edits.push(clearEdit("model_provider"));
      edits.push(clearEdit("oss_provider"));
    }

    edits.push({ keyPath: "model", value: fields.model, mergeStrategy: "upsert" });
    if (fields.reasoningEffort) {
      edits.push({ keyPath: "model_reasoning_effort", value: fields.reasoningEffort, mergeStrategy: "upsert" });
    }
    if (fields.reasoningSummary) {
      edits.push({ keyPath: "model_reasoning_summary", value: fields.reasoningSummary, mergeStrategy: "upsert" });
    } else {
      edits.push(clearEdit("model_reasoning_summary"));
    }

    if (fields.profileName) {
      if (fields.activateProfile) {
        edits.push({ keyPath: "profile", value: fields.profileName, mergeStrategy: "upsert" });
      }
      edits.push({ keyPath: `profiles.${fields.profileName}.model`, value: fields.model, mergeStrategy: "upsert" });
      if (isOpenAiProvider) {
        edits.push(clearEdit(`profiles.${fields.profileName}.model_provider`));
        edits.push(clearEdit(`profiles.${fields.profileName}.oss_provider`));
      } else if (isOssProvider) {
        edits.push({
          keyPath: `profiles.${fields.profileName}.model_provider`,
          value: "oss",
          mergeStrategy: "upsert",
        });
        edits.push({ keyPath: `profiles.${fields.profileName}.oss_provider`, value: fields.providerId, mergeStrategy: "upsert" });
      } else {
        edits.push({
          keyPath: `profiles.${fields.profileName}.model_provider`,
          value: fields.providerId,
          mergeStrategy: "upsert",
        });
        edits.push(clearEdit(`profiles.${fields.profileName}.oss_provider`));
      }
      if (fields.reasoningEffort) {
        edits.push({
          keyPath: `profiles.${fields.profileName}.model_reasoning_effort`,
          value: fields.reasoningEffort,
          mergeStrategy: "upsert",
        });
      }
    }

    return edits;
  }

  async function applyConfig() {
    state.busy = true;
    state.lastError = null;
    state.status = "Writing provider config...";
    renderNativeSettingsPanel();
    try {
      const edits = configEdits();
      await writeConfigEdits(edits);
      state.status = `Wrote ${edits.length} config setting${edits.length === 1 ? "" : "s"}. Restart Codex if the model picker does not refresh.`;
      saveDraft();
      await loadConfig();
    } catch (error) {
      state.lastError = error.message || String(error);
      state.status = state.lastError;
    } finally {
      state.busy = false;
      renderNativeSettingsPanel();
    }
  }

  async function activateProviderPreset(presetId) {
    const preset = PRESETS[presetId] || PRESETS.custom;
    const providerId = preset.providerId || presetId;
    if (["deepseek", "zai", "dashscope", "cerebras"].includes(presetId)) {
      await applyManagedProviderSetup(presetId, { activate: true });
      return;
    }
    applyPresetFields(presetId, false);
    const models = providerModelsForPreset(presetId);
    if (!state.fields.model || !models.includes(state.fields.model)) {
      state.fields.model = models[0] || preset.model || state.fields.model;
    }
    state.fields.reasoningEffort = bestReasoningForModel(state.fields.model, state.fields.reasoningEffort, providerId);
    await applyConfig();
  }

  async function saveProviderBaseUrl(presetId, value) {
    const preset = PRESETS[presetId] || PRESETS.custom;
    preset.baseUrl = String(value || "").trim();
    if (state.fields.preset === presetId || state.fields.providerId === preset.providerId) {
      state.fields.baseUrl = preset.baseUrl;
    }
    if (["deepseek", "zai", "dashscope", "cerebras"].includes(presetId)) {
      await applyManagedProviderSetup(presetId, { activate: providerIsActive(presetId) });
      return;
    }
    if (providerIsActive(presetId)) {
      await activateProviderPreset(presetId);
    } else {
      saveDraft();
      state.status = `${preset.label} base URL updated for this session.`;
      renderNativeSettingsPanel();
    }
  }

  async function applyModelMenuSelection({ model, reasoningEffort = state.fields.reasoningEffort }) {
    if (!model || state.menuBusy) {
      return;
    }
    state.menuBusy = true;
    state.lastError = null;
    state.status = `Selecting ${model}...`;
    state.fields.model = model;
    state.fields.reasoningEffort = reasoningEffort || "none";
    saveDraft();
    enhanceOpenModelMenus();
    try {
      const edits = configEdits();
      await writeConfigEdits(edits);
      state.status = `Selected ${state.fields.model} for ${providerLabel()}.`;
    } catch (error) {
      state.lastError = error.message || String(error);
      state.status = state.lastError;
    } finally {
      state.menuBusy = false;
      enhanceOpenModelMenus();
    }
  }

  function modelOptions() {
    const localModels = state.fields.providerId === "ollama" ? state.ollamaModels : state.fields.providerId === "lmstudio" ? state.lmStudioModels : [];
    return uniqueModelNames([state.fields.model, ...providerModelsForPreset(state.fields.preset), ...localModels]);
  }

  function reasoningProfileForModel(model = state.fields.model, providerId = currentProviderId()) {
    const normalized = String(model || "").toLowerCase();
    if (providerId === "openai") {
      return {
        parameter: "reasoning.effort",
        mode: "Native reasoning effort",
        options: ["minimal", "low", "medium", "high", "xhigh"],
      };
    }
    if (providerId === "deepseek") {
      if (normalized.includes("chat") && !normalized.includes("reason") && !normalized.includes("v4")) {
        return { parameter: "thinking.type", mode: "No thinking mode", options: ["none"] };
      }
      return {
        parameter: "thinking.type + reasoning_effort",
        mode: "DeepSeek thinking",
        options: ["none", "low", "medium", "high", "xhigh"],
      };
    }
    if (providerId === "zai") {
      if (normalized === "glm-5.2") {
        return {
          parameter: "thinking.type + reasoning_effort",
          mode: "GLM-5.2 reasoning effort",
          options: ["none", "low", "medium", "high", "xhigh"],
        };
      }
      return { parameter: "thinking.type", mode: "GLM thinking", options: ["none", "medium"] };
    }
    if (providerId === "dashscope") {
      return { parameter: "enable_thinking", mode: "Qwen thinking", options: ["none", "medium"] };
    }
    if (providerId === "cerebras") {
      if (normalized === "gpt-oss-120b") {
        return { parameter: "reasoning_effort", mode: "Cerebras reasoning effort", options: ["low", "medium", "high"] };
      }
      if (normalized === "zai-glm-4.7") {
        return { parameter: "reasoning_effort / clear_thinking", mode: "Cerebras GLM reasoning", options: ["none", "low", "medium", "high"] };
      }
      return { parameter: "none", mode: "No provider reasoning control", options: ["none"] };
    }
    if (normalized.includes("chat") && !normalized.includes("reason") && !normalized.includes("r1")) {
      return { parameter: "none", mode: "No thinking mode", options: ["none"] };
    }
    if (normalized.includes("reason") || normalized.includes("r1") || normalized.includes("thinking") || normalized.includes("gpt-oss")) {
      return { parameter: "provider default", mode: "Reasoning effort", options: ["none", "low", "medium", "high"] };
    }
    return { parameter: "provider default", mode: "Reasoning effort", options: ["none", "low", "medium", "high"] };
  }

  function reasoningOptionsForModel(model = state.fields.model, providerId = currentProviderId()) {
    return reasoningProfileForModel(model, providerId).options;
  }

  function reasoningLabel(value) {
    return (
      {
        none: "Off",
        minimal: "Minimal",
        low: "Low",
        medium: "Medium",
        high: "High",
        xhigh: "Extra High",
      }[value] || value
    );
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function optionHtml(value, selectedValue) {
    const selected = value === selectedValue ? " selected" : "";
    return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(value)}</option>`;
  }

  function isVisibleElement(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 40 || rect.bottom < 0 || rect.right < 0) {
      return false;
    }
    if (rect.top > window.innerHeight || rect.left > window.innerWidth) {
      return false;
    }
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
  }

  function isVisibleNode(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || rect.bottom < 0 || rect.right < 0) {
      return false;
    }
    if (rect.top > window.innerHeight || rect.left > window.innerWidth) {
      return false;
    }
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
  }

  function menuCandidates() {
    const candidates = new Set();
    document.querySelectorAll("[role='menu'], [role='listbox'], [data-radix-popper-content-wrapper], [data-floating-ui-portal], div").forEach((element) => {
      if (!isVisibleElement(element)) {
        return;
      }
      const rect = element.getBoundingClientRect();
      const role = element.getAttribute("role");
      const style = window.getComputedStyle(element);
      const floatingRoot = element.closest("[data-radix-popper-content-wrapper], [data-floating-ui-portal]");
      const isFloating =
        role === "menu" ||
        role === "listbox" ||
        Boolean(floatingRoot) ||
        ((style.position === "fixed" || style.position === "absolute") && rect.width <= 560 && rect.height <= 760);
      if (!isFloating || rect.width > 640 || rect.height > 820) {
        return;
      }
      const text = normalizedText(element);
      if (!text || text.length > 1200) {
        return;
      }
      if (/\b(Model|Reasoning|GPT-5|Provider models|Provider reasoning)\b/i.test(text)) {
        candidates.add(element);
      }
    });
    return Array.from(candidates).sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.width * ar.height - br.width * br.height;
    });
  }

  function hasExactMenuText(root, text) {
    const target = text.toLowerCase();
    return Array.from(root.querySelectorAll("button, div, span, [role='menuitem']")).some(
      (element) => normalizedText(element).toLowerCase() === target
    );
  }

  function isModelMenu(root) {
    const text = normalizedText(root);
    const nativeModelCount = Array.from(root.querySelectorAll("button, [role='menuitem'], [role='option'], div, span")).filter((element) =>
      isNativeModelText(normalizedText(element))
    ).length;
    if (!hasExactMenuText(root, "Model") && nativeModelCount < 2 && !root.querySelector("[data-cps-provider-model-section='active']")) {
      return false;
    }
    return /GPT-5|gpt-5|Model|models/i.test(text) || nativeModelCount >= 2;
  }

  function isReasoningMenu(root) {
    const text = normalizedText(root);
    return hasExactMenuText(root, "Reasoning") && /\b(Low|Medium|High|Extra High|Off)\b/.test(text);
  }

  function maybeRefreshMenuProviderModels() {
    if (state.menuRefreshing) {
      return;
    }
    const refreshes = [];
    refreshes.push(refreshOllamaModelsInBackground());
    if (state.lmStudioModels.length === 0) {
      refreshes.push(refreshLmStudioModels({ render: false }));
    }
    if (!providerSetup("deepseek").availableModels?.length) {
      refreshes.push(refreshManagedProviderModels("deepseek", { render: false, force: false }));
    }
    if (!providerSetup("zai").availableModels?.length) {
      refreshes.push(refreshManagedProviderModels("zai", { render: false, force: false }));
    }
    if (!providerSetup("dashscope").availableModels?.length) {
      refreshes.push(refreshManagedProviderModels("dashscope", { render: false, force: false }));
    }
    if (!providerSetup("cerebras").availableModels?.length) {
      refreshes.push(refreshManagedProviderModels("cerebras", { render: false, force: false }));
    }
    if (refreshes.length === 0) {
      return;
    }
    state.menuRefreshing = true;
    Promise.allSettled(refreshes).finally(() => {
      state.menuRefreshing = false;
      enhanceOpenModelMenus();
    });
  }

  function uniqueModelNames(values) {
    return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
  }

  function providerSetup(providerId) {
    const key = String(providerId || "").trim() || "custom";
    if (!state.providers[key]) {
      const presetId = presetIdForProviderId(key);
      const preset = PRESETS[presetId] || PRESETS.custom;
      state.providers[key] = {
        visibleModels: [...(preset.models || [])],
        availableModels: [],
        advancedOpen: false,
      };
    }
    return state.providers[key];
  }

  function rawProviderModelsForPreset(presetId) {
    const preset = PRESETS[presetId] || PRESETS.custom;
    const setup = providerSetup(preset.providerId || presetId);
    const availableModels = Array.isArray(setup.availableModels) ? setup.availableModels : [];
    const currentModels = state.fields.preset === presetId || state.fields.providerId === preset.providerId ? [state.fields.model] : [];
    if (presetId === "ollama") {
      return uniqueModelNames([...currentModels, ...preset.models, ...state.ollamaModels]);
    }
    if (presetId === "lmstudio") {
      return uniqueModelNames([...currentModels, ...preset.models, ...state.lmStudioModels]);
    }
    if (presetId === "custom") {
      return state.fields.preset === "custom" ? uniqueModelNames([state.fields.model, ...preset.models]) : [];
    }
    return uniqueModelNames([...currentModels, ...availableModels, ...preset.models]);
  }

  function visibleModelSet(providerId) {
    const setup = providerSetup(providerId);
    const models = uniqueModelNames(setup.visibleModels || []);
    return new Set(models);
  }

  function providerModelsForPreset(presetId) {
    const preset = PRESETS[presetId] || PRESETS.custom;
    const models = rawProviderModelsForPreset(presetId);
    if (presetId === "custom") {
      return models;
    }
    const visible = visibleModelSet(preset.providerId || presetId);
    return models.filter((model) => visible.has(model));
  }

  function toggleProviderModel(providerId, model, enabled) {
    const setup = providerSetup(providerId);
    const current = visibleModelSet(providerId);
    if (enabled) {
      current.add(model);
    } else {
      current.delete(model);
    }
    const presetId = presetIdForProviderId(providerId);
    const presetModels = rawProviderModelsForPreset(presetId);
    const next = presetModels.filter((candidate) => current.has(candidate));
    setup.visibleModels = next;
    if (state.fields.providerId === providerId && !setup.visibleModels.includes(state.fields.model)) {
      state.fields.model = setup.visibleModels[0] || state.fields.model;
      state.fields.reasoningEffort = bestReasoningForModel(state.fields.model, state.fields.reasoningEffort, providerId);
    }
    saveDraft();
  }

  function setProviderModelVisibility(providerId, visible) {
    const setup = providerSetup(providerId);
    const presetId = presetIdForProviderId(providerId);
    setup.visibleModels = visible ? rawProviderModelsForPreset(presetId) : [];
    if (visible && state.fields.providerId === providerId && !setup.visibleModels.includes(state.fields.model)) {
      state.fields.model = setup.visibleModels[0] || state.fields.model;
      state.fields.reasoningEffort = bestReasoningForModel(state.fields.model, state.fields.reasoningEffort, providerId);
    }
    saveDraft();
    enhanceOpenModelMenus();
  }

  function visibleModelCount(providerId) {
    return providerModelsForPreset(presetIdForProviderId(providerId)).length;
  }

  function providerModelGroups() {
    return ["openai", "deepseek", "zai", "dashscope", "cerebras", "ollama", "lmstudio", "custom"]
      .map((presetId) => ({
        presetId,
        preset: PRESETS[presetId] || PRESETS.custom,
        models: providerModelsForPreset(presetId),
      }))
      .filter((group) => group.models.length > 0 || group.presetId === "custom");
  }

  function autoRouterProviderPresets() {
    return ["openai", "deepseek", "zai", "dashscope", "cerebras", "ollama", "lmstudio"];
  }

  function modelEntryKey(providerId, model) {
    return `${String(providerId || "").trim()}:${String(model || "").trim()}`;
  }

  function modelEntryLabel(entry) {
    return `${entry.model} (${entry.providerLabel})`;
  }

  function allConfiguredModelEntries() {
    const entries = [];
    const seen = new Set();
    for (const presetId of autoRouterProviderPresets()) {
      const preset = PRESETS[presetId] || PRESETS.custom;
      const providerId = preset.providerId || presetId;
      for (const model of providerModelsForPreset(presetId)) {
        const key = modelEntryKey(providerId, model);
        if (!model || seen.has(key)) {
          continue;
        }
        seen.add(key);
        entries.push({
          key,
          model,
          presetId,
          providerId,
          providerLabel: preset.label || providerId,
          reasoningEffort: bestReasoningForModel(model, state.fields.reasoningEffort || "medium", providerId),
        });
      }
    }
    return entries;
  }

  function entryForModelKey(key, entries = allConfiguredModelEntries()) {
    return entries.find((entry) => entry.key === key) || entries.find((entry) => entry.model === key) || null;
  }

  function defaultPersonaItems() {
    return DEFAULT_PERSONAS.map((persona) => ({ ...persona, enabled: true }));
  }

  function personaIdFromName(name) {
    return String(name || "persona")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "persona";
  }

  function normalizePersona(item, index = 0) {
    const fallback = DEFAULT_PERSONAS[index] || DEFAULT_PERSONAS[0] || {};
    const name = String(item?.name || fallback.name || `Persona ${index + 1}`).trim();
    const id = String(item?.id || fallback.id || personaIdFromName(name) || `persona-${index + 1}`).trim();
    return {
      id,
      name,
      description: String(item?.description || fallback.description || "").trim(),
      context: String(item?.context || fallback.context || "").trim(),
      prompt: String(item?.prompt || fallback.prompt || "").trim(),
      enabled: item?.enabled !== false,
    };
  }

  function normalizePersonasSettings(settings) {
    const sourceItems = Array.isArray(settings?.items) && settings.items.length ? settings.items : defaultPersonaItems();
    const seen = new Set();
    const items = sourceItems.map((item, index) => {
      const persona = normalizePersona(item, index);
      let id = persona.id || `persona-${index + 1}`;
      if (seen.has(id)) {
        id = `${id}-${index + 1}`;
      }
      seen.add(id);
      return { ...persona, id };
    });
    const firstEnabled = items.find((persona) => persona.enabled !== false) || items[0] || null;
    const hasActive = items.some((persona) => persona.id === settings?.activePersonaId);
    const hasDefault = items.some((persona) => persona.id === settings?.defaultPersonaId);
    const mode = ["manual", "auto"].includes(String(settings?.mode || "")) ? String(settings.mode) : "manual";
    return {
      enabled: Boolean(settings?.enabled),
      mode,
      activePersonaId: hasActive ? String(settings.activePersonaId) : firstEnabled?.id || "",
      defaultPersonaId: hasDefault ? String(settings.defaultPersonaId) : firstEnabled?.id || "",
      autoFallbackToDefault: settings?.autoFallbackToDefault !== false,
      items,
      testInput: String(settings?.testInput || ""),
      testResult: settings?.testResult || null,
      lastAppliedAt: Number(settings?.lastAppliedAt || 0),
      lastAppliedPersonaId: String(settings?.lastAppliedPersonaId || ""),
      lastError: String(settings?.lastError || ""),
    };
  }

  function personaById(id) {
    state.personas = normalizePersonasSettings(state.personas);
    return state.personas.items.find((persona) => persona.id === id) || null;
  }

  function personaContextTokens(persona) {
    return String(persona?.context || "")
      .split(/[\n,;]+/)
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean);
  }

  function matchPersonaForText(text) {
    state.personas = normalizePersonasSettings(state.personas);
    const enabledItems = state.personas.items.filter((persona) => persona.enabled !== false);
    if (!enabledItems.length) {
      return { persona: null, reason: "No enabled personas." };
    }
    if (state.personas.mode !== "auto") {
      const manual = personaById(state.personas.activePersonaId) || enabledItems[0] || null;
      return { persona: manual, reason: manual ? "Selected manually." : "No manual persona selected." };
    }
    const normalized = String(text || "").toLowerCase();
    let best = null;
    for (const persona of enabledItems) {
      const tokens = personaContextTokens(persona);
      let score = 0;
      const hits = [];
      for (const token of tokens) {
        if (token && normalized.includes(token)) {
          score += Math.max(1, Math.min(6, Math.round(token.length / 4)));
          hits.push(token);
        }
      }
      if (score > 0 && (!best || score > best.score)) {
        best = { persona, score, hits };
      }
    }
    if (best) {
      return { persona: best.persona, reason: `Matched: ${best.hits.slice(0, 5).join(", ")}` };
    }
    if (state.personas.autoFallbackToDefault) {
      const fallback = personaById(state.personas.defaultPersonaId) || enabledItems[0] || null;
      return { persona: fallback, reason: fallback ? "No context match; using default persona." : "No default persona." };
    }
    return { persona: null, reason: "No context match and fallback is off." };
  }

  function personaInstruction(persona, reason = "") {
    if (!persona || !String(persona.prompt || "").trim()) {
      return "";
    }
    return [
      `Persona: ${persona.name}`,
      persona.description ? `Purpose: ${persona.description}` : "",
      reason ? `Selection: ${reason}` : "",
      "",
      String(persona.prompt || "").trim(),
    ]
      .filter((line) => line !== "")
      .join("\n");
  }

  function applyPersonaToTurnRequest(request) {
    if (!patcherFeatureEnabled("personas", true) || !state.personas.enabled) {
      return false;
    }
    const params = request?.params;
    if (!params || typeof params !== "object") {
      state.personas.lastError = "Persona skipped because turn/start params were not an object.";
      saveDraft();
      return false;
    }
    const turnText = extractTextFromTurnInput(params.input || params);
    const match = matchPersonaForText(turnText);
    const text = personaInstruction(match.persona, match.reason);
    if (!text) {
      state.personas.lastError = match.reason || "Persona skipped because no persona instructions were available.";
      saveDraft();
      return false;
    }
    if (applyAdditionalDeveloperInstructions(params, text, "append")) {
      state.personas.lastAppliedAt = Date.now();
      state.personas.lastAppliedPersonaId = match.persona.id;
      state.personas.lastError = "";
      state.status = `Persona applied: ${match.persona.name}.`;
      saveDraft();
      return true;
    }
    if (createLegacyDeveloperInstructionsSlot(params, text)) {
      state.personas.lastAppliedAt = Date.now();
      state.personas.lastAppliedPersonaId = match.persona.id;
      state.personas.lastError = "Applied persona through legacy developer_instructions.";
      saveDraft();
      return true;
    }
    state.personas.lastError = "Persona skipped because no safe instruction field was available.";
    saveDraft();
    return false;
  }

  function setPersonaField(personaId, field, value) {
    state.personas = normalizePersonasSettings(state.personas);
    const persona = state.personas.items.find((item) => item.id === personaId);
    if (!persona || !["name", "description", "context", "prompt", "enabled"].includes(field)) {
      return;
    }
    persona[field] = field === "enabled" ? Boolean(value) : String(value || "");
    saveDraft();
  }

  function addPersona() {
    state.personas = normalizePersonasSettings(state.personas);
    const id = `custom-${Date.now().toString(36)}`;
    state.personas.items.push({
      id,
      name: "New persona",
      description: "Custom persona.",
      context: "",
      prompt: "Describe how Codex should behave for this persona.",
      enabled: true,
    });
    state.personas.activePersonaId = id;
    saveDraft();
    renderNativeSettingsPanel();
  }

  function deletePersona(personaId) {
    state.personas = normalizePersonasSettings(state.personas);
    if (state.personas.items.length <= 1) {
      state.personas.lastError = "Keep at least one persona.";
      saveDraft();
      renderNativeSettingsPanel();
      return;
    }
    state.personas.items = state.personas.items.filter((persona) => persona.id !== personaId);
    state.personas = normalizePersonasSettings(state.personas);
    saveDraft();
    renderNativeSettingsPanel();
  }

  function resetPersonasToDefaults() {
    state.personas = normalizePersonasSettings({
      ...state.personas,
      enabled: state.personas.enabled,
      mode: "manual",
      activePersonaId: "pragmatic-engineer",
      defaultPersonaId: "pragmatic-engineer",
      autoFallbackToDefault: true,
      items: defaultPersonaItems(),
      testResult: null,
      lastError: "",
    });
    saveDraft();
    renderNativeSettingsPanel();
  }

  function runPersonaDryRun(sampleText) {
    state.personas.testInput = String(sampleText || "");
    const match = matchPersonaForText(state.personas.testInput);
    state.personas.testResult = {
      personaId: match.persona?.id || "",
      name: match.persona?.name || "No persona",
      reason: match.reason || "",
      promptPreview: compact(match.persona?.prompt || "", 500),
    };
    state.status = `Persona dry run: ${state.personas.testResult.name}.`;
    saveDraft();
    renderNativeSettingsPanel();
  }

  function routerModelEntries(entries = allConfiguredModelEntries()) {
    return entries.filter((entry) => Boolean(MANAGED_PROXY_PORTS[entry.providerId]));
  }

  function autoRouterEligibleEntries() {
    const entries = allConfiguredModelEntries();
    const keys = state.autoRouter.eligibleModelKeys;
    if (!Array.isArray(keys)) {
      return entries;
    }
    const selected = new Set(keys);
    return entries.filter((entry) => selected.has(entry.key));
  }

  function autoRouterEligibleKeySet(entries = allConfiguredModelEntries()) {
    if (!Array.isArray(state.autoRouter.eligibleModelKeys)) {
      return new Set(entries.map((entry) => entry.key));
    }
    return new Set(state.autoRouter.eligibleModelKeys);
  }

  function ensureAutoRouterEligibleKeys() {
    const entries = allConfiguredModelEntries();
    if (!Array.isArray(state.autoRouter.eligibleModelKeys)) {
      return entries.map((entry) => entry.key);
    }
    const valid = new Set(entries.map((entry) => entry.key));
    state.autoRouter.eligibleModelKeys = state.autoRouter.eligibleModelKeys.filter((key) => valid.has(key));
    return state.autoRouter.eligibleModelKeys;
  }

  function setAutoRouterEligibleModel(key, enabled) {
    const entries = allConfiguredModelEntries();
    const current = autoRouterEligibleKeySet(entries);
    if (enabled) {
      current.add(key);
    } else {
      current.delete(key);
    }
    state.autoRouter.eligibleModelKeys = entries.filter((entry) => current.has(entry.key)).map((entry) => entry.key);
    saveDraft();
  }

  function setAutoRouterEligibility(visible) {
    state.autoRouter.eligibleModelKeys = visible ? null : [];
    saveDraft();
  }

  function normalizeAutoRouterRouterModelKey() {
    const entries = routerModelEntries();
    if (entryForModelKey(state.autoRouter.routerModelKey, entries)) {
      return state.autoRouter.routerModelKey;
    }
    const fallback =
      entries.find((entry) => entry.providerId === "deepseek" && /flash/i.test(entry.model)) ||
      entries.find((entry) => entry.providerId === "zai") ||
      entries.find((entry) => entry.providerId === "dashscope") ||
      entries[0] ||
      null;
    if (fallback) {
      state.autoRouter.routerModelKey = fallback.key;
    } else {
      state.autoRouter.routerModelKey = "";
    }
    return state.autoRouter.routerModelKey;
  }

  function activeProviderModelGroup() {
    const providerId = currentProviderId();
    const presetId = presetIdForProviderId(providerId);
    const preset = PRESETS[presetId] || PRESETS.custom;
    return {
      presetId,
      preset,
      models: providerModelsForPreset(presetId),
      providerId: preset.providerId || providerId || presetId,
    };
  }

  function applyProviderModelMenuSelection(presetId, model) {
    const preset = PRESETS[presetId] || PRESETS.custom;
    if (presetId !== "custom") {
      applyPresetFields(presetId, false);
    } else {
      state.fields.preset = "custom";
      state.fields.providerId = state.fields.providerId || preset.providerId;
      state.fields.displayName = state.fields.displayName || preset.displayName;
      state.fields.writeProviderTable = true;
      saveDraft();
    }
    state.fields.model = model;
    const providerId = state.fields.providerId || preset.providerId || presetId;
    const reasoningEffort = bestReasoningForModel(model, state.fields.reasoningEffort, providerId);
    applyModelMenuSelection({ model, reasoningEffort });
  }

  function presetIdForModel(model) {
    const value = String(model || "").trim();
    const normalized = value.toLowerCase();
    if (!normalized) {
      return state.fields.preset || "openai";
    }
    for (const presetId of ["openai", "deepseek", "zai", "dashscope", "cerebras", "ollama", "lmstudio"]) {
      const models = rawProviderModelsForPreset(presetId).map((candidate) => candidate.toLowerCase());
      if (models.includes(normalized)) {
        return presetId;
      }
    }
    if (/^(gpt|o[0-9]|chatgpt|codex)[-.]/i.test(value) || normalized.startsWith("gpt-")) {
      return "openai";
    }
    if (normalized.startsWith("deepseek")) {
      return "deepseek";
    }
    if (normalized.startsWith("glm")) {
      return "zai";
    }
    if (normalized.includes(":")) {
      return "ollama";
    }
    if (normalized.startsWith("qwen") || normalized.startsWith("qwq")) {
      return "dashscope";
    }
    if (normalized.includes("cerebras") || normalized === "gemma-4-31b" || normalized === "gpt-oss-120b" || normalized.startsWith("zai-glm-")) {
      return "cerebras";
    }
    return state.fields.preset || "custom";
  }

  function modelMenuSelectionConfigEdits(presetId, model, reasoningEffort) {
    const preset = PRESETS[presetId] || PRESETS.custom;
    const providerId = preset.providerId || presetId;
    const normalizedReasoningEffort = bestReasoningForModel(model, reasoningEffort, providerId);
    const edits = [];

    if (providerId === "openai") {
      edits.push(clearEdit("model_provider"));
      edits.push(clearEdit("oss_provider"));
    } else if (providerId === "ollama" || providerId === "lmstudio") {
      edits.push({ keyPath: "model_provider", value: providerId, mergeStrategy: "upsert" });
      edits.push(clearEdit("oss_provider"));
    } else {
      edits.push({
        keyPath: `model_providers.${providerId}`,
        value: providerTableFromPreset(presetId),
        mergeStrategy: "upsert",
      });
      edits.push({ keyPath: "model_provider", value: providerId, mergeStrategy: "upsert" });
      edits.push(clearEdit("oss_provider"));
    }

    edits.push({ keyPath: "model", value: model, mergeStrategy: "upsert" });
    if (normalizedReasoningEffort) {
      edits.push({ keyPath: "model_reasoning_effort", value: normalizedReasoningEffort, mergeStrategy: "upsert" });
    } else {
      edits.push(clearEdit("model_reasoning_effort"));
    }
    edits.push(clearEdit("model_reasoning_summary"));

    const activeProfile = String(state.loadedConfig?.profile || "").trim();
    if (activeProfile) {
      edits.push({ keyPath: `profiles.${activeProfile}.model`, value: model, mergeStrategy: "upsert" });
      if (providerId === "openai") {
        edits.push(clearEdit(`profiles.${activeProfile}.model_provider`));
        edits.push(clearEdit(`profiles.${activeProfile}.oss_provider`));
      } else {
        edits.push({ keyPath: `profiles.${activeProfile}.model_provider`, value: providerId, mergeStrategy: "upsert" });
        edits.push(clearEdit(`profiles.${activeProfile}.oss_provider`));
      }
      if (normalizedReasoningEffort) {
        edits.push({
          keyPath: `profiles.${activeProfile}.model_reasoning_effort`,
          value: normalizedReasoningEffort,
          mergeStrategy: "upsert",
        });
      }
    }

    return { edits, providerId, reasoningEffort: normalizedReasoningEffort };
  }

  function extractTextFromTurnInput(value, depth = 0) {
    if (depth > 6 || value == null) {
      return "";
    }
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => extractTextFromTurnInput(item, depth + 1)).filter(Boolean).join("\n");
    }
    if (typeof value !== "object") {
      return "";
    }
    const preferred = [];
    for (const key of ["text", "message", "prompt", "content", "input"]) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const text = extractTextFromTurnInput(value[key], depth + 1);
        if (text) {
          preferred.push(text);
        }
      }
    }
    if (preferred.length) {
      return preferred.join("\n");
    }
    return Object.values(value)
      .map((item) => extractTextFromTurnInput(item, depth + 1))
      .filter(Boolean)
      .join("\n");
  }

  function outputTextFromResponse(response) {
    const chunks = [];
    const visit = (value, depth = 0) => {
      if (depth > 6 || value == null) {
        return;
      }
      if (typeof value === "string") {
        chunks.push(value);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item) => visit(item, depth + 1));
        return;
      }
      if (typeof value !== "object") {
        return;
      }
      if (typeof value.text === "string") {
        chunks.push(value.text);
      }
      if (typeof value.output_text === "string") {
        chunks.push(value.output_text);
      }
      if (typeof value.content === "string") {
        chunks.push(value.content);
      } else if (value.content) {
        visit(value.content, depth + 1);
      }
      if (value.output) {
        visit(value.output, depth + 1);
      }
    };
    visit(response);
    return chunks.join("\n").trim();
  }

  function parseRouterChoice(text, entries) {
    const trimmed = String(text || "").trim();
    if (!trimmed) {
      return null;
    }
    let payload = null;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      const match = trimmed.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          payload = JSON.parse(match[0]);
        } catch {
          payload = null;
        }
      }
    }
    const requestedModel = String(payload?.model || payload?.model_id || payload?.id || "").trim();
    const requestedKey = String(payload?.key || payload?.modelKey || "").trim();
    const reason = String(payload?.reason || payload?.rationale || "").trim();
    const lowered = trimmed.toLowerCase();
    const chosen =
      (requestedKey && entryForModelKey(requestedKey, entries)) ||
      (requestedModel && entries.find((entry) => entry.model.toLowerCase() === requestedModel.toLowerCase())) ||
      entries.find((entry) => lowered.includes(entry.key.toLowerCase())) ||
      entries.find((entry) => lowered.includes(entry.model.toLowerCase())) ||
      null;
    return chosen ? { entry: chosen, reason: reason || compact(trimmed, 220), source: "router-model" } : null;
  }

  async function modelBackedRouterChoice(turnText, entries) {
    normalizeAutoRouterRouterModelKey();
    const router = entryForModelKey(state.autoRouter.routerModelKey, routerModelEntries());
    if (!router) {
      throw new Error("No callable router model is configured. Select a router model from a provider with a local proxy.");
    }
    const port = MANAGED_PROXY_PORTS[router.providerId];
    if (!port) {
      throw new Error(`${router.providerLabel} cannot be used as the router model because it has no local routing proxy.`);
    }
    const eligibleText = entries.map((entry) => `- ${entry.model} [${entry.key}] ${entry.providerLabel}`).join("\n");
    const body = {
      model: router.model,
      stream: false,
      max_output_tokens: 220,
      input: [
        {
          role: "system",
          content: String(state.autoRouter.prompt || DEFAULT_AUTO_ROUTER_PROMPT),
        },
        {
          role: "user",
          content: `Eligible models:\n${eligibleText}\n\nUser turn:\n${compact(turnText, 4000)}\n\nReturn JSON only.`,
        },
      ],
    };
    const response = await fetchJsonWithTimeout(
      `http://127.0.0.1:${port}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      9000
    );
    return parseRouterChoice(outputTextFromResponse(response), entries);
  }

  async function chooseAutoRouterModel(turnText) {
    const entries = autoRouterEligibleEntries();
    if (!entries.length) {
      throw new Error("Auto Router has no eligible models. Enable at least one model in Auto Router settings.");
    }
    try {
      const routed = await modelBackedRouterChoice(turnText, entries);
      if (routed?.entry) {
        state.autoRouter.lastError = "";
        return routed;
      }
      throw new Error("Router model did not return one of the eligible model ids.");
    } catch (error) {
      state.autoRouter.lastError = `Router model failed: ${error.message || String(error)}`;
      throw new Error(state.autoRouter.lastError);
    }
  }

  async function routeAutoBeforeTurn(params) {
    if (!patcherFeatureEnabled("autoRouter", true) || !state.autoRouter.enabled || !state.autoRouter.selected || state.autoRouter.routing) {
      return null;
    }
    const turnText = extractTextFromTurnInput(params?.input || params);
    state.autoRouter.routing = true;
    state.autoRouter.lastTextPreview = compact(turnText, 240);
    state.autoRouter.lastError = "";
    saveDraft();
    try {
      const choice = await chooseAutoRouterModel(turnText);
      const entry = choice.entry;
      const reasoningEffort = bestReasoningForModel(entry.model, entry.reasoningEffort || state.fields.reasoningEffort, entry.providerId);
      const presetId = presetIdForProviderId(entry.providerId);
      const selectionConfig = modelMenuSelectionConfigEdits(presetId, entry.model, reasoningEffort);
      state.fields.preset = presetId;
      state.fields.providerId = selectionConfig.providerId;
      state.fields.model = entry.model;
      state.fields.reasoningEffort = selectionConfig.reasoningEffort;
      state.autoRouter.lastChoice = {
        key: entry.key,
        model: entry.model,
        providerId: entry.providerId,
        providerLabel: entry.providerLabel,
        source: choice.source,
      };
      state.autoRouter.lastReason = choice.reason || "";
      state.autoRouter.lastRoutedAt = Date.now();
      state.status = `Auto Router selected ${entry.model} for ${entry.providerLabel}.`;
      saveDraft();
      await writeConfigEdits(selectionConfig.edits);
      return state.autoRouter.lastChoice;
    } catch (error) {
      state.autoRouter.lastError = error.message || String(error);
      state.status = state.autoRouter.lastError;
      saveDraft();
      throw error;
    } finally {
      state.autoRouter.routing = false;
      saveDraft();
    }
  }

  async function runAutoRouterDryRun(sampleText) {
    const text = String(sampleText || "").trim();
    if (!text) {
      state.autoRouter.testResult = { error: "Enter a sample request before running a dry run." };
      state.status = state.autoRouter.testResult.error;
      saveDraft();
      renderNativeSettingsPanel();
      return null;
    }
    state.autoRouter.testBusy = true;
    state.autoRouter.testInput = text;
    state.autoRouter.testResult = null;
    state.autoRouter.lastError = "";
    state.status = "Running Auto Router dry run with the selected router model...";
    saveDraft();
    renderNativeSettingsPanel();
    try {
      const choice = await chooseAutoRouterModel(text);
      const entry = choice.entry;
      state.autoRouter.testResult = {
        model: entry.model,
        providerId: entry.providerId,
        providerLabel: entry.providerLabel,
        source: choice.source,
        reason: choice.reason || "",
      };
      state.status = `Auto Router dry run selected ${entry.model} for ${entry.providerLabel}.`;
      saveDraft();
      return state.autoRouter.testResult;
    } catch (error) {
      state.autoRouter.testResult = { error: error.message || String(error) };
      state.status = state.autoRouter.testResult.error;
      saveDraft();
      return null;
    } finally {
      state.autoRouter.testBusy = false;
      saveDraft();
      renderNativeSettingsPanel();
    }
  }

  function normalizeReviewPromptModelKey() {
    const entries = allConfiguredModelEntries();
    if (!entryForModelKey(state.reviewPrompt.modelKey, entries)) {
      state.reviewPrompt.modelKey = entries[0]?.key || "";
    }
    return entryForModelKey(state.reviewPrompt.modelKey, entries);
  }

  function reviewHeuristicDecision(sampleText) {
    const text = String(sampleText || "");
    const lowered = text.toLowerCase();
    const risks = [];
    if (/\b(rm\s+-rf|remove-item\b.*\b-recurse\b|del\s+\/s|format\s+[a-z]:|diskpart|clean\s+all)\b/i.test(text)) {
      risks.push("destructive filesystem or disk command");
    }
    if (/\b(git\s+reset\s+--hard|git\s+clean\s+-fd|git\s+checkout\s+--|git\s+push\s+--force)\b/i.test(text)) {
      risks.push("destructive or history-changing git command");
    }
    if (/\b(api[_-]?key|token|secret|password|credential|sk-[a-z0-9])/i.test(text)) {
      risks.push("credential or secret exposure");
    }
    if (/\b(curl|wget|invoke-webrequest|irm|iex|eval|downloadstring)\b/i.test(text) && /\b(sh|bash|powershell|cmd|iex|eval)\b/i.test(text)) {
      risks.push("remote code execution pattern");
    }
    if (lowered.includes("charge") || lowered.includes("billing") || lowered.includes("delete account")) {
      risks.push("account, billing, or irreversible service action");
    }
    const riskLevel = risks.length >= 2 ? "high" : risks.length === 1 ? "medium" : "low";
    return {
      source: "local-safety-check",
      riskLevel,
      decision: risks.length ? "review" : "allow",
      reason: risks.length ? `Potential risk: ${risks.join("; ")}.` : "No obvious destructive, credential, or billing risk found by the local check.",
      saferAlternative: risks.length ? "Confirm the target path/resource, take a backup, and prefer a read-only or dry-run command first." : "",
    };
  }

  async function modelBackedReviewPromptTest(sampleText) {
    const reviewModel = normalizeReviewPromptModelKey();
    if (!reviewModel) {
      return null;
    }
    const port = MANAGED_PROXY_PORTS[reviewModel.providerId];
    if (!port) {
      return null;
    }
    const body = {
      model: reviewModel.model,
      stream: false,
      max_output_tokens: 420,
      input: [
        {
          role: "system",
          content: String(state.reviewPrompt.prompt || DEFAULT_REVIEW_PROMPT),
        },
        {
          role: "user",
          content: compact(sampleText, 4000),
        },
      ],
    };
    const response = await fetchJsonWithTimeout(
      `http://127.0.0.1:${port}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      12000
    );
    return {
      source: "review-model",
      model: reviewModel.model,
      providerId: reviewModel.providerId,
      providerLabel: reviewModel.providerLabel,
      text: outputTextFromResponse(response) || safeJson(response),
    };
  }

  async function runReviewPromptTest(sampleText) {
    const text = String(sampleText || "").trim();
    if (!text) {
      state.reviewPrompt.testResult = { error: "Enter a sample command or prompt before testing review." };
      state.status = state.reviewPrompt.testResult.error;
      saveDraft();
      renderNativeSettingsPanel();
      return null;
    }
    state.reviewPrompt.testBusy = true;
    state.reviewPrompt.testInput = text;
    state.reviewPrompt.testResult = null;
    state.reviewPrompt.lastError = "";
    state.status = "Testing review prompt...";
    saveDraft();
    renderNativeSettingsPanel();
    try {
      const modelResult = await modelBackedReviewPromptTest(text);
      if (modelResult) {
        state.reviewPrompt.testResult = modelResult;
      } else {
        state.reviewPrompt.testResult = reviewHeuristicDecision(text);
      }
      state.status =
        state.reviewPrompt.testResult.source === "review-model"
          ? `Review prompt test completed with ${state.reviewPrompt.testResult.model}.`
          : "Review prompt test completed with the local safety check.";
      saveDraft();
      return state.reviewPrompt.testResult;
    } catch (error) {
      state.reviewPrompt.lastError = error.message || String(error);
      state.reviewPrompt.testResult = {
        error: state.reviewPrompt.lastError,
        fallback: reviewHeuristicDecision(text),
      };
      state.status = state.reviewPrompt.lastError;
      saveDraft();
      return null;
    } finally {
      state.reviewPrompt.testBusy = false;
      saveDraft();
      renderNativeSettingsPanel();
    }
  }

  function appendInstruction(existing, addition) {
    const left = String(existing || "").trim();
    const right = String(addition || "").trim();
    return [left, right].filter(Boolean).join("\n\n");
  }

  function promptString(value) {
    return typeof value === "string" ? value : value == null ? "" : String(value);
  }

  function normalizePromptModelName(value) {
    return String(value || "")
      .trim()
      .toLowerCase();
  }

  function modelInfoName(info) {
    if (!info || typeof info !== "object") {
      return "";
    }
    return promptString(info.model || info.id || info.name || info.slug || info.modelId || info.displayName).trim();
  }

  function modelInfoPrompt(info) {
    if (!info || typeof info !== "object") {
      return null;
    }
    const messages =
      info.model_messages && typeof info.model_messages === "object"
        ? info.model_messages
        : info.modelMessages && typeof info.modelMessages === "object"
          ? info.modelMessages
          : info.messages && typeof info.messages === "object"
            ? info.messages
            : {};
    const baseInstructions = promptString(
      messages.base_instructions || messages.baseInstructions || info.base_instructions || info.baseInstructions
    );
    const instructionsTemplate = promptString(
      messages.instructions_template ||
        messages.instructionsTemplate ||
        info.instructions_template ||
        info.instructionsTemplate
    );
    const directInstructions = promptString(info.instructions || info.system_prompt || info.systemPrompt);
    const text = baseInstructions || directInstructions || instructionsTemplate;
    const field = baseInstructions
      ? "model_messages.base_instructions"
      : directInstructions
        ? "instructions"
        : instructionsTemplate
          ? "model_messages.instructions_template"
          : "";
    return text ? { text, baseInstructions, instructionsTemplate, field } : null;
  }

  function collectModelInfoObjects(value) {
    const output = [];
    const seen = new Set();

    function visit(node, depth) {
      if (!node || typeof node !== "object" || depth > 10 || seen.has(node)) {
        return;
      }
      seen.add(node);
      if (Array.isArray(node)) {
        node.forEach((item) => visit(item, depth + 1));
        return;
      }
      const hasName = Boolean(modelInfoName(node));
      const hasPrompt = Boolean(modelInfoPrompt(node));
      if (hasName && hasPrompt) {
        output.push(node);
      }
      for (const child of Object.values(node)) {
        if (child && typeof child === "object") {
          visit(child, depth + 1);
        }
      }
    }

    visit(value, 0);
    return output;
  }

  function choosePromptModelInfo(entries) {
    const withPrompts = entries
      .map((info) => ({ info, name: modelInfoName(info), prompt: modelInfoPrompt(info) }))
      .filter((entry) => entry.prompt?.text);
    if (!withPrompts.length) {
      return null;
    }
    const currentModel = normalizePromptModelName(state.fields.model);
    if (currentModel) {
      const exact = withPrompts.find((entry) => normalizePromptModelName(entry.name) === currentModel);
      if (exact) {
        return exact;
      }
      const contains = withPrompts.find((entry) => normalizePromptModelName(entry.name).includes(currentModel));
      if (contains) {
        return contains;
      }
    }
    const openAiCodex = withPrompts.find((entry) => /codex|gpt/i.test(entry.name));
    return openAiCodex || withPrompts[0];
  }

  async function readModelListForPrompt() {
    try {
      return await requestAppServer("model/list", {}, 30000);
    } catch (firstError) {
      try {
        return await requestAppServer("model/list", null, 30000);
      } catch {
        throw firstError;
      }
    }
  }

  function choosePromptCatalogRecord(records) {
    const withPrompts = (Array.isArray(records) ? records : [])
      .map((record) => ({
        record,
        name: promptString(record?.model || record?.id || record?.displayName || record?.name).trim(),
        text: promptString(record?.defaultPrompt || record?.baseInstructions || record?.instructionsTemplate || record?.text),
      }))
      .filter((entry) => entry.name && entry.text);
    if (!withPrompts.length) {
      return null;
    }
    const currentModel = normalizePromptModelName(state.fields.model);
    if (currentModel) {
      const exact = withPrompts.find((entry) => normalizePromptModelName(entry.name) === currentModel);
      if (exact) {
        return exact;
      }
      const contains = withPrompts.find((entry) => normalizePromptModelName(entry.name).includes(currentModel));
      if (contains) {
        return contains;
      }
    }
    return withPrompts.find((entry) => /codex|gpt/i.test(entry.name)) || withPrompts[0];
  }

  async function refreshDefaultPromptFromCatalog(fallbackReason = "") {
    const response = await fetch("./assets/codex-native-default-prompts.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Default prompt catalog returned HTTP ${response.status}.`);
    }
    const catalog = await response.json();
    const chosen = choosePromptCatalogRecord(catalog?.prompts || []);
    if (!chosen) {
      throw new Error(`Default prompt catalog has no readable prompt records.`);
    }
    const record = chosen.record || {};
    state.promptModifier.observedText = chosen.text;
    state.promptModifier.observedBaseInstructions = promptString(record.baseInstructions || "");
    state.promptModifier.observedTemplate = promptString(record.instructionsTemplate || "");
    state.promptModifier.observedPath = `codex-native-default-prompts.json:${chosen.name}.${record.sourceField || "defaultPrompt"}`;
    state.promptModifier.observedSource = "backend-binary-catalog";
    state.promptModifier.observedAt = Date.now();
    state.promptModifier.observedError = fallbackReason
      ? `Loaded from embedded backend prompt catalog after model/list fallback: ${fallbackReason}`
      : "Loaded from embedded backend prompt catalog.";
    state.status = `Loaded embedded default prompt for ${chosen.name}.`;
    saveDraft();
    return chosen;
  }

  async function refreshDefaultPromptFromModels() {
    state.promptModifier.modelListBusy = true;
    state.promptModifier.observedError = "";
    state.status = "Reading built-in Codex prompt metadata...";
    renderNativeSettingsPanel();
    try {
      const result = await readModelListForPrompt();
      const entries = collectModelInfoObjects(result);
      const chosen = choosePromptModelInfo(entries);
      if (!chosen) {
        return await refreshDefaultPromptFromCatalog(
          `model/list returned ${entries.length} model object${entries.length === 1 ? "" : "s"}, but no base instructions or instruction template fields were exposed.`
        );
      }
      state.promptModifier.observedText = chosen.prompt.text;
      state.promptModifier.observedBaseInstructions = chosen.prompt.baseInstructions;
      state.promptModifier.observedTemplate = chosen.prompt.instructionsTemplate;
      state.promptModifier.observedPath = `model/list:${chosen.name}.${chosen.prompt.field}`;
      state.promptModifier.observedSource = "model/list";
      state.promptModifier.observedAt = Date.now();
      state.promptModifier.observedError = chosen.prompt.baseInstructions
        ? ""
        : "Loaded an instruction template because this model did not expose base_instructions.";
      state.status = `Loaded built-in prompt metadata for ${chosen.name || "the selected model"}.`;
      saveDraft();
      return chosen;
    } catch (error) {
      const modelListError = error.message || String(error);
      try {
        return await refreshDefaultPromptFromCatalog(modelListError);
      } catch (catalogError) {
        state.promptModifier.observedError = `${modelListError}; catalog fallback failed: ${catalogError.message || String(catalogError)}`;
        state.status = state.promptModifier.observedError;
        saveDraft();
        return null;
      }
    } finally {
      state.promptModifier.modelListBusy = false;
      saveDraft();
      renderNativeSettingsPanel();
    }
  }

  function promptPathLabel(path) {
    return Array.isArray(path) ? path.join(".") : String(path || "");
  }

  function isDefaultPromptKey(key, path) {
    const normalized = String(key || "").replace(/[_-]/g, "").toLowerCase();
    const pathText = promptPathLabel(path).toLowerCase();
    if (normalized === "developerinstructions") {
      return true;
    }
    if (normalized === "additionaldeveloperinstructions") {
      return true;
    }
    if (normalized === "systemprompt") {
      return true;
    }
    if (normalized === "instructions" && /\b(settings|collaborationmode|developer|system|prompt|profile)\b/i.test(pathText)) {
      return true;
    }
    return false;
  }

  function findDefaultPromptSlots(root) {
    const slots = [];
    const seen = new Set();
    const skipKeys = new Set(["input", "content", "message", "messages", "items", "turns", "attachments", "tools", "tool_calls"]);

    function visit(value, path, depth) {
      if (!value || typeof value !== "object" || depth > 8 || seen.has(value)) {
        return;
      }
      seen.add(value);
      if (Array.isArray(value)) {
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        const childPath = [...path, key];
        const lowered = String(key || "").toLowerCase();
        if (isDefaultPromptKey(key, childPath) && typeof child === "string") {
          slots.push({
            path: childPath,
            label: promptPathLabel(childPath),
            value: child,
          });
          continue;
        }
        if (skipKeys.has(lowered)) {
          continue;
        }
        visit(child, childPath, depth + 1);
      }
    }

    visit(root, [], 0);
    return slots.sort((left, right) => {
      const rank = (slot) => {
        const label = slot.label.toLowerCase();
        if (label.includes("collaborationmode.settings.developer")) return 0;
        if (label.includes("settings.developer")) return 1;
        if (label.includes("developer")) return 2;
        if (label.includes("system")) return 3;
        return 4;
      };
      return rank(left) - rank(right);
    });
  }

  function setPromptSlot(root, path, value) {
    if (!root || typeof root !== "object" || !Array.isArray(path) || !path.length) {
      return false;
    }
    let target = root;
    for (let index = 0; index < path.length - 1; index += 1) {
      target = target?.[path[index]];
      if (!target || typeof target !== "object") {
        return false;
      }
    }
    target[path[path.length - 1]] = value;
    return true;
  }

  function applyAdditionalDeveloperInstructions(params, text, mode) {
    if (!params || typeof params !== "object") {
      return false;
    }
    const current = promptString(params.additionalDeveloperInstructions || "");
    params.additionalDeveloperInstructions = mode === "replace" ? text : appendInstruction(current, text);
    return true;
  }

  function createLegacyDeveloperInstructionsSlot(params, text) {
    if (!params || typeof params !== "object") {
      return false;
    }
    if (params.collaborationMode && typeof params.collaborationMode === "object") {
      const settings =
        params.collaborationMode.settings && typeof params.collaborationMode.settings === "object"
          ? { ...params.collaborationMode.settings }
          : {};
      settings.developer_instructions = text;
      params.collaborationMode = { ...params.collaborationMode, settings };
      return true;
    }
    if (params.settings && typeof params.settings === "object") {
      params.settings = { ...params.settings, developer_instructions: text };
      return true;
    }
    return false;
  }

  function captureDefaultPromptFromTurnRequest(request) {
    const params = request?.params;
    if (!params || typeof params !== "object") {
      state.promptModifier.observedError = "No turn/start params object to inspect.";
      saveDraft();
      return null;
    }
    const slot = findDefaultPromptSlots(params)[0] || null;
    if (!slot) {
      if (!state.promptModifier.observedText) {
        state.promptModifier.observedError = "No exposed default prompt field was present in the renderer turn/start request.";
      }
      saveDraft();
      return null;
    }
    state.promptModifier.observedText = String(slot.value || "");
    state.promptModifier.observedPath = slot.label;
    state.promptModifier.observedAt = Date.now();
    state.promptModifier.observedError = slot.value
      ? ""
      : "The default prompt field was present but empty. The full built-in system prompt may be generated inside app-server.";
    saveDraft();
    return slot;
  }

  function applyPromptModifierToTurnRequest(request) {
    if (!patcherFeatureEnabled("promptTools", true) || !state.promptModifier.enabled) {
      return false;
    }
    const text = String(state.promptModifier.text || "").trim();
    if (!text) {
      return false;
    }
    const params = request?.params;
    if (!params || typeof params !== "object") {
      state.promptModifier.lastError = "Prompt modifier skipped because turn/start params were not an object.";
      saveDraft();
      return false;
    }
    const slot = findDefaultPromptSlots(params)[0] || null;
    const mode = state.promptModifier.mode === "replace" ? "replace" : "append";
    if (applyAdditionalDeveloperInstructions(params, text, mode)) {
      state.promptModifier.lastAppliedAt = Date.now();
      state.promptModifier.lastError =
        mode === "replace"
          ? "Applied via additionalDeveloperInstructions. Native base instructions still come from app-server; this replaces the additional instruction field."
          : "Applied via additionalDeveloperInstructions.";
      saveDraft();
      return true;
    }
    if (slot) {
      const nextText = mode === "replace" ? text : appendInstruction(slot.value, text);
      setPromptSlot(params, slot.path, nextText);
      state.promptModifier.lastAppliedAt = Date.now();
      state.promptModifier.lastError = "";
      saveDraft();
      return true;
    }
    if (createLegacyDeveloperInstructionsSlot(params, text)) {
      state.promptModifier.lastAppliedAt = Date.now();
      state.promptModifier.lastError = "No existing default prompt field was exposed; injected edited prompt as developer_instructions.";
      saveDraft();
      return true;
    }
    state.promptModifier.lastError = "Edited default prompt skipped because this turn/start request did not expose a safe prompt/settings field.";
    saveDraft();
    return false;
  }

  function applyReviewPromptToReviewRequest(request) {
    if (!patcherFeatureEnabled("promptTools", true) || !state.reviewPrompt.enabled) {
      return false;
    }
    const prompt = String(state.reviewPrompt.prompt || "").trim();
    if (!prompt) {
      return false;
    }
    const params = request?.params;
    if (!params || typeof params !== "object") {
      state.reviewPrompt.lastError = "Review prompt skipped because review/start params were not an object.";
      saveDraft();
      return false;
    }
    const target = params.target && typeof params.target === "object" ? params.target : null;
    if (target && String(target.type || "").toLowerCase() === "custom") {
      if ("instructions" in target || !("prompt" in target)) {
        target.instructions = appendInstruction(target.instructions, prompt);
      } else {
        target.prompt = appendInstruction(target.prompt, prompt);
      }
      state.reviewPrompt.lastAppliedAt = Date.now();
      state.reviewPrompt.lastError = "";
      saveDraft();
      return true;
    }
    if ("instructions" in params) {
      params.instructions = appendInstruction(params.instructions, prompt);
      state.reviewPrompt.lastAppliedAt = Date.now();
      state.reviewPrompt.lastError = "";
      saveDraft();
      return true;
    }
    state.reviewPrompt.lastError = "Review prompt override skipped because this review/start target is not a custom prompt target.";
    saveDraft();
    return false;
  }

  async function selectModelFromNativeMenu(selection = {}) {
    const model = String(selection.model || "").trim();
    if (!model) {
      return;
    }
    if (model === AUTO_ROUTER_MODEL_ID || String(selection.providerId || "").trim() === AUTO_ROUTER_MODEL_ID) {
      state.autoRouter.enabled = true;
      state.autoRouter.selected = true;
      state.autoRouter.lastError = "";
      state.status = "Auto Model Router selected. The router will choose an eligible model before each new turn.";
      saveDraft();
      return { ok: true, model: AUTO_ROUTER_MODEL_ID, providerId: AUTO_ROUTER_MODEL_ID };
    }
    if (!state.autoRouter.routing) {
      state.autoRouter.selected = false;
    }
    const providerHint = String(selection.providerId || "").trim();
    const presetId = providerHint ? presetIdForProviderId(providerHint) : presetIdForModel(model);
    applyPresetFields(presetId, true);
    state.fields.model = model;
    const selectionConfig = modelMenuSelectionConfigEdits(presetId, model, selection.reasoningEffort || state.fields.reasoningEffort);
    state.fields.providerId = selectionConfig.providerId;
    state.fields.reasoningEffort = selectionConfig.reasoningEffort;
    state.status = `Selected ${model} for ${providerLabel()}.`;
    state.lastError = null;
    saveDraft();

    try {
      await writeConfigEdits(selectionConfig.edits);
      await loadConfig();
      return { ok: true, model, providerId: selectionConfig.providerId };
    } catch (error) {
      state.lastError = error.message || String(error);
      state.status = state.lastError;
      console.warn("[native-provider-settings] failed to switch provider for selected model", error);
      throw error;
    }
  }

  function nativeMenuRow(label, meta, selected, onClick) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "cps-native-menu-row";
    row.innerHTML = `
      <span class="cps-native-menu-row-copy">
        <span class="cps-native-menu-row-label"></span>
        ${meta ? `<span class="cps-native-menu-row-meta"></span>` : ""}
      </span>
      <span class="cps-native-menu-check" aria-hidden="true">${selected ? "✓" : ""}</span>
    `;
    row.querySelector(".cps-native-menu-row-label").textContent = label;
    const metaNode = row.querySelector(".cps-native-menu-row-meta");
    if (metaNode) {
      metaNode.textContent = meta;
    }
    row.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    row.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      onClick();
    });
    return row;
  }

  function commonAncestor(elements) {
    if (!elements.length) {
      return null;
    }
    let node = elements[0];
    while (node && node !== document.body) {
      if (elements.every((element) => node === element || node.contains(element))) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function isNativeModelText(text) {
    return /^(GPT-5\.5|GPT-5\.4|GPT-5\.4-Mini|GPT-5\.3-Codex-Spark|5\.5|5\.4)$/i.test(String(text || "").trim());
  }

  function nearestFloatingMenuAncestor(element) {
    let node = element;
    while (node && node !== document.body) {
      if (node instanceof HTMLElement && isVisibleNode(node)) {
        const rect = node.getBoundingClientRect();
        const role = node.getAttribute("role");
        const style = window.getComputedStyle(node);
        const isFloating =
          role === "menu" ||
          role === "listbox" ||
          Boolean(node.closest("[data-radix-popper-content-wrapper], [data-floating-ui-portal]")) ||
          style.position === "fixed" ||
          style.position === "absolute";
        if (isFloating && rect.width >= 120 && rect.width <= 640 && rect.height >= 40 && rect.height <= 820) {
          return node;
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  function forceEnhanceNativeModelMenus() {
    const grouped = new Map();
    Array.from(document.querySelectorAll("button, [role='menuitem'], [role='option'], div, span")).forEach((element) => {
      if (!isVisibleNode(element) || !isNativeModelText(normalizedText(element))) {
        return;
      }
      const root = nearestFloatingMenuAncestor(element);
      if (!root) {
        return;
      }
      const group = grouped.get(root) || new Set();
      group.add(normalizedText(element));
      grouped.set(root, group);
    });
    grouped.forEach((labels, root) => {
      if (labels.size >= 2) {
        enhanceModelMenu(root);
      }
    });
  }

  function modelMenuContentRoot(menu) {
    const activeModels = providerModelsForPreset(activeProviderModelGroup().presetId);
    const rows = Array.from(menu.querySelectorAll("button, [role='menuitem'], [role='option'], div, span")).filter((element) => {
      if (!isVisibleNode(element)) {
        return false;
      }
      const text = normalizedText(element);
      return isNativeModelText(text) || activeModels.includes(text);
    });
    if (rows.length < 2) {
      return menu;
    }
    let root = commonAncestor(rows) || menu;
    while (root.parentElement && root.parentElement !== document.body && root.parentElement !== menu && !hasExactMenuText(root, "Model")) {
      const parentText = normalizedText(root.parentElement);
      if (parentText.length > 1200 || !rows.every((row) => root.parentElement.contains(row))) {
        break;
      }
      root = root.parentElement;
    }
    return root;
  }

  function enhanceModelMenu(menu) {
    maybeRefreshMenuProviderModels();
    const group = activeProviderModelGroup();
    const root = modelMenuContentRoot(menu);
    const signature = [group.presetId, group.providerId, group.models.join("|")]
      .concat([state.fields.model, state.fields.reasoningEffort, state.menuBusy ? "busy" : "ready", state.menuRefreshing ? "refreshing" : "ready"])
      .join("::");
    if (root.dataset.cpsModelMenuSignature === signature && root.querySelector("[data-cps-provider-model-section='active']")) {
      return;
    }
    root.dataset.cpsModelMenuSignature = signature;
    root.querySelectorAll("[data-cps-provider-model-section]").forEach((node) => node.remove());
    if (!group.models.length) {
      return;
    }
    const section = document.createElement("div");
    section.className = "cps-native-menu-section cps-native-menu-section-active";
    section.dataset.cpsProviderModelSection = "active";
    const heading = document.createElement("div");
    heading.className = "cps-native-menu-heading";
    heading.textContent = `${group.preset.label} models`;
    section.append(heading);
    group.models.forEach((model) => {
      const selected = model === state.fields.model && state.fields.providerId === group.providerId;
      section.append(
        nativeMenuRow(
          model,
          reasoningOptionsForModel(model, group.providerId).includes("none") ? "reasoning optional" : "reasoning effort",
          selected,
          () => applyProviderModelMenuSelection(group.presetId, model)
        )
      );
    });
    if (state.menuRefreshing) {
      const loading = document.createElement("div");
      loading.className = "cps-native-menu-note";
      loading.textContent = "Refreshing provider models...";
      section.append(loading);
    }
    root.replaceChildren(section);
  }

  function bestReasoningForModel(model, requested, providerId = currentProviderId()) {
    const options = reasoningOptionsForModel(model, providerId);
    if (options.includes(requested)) {
      return requested;
    }
    if (options.includes("none")) {
      return "none";
    }
    return options[0] || "medium";
  }

  function enhanceReasoningMenu(menu) {
    const providerId = currentProviderId();
    const options = reasoningOptionsForModel(state.fields.model, providerId);
    const signature = `${providerId}:${state.fields.model}:${state.fields.reasoningEffort}:${options.join("|")}`;
    if (menu.dataset.cpsReasoningMenuSignature === signature) {
      return;
    }
    menu.dataset.cpsReasoningMenuSignature = signature;
    menu.querySelectorAll("[data-cps-provider-reasoning-section]").forEach((node) => node.remove());
    if (providerId === "openai") {
      return;
    }
    const section = document.createElement("div");
    section.className = "cps-native-menu-section";
    section.dataset.cpsProviderReasoningSection = "true";
    const heading = document.createElement("div");
    heading.className = "cps-native-menu-heading";
    heading.textContent = `${providerLabel(providerId)} reasoning`;
    section.append(heading);
    options.forEach((option) => {
      section.append(
        nativeMenuRow(reasoningLabel(option), option === "none" ? "disable thinking" : "thinking effort", option === state.fields.reasoningEffort, () =>
          applyModelMenuSelection({ model: state.fields.model, reasoningEffort: option })
        )
      );
    });
    menu.append(section);
  }

  function enhanceOpenModelMenus() {
    // Provider models are injected into the native composer catalog during build.
    // Avoid rewriting transient flyout DOM here; observing and replacing the
    // model menu can create renderer stalls when the picker opens.
    return;
    forceEnhanceNativeModelMenus();
    for (const menu of menuCandidates()) {
      if (isModelMenu(menu)) {
        enhanceModelMenu(menu);
      } else if (isReasoningMenu(menu)) {
        enhanceReasoningMenu(menu);
      }
    }
  }

  function safeEnhanceOpenModelMenus() {
    try {
      enhanceOpenModelMenus();
    } catch (error) {
      console.warn("[native-provider-settings] menu enhancement failed", error);
    }
  }

  function startModelMenuEnhancer() {
    // Kept as a no-op for patched builds that still call it from init().
    // The previous implementation observed the entire document subtree and
    // repeatedly scanned/replaced menu DOM, which could freeze the app.
    return;
    if (menuEnhancerObserver) {
      return;
    }
    menuEnhancerObserver = new MutationObserver(() => {
      safeEnhanceOpenModelMenus();
    });
    menuEnhancerObserver.observe(document.body, { childList: true, subtree: true });
    menuEnhancerTimer = window.setInterval(safeEnhanceOpenModelMenus, 750);
  }

  function providerSettingsRoutes() {
    const routes = {};
    if (patcherFeatureEnabled("providers", true)) {
      routes.providers = {
          hostId: "codex-native-providers-settings-route",
          path: "/settings/providers",
          title: "Providers",
          description: "Configure model providers and choose which models appear in chat.",
          aria: "Provider settings",
        };
    }
    if (patcherFeatureEnabled("autoRouter", true)) {
      routes["auto-router"] = {
          hostId: "codex-native-auto-router-settings-route",
          path: "/settings/auto-router",
          title: "Auto Router",
          description: "Configure automatic model selection and choose which models Auto may use.",
          aria: "Auto Router settings",
        };
    }
    if (patcherFeatureEnabled("promptTools", true)) {
      routes["prompt-tools"] = {
          hostId: "codex-native-prompt-tools-settings-route",
          path: "/settings/prompt-tools",
          title: "Prompt Tools",
          description: "Inspect, test, and edit review and default prompt controls.",
          aria: "Prompt Tools settings",
        };
    }
    if (patcherFeatureEnabled("personas", true)) {
      routes.personas = {
          hostId: "codex-native-personas-settings-route",
          path: "/settings/personas",
          title: "Personas",
          description: "Create reusable behavior profiles and apply them manually or by context.",
          aria: "Personas settings",
        };
    }
    if (patcherFeatureEnabled("swarm", true)) {
      routes.swarm = {
          hostId: "codex-native-swarm-settings-route",
          path: "/settings/swarm",
          title: "Swarm",
          description: "Configure hierarchical manager and worker agent defaults for swarm runs.",
          aria: "Swarm settings",
        };
    }
    return routes;
  }

  function activeProviderSettingsRoute() {
    const routes = providerSettingsRoutes();
    for (const [id, route] of Object.entries(routes)) {
      if (document.getElementById(route.hostId)) {
        return id;
      }
    }
    const pathName = window.location.pathname.replace(/\/+$/, "");
    for (const [id, route] of Object.entries(routes)) {
      if (pathName === route.path) {
        return id;
      }
    }
    return "";
  }

  function activeProviderSettingsRouteHost() {
    const id = activeProviderSettingsRoute();
    const route = providerSettingsRoutes()[id];
    return route ? document.getElementById(route.hostId) : null;
  }

  function openProvidersSettingsRoutePanel(routeId = "providers") {
    const routes = providerSettingsRoutes();
    if (!routes[routeId]) {
      removeNativeSettingsPanel();
      return;
    }
    state.settingsRoute = routeId;
    state.settingsTabActive = true;
    state.pendingSettingsOpen = false;
    renderNativeSettingsPanel();
    for (const delay of [0, 50, 150, 400]) {
      window.setTimeout(renderNativeSettingsPanel, delay);
    }
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

    const orderedRows = [document.getElementById("cno-settings-nav-button"), button].filter(Boolean);
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

  function findSettingsContentHost(nav) {
    const routeHost = activeProviderSettingsRouteHost();
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
      if (element.id === ROOT_ID || element.id === "cno-native-settings-content") return false;
      if (element.closest(`#${ROOT_ID}`) || element.closest("#cno-native-settings-content")) return false;
      if (nav && (element.contains(nav) || nav.contains(element))) return false;
      const rect = element.getBoundingClientRect();
      return rect.left >= navRect.right - 12 && rect.width >= 420 && rect.height >= window.innerHeight * 0.45;
    });
    return (
      candidates.sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return br.width * br.height - ar.width * ar.height;
      })[0] || null
    );
  }

  function installNativeSettingsNav(nav) {
    for (const button of document.querySelectorAll("#cps-settings-nav-button")) {
      button.remove();
    }
  }

  function syncNativeSettingsIntegration() {
    const activeRoute = activeProviderSettingsRoute();
    const routeActive = Boolean(activeRoute);
    if (routeActive) {
      state.settingsRoute = activeRoute;
      state.settingsTabActive = true;
    } else if (!state.pendingSettingsOpen && state.settingsTabActive) {
      state.settingsTabActive = false;
      removeNativeSettingsPanel();
    }

    const nav = findSettingsNavigation();
    installNativeSettingsNav(nav);
    if (routeActive || state.pendingSettingsOpen || state.settingsTabActive) {
      state.pendingSettingsOpen = false;
      renderNativeSettingsPanel();
    }
  }

  function removeNativeSettingsPanel() {
    const panel = document.getElementById("cps-native-settings-content");
    if (panel) {
      panel.remove();
    }
    for (const button of document.querySelectorAll("#cps-settings-nav-button")) {
      button.classList.remove("is-active");
    }
  }

  function isTextEntryElement(element) {
    if (!element) {
      return false;
    }
    if (element.isContentEditable) {
      return true;
    }
    const tag = String(element.tagName || "").toLowerCase();
    if (tag === "textarea") {
      return true;
    }
    if (tag !== "input") {
      return false;
    }
    const type = String(element.type || "text").toLowerCase();
    return !["button", "checkbox", "color", "file", "hidden", "radio", "range", "reset", "submit"].includes(type);
  }

  function isProviderPanelTextEntryFocused() {
    const panel = document.getElementById("cps-native-settings-content");
    const active = document.activeElement;
    return Boolean(panel && active && panel.contains(active) && isTextEntryElement(active));
  }

  function handleNativeSettingsTabEvent(event) {
    if (providerSettingsRoutes()[event.detail?.id]) {
      openProvidersSettingsRoutePanel(event.detail.id);
      return;
    }
    if (state.settingsTabActive) {
      state.settingsTabActive = false;
      removeNativeSettingsPanel();
    }
  }

  function statusBadgeHtml(label, ok, pending = false) {
    const unknown = ok == null;
    const managed = ok === "managed";
    const env = ok === "env";
    const className = pending ? "is-pending" : managed || env || ok === true ? "is-ok" : unknown ? "is-unknown" : "is-missing";
    const value = pending ? "Checking" : managed ? "Managed" : env ? "Env var" : unknown ? "Unknown" : ok ? "OK" : "Missing";
    return `<span class="cps-status-pill ${className}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></span>`;
  }

  function providerScreenPresets() {
    return ["openai", "deepseek", "zai", "dashscope", "cerebras", "ollama"];
  }

  function providerConfigForPreset(presetId) {
    const preset = PRESETS[presetId] || PRESETS.custom;
    return providerConfig(state.loadedConfig || {}, preset.providerId || presetId) || {};
  }

  function providerBaseUrlForPreset(presetId) {
    const preset = PRESETS[presetId] || PRESETS.custom;
    const provider = providerConfigForPreset(presetId);
    return provider.base_url || preset.baseUrl || "";
  }

  function providerEnvKeyForPreset(presetId) {
    const preset = PRESETS[presetId] || PRESETS.custom;
    const provider = providerConfigForPreset(presetId);
    return provider.env_key || preset.envKey || "";
  }

  function providerIsActive(presetId) {
    const preset = PRESETS[presetId] || PRESETS.custom;
    const providerId = preset.providerId || presetId;
    if (providerId === "openai") {
      return !state.fields.providerId || state.fields.providerId === "openai";
    }
    return state.fields.providerId === providerId;
  }

  function providerSummaryStatus(presetId) {
    const preset = PRESETS[presetId] || PRESETS.custom;
    const providerId = preset.providerId || presetId;
    if (providerId === "ollama") {
      const ready = providerIsActive(presetId) || state.ollamaModels.length > 0;
      return { active: providerIsActive(presetId), proxy: state.ollamaModels.length > 0, apiKey: null, config: ready };
    }
    if (providerId === "openai") {
      return { active: providerIsActive(presetId), proxy: true, apiKey: providerEnvKeyForPreset(presetId) ? "env" : null, config: true };
    }
    const status = state.providerStatus[providerId] || {};
    return {
      active: providerIsActive(presetId) || Boolean(status.active || status.config || status.proxy || status.apiKey),
      proxy: status.proxy,
      apiKey: status.apiKey,
      config: status.config,
      checking: status.checking,
    };
  }

  function providerIconHtml(presetId) {
    const letters = {
      openai: "O",
      deepseek: "D",
      zai: "Z",
      dashscope: "Q",
      cerebras: "C",
      ollama: "O",
    };
    return `<span class="cps-provider-logo cps-provider-logo-${escapeHtml(presetId)}">${escapeHtml(letters[presetId] || "P")}</span>`;
  }

  function compactStatusPill(value, kind = "ok") {
    return `<span class="cps-compact-pill is-${escapeHtml(kind)}">${escapeHtml(value)}</span>`;
  }

  function statusValuePill(label, stateValue, pending = false) {
    const unknown = stateValue == null;
    const ok = stateValue === true || stateValue === "managed" || stateValue === "env";
    const value = pending ? "Checking" : stateValue === "env" ? "Env" : stateValue === "managed" ? "Managed" : unknown ? "-" : ok ? "OK" : "Missing";
    const kind = pending ? "pending" : unknown ? "muted" : ok ? "ok" : "bad";
    const slug = String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return `
      <span class="cps-provider-stat cps-provider-stat-${escapeHtml(slug)}">
        <span>${escapeHtml(label)}</span>
        ${compactStatusPill(value, kind)}
      </span>
    `;
  }

  function maskedApiKeyText(presetId) {
    const envKey = providerEnvKeyForPreset(presetId);
    if (!envKey) return "-";
    return "••••••••••••";
  }

  function providerModelsSummary(presetId) {
    const preset = PRESETS[presetId] || PRESETS.custom;
    const providerId = preset.providerId || presetId;
    const visible = visibleModelCount(providerId);
    const total = rawProviderModelsForPreset(presetId).length;
    return `${visible} / ${Math.max(visible, total)}`;
  }

  function providerDiscoveryAction(presetId) {
    if (presetId === "ollama") return "refresh-ollama";
    if (presetId === "lmstudio") return "refresh-lmstudio";
    const providerId = PRESETS[presetId]?.providerId || presetId;
    return `refresh-${providerId}-models`;
  }

  function providerTestAction(presetId) {
    if (presetId === "ollama") return "refresh-ollama";
    if (presetId === "lmstudio") return "refresh-lmstudio";
    if (presetId === "openai") return "reload-config";
    const providerId = PRESETS[presetId]?.providerId || presetId;
    return `check-${providerId}`;
  }

  function providerActivateAction(presetId) {
    return `activate-provider-${presetId}`;
  }

  function providerSaveApiAction(presetId) {
    const providerId = PRESETS[presetId]?.providerId || presetId;
    return `save-${providerId}-api-key`;
  }

  function modelRefreshAge(setup) {
    const timestamp = Number(setup?.lastModelRefreshAt || 0);
    if (!timestamp) return "Not refreshed";
    const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    return `${hours}h ago`;
  }

  function renderProviderModelGrid(presetId) {
    const preset = PRESETS[presetId] || PRESETS.custom;
    const providerId = preset.providerId || presetId;
    const setup = providerSetup(providerId);
    const visible = visibleModelSet(providerId);
    const models = rawProviderModelsForPreset(presetId);
    const compactModelList = models.length > 10;
    if (!models.length) {
      return `<div class="cps-model-empty">No models discovered yet.</div>`;
    }
    return `
      <div class="cps-visible-models-head">
        <span>Visible models (${escapeHtml(visibleModelCount(providerId))})</span>
        <span class="cps-model-tools">
          ${models.length > 10 ? `<input class="cps-model-search" placeholder="Search models" data-model-search="${escapeHtml(providerId)}">` : ""}
          <button class="cps-icon-button" type="button" data-provider-model-bulk="${escapeHtml(providerId)}" data-visible="true">All</button>
          <button class="cps-icon-button" type="button" data-provider-model-bulk="${escapeHtml(providerId)}" data-visible="false">None</button>
        </span>
      </div>
      <div class="cps-provider-model-grid${compactModelList ? " is-compact" : ""}" data-model-grid="${escapeHtml(providerId)}">
        ${models
          .map((model, index) => {
            const checked = visible.has(model);
            const defaultBadge = index === 0 ? `<span class="cps-default-badge">Default</span>` : "";
            return `<label class="cps-provider-model-check" data-model-row="${escapeHtml(model.toLowerCase())}">
              <input type="checkbox" data-provider-model="${escapeHtml(providerId)}" data-model="${escapeHtml(model)}"${checked ? " checked" : ""}>
              <span>${escapeHtml(model)}</span>
              ${defaultBadge}
            </label>`;
          })
          .join("")}
      </div>
    `;
  }

  function toolTimestamp(value) {
    const number = Number(value || 0);
    return number ? new Date(number).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Never";
  }

  function autoRouterDryRunResultText() {
    const result = state.autoRouter.testResult;
    if (!result) {
      return "No dry run yet.";
    }
    if (result.error) {
      return `Error: ${result.error}`;
    }
    return [
      `Model: ${result.model}`,
      `Provider: ${result.providerLabel || result.providerId}`,
      `Source: ${result.source}`,
      result.reason ? `Reason: ${result.reason}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  function reviewPromptResultText() {
    const result = state.reviewPrompt.testResult;
    if (!result) {
      return "No review test yet.";
    }
    if (result.error) {
      const fallback = result.fallback
        ? `\n\nFallback:\n${JSON.stringify(result.fallback, null, 2)}`
        : "";
      return `Error: ${result.error}${fallback}`;
    }
    if (result.source === "review-model") {
      return [
        `Model: ${result.model}`,
        `Provider: ${result.providerLabel || result.providerId}`,
        "",
        result.text || "No text returned.",
      ].join("\n");
    }
    return JSON.stringify(result, null, 2);
  }

  function settingsIconSvg(name) {
    const icons = {
      auto: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 5.5v13M5.5 12h13"/><circle cx="12" cy="12" r="8"/></svg>',
      router: '<svg viewBox="0 0 24 24" fill="none"><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.4 11l7.2-4M8.4 13l7.2 4"/></svg>',
      models: '<svg viewBox="0 0 24 24" fill="none"><path d="M7 8h10M7 12h10M7 16h6"/><rect x="4" y="5" width="16" height="14" rx="3"/></svg>',
      clock: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8"/><path d="M12 8v5l3 2"/></svg>',
      review: '<svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="6"/><path d="M16 16l4 4M9 11l1.5 1.5L14 9"/></svg>',
      prompt: '<svg viewBox="0 0 24 24" fill="none"><path d="M7 8h10M7 12h10M7 16h6"/><rect x="5" y="4" width="14" height="16" rx="2"/></svg>',
      test: '<svg viewBox="0 0 24 24" fill="none"><path d="M10 4h4M11 4v5l-5 8a2 2 0 0 0 1.7 3h8.6A2 2 0 0 0 18 17l-5-8V4"/></svg>',
      edit: '<svg viewBox="0 0 24 24" fill="none"><path d="M5 19h4l10-10-4-4L5 15v4Z"/><path d="M13 7l4 4"/></svg>',
      persona: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="3.4"/><path d="M5.6 19c.9-3.7 3-5.6 6.4-5.6s5.5 1.9 6.4 5.6"/><path d="M17.6 5.2l.95-.42.42-.95.42.95.95.42-.95.42-.42.95-.42-.95-.95-.42Z"/></svg>',
      swarm: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="5" r="2.4"/><circle cx="6" cy="14" r="2.2"/><circle cx="18" cy="14" r="2.2"/><circle cx="12" cy="20" r="1.7"/><path d="M11 7.1 7.2 12M13 7.1 16.8 12M8.1 15.5 11 18.8M15.9 15.5 13 18.8M8.2 14h7.6"/></svg>',
      topology: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 4v5M7 14h10M7 14l5-5 5 5M7 14v5M17 14v5"/><circle cx="12" cy="4" r="2"/><circle cx="7" cy="20" r="2"/><circle cx="17" cy="20" r="2"/></svg>',
      workspace: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 7.5h6l2 2h8v8.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7.5Z"/><path d="M4 7.5V6a2 2 0 0 1 2-2h4l2 2h4"/></svg>',
    };
    return icons[name] || `<span>${escapeHtml(String(name || ""))}</span>`;
  }

  function settingsSummaryPill(label, value, kind = "muted", icon = "models") {
    return `<span class="cps-page-pill is-${escapeHtml(kind)}">
      <span class="cps-page-pill-icon" aria-hidden="true">${settingsIconSvg(icon)}</span>
      <span class="cps-page-pill-copy"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></span>
    </span>`;
  }

  function settingsSectionHeader(icon, title, description, right = "") {
    return `
      <div class="cps-section-header">
        <span class="cps-section-icon" aria-hidden="true">${settingsIconSvg(icon)}</span>
        <span class="cps-section-title-wrap">
          <strong>${escapeHtml(title)}</strong>
          <small>${escapeHtml(description)}</small>
        </span>
        ${right ? `<span class="cps-section-right">${right}</span>` : ""}
      </div>
    `;
  }

  function groupedAutoModelEntriesHtml(entries, eligible) {
    const groups = new Map();
    for (const entry of entries) {
      const key = entry.providerLabel || entry.providerId || "Provider";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    return [...groups.entries()]
      .map(([label, groupEntries]) => `
        <div class="cps-model-group">
          <div class="cps-model-group-title">${escapeHtml(label)}</div>
          <div class="cps-model-group-grid">
            ${groupEntries
              .map((entry) => `<label class="cps-provider-model-check" data-auto-model-row="${escapeHtml(`${entry.model} ${entry.providerLabel}`.toLowerCase())}">
                <input type="checkbox" data-auto-router-model-key="${escapeHtml(entry.key)}"${eligible.has(entry.key) ? " checked" : ""}>
                <span>${escapeHtml(entry.model)}</span>
              </label>`)
              .join("")}
          </div>
        </div>
      `)
      .join("");
  }

  function clampInteger(value, min, max, fallback) {
    const number = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.max(min, Math.min(max, number));
  }

  function swarmModelEntries(entries = allConfiguredModelEntries()) {
    const managed = entries.filter((entry) => entry.providerId === "cerebras" || Boolean(MANAGED_PROXY_PORTS[entry.providerId]));
    return managed.length ? managed : entries;
  }

  function normalizeSwarmSettings() {
    const entries = allConfiguredModelEntries();
    const candidates = swarmModelEntries(entries);
    const gemma = candidates.find((entry) => entry.providerId === "cerebras" && entry.model === "gemma-4-31b");
    const cerebras = candidates.find((entry) => entry.providerId === "cerebras");
    const fallback = gemma || cerebras || candidates[0] || entries[0] || null;
    const fallbackKey = fallback?.key || "cerebras:gemma-4-31b";
    for (const key of ["orchestratorModelKey", "managerModelKey", "workerModelKey"]) {
      if (!entryForModelKey(state.swarmSettings[key], entries)) {
        state.swarmSettings[key] = fallbackKey;
      }
    }
    state.swarmSettings.providerId = String(state.swarmSettings.providerId || fallback?.providerId || "cerebras");
    state.swarmSettings.maxManagers = clampInteger(state.swarmSettings.maxManagers, 1, 16, 4);
    state.swarmSettings.maxWorkersPerManager = clampInteger(state.swarmSettings.maxWorkersPerManager, 1, 32, 6);
    state.swarmSettings.maxParallelWorkers = clampInteger(state.swarmSettings.maxParallelWorkers, 1, 128, 12);
    return state.swarmSettings;
  }

  function swarmModelSelectHtml(role, label, description, entries) {
    const settings = normalizeSwarmSettings();
    const key = `${role}ModelKey`;
    return `
      <label class="cps-settings-row">
        <span class="cps-settings-row-copy">
          <span class="cps-settings-label">${escapeHtml(label)}</span>
          <span class="cps-settings-description">${escapeHtml(description)}</span>
        </span>
        <span class="cps-settings-control">
          <select class="cps-input" data-swarm-model-role="${escapeHtml(role)}"${entries.length ? "" : " disabled"}>
            ${
              entries.length
                ? entries
                    .map((entry) => `<option value="${escapeHtml(entry.key)}"${entry.key === settings[key] ? " selected" : ""}>${escapeHtml(modelEntryLabel(entry))}</option>`)
                    .join("")
                : `<option value="">No configured managed models</option>`
            }
          </select>
        </span>
      </label>
    `;
  }

  function swarmToggleRowHtml(key, title, description) {
    return `
      <label class="cps-settings-row">
        <span class="cps-settings-row-copy">
          <span class="cps-settings-label">${escapeHtml(title)}</span>
          <span class="cps-settings-description">${escapeHtml(description)}</span>
        </span>
        <span class="cps-settings-control">
          <input type="checkbox" data-swarm-toggle="${escapeHtml(key)}"${state.swarmSettings[key] ? " checked" : ""}>
        </span>
      </label>
    `;
  }

  function renderSwarmSettings() {
    const entries = allConfiguredModelEntries();
    const swarmEntries = swarmModelEntries(entries);
    const settings = normalizeSwarmSettings();
    const orchestrator = entryForModelKey(settings.orchestratorModelKey, entries);
    const manager = entryForModelKey(settings.managerModelKey, entries);
    const worker = entryForModelKey(settings.workerModelKey, entries);
    const updated = settings.lastUpdatedAt ? toolTimestamp(settings.lastUpdatedAt) : "Not saved yet";
    return `
      <div class="cps-settings-page cps-swarm-page">
        <div class="cps-page-summary">
          ${settingsSummaryPill("Swarm", settings.enabled ? "On" : "Off", settings.enabled ? "ok" : "muted", "swarm")}
          ${settingsSummaryPill("Provider", providerLabel(settings.providerId), settings.providerId === "cerebras" ? "accent" : "muted", "models")}
          ${settingsSummaryPill("Worker model", worker ? modelEntryLabel(worker) : "Not set", worker ? "ok" : "warn", "router")}
          ${settingsSummaryPill("Parallelism", `${settings.maxManagers} managers / ${settings.maxParallelWorkers} workers`, "accent", "topology")}
        </div>
        <div class="cps-page-grid cps-swarm-grid">
          <div class="cps-page-column">
            <section class="cps-settings-band">
              ${settingsSectionHeader("swarm", "Swarm Mode", "Configure the manager/worker hierarchy used by new swarm runs.", `<button class="cps-button cps-secondary" type="button" data-action="swarm-gemma-defaults">Use Gemma defaults</button>`)}
              <label class="cps-settings-row">
                <span class="cps-settings-row-copy">
                  <span class="cps-settings-label">Enable Swarm</span>
                  <span class="cps-settings-description">Shows Swarm in the sidebar and uses these defaults for new hierarchical agent runs.</span>
                </span>
                <span class="cps-settings-control">
                  <input type="checkbox" data-swarm-enabled${settings.enabled ? " checked" : ""}>
                </span>
              </label>
              <label class="cps-settings-row">
                <span class="cps-settings-row-copy">
                  <span class="cps-settings-label">Primary provider</span>
                  <span class="cps-settings-description">Swarm defaults are optimized for fast managed providers. Gemma-4-31B is configured through Cerebras.</span>
                </span>
                <span class="cps-settings-control">
                  <select class="cps-input" data-swarm-provider>
                    ${autoRouterProviderPresets()
                      .map((presetId) => {
                        const preset = PRESETS[presetId] || PRESETS.custom;
                        const providerId = preset.providerId || presetId;
                        return `<option value="${escapeHtml(providerId)}"${providerId === settings.providerId ? " selected" : ""}>${escapeHtml(preset.label || providerId)}</option>`;
                      })
                      .join("")}
                  </select>
                </span>
              </label>
              <div class="cps-swarm-number-grid">
                <label>Managers<input class="cps-input" type="number" min="1" max="16" data-swarm-number="maxManagers" value="${escapeHtml(settings.maxManagers)}"></label>
                <label>Workers per manager<input class="cps-input" type="number" min="1" max="32" data-swarm-number="maxWorkersPerManager" value="${escapeHtml(settings.maxWorkersPerManager)}"></label>
                <label>Max parallel workers<input class="cps-input" type="number" min="1" max="128" data-swarm-number="maxParallelWorkers" value="${escapeHtml(settings.maxParallelWorkers)}"></label>
              </div>
              ${swarmToggleRowHtml("isolatedWorkspaces", "Subagent workspaces", "Create or reserve isolated work areas so workers do not edit the same files accidentally.")}
            </section>
            <section class="cps-settings-band">
              ${settingsSectionHeader("workspace", "Workflow Defaults", "Control how manager agents coordinate and what checks they request.")}
              ${swarmToggleRowHtml("interAgentMessaging", "Inter-agent communication", "Managers can pass notes and blockers through the top-level swarm run.")}
              ${swarmToggleRowHtml("autoTests", "Testing manager", "Adds a testing manager lane that can generate and run verification work.")}
              ${swarmToggleRowHtml("autoReview", "Review manager", "Adds a review manager lane for code review and risk checks before synthesis.")}
              <label class="cps-settings-row cps-prompt-row">
                <span class="cps-settings-row-copy">
                  <span class="cps-settings-label">Default manager departments</span>
                  <span class="cps-settings-description">One department per line. New swarm runs use these as the initial manager lanes.</span>
                </span>
                <span class="cps-settings-control cps-textarea-control">
                  <textarea class="cps-input cps-textarea cps-swarm-departments" data-swarm-departments spellcheck="true">${escapeHtml(settings.defaultDepartments || "")}</textarea>
                </span>
              </label>
            </section>
          </div>
          <div class="cps-page-column">
            <section class="cps-settings-band">
              ${settingsSectionHeader("topology", "Agent Model Roles", "Choose the model used by each layer of the swarm hierarchy.", `<button class="cps-button cps-primary" type="button" data-action="swarm-open-tab">Open Swarm</button>`)}
              ${swarmModelSelectHtml("orchestrator", "Top-level orchestrator", "Turns the user goal into manager lanes, constraints, and synthesis.", swarmEntries)}
              ${swarmModelSelectHtml("manager", "Manager agents", "Coordinate a department such as implementation, testing, review, or discovery.", swarmEntries)}
              ${swarmModelSelectHtml("worker", "Worker agents", "Perform parallel scoped implementation, inspection, testing, or review tasks.", swarmEntries)}
              <div class="cps-swarm-topology-preview" aria-label="Swarm hierarchy preview">
                <div class="cps-swarm-node is-root">${escapeHtml(orchestrator ? orchestrator.model : "Orchestrator")}</div>
                <div class="cps-swarm-lanes">
                  <div class="cps-swarm-node">${escapeHtml(manager ? manager.model : "Manager")}</div>
                  <div class="cps-swarm-node">${escapeHtml(manager ? manager.model : "Manager")}</div>
                  <div class="cps-swarm-node">${escapeHtml(manager ? manager.model : "Manager")}</div>
                </div>
                <div class="cps-swarm-lanes is-workers">
                  <div class="cps-swarm-node">${escapeHtml(worker ? worker.model : "Worker")}</div>
                  <div class="cps-swarm-node">${escapeHtml(worker ? worker.model : "Worker")}</div>
                  <div class="cps-swarm-node">${escapeHtml(worker ? worker.model : "Worker")}</div>
                  <div class="cps-swarm-node">${escapeHtml(worker ? worker.model : "Worker")}</div>
                </div>
              </div>
              <div class="cps-action-row cps-band-actions">
                <div class="cps-status">Last saved: ${escapeHtml(updated)}</div>
                <div class="cps-actions">
                  <button class="cps-button cps-secondary" type="button" data-action="reload-config" ${state.busy ? "disabled" : ""}>Reload</button>
                  <button class="cps-button cps-primary" type="button" data-action="apply-config" ${state.busy ? "disabled" : ""}>Apply</button>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    `;
  }

  function renderAutoRouterSettings() {
    const entries = allConfiguredModelEntries();
    const routerEntries = routerModelEntries(entries);
    normalizeAutoRouterRouterModelKey();
    const eligible = autoRouterEligibleKeySet(entries);
    const eligibleEntries = entries.filter((entry) => eligible.has(entry.key));
    const router = entryForModelKey(state.autoRouter.routerModelKey, routerEntries);
    const lastChoice = state.autoRouter.lastChoice;
    const lastChoiceText = lastChoice?.model
      ? `${lastChoice.model} (${lastChoice.providerLabel || lastChoice.providerId || "provider"})`
      : "No route yet";
    const lastRouteTime = state.autoRouter.lastRoutedAt ? new Date(state.autoRouter.lastRoutedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
    return `
      <div class="cps-settings-page cps-auto-router-page">
        <div class="cps-page-summary">
          ${settingsSummaryPill("Auto", state.autoRouter.enabled ? "On" : "Off", state.autoRouter.enabled ? "ok" : "muted", "auto")}
          ${settingsSummaryPill("Router model", router ? modelEntryLabel(router) : "Not set", router ? "ok" : "warn", "router")}
          ${settingsSummaryPill("Eligible", `${eligibleEntries.length} / ${entries.length}`, eligibleEntries.length ? "ok" : "bad", "models")}
          ${settingsSummaryPill("Last route", lastChoiceText, lastChoice?.model ? "accent" : "muted", "clock")}
        </div>
        <div class="cps-page-grid cps-auto-router-grid">
          <div class="cps-page-column">
            <section class="cps-settings-band">
              ${settingsSectionHeader("router", "Routing", "Choose when Auto appears and how route decisions are made.", `<button class="cps-button cps-secondary" type="button" data-action="select-auto-router" ${state.busy ? "disabled" : ""}>Use Auto</button>`)}
              <label class="cps-settings-row">
                <span class="cps-settings-row-copy">
                  <span class="cps-settings-label">Enable Auto in chat picker</span>
                  <span class="cps-settings-description">Adds an Auto model choice and routes each new turn to an eligible configured model.</span>
                </span>
                <span class="cps-settings-control">
                  <input type="checkbox" data-auto-router-enabled${state.autoRouter.enabled ? " checked" : ""}>
                </span>
              </label>
              <label class="cps-settings-row">
                <span class="cps-settings-row-copy">
                  <span class="cps-settings-label">Router model</span>
                  <span class="cps-settings-description">Selects the proxy-backed model that chooses the target model for each Auto turn.</span>
                </span>
                <span class="cps-settings-control">
                  <select class="cps-input" data-auto-router-model${routerEntries.length ? "" : " disabled"}>
                    ${
                      routerEntries.length
                        ? routerEntries
                      .map((entry) => `<option value="${escapeHtml(entry.key)}"${entry.key === state.autoRouter.routerModelKey ? " selected" : ""}>${escapeHtml(modelEntryLabel(entry))}</option>`)
                      .join("")
                        : `<option value="">No proxy-backed router models</option>`
                    }
                  </select>
                </span>
              </label>
              <label class="cps-settings-row cps-prompt-row">
                <span class="cps-settings-row-copy">
                  <span class="cps-settings-label">Router prompt</span>
                  <span class="cps-settings-description">Customize the instruction sent to the router model before each Auto turn.</span>
                </span>
                <span class="cps-settings-control cps-textarea-control">
                  <textarea class="cps-input cps-textarea cps-router-prompt-textarea" data-auto-router-prompt spellcheck="true">${escapeHtml(state.autoRouter.prompt || DEFAULT_AUTO_ROUTER_PROMPT)}</textarea>
                </span>
              </label>
              <div class="cps-action-row cps-band-actions">
                <div class="cps-status">
                  Last route: ${escapeHtml(lastChoiceText)}${lastRouteTime ? ` at ${escapeHtml(lastRouteTime)}` : ""}${state.autoRouter.lastReason ? ` · ${escapeHtml(state.autoRouter.lastReason)}` : ""}${state.autoRouter.lastError ? ` · ${escapeHtml(state.autoRouter.lastError)}` : ""}
                </div>
                <div class="cps-actions">
                  <button class="cps-button cps-secondary" type="button" data-action="reset-auto-router-prompt">Reset prompt</button>
                </div>
              </div>
            </section>
            <section class="cps-settings-band">
              ${settingsSectionHeader("test", "Routing dry run", "Enter a sample request and see what Auto would choose without starting a real turn.", `<button class="cps-button cps-primary" type="button" data-action="test-auto-router" ${state.autoRouter.testBusy || !eligibleEntries.length || !router ? "disabled" : ""}>${state.autoRouter.testBusy ? "Testing..." : "Dry run"}</button>`)}
              <textarea class="cps-input cps-textarea cps-test-input" data-auto-router-test-input spellcheck="true" placeholder="Example: Refactor this Electron settings page and add tests.">${escapeHtml(state.autoRouter.testInput || "")}</textarea>
              <pre class="cps-tool-output">${escapeHtml(autoRouterDryRunResultText())}</pre>
            </section>
          </div>
          <section class="cps-settings-band cps-models-band">
            ${settingsSectionHeader("models", "Available Models For Auto", "Choose which configured models the router is allowed to select.")}
            <div class="cps-model-toolbar">
              ${entries.length > 10 ? `<input class="cps-model-search" placeholder="Search models" data-auto-model-search>` : ""}
              <button class="cps-button cps-secondary cps-button-sm" type="button" data-auto-router-model-bulk data-visible="true">All</button>
              <button class="cps-button cps-secondary cps-button-sm" type="button" data-auto-router-model-bulk data-visible="false">None</button>
            </div>
            <div class="cps-grouped-model-list" data-auto-router-model-grid>
              ${groupedAutoModelEntriesHtml(entries, eligible)}
            </div>
          </section>
        </div>
      </div>
    `;
  }

  function renderPromptToolsSettings() {
    const entries = allConfiguredModelEntries();
    const reviewModel = normalizeReviewPromptModelKey();
    const reviewApplied = toolTimestamp(state.reviewPrompt.lastAppliedAt);
    const promptApplied = toolTimestamp(state.promptModifier.lastAppliedAt);
    const observedAt = toolTimestamp(state.promptModifier.observedAt);
    const observedText = state.promptModifier.observedText || "";
    const observedBusy = Boolean(state.promptModifier.modelListBusy);
    const observedSource = state.promptModifier.observedSource || "turn/start";
    const observedSummary = state.promptModifier.observedPath
      ? `Source: ${observedSource} · Path: ${state.promptModifier.observedPath} · Loaded: ${observedAt}`
      : "No built-in prompt loaded yet. Click Read built-in prompt to ask Codex model metadata for the prompt text.";
    return `
      <div class="cps-settings-page cps-prompt-tools-page">
        <div class="cps-page-summary">
          ${settingsSummaryPill("Review prompt", state.reviewPrompt.enabled ? "On" : "Off", state.reviewPrompt.enabled ? "ok" : "muted", "review")}
          ${settingsSummaryPill("Review model", reviewModel ? modelEntryLabel(reviewModel) : "Not set", reviewModel ? "ok" : "warn", "models")}
          ${settingsSummaryPill("Default prompt", state.promptModifier.enabled ? "Modified" : "Built-in", state.promptModifier.enabled ? "warn" : "muted", "prompt")}
          ${settingsSummaryPill("Last test", state.reviewPrompt.testResult ? "Complete" : "None", state.reviewPrompt.testResult ? "accent" : "muted", "test")}
        </div>
        <div class="cps-page-grid cps-prompt-tools-grid">
          <div class="cps-page-column">
            <section class="cps-settings-band">
              ${settingsSectionHeader("review", "Review Prompt", "Inspect, edit, and test the prompt used for review decisions.")}
              <label class="cps-settings-row">
                <span class="cps-settings-row-copy">
                  <span class="cps-settings-label">Apply custom review prompt where supported</span>
                  <span class="cps-settings-description">Adds your review instructions to review/start requests that expose a custom prompt target.</span>
                </span>
                <span class="cps-settings-control">
                  <input type="checkbox" data-review-prompt-enabled${state.reviewPrompt.enabled ? " checked" : ""}>
                </span>
              </label>
              <label class="cps-settings-row">
                <span class="cps-settings-row-copy">
                  <span class="cps-settings-label">Review model</span>
                  <span class="cps-settings-description">Used by the review prompt test panel. Runtime review support depends on the native request shape.</span>
                </span>
                <span class="cps-settings-control">
                  <select class="cps-input" data-review-model>
                    ${entries
                      .map((entry) => `<option value="${escapeHtml(entry.key)}"${entry.key === state.reviewPrompt.modelKey ? " selected" : ""}>${escapeHtml(modelEntryLabel(entry))}</option>`)
                      .join("")}
                  </select>
                </span>
              </label>
              <label class="cps-settings-row cps-prompt-row">
                <span class="cps-settings-row-copy">
                  <span class="cps-settings-label">Review prompt viewer</span>
                  <span class="cps-settings-description">Inspect or edit the prompt/template used for review decisions.</span>
                </span>
                <span class="cps-settings-control cps-textarea-control">
                  <textarea class="cps-input cps-textarea cps-review-prompt-textarea" data-review-prompt spellcheck="true">${escapeHtml(state.reviewPrompt.prompt || DEFAULT_REVIEW_PROMPT)}</textarea>
                </span>
              </label>
              <div class="cps-action-row cps-band-actions">
                <div class="cps-status">Last applied: ${escapeHtml(reviewApplied)}${state.reviewPrompt.lastError ? ` · ${escapeHtml(state.reviewPrompt.lastError)}` : ""}</div>
                <div class="cps-actions">
                  <button class="cps-button cps-secondary" type="button" data-action="reset-review-prompt">Reset review prompt</button>
                </div>
              </div>
            </section>
            <section class="cps-settings-band">
              ${settingsSectionHeader("test", "Review prompt test panel", "Test the review model and prompt against a sample command before applying it broadly.", `<button class="cps-button cps-primary" type="button" data-action="test-review-prompt" ${state.reviewPrompt.testBusy ? "disabled" : ""}>${state.reviewPrompt.testBusy ? "Testing..." : "Test review"}</button>`)}
              <textarea class="cps-input cps-textarea cps-test-input" data-review-test-input spellcheck="true" placeholder="Example: Remove-Item -Recurse C:\\Users\\Ryan\\Documents\\old-build">${escapeHtml(state.reviewPrompt.testInput || "")}</textarea>
              <pre class="cps-tool-output">${escapeHtml(reviewPromptResultText())}</pre>
            </section>
          </div>
          <div class="cps-page-column">
            <section class="cps-settings-band">
              ${settingsSectionHeader("prompt", "Default Prompt", "Read the built-in prompt and apply your own controlled additions.")}
              <label class="cps-settings-row">
                <span class="cps-settings-row-copy">
                  <span class="cps-settings-label">Apply edited default prompt</span>
                  <span class="cps-settings-description">Applies the editor below to new turns through Codex's additionalDeveloperInstructions field.</span>
                </span>
                <span class="cps-settings-control">
                  <input type="checkbox" data-prompt-modifier-enabled${state.promptModifier.enabled ? " checked" : ""}>
                </span>
              </label>
              <label class="cps-settings-row">
                <span class="cps-settings-row-copy">
                  <span class="cps-settings-label">Default prompt apply mode</span>
                  <span class="cps-settings-description">Append keeps the native prompt and adds your edit. Replace overwrites the exposed prompt field when one exists.</span>
                </span>
                <span class="cps-settings-control">
                  <select class="cps-input" data-prompt-modifier-mode>
                    <option value="append"${state.promptModifier.mode === "replace" ? "" : " selected"}>Append as extra instructions</option>
                    <option value="replace"${state.promptModifier.mode === "replace" ? " selected" : ""}>Replace extra instructions</option>
                  </select>
                </span>
              </label>
              <label class="cps-settings-row cps-prompt-row">
                <span class="cps-settings-row-copy">
                  <span class="cps-settings-label">Default prompt viewer</span>
                  <span class="cps-settings-description">${escapeHtml(observedSummary)}${state.promptModifier.observedError ? ` · ${escapeHtml(state.promptModifier.observedError)}` : ""}</span>
                </span>
                <span class="cps-settings-control cps-textarea-control">
                  <textarea class="cps-input cps-textarea cps-prompt-observed-textarea" data-prompt-observed-text readonly spellcheck="false">${escapeHtml(observedText || "No built-in default prompt text loaded yet.")}</textarea>
                </span>
              </label>
              <div class="cps-action-row cps-band-actions">
                <div class="cps-status">Reads prompt metadata from native app-server model/list.</div>
                <div class="cps-actions">
                  <button class="cps-button cps-secondary" type="button" data-action="refresh-default-prompt" ${observedBusy ? "disabled" : ""}>${observedBusy ? "Reading..." : "Read built-in prompt"}</button>
                  <button class="cps-button cps-secondary" type="button" data-action="load-observed-default-prompt" ${observedText ? "" : "disabled"}>Load into editor</button>
                </div>
              </div>
            </section>
            <section class="cps-settings-band">
              ${settingsSectionHeader("edit", "Default prompt editor", "Edit the default/developer prompt applied to future turns according to the selected mode.")}
              <textarea class="cps-input cps-textarea cps-prompt-modifier-textarea" data-prompt-modifier-text spellcheck="true" placeholder="Example: Prefer short answers unless I ask for implementation detail.">${escapeHtml(state.promptModifier.text || "")}</textarea>
              <div class="cps-action-row cps-band-actions">
                <div class="cps-status">Last applied: ${escapeHtml(promptApplied)}${state.promptModifier.lastError ? ` · ${escapeHtml(state.promptModifier.lastError)}` : ""}</div>
                <div class="cps-actions">
                  <button class="cps-button cps-secondary" type="button" data-action="reset-default-prompt-editor" ${observedText ? "" : "disabled"}>Reset to observed</button>
                  <button class="cps-button cps-secondary" type="button" data-action="clear-prompt-modifier">Clear</button>
                </div>
              </div>
              <div class="cps-note">Prompt tools are user-controlled overrides. Tests do not start normal chat turns.</div>
            </section>
          </div>
        </div>
      </div>
    `;
  }

  function personaOptionHtml(selectedId) {
    state.personas = normalizePersonasSettings(state.personas);
    return state.personas.items
      .map((persona) => `<option value="${escapeHtml(persona.id)}"${persona.id === selectedId ? " selected" : ""}>${escapeHtml(persona.name)}</option>`)
      .join("");
  }

  function personaDryRunText() {
    const result = state.personas.testResult;
    if (!result) {
      return "Enter a sample request and run a match test.";
    }
    return [
      `Persona: ${result.name || "No persona"}`,
      `Reason: ${result.reason || "No reason"}`,
      "",
      result.promptPreview || "No prompt preview.",
    ].join("\n");
  }

  function renderPersonaCard(persona) {
    return `
      <details class="cps-persona-card" data-persona-card="${escapeHtml(persona.id)}" open>
        <summary class="cps-persona-summary">
          <span class="cps-persona-title">
            <span class="cps-persona-avatar" aria-hidden="true">${settingsIconSvg("persona")}</span>
            <span>
              <strong>${escapeHtml(persona.name || "Persona")}</strong>
              <small>${escapeHtml(persona.description || "Custom persona")}</small>
            </span>
          </span>
          <span class="cps-persona-actions">
            <label class="cps-inline-check"><input type="checkbox" data-persona-enabled="${escapeHtml(persona.id)}"${persona.enabled !== false ? " checked" : ""}> Enabled</label>
            <button class="cps-button cps-secondary cps-button-sm" type="button" data-persona-delete="${escapeHtml(persona.id)}">Delete</button>
          </span>
        </summary>
        <div class="cps-persona-editor">
          <label>
            <span>Name</span>
            <input class="cps-input" value="${escapeHtml(persona.name)}" data-persona-field="${escapeHtml(persona.id)}" data-field-name="name">
          </label>
          <label>
            <span>Description</span>
            <input class="cps-input" value="${escapeHtml(persona.description)}" data-persona-field="${escapeHtml(persona.id)}" data-field-name="description">
          </label>
          <label>
            <span>Context triggers</span>
            <textarea class="cps-input cps-textarea cps-persona-context" data-persona-field="${escapeHtml(persona.id)}" data-field-name="context" spellcheck="true">${escapeHtml(persona.context)}</textarea>
          </label>
          <label>
            <span>Persona prompt</span>
            <textarea class="cps-input cps-textarea cps-persona-prompt" data-persona-field="${escapeHtml(persona.id)}" data-field-name="prompt" spellcheck="true">${escapeHtml(persona.prompt)}</textarea>
          </label>
        </div>
      </details>
    `;
  }

  function renderPersonasSettings() {
    state.personas = normalizePersonasSettings(state.personas);
    const active = personaById(state.personas.activePersonaId);
    const fallback = personaById(state.personas.defaultPersonaId);
    const enabledCount = state.personas.items.filter((persona) => persona.enabled !== false).length;
    const lastApplied = personaById(state.personas.lastAppliedPersonaId);
    return `
      <div class="cps-settings-page cps-personas-page">
        <div class="cps-page-summary">
          ${settingsSummaryPill("Personas", state.personas.enabled ? "On" : "Off", state.personas.enabled ? "ok" : "muted", "persona")}
          ${settingsSummaryPill("Mode", state.personas.mode === "auto" ? "Auto context" : "Manual", "accent", "router")}
          ${settingsSummaryPill("Enabled", `${enabledCount} / ${state.personas.items.length}`, enabledCount ? "ok" : "bad", "models")}
          ${settingsSummaryPill("Last applied", lastApplied ? lastApplied.name : "None", lastApplied ? "accent" : "muted", "clock")}
        </div>
        <div class="cps-page-grid cps-personas-grid">
          <div class="cps-page-column">
            <section class="cps-settings-band">
              ${settingsSectionHeader("persona", "Persona Routing", "Choose whether Codex applies a fixed persona or picks one from context.", `<button class="cps-button cps-secondary" type="button" data-action="reset-personas">Reset presets</button>`)}
              <label class="cps-settings-row">
                <span class="cps-settings-row-copy">
                  <span class="cps-settings-label">Enable personas</span>
                  <span class="cps-settings-description">Appends the selected persona to new turn instructions. This does not write to config.toml.</span>
                </span>
                <span class="cps-settings-control">
                  <input type="checkbox" data-personas-enabled${state.personas.enabled ? " checked" : ""}>
                </span>
              </label>
              <label class="cps-settings-row">
                <span class="cps-settings-row-copy">
                  <span class="cps-settings-label">Selection mode</span>
                  <span class="cps-settings-description">Manual always uses the selected persona. Auto matches the user request against context triggers.</span>
                </span>
                <span class="cps-settings-control">
                  <select class="cps-input" data-persona-mode>
                    <option value="manual"${state.personas.mode === "manual" ? " selected" : ""}>Manual selected persona</option>
                    <option value="auto"${state.personas.mode === "auto" ? " selected" : ""}>Auto by context</option>
                  </select>
                </span>
              </label>
              <label class="cps-settings-row">
                <span class="cps-settings-row-copy">
                  <span class="cps-settings-label">Active persona</span>
                  <span class="cps-settings-description">Used when mode is manual.</span>
                </span>
                <span class="cps-settings-control">
                  <select class="cps-input" data-persona-active>${personaOptionHtml(active?.id || "")}</select>
                </span>
              </label>
              <label class="cps-settings-row">
                <span class="cps-settings-row-copy">
                  <span class="cps-settings-label">Default persona</span>
                  <span class="cps-settings-description">Used by auto mode when no context trigger matches and fallback is enabled.</span>
                </span>
                <span class="cps-settings-control">
                  <select class="cps-input" data-persona-default>${personaOptionHtml(fallback?.id || "")}</select>
                </span>
              </label>
              <label class="cps-settings-row">
                <span class="cps-settings-row-copy">
                  <span class="cps-settings-label">Fallback in auto mode</span>
                  <span class="cps-settings-description">If no trigger matches, apply the default persona instead of applying nothing.</span>
                </span>
                <span class="cps-settings-control">
                  <input type="checkbox" data-persona-fallback${state.personas.autoFallbackToDefault ? " checked" : ""}>
                </span>
              </label>
              <div class="cps-action-row cps-band-actions">
                <div class="cps-status">Last applied: ${escapeHtml(toolTimestamp(state.personas.lastAppliedAt))}${state.personas.lastError ? ` · ${escapeHtml(state.personas.lastError)}` : ""}</div>
                <div class="cps-actions">
                  <button class="cps-button cps-primary" type="button" data-action="add-persona">Add persona</button>
                </div>
              </div>
            </section>
            <section class="cps-settings-band">
              ${settingsSectionHeader("test", "Persona dry run", "Test which persona would be selected without starting a chat turn.", `<button class="cps-button cps-primary" type="button" data-action="test-persona-match">Match</button>`)}
              <textarea class="cps-input cps-textarea cps-test-input" data-persona-test-input spellcheck="true" placeholder="Example: explain why this TypeScript build is failing">${escapeHtml(state.personas.testInput || "")}</textarea>
              <pre class="cps-tool-output">${escapeHtml(personaDryRunText())}</pre>
            </section>
          </div>
          <section class="cps-settings-band cps-persona-list-band">
            ${settingsSectionHeader("edit", "Persona Library", "Edit reusable personas and their context triggers. Context triggers can be comma-separated words or phrases.")}
            <div class="cps-persona-list">
              ${state.personas.items.map((persona) => renderPersonaCard(persona)).join("")}
            </div>
          </section>
        </div>
      </div>
    `;
  }

  function renderProviderExpanded(presetId) {
    const preset = PRESETS[presetId] || PRESETS.custom;
    const providerId = preset.providerId || presetId;
    const setup = providerSetup(providerId);
    const envKey = providerEnvKeyForPreset(presetId);
    const baseUrl = providerBaseUrlForPreset(presetId);
    const supportsApiKeySave = Boolean(envKey && MANAGED_PROXY_PORTS[providerId]);
    const parameterModel =
      state.fields.providerId === providerId
        ? state.fields.model
        : managedProviderActivationModel(presetId) || rawProviderModelsForPreset(presetId)[0] || preset.model || "";
    const reasoningProfile = reasoningProfileForModel(parameterModel, providerId);
    return `
      <div class="cps-provider-expanded">
        <div class="cps-provider-config-pane">
          ${
            envKey
              ? `<label class="cps-provider-field">
                  <span>API key</span>
                  <span class="cps-inline-input-row">
                    <input class="cps-input" type="password" autocomplete="off" spellcheck="false" data-secret-field="${escapeHtml(providerId)}ApiKey" placeholder="${escapeHtml(envKey)}">
                    <button class="cps-button cps-secondary" type="button" data-action="${escapeHtml(providerSaveApiAction(presetId))}" ${state.busy || !supportsApiKeySave ? "disabled" : ""}>Save</button>
                  </span>
                </label>`
              : `<div class="cps-provider-field is-readonly"><span>API key</span><strong>Not required</strong></div>`
          }
          <label class="cps-provider-field">
            <span>Base URL</span>
            <span class="cps-inline-input-row">
              <input class="cps-input" value="${escapeHtml(baseUrl)}" data-provider-base-url="${escapeHtml(presetId)}">
              <button class="cps-button cps-secondary" type="button" data-provider-base-save="${escapeHtml(presetId)}" ${state.busy || presetId === "openai" ? "disabled" : ""}>Save</button>
            </span>
          </label>
          <div class="cps-provider-field is-row">
            <span>Models</span>
            <span>Last updated: ${escapeHtml(modelRefreshAge(setup))}</span>
            ${compactStatusPill(setup.lastModelRefreshError ? "Error" : "Up to date", setup.lastModelRefreshError ? "bad" : "ok")}
          </div>
          <div class="cps-provider-field is-row">
            <span>Reasoning</span>
            <span>${escapeHtml(reasoningProfile.mode)} · ${escapeHtml(reasoningProfile.parameter)}</span>
            ${compactStatusPill(reasoningProfile.options.map((option) => reasoningLabel(option)).join(" / "), "muted")}
          </div>
          <details class="cps-inline-advanced" data-inline-advanced="${escapeHtml(providerId)}">
            <summary>Show advanced</summary>
            <div class="cps-advanced-grid">
              <label>Provider id<input class="cps-input" data-provider-field-provider-id="${escapeHtml(presetId)}" value="${escapeHtml(providerId)}"></label>
              <label>Display name<input class="cps-input" data-provider-field-display-name="${escapeHtml(presetId)}" value="${escapeHtml(preset.displayName || preset.label)}"></label>
              <label>Env var<input class="cps-input" data-provider-field-env-key="${escapeHtml(presetId)}" value="${escapeHtml(envKey)}"></label>
              <label>Wire API<input class="cps-input" value="responses" disabled></label>
            </div>
          </details>
        </div>
        <div class="cps-provider-model-pane">
          ${renderProviderModelGrid(presetId)}
        </div>
      </div>
    `;
  }

  function renderProviderCard(presetId) {
    const preset = PRESETS[presetId] || PRESETS.custom;
    const providerId = preset.providerId || presetId;
    const setup = providerSetup(providerId);
    const status = providerSummaryStatus(presetId);
    const title = presetId === "dashscope" ? "Qwen" : preset.label;
    const expanded = setup.advancedOpen || presetId === "deepseek" || presetId === "dashscope";
    const inactive = !status.active && presetId === "ollama" && !state.ollamaModels.length;
    return `
      <details class="cps-provider-row ${expanded ? "is-expanded" : ""}" data-advanced-provider="${escapeHtml(providerId)}"${expanded ? " open" : ""}>
        <summary class="cps-provider-summary">
          <span class="cps-provider-title">
            ${providerIconHtml(presetId)}
            <span>${escapeHtml(title)}</span>
          </span>
          <span class="cps-provider-stat cps-provider-stat-status"><span>Status</span>${compactStatusPill(status.active ? "Active" : inactive ? "Inactive" : "Ready", status.active ? "ok" : inactive ? "warn" : "muted")}</span>
          <span class="cps-provider-stat cps-provider-stat-api-key"><span>API key</span><strong>${escapeHtml(maskedApiKeyText(presetId))}</strong></span>
          ${statusValuePill("Proxy", status.proxy, status.checking)}
          <span class="cps-provider-stat cps-provider-stat-models"><span>Models</span><strong>${escapeHtml(providerModelsSummary(presetId))}</strong>${compactStatusPill("OK", visibleModelCount(providerId) ? "ok" : "muted")}</span>
          <span class="cps-provider-actions">
            <button class="cps-button cps-secondary" type="button" data-action="${escapeHtml(providerDiscoveryAction(presetId))}" ${state.busy ? "disabled" : ""}>Discover models</button>
            <button class="cps-button cps-secondary" type="button" data-action="${escapeHtml(providerTestAction(presetId))}" ${state.busy ? "disabled" : ""}>Test</button>
            <button class="cps-icon-button" type="button" aria-label="Provider menu">...</button>
          </span>
          <span class="cps-disclosure" aria-hidden="true">⌄</span>
        </summary>
        ${renderProviderExpanded(presetId)}
      </details>
    `;
  }

  function deepSeekSetupSectionHtml() {
    const setup = providerSetup("deepseek");
    return `
      ${managedProviderSetupCardHtml("deepseek")}
      ${managedProviderSetupCardHtml("zai")}
      ${managedProviderSetupCardHtml("dashscope")}
      ${managedProviderSetupCardHtml("cerebras")}

      <details class="cps-advanced-settings" data-advanced-provider="deepseek"${setup.advancedOpen ? " open" : ""}>
        <summary>Advanced configuration</summary>
        <div class="cps-advanced-content">
    `;
  }

  function managedProviderSetupCardHtml(presetId) {
    const preset = PRESETS[presetId] || PRESETS.custom;
    const providerId = preset.providerId || presetId;
    const status = state.providerStatus[providerId] || {};
    const setup = providerSetup(providerId);
    const visible = visibleModelSet(providerId);
    const models = rawProviderModelsForPreset(presetId);
    const activeModel = managedProviderActivationModel(presetId);
    const visibleCount = visibleModelCount(providerId);
    const label = preset.label || providerId;
    const discoveredCount = Array.isArray(setup.availableModels) ? setup.availableModels.length : 0;
    const refreshSource = setup.lastModelRefreshSource ? ` Source: ${setup.lastModelRefreshSource}.` : "";
    const refreshError = setup.lastModelRefreshError ? ` ${setup.lastModelRefreshError}` : "";
    const compactModelList = models.length > 12;
    const secretField = `${providerId}ApiKey`;
    const saveAction = `save-${providerId}-api-key`;
    const checkAction = `check-${providerId}`;
    const applyAction = `apply-${providerId}-setup`;
    const activateAction = `activate-${providerId}`;
    return `
      <section class="flex flex-col">
        <div class="flex h-toolbar items-center justify-between gap-2 px-0 py-0">
          <div class="flex min-w-0 flex-1 flex-col gap-1">
            <div class="text-base font-medium text-token-text-primary">${escapeHtml(label)} setup</div>
          </div>
        </div>
        <div class="cps-provider-card">
          <div class="cps-status-grid">
            ${statusBadgeHtml("Proxy", status.proxy, status.checking)}
            ${statusBadgeHtml("API key", status.apiKey, status.checking)}
            ${statusBadgeHtml("Config", status.config)}
            ${statusBadgeHtml("Active", status.active)}
          </div>
          <div class="cps-provider-message">${escapeHtml(status.message)}</div>

          <div class="cps-settings-row">
            <span class="cps-settings-row-copy">
              <span class="cps-settings-label">API key</span>
              <span class="cps-settings-description">Writes ${escapeHtml(preset.envKey)} to the Windows user environment and updates the local proxy immediately.</span>
            </span>
            <span class="cps-settings-control cps-secret-control">
              <input class="cps-input" type="password" autocomplete="off" spellcheck="false" data-secret-field="${escapeHtml(secretField)}" placeholder="${escapeHtml(label)} API key">
              <button class="cps-button cps-secondary" type="button" data-action="${escapeHtml(saveAction)}" ${state.busy ? "disabled" : ""}>Save key</button>
            </span>
          </div>

          <div class="cps-settings-row cps-model-row">
            <span class="cps-settings-row-copy">
              <span class="cps-settings-label">Visible models</span>
              <span class="cps-settings-description">${escapeHtml(visibleCount)} ${escapeHtml(label)} model${visibleCount === 1 ? "" : "s"} will appear in the chat model picker. ${escapeHtml(discoveredCount)} discovered from API.${escapeHtml(refreshSource)}${escapeHtml(refreshError)}</span>
            </span>
            <span class="cps-settings-control cps-model-visibility-control">
              <span class="cps-model-bulk-actions">
                <button class="cps-button cps-secondary cps-button-sm" type="button" data-provider-model-bulk="${escapeHtml(providerId)}" data-visible="true" ${state.busy ? "disabled" : ""}>Check all</button>
                <button class="cps-button cps-secondary cps-button-sm" type="button" data-provider-model-bulk="${escapeHtml(providerId)}" data-visible="false" ${state.busy ? "disabled" : ""}>Uncheck all</button>
              </span>
              <span class="cps-model-checks${compactModelList ? " is-compact" : ""}">
                ${models
                  .map((model) => {
                    const checked = visible.has(model);
                    return `<label class="cps-model-check">
                      <input type="checkbox" data-provider-model="${escapeHtml(providerId)}" data-model="${escapeHtml(model)}"${checked ? " checked" : ""}>
                      <span>${escapeHtml(model)}</span>
                    </label>`;
                  })
                  .join("")}
              </span>
            </span>
          </div>

          <div class="cps-action-row cps-provider-actions">
            <div class="cps-status">Activation model: ${escapeHtml(activeModel)}</div>
            <div class="cps-actions">
              <button class="cps-button cps-secondary" type="button" data-action="${escapeHtml(checkAction)}" ${state.busy || status.checking ? "disabled" : ""}>Check</button>
              <button class="cps-button cps-secondary" type="button" data-action="refresh-${escapeHtml(providerId)}-models" ${state.busy ? "disabled" : ""}>Refresh models</button>
              <button class="cps-button cps-secondary" type="button" data-action="${escapeHtml(applyAction)}" ${state.busy ? "disabled" : ""}>Apply setup</button>
              <button class="cps-button cps-primary" type="button" data-action="${escapeHtml(activateAction)}" ${state.busy ? "disabled" : ""}>Make active</button>
            </div>
          </div>
        </div>
      </section>
    `;
  }

  function renderNativeSettingsPanel() {
    const nav = findSettingsNavigation();
    const activeRoute = activeProviderSettingsRoute() || state.settingsRoute || "providers";
    const routes = providerSettingsRoutes();
    const route = routes[activeRoute];
    if (!route) {
      removeNativeSettingsPanel();
      return;
    }
    state.settingsRoute = activeRoute;
    const routeHost = activeProviderSettingsRouteHost();
    if (!nav && !routeHost) {
      return;
    }
    const host = findSettingsContentHost(nav);
    if (!host) {
      return;
    }

    let panel = document.getElementById("cps-native-settings-content");
    if (panel && panel.parentElement === host && isProviderPanelTextEntryFocused()) {
      deferredTextEntryRender = true;
      return;
    }
    try {
      deferredTextEntryRender = false;
      host.classList.add("cps-settings-content-host");
      if (!panel || panel.parentElement !== host) {
        removeNativeSettingsPanel();
        panel = document.createElement("section");
        panel.id = "cps-native-settings-content";
        panel.className = "cps-native-settings-panel main-surface flex h-full min-h-0 flex-col";
        panel.setAttribute("aria-label", route.aria);
      }
      panel.setAttribute("aria-label", route.aria);

      const statusClass = state.lastError ? "is-error" : state.busy ? "is-busy" : "";
      const pageBody =
        activeRoute === "auto-router"
          ? renderAutoRouterSettings()
          : activeRoute === "prompt-tools"
            ? renderPromptToolsSettings()
            : activeRoute === "personas"
              ? renderPersonasSettings()
              : activeRoute === "swarm"
                ? renderSwarmSettings()
                : providerScreenPresets().map((presetId) => renderProviderCard(presetId)).join("");
      const addProviderButton =
        activeRoute === "providers"
          ? `<button class="cps-add-provider" type="button" data-preset="custom">+ Add provider <span>⌄</span></button>`
          : "";
      const html = `
      <div class="cps-providers-root">
        <header class="cps-providers-header">
          <div>
            <h1>${escapeHtml(route.title)}</h1>
            <p>${escapeHtml(route.description)}</p>
          </div>
          ${addProviderButton}
        </header>
        <div class="cps-providers-list${activeRoute === "providers" ? "" : " is-settings-page"}">
          ${pageBody}
        </div>
        <footer class="cps-providers-footer">
          <div class="cps-status ${statusClass}">${escapeHtml(state.status)}</div>
          <div class="cps-actions">
            <button class="cps-button cps-secondary" type="button" data-action="reload-config" ${state.busy ? "disabled" : ""}>Reload</button>
            <button class="cps-button cps-primary" type="button" data-action="apply-config" ${state.busy ? "disabled" : ""}>Apply</button>
          </div>
        </footer>
      </div>
    `;
      panel.innerHTML = html;
      if (panel.parentElement !== host) {
        host.append(panel);
      }
      bindNativeSettingsPanel(panel);
      installNativeSettingsNav(nav);
    } catch (error) {
      console.error("[native-provider-settings] render failed", error);
      removeNativeSettingsPanel();
      state.lastError = error?.message || String(error);
    }
  }

  function bindNativeSettingsPanel(panel) {
    panel.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (deferredTextEntryRender && !isProviderPanelTextEntryFocused()) {
          deferredTextEntryRender = false;
          renderNativeSettingsPanel();
        }
      }, 150);
    });
    panel.querySelectorAll("[data-preset]").forEach((button) => {
      button.addEventListener("click", () => {
        applyPresetFields(button.dataset.preset || "custom");
        renderNativeSettingsPanel();
      });
    });
    panel.querySelectorAll("[data-field]").forEach((input) => {
      const key = input.dataset.field;
      const eventName = input.type === "checkbox" ? "change" : "input";
      input.addEventListener(eventName, () => {
        state.fields[key] = input.type === "checkbox" ? input.checked : key === "wireApi" ? normalizeWireApi(input.value) : input.value;
        saveDraft();
      });
    });
    panel.querySelectorAll("[data-provider-model]").forEach((input) => {
      input.addEventListener("change", () => {
        toggleProviderModel(input.dataset.providerModel || "deepseek", input.dataset.model || "", input.checked);
        renderNativeSettingsPanel();
      });
    });
    panel.querySelectorAll("[data-provider-model-bulk]").forEach((button) => {
      button.addEventListener("click", () => {
        setProviderModelVisibility(button.dataset.providerModelBulk || "deepseek", button.dataset.visible === "true");
        renderNativeSettingsPanel();
      });
    });
    panel.querySelector("[data-swarm-enabled]")?.addEventListener("change", (event) => {
      state.swarmSettings.enabled = Boolean(event.currentTarget.checked);
      state.swarmSettings.lastUpdatedAt = Date.now();
      saveDraft();
      renderNativeSettingsPanel();
    });
    panel.querySelector("[data-swarm-provider]")?.addEventListener("change", (event) => {
      state.swarmSettings.providerId = String(event.currentTarget.value || "cerebras");
      state.swarmSettings.lastUpdatedAt = Date.now();
      saveDraft();
      renderNativeSettingsPanel();
    });
    panel.querySelectorAll("[data-swarm-model-role]").forEach((select) => {
      select.addEventListener("change", () => {
        const role = select.dataset.swarmModelRole || "worker";
        const key = `${role}ModelKey`;
        if (Object.prototype.hasOwnProperty.call(state.swarmSettings, key)) {
          state.swarmSettings[key] = String(select.value || "");
          const entry = entryForModelKey(select.value);
          if (entry) {
            state.swarmSettings.providerId = entry.providerId || state.swarmSettings.providerId;
          }
          state.swarmSettings.lastUpdatedAt = Date.now();
          saveDraft();
          renderNativeSettingsPanel();
        }
      });
    });
    panel.querySelectorAll("[data-swarm-number]").forEach((input) => {
      input.addEventListener("change", () => {
        const key = input.dataset.swarmNumber || "";
        const limits = {
          maxManagers: [1, 16, 4],
          maxWorkersPerManager: [1, 32, 6],
          maxParallelWorkers: [1, 128, 12],
        }[key];
        if (limits) {
          state.swarmSettings[key] = clampInteger(input.value, limits[0], limits[1], limits[2]);
          state.swarmSettings.lastUpdatedAt = Date.now();
          saveDraft();
          renderNativeSettingsPanel();
        }
      });
    });
    panel.querySelectorAll("[data-swarm-toggle]").forEach((input) => {
      input.addEventListener("change", () => {
        const key = input.dataset.swarmToggle || "";
        if (Object.prototype.hasOwnProperty.call(state.swarmSettings, key)) {
          state.swarmSettings[key] = Boolean(input.checked);
          state.swarmSettings.lastUpdatedAt = Date.now();
          saveDraft();
          renderNativeSettingsPanel();
        }
      });
    });
    panel.querySelector("[data-swarm-departments]")?.addEventListener("input", (event) => {
      state.swarmSettings.defaultDepartments = String(event.currentTarget.value || "");
      state.swarmSettings.lastUpdatedAt = Date.now();
      saveDraft();
    });
    panel.querySelector('[data-action="swarm-gemma-defaults"]')?.addEventListener("click", () => {
      state.swarmSettings = {
        ...state.swarmSettings,
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
        lastUpdatedAt: Date.now(),
      };
      saveDraft();
      renderNativeSettingsPanel();
    });
    panel.querySelector('[data-action="swarm-open-tab"]')?.addEventListener("click", () => {
      if (window.__codexNativeOrchestrator?.openSwarm) {
        window.__codexNativeOrchestrator.openSwarm();
      } else {
        window.location.assign("/");
      }
    });
    panel.querySelector("[data-auto-router-enabled]")?.addEventListener("change", (event) => {
      state.autoRouter.enabled = Boolean(event.currentTarget.checked);
      if (!state.autoRouter.enabled) {
        state.autoRouter.selected = false;
      }
      saveDraft();
      enhanceOpenModelMenus();
      renderNativeSettingsPanel();
    });
    panel.querySelector("[data-auto-router-model]")?.addEventListener("change", (event) => {
      state.autoRouter.routerModelKey = String(event.currentTarget.value || "");
      saveDraft();
      renderNativeSettingsPanel();
    });
    panel.querySelector("[data-auto-router-prompt]")?.addEventListener("input", (event) => {
      state.autoRouter.prompt = String(event.currentTarget.value || "");
      saveDraft();
    });
    panel.querySelector("[data-auto-router-test-input]")?.addEventListener("input", (event) => {
      state.autoRouter.testInput = String(event.currentTarget.value || "");
      saveDraft();
    });
    panel.querySelectorAll("[data-auto-router-model-key]").forEach((input) => {
      input.addEventListener("change", () => {
        setAutoRouterEligibleModel(input.dataset.autoRouterModelKey || "", input.checked);
        renderNativeSettingsPanel();
      });
    });
    panel.querySelectorAll("[data-auto-router-model-bulk]").forEach((button) => {
      button.addEventListener("click", () => {
        setAutoRouterEligibility(button.dataset.visible === "true");
        renderNativeSettingsPanel();
      });
    });
    panel.querySelector("[data-auto-model-search]")?.addEventListener("input", (event) => {
      const query = String(event.currentTarget.value || "").trim().toLowerCase();
      panel.querySelectorAll("[data-auto-model-row]").forEach((row) => {
        row.hidden = query ? !String(row.dataset.autoModelRow || "").includes(query) : false;
      });
    });
    panel.querySelector('[data-action="select-auto-router"]')?.addEventListener("click", () => {
      selectModelFromNativeMenu({ model: AUTO_ROUTER_MODEL_ID, providerId: AUTO_ROUTER_MODEL_ID, reasoningEffort: "medium" });
      enhanceOpenModelMenus();
      renderNativeSettingsPanel();
    });
    panel.querySelector('[data-action="reset-auto-router-prompt"]')?.addEventListener("click", () => {
      state.autoRouter.prompt = DEFAULT_AUTO_ROUTER_PROMPT;
      saveDraft();
      renderNativeSettingsPanel();
    });
    panel.querySelector('[data-action="test-auto-router"]')?.addEventListener("click", () => {
      const input = panel.querySelector("[data-auto-router-test-input]");
      runAutoRouterDryRun(input?.value || state.autoRouter.testInput || "");
    });
    panel.querySelector("[data-review-prompt-enabled]")?.addEventListener("change", (event) => {
      state.reviewPrompt.enabled = Boolean(event.currentTarget.checked);
      state.reviewPrompt.lastError = "";
      saveDraft();
      renderNativeSettingsPanel();
    });
    panel.querySelector("[data-review-model]")?.addEventListener("change", (event) => {
      state.reviewPrompt.modelKey = String(event.currentTarget.value || "");
      saveDraft();
      renderNativeSettingsPanel();
    });
    panel.querySelector("[data-review-prompt]")?.addEventListener("input", (event) => {
      state.reviewPrompt.prompt = String(event.currentTarget.value || "");
      saveDraft();
    });
    panel.querySelector("[data-review-test-input]")?.addEventListener("input", (event) => {
      state.reviewPrompt.testInput = String(event.currentTarget.value || "");
      saveDraft();
    });
    panel.querySelector('[data-action="reset-review-prompt"]')?.addEventListener("click", () => {
      state.reviewPrompt.prompt = DEFAULT_REVIEW_PROMPT;
      state.reviewPrompt.lastError = "";
      saveDraft();
      renderNativeSettingsPanel();
    });
    panel.querySelector('[data-action="test-review-prompt"]')?.addEventListener("click", () => {
      const input = panel.querySelector("[data-review-test-input]");
      runReviewPromptTest(input?.value || state.reviewPrompt.testInput || "");
    });
    panel.querySelector("[data-prompt-modifier-enabled]")?.addEventListener("change", (event) => {
      state.promptModifier.enabled = Boolean(event.currentTarget.checked);
      state.promptModifier.lastError = "";
      saveDraft();
      renderNativeSettingsPanel();
    });
    panel.querySelector("[data-prompt-modifier-mode]")?.addEventListener("change", (event) => {
      state.promptModifier.mode = String(event.currentTarget.value || "append") === "replace" ? "replace" : "append";
      state.promptModifier.lastError = "";
      saveDraft();
      renderNativeSettingsPanel();
    });
    panel.querySelector("[data-prompt-modifier-text]")?.addEventListener("input", (event) => {
      state.promptModifier.text = String(event.currentTarget.value || "");
      saveDraft();
    });
    panel.querySelector('[data-action="refresh-default-prompt"]')?.addEventListener("click", () => {
      refreshDefaultPromptFromModels();
    });
    panel.querySelector('[data-action="load-observed-default-prompt"]')?.addEventListener("click", () => {
      state.promptModifier.text = String(state.promptModifier.observedText || "");
      state.promptModifier.lastError = "";
      saveDraft();
      renderNativeSettingsPanel();
    });
    panel.querySelector('[data-action="reset-default-prompt-editor"]')?.addEventListener("click", () => {
      state.promptModifier.text = String(state.promptModifier.observedText || "");
      state.promptModifier.lastError = "";
      saveDraft();
      renderNativeSettingsPanel();
    });
    panel.querySelector('[data-action="clear-prompt-modifier"]')?.addEventListener("click", () => {
      state.promptModifier.text = DEFAULT_CODEX_PROMPT_MODIFIER;
      state.promptModifier.lastError = "";
      saveDraft();
      renderNativeSettingsPanel();
    });
    panel.querySelector("[data-personas-enabled]")?.addEventListener("change", (event) => {
      state.personas.enabled = Boolean(event.currentTarget.checked);
      state.personas.lastError = "";
      saveDraft();
      renderNativeSettingsPanel();
    });
    panel.querySelector("[data-persona-mode]")?.addEventListener("change", (event) => {
      state.personas.mode = String(event.currentTarget.value || "manual") === "auto" ? "auto" : "manual";
      saveDraft();
      renderNativeSettingsPanel();
    });
    panel.querySelector("[data-persona-active]")?.addEventListener("change", (event) => {
      state.personas.activePersonaId = String(event.currentTarget.value || "");
      saveDraft();
      renderNativeSettingsPanel();
    });
    panel.querySelector("[data-persona-default]")?.addEventListener("change", (event) => {
      state.personas.defaultPersonaId = String(event.currentTarget.value || "");
      saveDraft();
      renderNativeSettingsPanel();
    });
    panel.querySelector("[data-persona-fallback]")?.addEventListener("change", (event) => {
      state.personas.autoFallbackToDefault = Boolean(event.currentTarget.checked);
      saveDraft();
      renderNativeSettingsPanel();
    });
    panel.querySelectorAll("[data-persona-field]").forEach((input) => {
      input.addEventListener("input", () => {
        setPersonaField(input.dataset.personaField || "", input.dataset.fieldName || "", input.value);
      });
    });
    panel.querySelectorAll("[data-persona-enabled]").forEach((input) => {
      input.addEventListener("change", () => {
        setPersonaField(input.dataset.personaEnabled || "", "enabled", input.checked);
        renderNativeSettingsPanel();
      });
    });
    panel.querySelectorAll("[data-persona-delete]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        deletePersona(button.dataset.personaDelete || "");
      });
    });
    panel.querySelector("[data-persona-test-input]")?.addEventListener("input", (event) => {
      state.personas.testInput = String(event.currentTarget.value || "");
      saveDraft();
    });
    panel.querySelector('[data-action="test-persona-match"]')?.addEventListener("click", () => {
      const input = panel.querySelector("[data-persona-test-input]");
      runPersonaDryRun(input?.value || state.personas.testInput || "");
    });
    panel.querySelector('[data-action="add-persona"]')?.addEventListener("click", addPersona);
    panel.querySelector('[data-action="reset-personas"]')?.addEventListener("click", resetPersonasToDefaults);
    panel.querySelectorAll(".cps-persona-summary button, .cps-persona-summary input").forEach((control) => {
      control.addEventListener("click", (event) => {
        event.stopPropagation();
      });
    });
    panel.querySelectorAll(".cps-provider-summary button, .cps-provider-summary input").forEach((control) => {
      control.addEventListener("click", (event) => {
        event.stopPropagation();
      });
    });
    panel.querySelectorAll("[data-model-search]").forEach((input) => {
      input.addEventListener("input", () => {
        const providerId = input.dataset.modelSearch || "";
        const query = String(input.value || "").trim().toLowerCase();
        const grid = Array.from(panel.querySelectorAll("[data-model-grid]")).find((node) => node.dataset.modelGrid === providerId);
        grid?.querySelectorAll("[data-model-row]").forEach((row) => {
          row.hidden = query ? !String(row.dataset.modelRow || "").includes(query) : false;
        });
      });
    });
    panel.querySelectorAll("[data-provider-base-url]").forEach((input) => {
      input.addEventListener("input", () => {
        const presetId = input.dataset.providerBaseUrl || "custom";
        const preset = PRESETS[presetId] || PRESETS.custom;
        preset.baseUrl = input.value;
        if (state.fields.preset === presetId || state.fields.providerId === preset.providerId) {
          state.fields.baseUrl = input.value;
        }
      });
    });
    panel.querySelectorAll("[data-provider-base-save]").forEach((button) => {
      button.addEventListener("click", () => {
        const presetId = button.dataset.providerBaseSave || "custom";
        const input = Array.from(panel.querySelectorAll("[data-provider-base-url]")).find((node) => node.dataset.providerBaseUrl === presetId);
        saveProviderBaseUrl(presetId, input?.value || "");
      });
    });
    panel.querySelectorAll("[data-action^='activate-provider-']").forEach((button) => {
      button.addEventListener("click", () => {
        activateProviderPreset(String(button.dataset.action || "").replace("activate-provider-", ""));
      });
    });
    panel.querySelectorAll("[data-advanced-provider]").forEach((details) => {
      details.addEventListener("toggle", () => {
        const setup = providerSetup(details.dataset.advancedProvider || "deepseek");
        setup.advancedOpen = details.open;
        saveDraft();
      });
    });
    panel.querySelector('[data-action="reload-config"]')?.addEventListener("click", () => {
      loadConfig();
    });
    panel.querySelector('[data-action="apply-config"]')?.addEventListener("click", () => {
      applyConfig();
    });
    panel.querySelector('[data-action="refresh-ollama"]')?.addEventListener("click", () => {
      refreshOllamaModels();
    });
    panel.querySelector('[data-action="refresh-lmstudio"]')?.addEventListener("click", () => {
      refreshLmStudioModels();
    });
    panel.querySelector('[data-action="check-deepseek"]')?.addEventListener("click", () => {
      refreshDeepSeekStatus();
    });
    panel.querySelector('[data-action="check-zai"]')?.addEventListener("click", () => {
      refreshManagedProviderStatus("zai");
    });
    panel.querySelector('[data-action="check-dashscope"]')?.addEventListener("click", () => {
      refreshManagedProviderStatus("dashscope");
    });
    panel.querySelector('[data-action="check-cerebras"]')?.addEventListener("click", () => {
      refreshManagedProviderStatus("cerebras");
    });
    panel.querySelector('[data-action="refresh-deepseek-models"]')?.addEventListener("click", () => {
      refreshManagedProviderModels("deepseek");
    });
    panel.querySelector('[data-action="refresh-zai-models"]')?.addEventListener("click", () => {
      refreshManagedProviderModels("zai");
    });
    panel.querySelector('[data-action="refresh-dashscope-models"]')?.addEventListener("click", () => {
      refreshManagedProviderModels("dashscope");
    });
    panel.querySelector('[data-action="refresh-cerebras-models"]')?.addEventListener("click", () => {
      refreshManagedProviderModels("cerebras");
    });
    panel.querySelector('[data-action="apply-deepseek-setup"]')?.addEventListener("click", () => {
      applyDeepSeekSetup({ activate: false });
    });
    panel.querySelector('[data-action="apply-zai-setup"]')?.addEventListener("click", () => {
      applyManagedProviderSetup("zai", { activate: false });
    });
    panel.querySelector('[data-action="apply-dashscope-setup"]')?.addEventListener("click", () => {
      applyManagedProviderSetup("dashscope", { activate: false });
    });
    panel.querySelector('[data-action="apply-cerebras-setup"]')?.addEventListener("click", () => {
      applyManagedProviderSetup("cerebras", { activate: false });
    });
    panel.querySelector('[data-action="activate-deepseek"]')?.addEventListener("click", () => {
      applyDeepSeekSetup({ activate: true });
    });
    panel.querySelector('[data-action="activate-zai"]')?.addEventListener("click", () => {
      applyManagedProviderSetup("zai", { activate: true });
    });
    panel.querySelector('[data-action="activate-dashscope"]')?.addEventListener("click", () => {
      applyManagedProviderSetup("dashscope", { activate: true });
    });
    panel.querySelector('[data-action="activate-cerebras"]')?.addEventListener("click", () => {
      applyManagedProviderSetup("cerebras", { activate: true });
    });
    panel.querySelector('[data-action="save-deepseek-api-key"]')?.addEventListener("click", async () => {
      const input = panel.querySelector('[data-secret-field="deepseekApiKey"]');
      state.busy = true;
      state.lastError = null;
      state.status = "Saving DeepSeek API key...";
      renderNativeSettingsPanel();
      try {
        await saveProviderApiKey("deepseek", input?.value || "");
        state.status = "Saved DEEPSEEK_API_KEY. Relaunch patched Codex if the current backend still reports it missing.";
        await refreshDeepSeekStatus({ render: false });
      } catch (error) {
        state.lastError = error.message || String(error);
        state.status = state.lastError;
      } finally {
        state.busy = false;
        renderNativeSettingsPanel();
      }
    });
    panel.querySelector('[data-action="save-zai-api-key"]')?.addEventListener("click", async () => {
      const input = panel.querySelector('[data-secret-field="zaiApiKey"]');
      state.busy = true;
      state.lastError = null;
      state.status = "Saving ZAI_API_KEY...";
      renderNativeSettingsPanel();
      try {
        await saveProviderApiKey("zai", input?.value || "");
        state.status = "Saved ZAI_API_KEY. Relaunch patched Codex if the current backend still reports it missing.";
        await refreshManagedProviderStatus("zai", { render: false });
      } catch (error) {
        state.lastError = error.message || String(error);
        state.status = state.lastError;
      } finally {
        state.busy = false;
        renderNativeSettingsPanel();
      }
    });
    panel.querySelector('[data-action="save-dashscope-api-key"]')?.addEventListener("click", async () => {
      const input = panel.querySelector('[data-secret-field="dashscopeApiKey"]');
      state.busy = true;
      state.lastError = null;
      state.status = "Saving Alibaba Qwen API key...";
      renderNativeSettingsPanel();
      try {
        await saveProviderApiKey("dashscope", input?.value || "");
        state.fields.dashscopeApiKey = "";
        await refreshManagedProviderStatus("dashscope", { render: false });
        state.status = "Alibaba Qwen API key saved to the Windows user environment. Restart shells that need the new value.";
      } catch (error) {
        state.lastError = error.message || String(error);
        state.status = state.lastError;
      } finally {
        state.busy = false;
        renderNativeSettingsPanel();
      }
    });
    panel.querySelector('[data-action="save-cerebras-api-key"]')?.addEventListener("click", async () => {
      const input = panel.querySelector('[data-secret-field="cerebrasApiKey"]');
      state.busy = true;
      state.lastError = null;
      state.status = "Saving Cerebras API key...";
      renderNativeSettingsPanel();
      try {
        await saveProviderApiKey("cerebras", input?.value || "");
        state.fields.cerebrasApiKey = "";
        await refreshManagedProviderStatus("cerebras", { render: false });
        state.status = "Cerebras API key saved to the Windows user environment. Restart shells that need the new value.";
      } catch (error) {
        state.lastError = error.message || String(error);
        state.status = state.lastError;
      } finally {
        state.busy = false;
        renderNativeSettingsPanel();
      }
    });
  }

  function createStyle() {
    const style = document.createElement("style");
    style.textContent = `
      .cps-settings-content-host {
        min-height: 0;
        position: relative;
      }
      .cps-settings-nav-button {
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
        pointer-events: auto;
        position: relative;
        text-align: left;
        width: 100%;
      }
      .cps-sidebar-icon {
        color: currentColor;
        flex: 0 0 auto;
      }
      .cps-settings-nav-button:hover,
      .cps-settings-nav-button.is-active {
        background: var(--color-token-list-active-selection-background, var(--color-token-list-hover-background));
        color: var(--color-token-text-primary);
      }
      .cps-native-settings-panel {
        background: var(--color-token-main-surface-primary);
        color: var(--color-token-text-primary);
        inset: 0;
        position: absolute;
        z-index: 2147483001;
      }
      .cps-native-settings-panel * { box-sizing: border-box; }
      .cps-providers-root {
        --cps-settings-max-width: 672px;
        --cps-settings-wide-max-width: 672px;
        display: flex;
        flex-direction: column;
        gap: var(--padding-panel, 16px);
        height: 100%;
        margin: 0 auto;
        max-width: min(var(--cps-settings-wide-max-width), 100%);
        min-height: 0;
        overflow: auto;
        padding: var(--padding-panel, 16px);
        scrollbar-gutter: stable;
        width: 100%;
      }
      .cps-providers-root:has(.cps-providers-list.is-settings-page) {
        max-width: min(var(--cps-settings-max-width), 100%);
      }
      .cps-providers-header {
        align-items: flex-start;
        display: flex;
        gap: 18px;
        justify-content: space-between;
        min-width: 0;
      }
      .cps-providers-header h1 {
        font-size: 20px;
        font-weight: 650;
        line-height: 1.25;
        margin: 0;
      }
      .cps-providers-header p {
        color: var(--color-token-text-secondary);
        font-size: 13px;
        line-height: 1.35;
        margin: 5px 0 0;
        max-width: 760px;
      }
      .cps-add-provider {
        align-items: center;
        background: transparent;
        border: 1px solid var(--color-token-border-default, var(--color-token-border));
        border-radius: 8px;
        color: var(--color-token-text-primary);
        cursor: pointer;
        display: inline-flex;
        font: inherit;
        font-size: 14px;
        gap: 8px;
        min-height: 34px;
        padding: 6px 12px;
      }
      .cps-providers-list {
        background: var(--color-background-panel, var(--color-token-bg-fog, var(--color-token-main-surface-primary)));
        border: 1px solid var(--color-token-border-default, var(--color-token-border));
        border-radius: var(--radius-lg, 8px);
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
        min-height: 0;
        overflow: auto;
        scrollbar-gutter: stable;
      }
      .cps-providers-list.is-settings-page {
        background: transparent;
        border: 0;
        border-radius: 0;
        overflow: visible;
      }
      .cps-provider-row {
        border-bottom: 1px solid var(--color-token-border-default, var(--color-token-border));
        flex: 0 0 auto;
      }
      .cps-provider-row:last-child {
        border-bottom: 0;
      }
      .cps-provider-summary {
        align-items: center;
        cursor: pointer;
        display: grid;
        gap: 12px;
        grid-template-columns: minmax(0, 1fr) auto 18px;
        min-height: 52px;
        padding: 8px 12px;
      }
      .cps-provider-summary::-webkit-details-marker {
        display: none;
      }
      .cps-provider-title {
        align-items: center;
        display: flex;
        gap: 12px;
        min-width: 0;
      }
      .cps-provider-title span:last-child {
        font-size: 16px;
        font-weight: 620;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cps-provider-logo {
        align-items: center;
        border-radius: var(--radius-lg, 8px);
        color: #fff;
        display: inline-flex;
        flex: 0 0 32px;
        font-size: 17px;
        font-weight: 760;
        height: 32px;
        justify-content: center;
        width: 32px;
      }
      .cps-provider-logo-openai { background: #111827; }
      .cps-provider-logo-deepseek { background: #4f7cff; }
      .cps-provider-logo-zai { background: #111111; }
      .cps-provider-logo-dashscope { background: #7057ff; }
      .cps-provider-logo-cerebras { background: #f15a24; color: #ffffff; }
      .cps-provider-logo-ollama { background: #f3f4f6; border: 1px solid rgba(0,0,0,.16); color: #111827; }
      .cps-provider-logo-auto { background: linear-gradient(135deg, #111827, #4f7cff 55%, #16a34a); }
      .cps-provider-logo-prompts { background: linear-gradient(135deg, #0f766e, #2563eb); }
      .cps-provider-stat {
        color: var(--color-token-text-secondary);
        display: grid;
        font-size: 12px;
        gap: 3px;
        min-width: 0;
      }
      .cps-provider-stat-api-key,
      .cps-provider-stat-proxy,
      .cps-provider-stat-models {
        display: none;
      }
      .cps-provider-stat strong {
        color: var(--color-token-text-primary);
        font-size: 13px;
        font-weight: 620;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cps-compact-pill {
        align-items: center;
        border: 1px solid var(--color-token-border-default, var(--color-token-border));
        border-radius: 6px;
        display: inline-flex;
        font-size: 12px;
        font-weight: 560;
        justify-self: start;
        line-height: 1;
        min-height: 21px;
        padding: 3px 7px;
      }
      .cps-compact-pill.is-ok {
        background: rgba(34, 197, 94, .08);
        border-color: rgba(34, 197, 94, .35);
        color: #15803d;
      }
      .cps-compact-pill.is-warn,
      .cps-compact-pill.is-pending {
        background: rgba(245, 158, 11, .09);
        border-color: rgba(245, 158, 11, .4);
        color: #b45309;
      }
      .cps-compact-pill.is-bad {
        background: rgba(239, 68, 68, .08);
        border-color: rgba(239, 68, 68, .42);
        color: #dc2626;
      }
      .cps-compact-pill.is-muted {
        background: rgba(107, 114, 128, .07);
        border-color: rgba(107, 114, 128, .24);
        color: var(--color-token-text-secondary);
      }
      .cps-provider-actions {
        align-items: center;
        display: none;
        gap: 8px;
        justify-content: flex-end;
        min-width: 0;
      }
      .cps-icon-button {
        align-items: center;
        background: transparent;
        border: 1px solid var(--color-token-border-default, var(--color-token-border));
        border-radius: 7px;
        color: var(--color-token-text-primary);
        cursor: pointer;
        display: inline-flex;
        font: inherit;
        font-size: 13px;
        justify-content: center;
        min-height: 31px;
        min-width: 34px;
        padding: 5px 8px;
      }
      .cps-disclosure {
        color: var(--color-token-text-secondary);
        font-size: 16px;
        transform: rotate(0deg);
      }
      .cps-provider-row[open] .cps-disclosure {
        transform: rotate(180deg);
      }
      .cps-provider-expanded {
        border-top: 1px solid var(--color-token-border-default, var(--color-token-border));
        display: grid;
        grid-template-columns: 1fr;
        min-height: 142px;
      }
      .cps-settings-page {
        display: flex;
        flex-direction: column;
        gap: var(--padding-panel, 16px);
        margin: 0 auto;
        max-width: 100%;
        min-height: 0;
        padding: 0;
        width: 100%;
      }
      .cps-page-summary {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        padding: 0;
      }
      .cps-page-pill {
        align-items: center;
        border: 1px solid var(--color-token-border-default, var(--color-token-border));
        border-radius: var(--radius-lg, 8px);
        color: var(--color-token-text-secondary);
        display: inline-flex;
        font-size: 12px;
        gap: 10px;
        min-height: 38px;
        min-width: min(155px, 100%);
        padding: 7px 10px;
      }
      .cps-page-pill-icon {
        align-items: center;
        background: transparent;
        border-radius: 999px;
        color: var(--color-token-text-primary);
        display: inline-flex;
        height: 22px;
        justify-content: center;
        width: 22px;
      }
      .cps-page-pill-icon svg,
      .cps-section-icon svg {
        height: 17px;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 1.8;
        width: 17px;
      }
      .cps-page-pill-copy {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .cps-page-pill-copy > span {
        color: var(--color-token-text-secondary);
        line-height: 1.2;
      }
      .cps-page-pill-copy strong {
        color: var(--color-token-text-primary);
        font-weight: 600;
        line-height: 1.2;
        max-width: 220px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cps-page-pill.is-ok {
        border-color: rgba(34, 197, 94, .34);
      }
      .cps-page-pill.is-ok .cps-page-pill-icon {
        background: rgba(34, 197, 94, .14);
        color: rgb(22, 101, 52);
      }
      .cps-page-pill.is-warn {
        border-color: rgba(245, 158, 11, .34);
      }
      .cps-page-pill.is-warn .cps-page-pill-icon {
        background: rgba(245, 158, 11, .14);
        color: rgb(146, 64, 14);
      }
      .cps-page-pill.is-bad {
        border-color: rgba(239, 68, 68, .32);
      }
      .cps-page-pill.is-bad .cps-page-pill-icon {
        background: rgba(239, 68, 68, .13);
        color: rgb(153, 27, 27);
      }
      .cps-page-pill.is-accent {
        border-color: rgba(37, 99, 235, .28);
      }
      .cps-page-pill.is-accent .cps-page-pill-icon {
        background: rgba(37, 99, 235, .13);
        color: rgb(30, 64, 175);
      }
      .cps-page-grid {
        display: grid;
        gap: var(--padding-panel, 16px);
        min-height: 0;
      }
      .cps-auto-router-grid {
        grid-template-columns: 1fr;
      }
      .cps-prompt-tools-grid {
        grid-template-columns: 1fr;
      }
      .cps-swarm-grid {
        grid-template-columns: 1fr;
      }
      .cps-personas-grid {
        grid-template-columns: 1fr;
      }
      .cps-page-column {
        display: flex;
        flex-direction: column;
        gap: 16px;
        min-width: 0;
      }
      .cps-settings-band {
        background: var(--color-background-panel, var(--color-token-bg-fog, var(--color-token-main-surface-primary)));
        border: 1px solid var(--color-token-border-default, var(--color-token-border));
        border-radius: var(--radius-lg, 8px);
        display: flex;
        flex-direction: column;
        min-width: 0;
        overflow: hidden;
        padding: 0;
      }
      .cps-section-header {
        align-items: flex-start;
        display: flex;
        gap: 10px;
        justify-content: space-between;
        min-height: 48px;
        padding: 12px 14px;
      }
      .cps-section-icon {
        align-items: center;
        background: transparent;
        border: 0;
        border-radius: 0;
        color: var(--color-token-text-primary);
        display: inline-flex;
        flex: 0 0 auto;
        height: 22px;
        justify-content: center;
        width: 22px;
      }
      .cps-section-title-wrap {
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .cps-section-title-wrap strong {
        color: var(--color-token-text-primary);
        font-size: 14px;
        font-weight: 650;
      }
      .cps-section-title-wrap small {
        color: var(--color-token-text-secondary);
        font-size: 12px;
        line-height: 1.35;
      }
      .cps-section-right {
        align-items: center;
        display: flex;
        flex: 0 0 auto;
        gap: 8px;
      }
      .cps-settings-page .cps-settings-row {
        align-items: flex-start;
        border-top: 1px solid var(--color-token-border-subtle, rgba(0,0,0,.075));
        min-height: 50px;
        padding: 10px 14px;
      }
      .cps-settings-page .cps-settings-label {
        font-size: 13px;
      }
      .cps-settings-page .cps-settings-description {
        font-size: 12px;
      }
      .cps-settings-page .cps-settings-control {
        flex: 0 1 min(360px, 48%);
      }
      .cps-settings-page .cps-prompt-row {
        align-items: stretch;
        flex-direction: column;
        gap: 8px;
      }
      .cps-settings-page .cps-prompt-row .cps-settings-control,
      .cps-settings-page .cps-textarea-control {
        flex: 1 1 auto;
        width: 100%;
      }
      .cps-router-prompt-textarea,
      .cps-review-prompt-textarea {
        min-height: 150px;
      }
      .cps-settings-page .cps-test-input {
        min-height: 82px;
        margin: 0 14px 12px;
        width: calc(100% - 28px);
      }
      .cps-settings-page .cps-prompt-modifier-textarea {
        margin: 0 14px 12px;
        min-height: 180px;
        width: calc(100% - 28px);
      }
      .cps-settings-page .cps-tool-output {
        min-height: 112px;
        margin: 0 14px 14px;
      }
      .cps-settings-page .cps-note {
        margin: 0;
        padding: 12px 14px;
      }
      .cps-band-actions {
        align-items: center;
        border-top: 1px solid var(--color-token-border-default, var(--color-token-border));
        min-height: 46px;
        padding: 10px 14px;
      }
      .cps-model-toolbar {
        align-items: center;
        display: flex;
        gap: 8px;
        padding: 0 14px 12px;
      }
      .cps-model-toolbar .cps-model-search {
        flex: 1 1 auto;
        min-width: 0;
      }
      .cps-grouped-model-list {
        border-top: 1px solid var(--color-token-border-default, var(--color-token-border));
        display: flex;
        flex-direction: column;
        gap: 0;
        max-height: min(52vh, 590px);
        min-height: 220px;
        overflow: auto;
        padding: 0;
        scrollbar-gutter: stable;
      }
      .cps-model-group {
        display: flex;
        flex-direction: column;
        gap: 7px;
        min-width: 0;
        padding: 12px 14px;
      }
      .cps-model-group + .cps-model-group {
        border-top: 1px solid var(--color-token-border-subtle, rgba(0,0,0,.075));
      }
      .cps-model-group-title {
        color: var(--color-token-text-secondary);
        font-size: 12px;
        font-weight: 650;
        text-transform: none;
      }
      .cps-model-group-grid {
        display: grid;
        gap: 4px 10px;
        grid-template-columns: repeat(auto-fit, minmax(155px, 1fr));
      }
      .cps-model-group-grid .cps-provider-model-check {
        border-radius: var(--radius-sm, 6px);
        min-height: 24px;
        padding: 2px 4px;
      }
      .cps-model-group-grid .cps-provider-model-check:hover {
        background: var(--color-token-list-hover-background, rgba(0,0,0,.04));
      }
      .cps-models-band {
        min-height: 0;
      }
      .cps-persona-list-band {
        min-height: 0;
      }
      .cps-persona-list {
        display: flex;
        flex-direction: column;
        max-height: min(62vh, 680px);
        min-height: 260px;
        overflow: auto;
        scrollbar-gutter: stable;
      }
      .cps-persona-card {
        border-top: 1px solid var(--color-token-border-subtle, rgba(0,0,0,.075));
      }
      .cps-persona-card:first-child {
        border-top: 0;
      }
      .cps-persona-summary {
        align-items: center;
        cursor: pointer;
        display: flex;
        gap: 12px;
        justify-content: space-between;
        min-height: 54px;
        padding: 10px 14px;
      }
      .cps-persona-summary::-webkit-details-marker {
        display: none;
      }
      .cps-persona-title {
        align-items: center;
        display: flex;
        gap: 10px;
        min-width: 0;
      }
      .cps-persona-title > span:last-child {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .cps-persona-title strong,
      .cps-persona-title small {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cps-persona-title strong {
        color: var(--color-token-text-primary);
        font-size: 13px;
        font-weight: 650;
      }
      .cps-persona-title small {
        color: var(--color-token-text-secondary);
        font-size: 12px;
      }
      .cps-persona-avatar {
        align-items: center;
        color: var(--color-token-text-primary);
        display: inline-flex;
        flex: 0 0 24px;
        height: 24px;
        justify-content: center;
        width: 24px;
      }
      .cps-persona-avatar svg {
        height: 18px;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 1.8;
        width: 18px;
      }
      .cps-persona-actions {
        align-items: center;
        display: flex;
        flex: 0 0 auto;
        gap: 8px;
      }
      .cps-inline-check {
        align-items: center;
        color: var(--color-token-text-secondary);
        display: inline-flex;
        font-size: 12px;
        gap: 6px;
        white-space: nowrap;
      }
      .cps-persona-editor {
        border-top: 1px solid var(--color-token-border-subtle, rgba(0,0,0,.075));
        display: grid;
        gap: 10px;
        padding: 12px 14px 14px;
      }
      .cps-persona-editor label {
        color: var(--color-token-text-secondary);
        display: grid;
        font-size: 12px;
        gap: 5px;
        min-width: 0;
      }
      .cps-persona-context {
        min-height: 72px;
      }
      .cps-persona-prompt {
        min-height: 140px;
      }
      .cps-swarm-number-grid {
        border-top: 1px solid var(--color-token-border-subtle, rgba(0,0,0,.075));
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        padding: 12px 14px;
      }
      .cps-swarm-number-grid label {
        color: var(--color-token-text-secondary);
        display: grid;
        font-size: 12px;
        gap: 5px;
      }
      .cps-swarm-departments {
        min-height: 126px;
      }
      .cps-swarm-topology-preview {
        border-top: 1px solid var(--color-token-border-subtle, rgba(0,0,0,.075));
        display: grid;
        gap: 12px;
        justify-items: center;
        padding: 14px;
      }
      .cps-swarm-lanes {
        display: grid;
        gap: 8px;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        width: 100%;
      }
      .cps-swarm-lanes.is-workers {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
      .cps-swarm-node {
        background: var(--color-token-surface-secondary, rgba(0,0,0,.035));
        border: 1px solid var(--color-token-border-default, var(--color-token-border));
        border-radius: var(--radius-lg, 8px);
        color: var(--color-token-text-primary);
        font-size: 12px;
        min-height: 34px;
        overflow: hidden;
        padding: 8px 10px;
        text-align: center;
        text-overflow: ellipsis;
        white-space: nowrap;
        width: 100%;
      }
      .cps-swarm-node.is-root {
        background: rgba(37, 99, 235, .08);
        border-color: rgba(37, 99, 235, .28);
        max-width: 320px;
      }
      .cps-auto-router-row {
        background: transparent;
      }
      .cps-auto-router-expanded {
        grid-template-columns: 1fr;
      }
      .cps-auto-router-prompt-row {
        align-items: flex-start;
      }
      .cps-prompt-tools-row {
        background: transparent;
      }
      .cps-prompt-tools-expanded {
        grid-template-columns: 1fr;
      }
      .cps-provider-config-pane,
      .cps-provider-model-pane {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: 0;
        padding: 12px 14px;
      }
      .cps-provider-config-pane {
        border-bottom: 1px solid var(--color-token-border-default, var(--color-token-border));
      }
      .cps-provider-field {
        display: grid;
        gap: 5px;
      }
      .cps-provider-field > span:first-child,
      .cps-visible-models-head > span:first-child {
        color: var(--color-token-text-primary);
        font-size: 13px;
        font-weight: 560;
      }
      .cps-provider-field.is-readonly {
        align-items: center;
        grid-template-columns: 110px 1fr;
      }
      .cps-provider-field.is-row {
        align-items: center;
        display: flex;
        gap: 12px;
      }
      .cps-provider-field.is-row span:nth-child(2) {
        color: var(--color-token-text-secondary);
        font-size: 12px;
      }
      .cps-inline-input-row {
        display: grid;
        gap: 8px;
        grid-template-columns: minmax(0, 1fr) 68px;
      }
      .cps-inline-advanced {
        border-top: 1px solid var(--color-token-border-default, var(--color-token-border));
        color: var(--color-token-text-secondary);
        font-size: 13px;
        padding-top: 8px;
      }
      .cps-inline-advanced summary {
        cursor: pointer;
      }
      .cps-advanced-grid {
        display: grid;
        gap: 8px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        padding-top: 10px;
      }
      .cps-advanced-grid label {
        color: var(--color-token-text-secondary);
        display: grid;
        font-size: 12px;
        gap: 4px;
      }
      .cps-visible-models-head {
        align-items: center;
        display: flex;
        gap: 12px;
        justify-content: space-between;
      }
      .cps-model-tools {
        align-items: center;
        display: flex;
        gap: 6px;
      }
      .cps-model-search {
        background: var(--color-token-input-surface, var(--color-token-surface-primary));
        border: 1px solid var(--color-token-border-default, var(--color-token-border));
        border-radius: 7px;
        color: var(--color-token-text-primary);
        font: inherit;
        min-height: 28px;
        min-width: 220px;
        padding: 4px 9px;
      }
      .cps-provider-model-grid {
        border: 1px solid var(--color-token-border-default, var(--color-token-border));
        border-radius: 8px;
        display: grid;
        gap: 5px 16px;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 170px), 1fr));
        max-height: 220px;
        min-height: 86px;
        overflow: auto;
        padding: 8px;
        scrollbar-gutter: stable;
      }
      .cps-provider-model-grid.is-compact {
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr));
      }
      .cps-provider-model-check {
        align-items: center;
        color: var(--color-token-text-primary);
        display: flex;
        font-size: 12px;
        gap: 7px;
        min-height: 23px;
        min-width: 0;
      }
      .cps-provider-model-check input {
        flex: 0 0 auto;
        margin: 0;
      }
      .cps-provider-model-check span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cps-default-badge {
        background: rgba(0,0,0,.06);
        border-radius: 5px;
        color: var(--color-token-text-secondary);
        font-size: 11px;
        padding: 2px 6px;
      }
      .cps-model-empty {
        border: 1px solid var(--color-token-border-default, var(--color-token-border));
        border-radius: 8px;
        color: var(--color-token-text-secondary);
        font-size: 13px;
        padding: 12px;
      }
      .cps-providers-footer {
        align-items: center;
        border-top: 1px solid var(--color-token-border-default, var(--color-token-border));
        display: flex;
        gap: 14px;
        justify-content: space-between;
        min-height: 34px;
        padding-top: 8px;
      }
      .cps-settings-surface {
        border-bottom: 1px solid var(--color-token-border-default, var(--color-token-border));
        display: flex;
        flex-direction: column;
      }
      .cps-provider-card {
        border-bottom: 1px solid var(--color-token-border-default, var(--color-token-border));
        display: flex;
        flex-direction: column;
      }
      .cps-status-grid {
        display: grid;
        gap: 8px;
        grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
        padding: 0 0 12px;
      }
      .cps-status-pill {
        align-items: center;
        border: 1px solid var(--color-token-border-default, var(--color-token-border));
        border-radius: var(--radius-lg, 8px);
        color: var(--color-token-text-secondary);
        display: flex;
        font-size: 12px;
        gap: 8px;
        justify-content: space-between;
        min-height: 34px;
        padding: 7px 9px;
      }
      .cps-status-pill strong {
        color: var(--color-token-text-primary);
        font-size: 12px;
        font-weight: 600;
      }
      .cps-status-pill.is-ok {
        border-color: rgba(34, 197, 94, .45);
      }
      .cps-status-pill.is-missing {
        border-color: rgba(239, 68, 68, .4);
      }
      .cps-status-pill.is-pending {
        border-color: var(--color-token-text-secondary);
      }
      .cps-status-pill.is-unknown {
        border-color: rgba(148, 163, 184, .45);
      }
      .cps-provider-message {
        color: var(--color-token-text-secondary);
        font-size: 13px;
        line-height: 1.35;
        padding: 0 0 8px;
      }
      .cps-secret-control {
        align-items: center;
        gap: 8px;
      }
      .cps-secret-control .cps-input {
        min-width: 0;
      }
      .cps-textarea-control {
        flex: 0 1 min(520px, 58%);
      }
      .cps-textarea {
        min-height: 108px;
        resize: vertical;
        white-space: pre-wrap;
      }
      .cps-test-input {
        min-height: 72px;
      }
      .cps-prompt-modifier-textarea {
        min-height: 150px;
      }
      .cps-prompt-observed-textarea {
        color: var(--color-token-text-secondary);
        min-height: 150px;
      }
      .cps-tool-panel {
        border-top: 1px solid var(--color-token-border-default, var(--color-token-border));
        display: flex;
        flex-direction: column;
        gap: 9px;
        padding-top: 12px;
      }
      .cps-tool-panel-header {
        align-items: flex-start;
        display: flex;
        gap: 12px;
        justify-content: space-between;
      }
      .cps-tool-output {
        background: var(--color-token-surface-secondary, rgba(0,0,0,.035));
        border: 1px solid var(--color-token-border-default, var(--color-token-border));
        border-radius: var(--radius-lg, 8px);
        color: var(--color-token-text-primary);
        font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
        margin: 0;
        max-height: 190px;
        min-height: 72px;
        overflow: auto;
        padding: 10px;
        white-space: pre-wrap;
      }
      .cps-model-visibility-control {
        align-items: stretch;
        flex: 0 1 min(720px, 68%);
        flex-direction: column;
        gap: 8px;
      }
      .cps-model-bulk-actions {
        display: flex;
        gap: 6px;
        justify-content: flex-end;
      }
      .cps-button-sm {
        font-size: 12px;
        min-height: 28px;
        padding: 4px 9px;
      }
      .cps-model-checks {
        align-items: stretch;
        flex-direction: column;
        gap: 6px;
      }
      .cps-model-row {
        align-items: flex-start;
      }
      .cps-model-checks.is-compact {
        border: 1px solid var(--color-token-border-default, var(--color-token-border));
        border-radius: var(--radius-lg, 8px);
        display: grid;
        gap: 2px 8px;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 170px), 1fr));
        justify-content: stretch;
        max-height: 260px;
        min-width: min(100%, 520px);
        overflow: auto;
        padding: 6px;
        scrollbar-gutter: stable;
      }
      .cps-model-check {
        align-items: center;
        color: var(--color-token-text-primary);
        display: flex;
        font-size: 13px;
        gap: 8px;
        min-height: 26px;
      }
      .cps-model-checks.is-compact .cps-model-check {
        border-radius: var(--radius-sm, 6px);
        font-size: 12px;
        gap: 6px;
        min-height: 22px;
        min-width: 0;
        padding: 2px 4px;
      }
      .cps-model-checks.is-compact .cps-model-check:hover {
        background: var(--color-token-list-hover-background, rgba(0, 0, 0, .04));
      }
      .cps-model-check input {
        flex: 0 0 auto;
        margin: 0;
      }
      .cps-model-check span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cps-provider-actions {
        border-top: 1px solid var(--color-token-border-default, var(--color-token-border));
        padding-bottom: 12px;
      }
      .cps-advanced-settings {
        border-bottom: 1px solid var(--color-token-border-default, var(--color-token-border));
      }
      .cps-advanced-settings > summary {
        align-items: center;
        color: var(--color-token-text-primary);
        cursor: pointer;
        display: flex;
        font-size: 14px;
        font-weight: 500;
        min-height: 42px;
        outline: none;
      }
      .cps-advanced-content {
        display: flex;
        flex-direction: column;
        gap: var(--padding-panel);
        padding-bottom: var(--padding-panel);
      }
      .cps-settings-row {
        align-items: center;
        border-top: 1px solid var(--color-token-border-default, var(--color-token-border));
        color: var(--color-token-text-primary);
        display: flex;
        gap: 18px;
        justify-content: space-between;
        min-height: 54px;
        padding: 10px 0;
      }
      .cps-settings-row:first-child { border-top: 0; }
      .cps-settings-row-clickable { cursor: pointer; }
      .cps-settings-row-copy {
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
        gap: 3px;
        min-width: 0;
      }
      .cps-settings-label {
        color: var(--color-token-text-primary);
        font-size: 14px;
        font-weight: 500;
      }
      .cps-settings-description,
      .cps-note {
        color: var(--color-token-text-secondary);
        font-size: 13px;
        line-height: 1.35;
      }
      .cps-note {
        border-top: 1px solid var(--color-token-border-default, var(--color-token-border));
        padding: 12px 0;
      }
      .cps-settings-control {
        display: flex;
        flex: 0 0 min(310px, 46%);
        justify-content: flex-end;
        min-width: 0;
      }
      .cps-combo {
        display: block;
      }
      .cps-input {
        background: var(--color-token-input-surface, var(--color-token-surface-primary));
        border: 1px solid var(--color-token-border-default, var(--color-token-border));
        border-radius: var(--radius-lg, 8px);
        color: var(--color-token-text-primary);
        font: inherit;
        min-height: 34px;
        outline: none;
        padding: 6px 9px;
        width: 100%;
      }
      .cps-input:focus {
        border-color: var(--color-token-text-secondary);
      }
      .cps-preset-grid {
        display: grid;
        gap: 8px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        padding: 0 0 12px;
      }
      .cps-preset {
        background: transparent;
        border: 1px solid var(--color-token-border-default, var(--color-token-border));
        border-radius: var(--radius-lg, 8px);
        color: var(--color-token-text-primary);
        cursor: pointer;
        display: flex;
        flex-direction: column;
        gap: 5px;
        min-height: 74px;
        padding: 10px;
        text-align: left;
      }
      .cps-preset:hover,
      .cps-preset.is-active {
        background: var(--color-token-list-hover-background);
        border-color: var(--color-token-text-secondary);
      }
      .cps-preset strong {
        font-size: 13px;
        font-weight: 600;
      }
      .cps-preset span {
        color: var(--color-token-text-secondary);
        font-size: 12px;
        line-height: 1.3;
      }
      .cps-action-row {
        align-items: center;
        border-top: 1px solid var(--color-token-border-default, var(--color-token-border));
        display: flex;
        gap: 16px;
        justify-content: space-between;
        padding: 14px 0 4px;
      }
      .cps-status {
        color: var(--color-token-text-secondary);
        flex: 1 1 auto;
        font-size: 13px;
        min-width: 0;
      }
      .cps-status.is-error {
        color: var(--color-token-error-foreground, #ef4444);
      }
      .cps-status.is-busy {
        color: var(--color-token-text-primary);
      }
      .cps-actions {
        display: flex;
        flex: 0 0 auto;
        gap: 8px;
      }
      .cps-button-group {
        gap: 8px;
      }
      .cps-button {
        align-items: center;
        background: transparent;
        border: 1px solid var(--color-token-border-default, var(--color-token-border));
        border-radius: var(--radius-lg, 8px);
        cursor: pointer;
        display: inline-flex;
        font: inherit;
        font-size: 13px;
        font-weight: 500;
        min-height: 32px;
        justify-content: center;
        padding: 6px 12px;
      }
      .cps-button:disabled {
        cursor: not-allowed;
        opacity: .55;
      }
      .cps-primary {
        background: var(--color-token-text-primary);
        border: 1px solid var(--color-token-text-primary);
        color: var(--color-token-main-surface-primary);
      }
      .cps-secondary {
        background: transparent;
        border: 1px solid var(--color-token-border-default, var(--color-token-border));
        color: var(--color-token-text-primary);
      }
      .cps-native-menu-section {
        border-top: 1px solid var(--color-token-border-default, var(--color-token-border));
        display: flex;
        flex-direction: column;
        margin-top: 6px;
        padding-top: 6px;
      }
      .cps-native-menu-section-active {
        border-top: 0;
        margin-top: 0;
        padding: 4px;
      }
      .cps-native-menu-heading {
        color: var(--color-token-text-secondary);
        font-size: 12px;
        line-height: 1.2;
        padding: 6px 12px 4px;
      }
      .cps-native-menu-row {
        align-items: center;
        background: transparent;
        border: 0;
        border-radius: var(--radius-lg, 8px);
        color: var(--color-token-text-primary);
        cursor: pointer;
        display: flex;
        font: inherit;
        gap: 12px;
        justify-content: space-between;
        min-height: 34px;
        min-width: 180px;
        padding: 6px 12px;
        text-align: left;
        width: 100%;
      }
      .cps-native-menu-row:hover {
        background: var(--color-token-list-hover-background);
      }
      .cps-native-menu-row-copy {
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .cps-native-menu-row-label,
      .cps-native-menu-row-meta {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cps-native-menu-row-label {
        font-size: 13px;
      }
      .cps-native-menu-row-meta {
        color: var(--color-token-text-secondary);
        font-size: 11px;
      }
      .cps-native-menu-check {
        color: var(--color-token-text-primary);
        flex: 0 0 auto;
        width: 16px;
      }
      .cps-native-menu-note {
        color: var(--color-token-text-secondary);
        font-size: 12px;
        padding: 8px 12px;
      }
      @media (max-width: 720px) {
        .cps-providers-root,
        .cps-settings-page {
          padding: 12px;
        }
        .cps-providers-header,
        .cps-section-header,
        .cps-action-row {
          align-items: stretch;
          flex-direction: column;
        }
        .cps-provider-summary {
          grid-template-columns: minmax(0, 1fr) auto;
        }
        .cps-provider-summary .cps-provider-stat,
        .cps-provider-actions {
          display: none;
        }
        .cps-settings-row,
        .cps-action-row {
          align-items: stretch;
          flex-direction: column;
        }
        .cps-settings-control {
          flex-basis: auto;
          justify-content: stretch;
          width: 100%;
        }
        .cps-secret-control {
          align-items: stretch;
          flex-direction: column;
        }
        .cps-preset-grid {
          grid-template-columns: 1fr;
        }
      }
    `;
    document.head.append(style);
  }

  function tickNativeIntegration() {
    try {
      syncNativeSettingsIntegration();
    } catch (error) {
      console.warn("[native-provider-settings] integration tick failed", error);
    }
  }

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

  function isInsideProviderSettingsPanel(event) {
    const target = event.target;
    return Boolean(target && target.closest && target.closest("#cps-native-settings-content"));
  }

  function startNativeSettingsIntegration() {
    if (!document.body || document.body.dataset.cpsNativeIntegrationBound) {
      return;
    }
    document.body.dataset.cpsNativeIntegrationBound = "true";
    document.addEventListener(
      "click",
      (event) => {
        if (!isInsideProviderSettingsPanel(event)) {
          scheduleNativeIntegrationBurst();
        }
      },
      true
    );
    document.addEventListener("keydown", (event) => {
      if ((event.key === "Escape" || event.key === "Enter") && !isInsideProviderSettingsPanel(event)) {
        scheduleNativeIntegrationBurst();
      }
    }, true);
  }

  function startNativeSettingsRouteObserver() {
    if (!document.body || nativeSettingsRouteObserver) {
      return;
    }
    nativeSettingsRouteObserver = new MutationObserver(() => {
      const routeId = activeProviderSettingsRoute();
      if (!routeId || document.getElementById("cps-native-settings-content")) {
        return;
      }
      if (activeProviderSettingsRouteHost() || findSettingsNavigation()) {
        scheduleNativeIntegration();
      }
    });
    nativeSettingsRouteObserver.observe(document.body, { childList: true, subtree: true });
  }

  function recoverActiveNativeSettingsRoute() {
    const recover = () => {
      const routeId = activeProviderSettingsRoute();
      if (!routeId || document.getElementById("cps-native-settings-content")) {
        return;
      }
      if (activeProviderSettingsRouteHost() || findSettingsNavigation()) {
        openProvidersSettingsRoutePanel(routeId);
      }
    };
    for (const delay of [0, 50, 150, 400, 1000]) {
      window.setTimeout(recover, delay);
    }
  }

  function init() {
    if (document.getElementById(`${ROOT_ID}-style`)) {
      return;
    }
    loadDraft();
    const marker = document.createElement("meta");
    marker.id = `${ROOT_ID}-style`;
    document.head.append(marker);
    createStyle();
    window.__codexNativeProviderSettings = {
      open: () => {
        window.dispatchEvent(new CustomEvent("codex-native-settings-tab", { detail: { id: "providers" } }));
        state.pendingSettingsOpen = true;
        state.settingsTabActive = true;
        syncNativeSettingsIntegration();
      },
      loadConfig,
      refreshOllamaModels,
      refreshOllamaModelsInBackground,
      refreshLmStudioModels,
      refreshManagedProviderModels,
      applyConfig,
      selectModelFromNativeMenu,
      routeAutoBeforeTurn,
      chooseAutoRouterModel,
      enhanceMenus: safeEnhanceOpenModelMenus,
      openSettingsRoute: openProvidersSettingsRoutePanel,
      getSwarmSettings: () => ({ ...normalizeSwarmSettings() }),
      getPersonaSettings: () => normalizePersonasSettings(state.personas),
      state,
    };
    installAutoRouterBridgeHook();
    window.addEventListener("codex-native-settings-tab", handleNativeSettingsTabEvent);
    window.addEventListener("codex-native-settings-route", handleNativeSettingsTabEvent);
    window.addEventListener("codex-native-patcher-settings-changed", () => {
      if (state.settingsTabActive || activeProviderSettingsRoute()) {
        renderNativeSettingsPanel();
      }
      safeEnhanceOpenModelMenus();
    });
    window.addEventListener("popstate", scheduleNativeIntegrationBurst);
    window.addEventListener("focus", () => refreshOllamaModelsInBackground());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        refreshOllamaModelsInBackground();
      }
    });
    tickNativeIntegration();
    startNativeSettingsIntegration();
    startNativeSettingsRouteObserver();
    recoverActiveNativeSettingsRoute();
    setTimeout(startModelMenuEnhancer, 1500);
    setTimeout(loadConfig, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
