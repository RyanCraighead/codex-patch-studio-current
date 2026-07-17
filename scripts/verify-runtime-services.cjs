#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { resolveListeningProcess } = require("./resolve-listening-process.cjs");

const root = path.resolve(__dirname, "..");
const requireProviderKeys = process.argv.includes("--require-provider-keys");
const cdpPort = Number(process.env.CODEX_PATCHED_REMOTE_DEBUGGING_PORT || 9229);

function fail(message) {
  throw new Error(message);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function expandEnvironmentPath(value) {
  return String(value || "").replace(/%([^%]+)%/g, (match, name) => process.env[name] || match);
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sameHash(left, right) {
  return Boolean(left && right) && String(left).toLowerCase() === String(right).toLowerCase();
}

function samePath(left, right) {
  if (!left || !right) return false;
  const normalizedLeft = path.resolve(String(left));
  const normalizedRight = path.resolve(String(right));
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function getJson(name, url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) fail(`${name} returned HTTP ${response.status}: ${url}`);
  if (response.headers.get("access-control-allow-origin") !== "*") {
    fail(`${name} is missing the renderer CORS header.`);
  }
  return response.json();
}

async function getRendererJson(name, url) {
  const response = await fetch(url, {
    headers: { Origin: "app://-" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) fail(`${name} returned HTTP ${response.status}: ${url}`);
  if (response.headers.get("access-control-allow-origin") !== "app://-") {
    fail(`${name} did not restrict its renderer CORS header to app://-.`);
  }
  return response.json();
}

async function waitForCatalogShim(launcher, timeoutMs = 60_000) {
  const basePort = Number(launcher.catalogShim?.basePort || 47851);
  const portRange = 50;
  const expectedSourceSha256 = sha256(path.join(root, "scripts", "codex-all-chats-shim.cjs"));
  const expectedUpstreamCli = launcher.catalogShim?.upstreamCli;
  const expectedCliSha256 = launcher.sourceAppServerCliSha256;
  const expectedMaxThreads = Number(launcher.catalogShim?.maxThreads || 10000);
  const deadline = Date.now() + timeoutMs;
  let health = null;
  while (Date.now() < deadline) {
    for (let port = basePort; port < basePort + portRange; port += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (!response.ok) continue;
        const candidate = await response.json();
        const matches =
          candidate.ok === true &&
          candidate.service === "codex-all-chats-shim" &&
          sameHash(candidate.runtimeSourceSha256, expectedSourceSha256) &&
          sameHash(candidate.upstreamCliSha256, expectedCliSha256) &&
          samePath(candidate.upstreamCli, expectedUpstreamCli) &&
          Number(candidate.maxThreads) === expectedMaxThreads;
        if (!matches) continue;
        health = candidate;
        if (candidate.expansions >= 1 && candidate.lastCatalogCount >= 1) return candidate;
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return health;
}

async function findPageTarget(desktopProcess) {
  let lastError;
  for (const host of desktopProcess.hosts) {
    try {
      const response = await fetch(`http://${host}:${cdpPort}/json/list`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`CDP returned HTTP ${response.status}.`);
      const targets = await response.json();
      const target =
        targets.find((entry) => entry.type === "page" && entry.url === "app://-/index.html") ||
        targets.find((entry) => entry.type === "page");
      if (target?.webSocketDebuggerUrl) return { host, target };
    } catch (error) {
      lastError = error;
    }
  }
  const detail = lastError?.message ? ` Last error: ${lastError.message}` : "";
  throw new Error(
    `Codex CDP is unavailable on port ${cdpPort}. Set CODEX_PATCHED_REMOTE_DEBUGGING_PORT=${cdpPort} and relaunch the patched app before running test:runtime.${detail}`,
  );
}

async function evaluate(target, expression) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  try {
    const id = 1;
    const result = await new Promise((resolve, reject) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw));
        if (message.id !== id) return;
        if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
        else resolve(message.result);
      });
      socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        })
      );
    });
    if (result.exceptionDetails) fail(result.exceptionDetails.text || "Renderer evaluation failed.");
    return result.result?.value;
  } finally {
    socket.close();
  }
}

async function waitForHistoryHydration(target, expectedLimit, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let hydration = null;
  while (Date.now() < deadline) {
    hydration = await evaluate(target, "globalThis.__codexPatchStudioHistoryHydration || null");
    if (
      hydration &&
      hydration.requestedThreadLimit === expectedLimit &&
      hydration.loadedThreadCount >= 1 &&
      hydration.loadedThreadCount <= expectedLimit
    ) {
      return hydration;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return hydration;
}

async function main() {
  const launcherPath = path.resolve(
    process.env.CODEX_PATCHED_LAUNCHER_CONFIG || path.join(root, "codex-launcher.local.json"),
  );
  if (!fs.existsSync(launcherPath)) fail(`Missing launcher config: ${launcherPath}`);
  const launcher = readJson(launcherPath);
  const projectConfig = readJson(path.join(root, "config", "patcher.json"));
  const patchedHome = path.resolve(
    expandEnvironmentPath(launcher.codexHome || projectConfig.patchedCodexHome),
  );
  const shareChatDatabaseWithStock =
    typeof launcher.shareChatDatabaseWithStock === "boolean"
      ? launcher.shareChatDatabaseWithStock
      : Boolean(projectConfig.shareChatDatabaseWithStock);
  const stockHome = path.join(os.homedir(), ".codex");
  const stockConfig = path.join(stockHome, "config.toml");
  const patchedConfig = path.join(patchedHome, "config.toml");
  const stockSessions = path.join(stockHome, "sessions");
  const patchedSessions = path.join(patchedHome, "sessions");
  const stockDb = path.join(stockHome, "state_5.sqlite");
  const runtimeSqliteHome = path.resolve(
    expandEnvironmentPath(launcher.sqliteHome || patchedHome),
  );
  const runtimeDb = path.join(runtimeSqliteHome, "state_5.sqlite");
  const expectedImportManagerSha256 = sha256(path.join(root, "viewer", "server.cjs"));
  const expectedPatchManagerSha256 = sha256(path.join(root, "codex-viewer", "server.cjs"));
  const expectedProviderProxySha256 = sha256(path.join(root, "scripts", "codex-responses-chat-proxy.cjs"));

  for (const filePath of [launcher.codexExe, launcher.appAsar, stockConfig, patchedConfig, stockDb, runtimeDb]) {
    if (!filePath || !fs.existsSync(filePath)) fail(`Required runtime path is missing: ${filePath}`);
  }
  if (path.resolve(stockConfig).toLowerCase() === path.resolve(patchedConfig).toLowerCase()) {
    fail("Stock and patched configuration paths are identical.");
  }
  if (fs.realpathSync(stockConfig).toLowerCase() === fs.realpathSync(patchedConfig).toLowerCase()) {
    fail("Stock and patched configuration files resolve to the same file.");
  }
  if (fs.realpathSync(stockSessions).toLowerCase() !== fs.realpathSync(patchedSessions).toLowerCase()) {
    fail("Patched sessions do not resolve to the stock session archive.");
  }
  const stockDbStat = fs.statSync(stockDb);
  const runtimeDbStat = fs.statSync(runtimeDb);
  const sharedChatDatabase =
    fs.realpathSync(stockDb).toLowerCase() === fs.realpathSync(runtimeDb).toLowerCase() ||
    (stockDbStat.dev === runtimeDbStat.dev && stockDbStat.ino === runtimeDbStat.ino);
  if (shareChatDatabaseWithStock && !sharedChatDatabase) {
    fail("Configured stock chat database sharing is not active.");
  }

  const desktopProcess = resolveListeningProcess(cdpPort, {
    expectedExecutablePath: launcher.codexExe,
    expectedUserDataPath: launcher.electronUserDataPath,
  });

  const [imports, patcher, featureDevelopment, ...providerHealth] = await Promise.all([
    getJson("import manager", "http://127.0.0.1:4577/api/health"),
    getJson("patch manager", "http://127.0.0.1:4590/api/patch/status"),
    getRendererJson("feature development", "http://127.0.0.1:4590/api/patch/feature-development"),
    ...[
      ["deepseek", 47731],
      ["zai", 47732],
      ["dashscope", 47733],
      ["cerebras", 47734],
    ].map(async ([provider, port]) => {
      const health = await getJson(`${provider} proxy`, `http://127.0.0.1:${port}/health`);
      if (health.ok !== true || health.provider !== provider) fail(`${provider} proxy health is invalid.`);
      if (!sameHash(health.sourceSha256, expectedProviderProxySha256)) {
        fail(`${provider} proxy is running stale source code.`);
      }
      if (!samePath(health.runtimeRoot, root)) {
        fail(`${provider} proxy belongs to a different patcher runtime.`);
      }
      if (requireProviderKeys && health.hasApiKey !== true) fail(`${provider} API key is not available to its proxy.`);
      return {
        provider,
        port,
        ok: health.ok === true,
        hasApiKey: health.hasApiKey === true,
        sourceSha256: health.sourceSha256,
        runtimeRoot: health.runtimeRoot,
      };
    }),
  ]);
  if (imports.ok !== true || imports.service !== "codex-import-manager") {
    fail("Import manager health is invalid.");
  }
  if (!sameHash(imports.sourceSha256, expectedImportManagerSha256)) {
    fail("Import manager is running stale source code.");
  }
  if (!samePath(imports.runtimeRoot, root)) {
    fail("Import manager belongs to a different patcher runtime.");
  }
  if (!sameHash(patcher.patchManagerSourceSha256, expectedPatchManagerSha256)) {
    fail("Patch manager is running stale source code.");
  }
  if (!samePath(patcher.runtimePaths?.repoRoot, root)) {
    fail("Patch manager belongs to a different patcher runtime.");
  }
  if (featureDevelopment.ok !== true || !Array.isArray(featureDevelopment.modules)) {
    fail("Feature Development bridge returned an invalid catalog.");
  }

  const { host: devToolsHost, target } = await findPageTarget(desktopProcess);
  const catalogShimEnabled = launcher.features?.catalogShim === true && launcher.catalogShim?.enabled === true;
  const catalogShim = catalogShimEnabled ? await waitForCatalogShim(launcher) : null;
  if (!catalogShimEnabled) await waitForHistoryHydration(target, Number(launcher.limit));
  const renderer = await evaluate(
    target,
    `(() => ({
      href: location.href,
      payloads: {
        providers: Boolean(globalThis.__codexNativeProviderSettings),
        orchestrator: Boolean(globalThis.__codexNativeOrchestrator),
        imports: Boolean(globalThis.__codexNativeImportSettings),
        patcher: Boolean(globalThis.__codexNativePatcherSettings),
        featureDevelopment: typeof globalThis.__codexNativePatcherSettings?.openSettingsRoute === 'function'
      },
      preloadInterceptor: typeof globalThis.electronBridge?.registerSendMessageInterceptor === 'function',
      historyHydration: globalThis.__codexPatchStudioHistoryHydration || null
    }))()`
  );
  if (!renderer || Object.values(renderer.payloads || {}).some((value) => value !== true)) {
    fail(`One or more native payloads are not initialized: ${JSON.stringify(renderer?.payloads || null)}`);
  }
  if (!renderer.preloadInterceptor) fail("The preload outbound interceptor is unavailable at runtime.");
  if (catalogShimEnabled) {
    if (!catalogShim || catalogShim.service !== "codex-all-chats-shim" || catalogShim.lastCatalogCount < 1) {
      fail(`All-chats catalog shim runtime result is invalid: ${JSON.stringify(catalogShim)}`);
    }
    if (String(catalogShim.upstreamCliSha256 || "").toLowerCase() !== String(launcher.sourceAppServerCliSha256 || "").toLowerCase()) {
      fail("All-chats catalog shim is not using the pinned app-server CLI.");
    }
    if (!sameHash(catalogShim.runtimeSourceSha256, sha256(path.join(root, "scripts", "codex-all-chats-shim.cjs")))) {
      fail("All-chats catalog shim is running stale source code.");
    }
    if (!samePath(catalogShim.upstreamCli, launcher.catalogShim?.upstreamCli)) {
      fail("All-chats catalog shim is running against a different clone path.");
    }
  } else if (
    !renderer.historyHydration ||
    renderer.historyHydration.requestedThreadLimit !== Number(launcher.limit) ||
    renderer.historyHydration.loadedThreadCount < 1 ||
    renderer.historyHydration.loadedThreadCount > Number(launcher.limit)
  ) {
    fail(`History hydration runtime result is invalid: ${JSON.stringify(renderer.historyHydration)}`);
  }

  const manifest = readJson(path.join(launcher.cloneRoot, "patch-manifest.json"));
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        source: {
          mode: launcher.sourceMode,
          version: launcher.sourceVersion,
          asarSha256: launcher.sourceAsarSha256,
          manifestBuiltAt: manifest.builtAt,
        },
        desktopProcess: {
          port: cdpPort,
          pid: desktopProcess.pid,
          executablePath: desktopProcess.executablePath,
          userDataPath: desktopProcess.userDataPath,
          localAddress: desktopProcess.localAddress,
          host: devToolsHost,
        },
        services: {
          importManager: { ok: imports.ok === true, service: imports.service },
          patchManager: { ok: Boolean(patcher.defaults && patcher.runtimePaths) },
          featureDevelopment: { ok: true, modules: featureDevelopment.modules.length },
          catalogShim,
          providers: providerHealth,
        },
        storage: {
          stockConfigSha256: sha256(stockConfig),
          patchedConfigSha256: sha256(patchedConfig),
          configFilesIsolated: true,
          sessionsShared: true,
          chatDatabaseShared: sharedChatDatabase,
          runtimeSqliteHome,
          launcherConfigPath: launcherPath,
        },
        renderer,
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
