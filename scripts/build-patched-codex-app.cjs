#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { patcherFingerprint } = require("./patcher-fingerprint.cjs");
const { promoteVerifiedJson, writeJsonAtomic } = require("./atomic-json.cjs");
const { withBuildLockSync } = require("./build-lock.cjs");
const {
  applyFeatureModules,
  discoverFeatureModules,
  publicFeatureRecord,
  resolveFeatureModules,
  verifyFeatureModules,
} = require("./feature-registry.cjs");

const rootDir = path.resolve(__dirname, "..");
const projectConfig = loadProjectConfig();
const compatibilityConfig = readJsonSafe(path.join(rootDir, "config", "compatibility.json")) || {};
const defaultOutputRoot = path.resolve(expandEnvironmentPath(projectConfig.outputRoot || path.join(rootDir, "build-output")));
const launcherConfigPath = path.join(rootDir, "codex-launcher.local.json");

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function expandEnvironmentPath(value) {
  return String(value || "").replace(/%([^%]+)%/g, (match, name) => process.env[name] || match);
}

function loadProjectConfig() {
  const base = readJsonSafe(path.join(rootDir, "config", "patcher.json")) || {};
  const local = readJsonSafe(path.join(rootDir, "config", "patcher.local.json")) || {};
  return { ...base, ...local };
}

function usage() {
  console.error(`Usage:
  node scripts/build-patched-codex-app.cjs [options]

Options:
  --limit <n>              Native recent-chat load size. Default: ${projectConfig.chatLimit || 1000}.
  --no-catalog-shim        Do not launch the lazy all-chats catalog shim.
  --source-app-dir <path>  Codex app directory to clone. Defaults to the newest installed Codex build.
  --source-asar <path>     ASAR to patch after cloning source app dir. Useful with app.asar.original.
  --no-chat-limit          Do not patch the native recent-chat loader.
  --no-remote-control      Do not enable the remote_control app-server feature.
  --no-remote-control-settings
                           Do not expose remote_control in native settings.
  --no-native-orchestrator Do not inject the native Orchestrations UI.
  --no-provider-settings   Do not inject the native Providers/model settings UI.
  --no-import-settings     Do not inject the native Imports settings UI.
  --no-patcher-settings    Do not inject the native Patcher settings UI and Help menu item.
  --no-feature-modules     Do not apply contribution or local feature modules.
  --feature <id>           Enable an installed source-only feature module. Repeatable.
  --force-main-window-startup
                           Patch Codex to force-open the main window on startup. Off by default.
  --no-shortcut            Do not create or refresh the desktop launch shortcut.
  --shortcut-name <name>   Shortcut name. Default: ${projectConfig.shortcutName || "Codex Patch Studio Current"}.
  --shortcut-dir <path>    Shortcut directory. Default: Windows Desktop.
  --output-root <path>     Clone output root. Default: ${defaultOutputRoot}
  --keep-work              Keep temporary ASAR extraction directory.
  --json                   Print machine-readable JSON only.`);
}

function parseArgs(argv) {
  const configuredBuildFeatures =
    projectConfig.buildFeatures && typeof projectConfig.buildFeatures === "object" && !Array.isArray(projectConfig.buildFeatures)
      ? projectConfig.buildFeatures
      : {};
  const configuredFeature = (id, fallback) =>
    Object.prototype.hasOwnProperty.call(configuredBuildFeatures, id) ? configuredBuildFeatures[id] !== false : fallback;
  const options = {
    limit: Number(projectConfig.chatLimit || 1000),
    sourceAppDir: null,
    sourceAsar: null,
    enableCatalogShim: configuredFeature("catalogShim", true),
    enableChatLimit: configuredFeature("chatLimit", false),
    enableRemoteControl: configuredFeature("remoteControl", true),
    enableRemoteControlSettings: configuredFeature("remoteControlSettings", true),
    enableNativeOrchestrator: configuredFeature("nativeOrchestrator", true),
    enableProviderSettings: configuredFeature("providerSettings", true),
    enableImportSettings: configuredFeature("importSettings", true),
    enablePatcherSettings: configuredFeature("patcherSettings", true),
    enableFeatureModules: true,
    enabledFeatureModules: [],
    forceMainWindowStartup: configuredFeature("forceMainWindowStartup", false),
    createShortcut: configuredFeature("shortcut", true),
    shortcutName: projectConfig.shortcutName || "Codex Patch Studio Current",
    shortcutDir: null,
    outputRoot: defaultOutputRoot,
    keepWork: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      return argv[index];
    };

    if (arg === "--limit") {
      options.limit = Number(next());
    } else if (arg === "--source-app-dir") {
      options.sourceAppDir = path.resolve(next());
    } else if (arg === "--source-asar") {
      options.sourceAsar = path.resolve(next());
    } else if (arg === "--no-catalog-shim") {
      options.enableCatalogShim = false;
    } else if (arg === "--catalog-shim") {
      options.enableCatalogShim = true;
      options.enableChatLimit = false;
    } else if (arg === "--no-chat-limit") {
      options.enableChatLimit = false;
    } else if (arg === "--chat-limit") {
      options.enableChatLimit = true;
      options.enableCatalogShim = false;
    } else if (arg === "--no-remote-control") {
      options.enableRemoteControl = false;
    } else if (arg === "--no-remote-control-settings") {
      options.enableRemoteControlSettings = false;
    } else if (arg === "--no-native-orchestrator") {
      options.enableNativeOrchestrator = false;
    } else if (arg === "--no-provider-settings") {
      options.enableProviderSettings = false;
    } else if (arg === "--no-import-settings") {
      options.enableImportSettings = false;
    } else if (arg === "--no-patcher-settings") {
      options.enablePatcherSettings = false;
    } else if (arg === "--no-feature-modules") {
      options.enableFeatureModules = false;
    } else if (arg === "--feature") {
      options.enabledFeatureModules.push(next());
    } else if (arg === "--force-main-window-startup") {
      options.forceMainWindowStartup = true;
    } else if (arg === "--no-shortcut") {
      options.createShortcut = false;
    } else if (arg === "--shortcut-name") {
      options.shortcutName = next();
    } else if (arg === "--shortcut-dir") {
      options.shortcutDir = path.resolve(next());
    } else if (arg === "--output-root") {
      options.outputRoot = path.resolve(next());
    } else if (arg === "--keep-work") {
      options.keepWork = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.limit) || options.limit < 50 || options.limit > 10000) {
    throw new Error("--limit must be an integer from 50 through 10000.");
  }

  return options;
}

function exists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function assertInside(parent, child, label) {
  const parentResolved = path.resolve(parent).toLowerCase();
  const childResolved = path.resolve(child).toLowerCase();
  if (childResolved !== parentResolved && !childResolved.startsWith(`${parentResolved}${path.sep}`)) {
    throw new Error(`${label} is outside expected root: ${child}`);
  }
}

function compareVersion(a, b) {
  const left = String(a).split(".").map((part) => Number(part));
  const right = String(b).split(".").map((part) => Number(part));
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] || 0) - (right[index] || 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function snapshotJavaScriptHashes(rootPath) {
  const hashes = new Map();
  const pending = [rootPath];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(filePath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".js")) {
        hashes.set(path.relative(rootPath, filePath).replace(/\\/g, "/"), sha256File(filePath));
      }
    }
  }
  return hashes;
}

function changedJavaScriptPaths(rootPath, baselineHashes) {
  return [...snapshotJavaScriptHashes(rootPath).entries()]
    .filter(([relativePath, hash]) => baselineHashes.get(relativePath) !== hash)
    .map(([relativePath]) => relativePath)
    .sort((left, right) => left.localeCompare(right));
}

function assertJavaScriptPathsSyntax(rootPath, relativePaths, label) {
  for (const relativePath of relativePaths) {
    const filePath = path.resolve(rootPath, relativePath);
    assertInside(rootPath, filePath, `${label} JavaScript path`);
    if (!exists(filePath)) throw new Error(`${label} JavaScript file is missing: ${relativePath}`);
    assertJsModuleSyntax(filePath, `${label}: ${relativePath}`);
  }
  return [...relativePaths];
}

function compatibilityForSource(source) {
  const minimumVersion = String(compatibilityConfig.minimumSupportedVersion || "").trim();
  if (minimumVersion && /^\d+(?:\.\d+)+$/.test(source.version) && compareVersion(source.version, minimumVersion) < 0) {
    throw new Error(
      `Codex ${source.version} is older than this successor patcher's minimum supported version ${minimumVersion}. Use the legacy chat-store patcher for older builds.`
    );
  }

  const validatedBuild = Array.isArray(compatibilityConfig.validatedBuilds)
    ? compatibilityConfig.validatedBuilds.find((entry) => String(entry?.version || "") === String(source.version)) || null
    : null;
  return {
    schemaVersion: Number(compatibilityConfig.schemaVersion || 1),
    strategy: compatibilityConfig.strategy || "structural-anchors-with-packed-verification",
    minimumSupportedVersion: minimumVersion || null,
    previouslyValidated: Boolean(validatedBuild),
    validatedBuild,
  };
}

function findDesktopExecutable(appDir) {
  for (const name of ["ChatGPT.exe", "Codex.exe"]) {
    const filePath = path.join(appDir, name);
    if (exists(filePath)) {
      return { name, filePath };
    }
  }
  throw new Error(`Could not find ChatGPT.exe or Codex.exe in ${appDir}.`);
}

function findAppServerCli(appDir) {
  const filePath = path.join(appDir, "resources", "codex.exe");
  if (!exists(filePath)) {
    throw new Error(`Could not find the Codex app-server CLI at ${filePath}.`);
  }
  return filePath;
}

function findInstalledCodexAppDir() {
  if (process.platform !== "win32") {
    throw new Error("Automatic Codex app discovery currently supports Windows only.");
  }

  const windowsApps = path.join(process.env.ProgramFiles || "C:\\Program Files", "WindowsApps");
  const registeredInstallLocation = powershellOutput(
    "Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty InstallLocation"
  );
  if (registeredInstallLocation) {
    const packageDirName = path.basename(registeredInstallLocation);
    const match = /^OpenAI\.Codex_([^_]+)_x64__2p2nqsd0c76g0$/i.exec(packageDirName);
    const appDir = path.join(registeredInstallLocation, "app");
    const asarPath = path.join(appDir, "resources", "app.asar");
    if (match && exists(asarPath)) {
      return { version: match[1], packageDirName, appDir, asarPath };
    }
  }
  let entries = [];
  try {
    entries = fs.readdirSync(windowsApps, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }));
  } catch {
    const installLocation = powershellOutput(
      "Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty InstallLocation"
    );
    if (installLocation) {
      const packageDirName = path.basename(installLocation);
      const match = /^OpenAI\.Codex_([^_]+)_x64__2p2nqsd0c76g0$/i.exec(packageDirName);
      const appDir = path.join(installLocation, "app");
      const asarPath = path.join(appDir, "resources", "app.asar");
      if (match && exists(asarPath)) {
        return { version: match[1], packageDirName, appDir, asarPath };
      }
    }

    const names = powershellOutput(
      `Get-ChildItem -LiteralPath '${windowsApps.replace(/'/g, "''")}' -Directory -Filter 'OpenAI.Codex_*_x64__2p2nqsd0c76g0' | Select-Object -ExpandProperty Name`
    );
    entries = names
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => ({ name, isDirectory: true }));
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory) {
      continue;
    }
    const match = /^OpenAI\.Codex_([^_]+)_x64__2p2nqsd0c76g0$/i.exec(entry.name);
    if (!match) {
      continue;
    }
    const appDir = path.join(windowsApps, entry.name, "app");
    const asarPath = path.join(appDir, "resources", "app.asar");
    if (exists(asarPath)) {
      candidates.push({ version: match[1], packageDirName: entry.name, appDir, asarPath });
    }
  }

  candidates.sort((a, b) => compareVersion(b.version, a.version));
  if (!candidates.length) {
    throw new Error(`Could not find installed Codex package under ${windowsApps}.`);
  }
  return candidates[0];
}

function powershellOutput(command) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    return "";
  }
  return String(result.stdout || "").trim();
}

function sourceFromAppDir(appDir, asarPath = null, label = "manual") {
  const resolvedAppDir = path.resolve(appDir);
  const resolvedAsarPath = path.resolve(asarPath || path.join(resolvedAppDir, "resources", "app.asar"));
  const versionMatch =
    resolvedAppDir.match(/OpenAI\.Codex_([^\\/_]+)_x64__2p2nqsd0c76g0[\\/]app$/i) ||
    resolvedAppDir.match(/Codex-([^\\/]+)-limit-\d+[\\/]app$/i);
  const version = versionMatch?.[1] || label;
  const packageDirName = path.basename(path.dirname(resolvedAppDir));
  return {
    version,
    packageDirName,
    appDir: resolvedAppDir,
    asarPath: resolvedAsarPath,
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || rootDir,
    encoding: "utf8",
    stdio: options.stdio || "pipe",
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} failed with exit code ${result.status}`,
        result.stdout ? `stdout:\n${result.stdout}` : "",
        result.stderr ? `stderr:\n${result.stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
  return result;
}

function runRobocopy(source, target) {
  ensureDir(target);
  const args = [
    source,
    target,
    "/MIR",
    "/R:2",
    "/W:1",
    "/NFL",
    "/NDL",
    "/NJH",
    "/NJS",
    "/NP",
    "/XF",
    "app.asar.before-*",
    "app.asar.failed-*",
  ];
  const result = spawnSync("robocopy.exe", args, { encoding: "utf8", stdio: "pipe", windowsHide: true });
  if (result.error) {
    throw result.error;
  }
  if (result.status >= 8) {
    throw new Error(
      [
        `robocopy failed with exit code ${result.status}`,
        result.stdout ? `stdout:\n${result.stdout}` : "",
        result.stderr ? `stderr:\n${result.stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
}

function runAsar(args) {
  const npx = process.platform === "win32" ? "npx.exe" : "npx";
  const attempts = [
    ["@electron/asar", args],
    ["asar", args],
  ];
  const errors = [];
  for (const [packageName, packageArgs] of attempts) {
    const result = spawnSync(npx, ["--yes", packageName, ...packageArgs], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: "pipe",
      windowsHide: true,
    });
    if (!result.error && result.status === 0) {
      return;
    }
    errors.push(
      [
        `${npx} --yes ${packageName} ${packageArgs.join(" ")} failed`,
        result.error ? String(result.error) : `exit ${result.status}`,
        result.stdout ? `stdout:\n${result.stdout}` : "",
        result.stderr ? `stderr:\n${result.stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
  throw new Error(errors.join("\n\n"));
}

function assertJsModuleSyntax(filePath, label) {
  const checkPath = `${filePath}.syntax-check.mjs`;
  fs.copyFileSync(filePath, checkPath);
  try {
    const result = spawnSync(process.execPath, ["--check", checkPath], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: "pipe",
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        [
          `Syntax check failed for ${label}: ${filePath}`,
          result.error ? `error: ${result.error.message}` : "",
          result.stdout ? `stdout:\n${result.stdout}` : "",
          result.stderr ? `stderr:\n${result.stderr}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
  } finally {
    fs.rmSync(checkPath, { force: true });
  }
}

function runFuses(args) {
  const npx = process.platform === "win32" ? "npx.exe" : "npx";
  const result = spawnSync(npx, ["--yes", "@electron/fuses", ...args], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      [
        `${npx} --yes @electron/fuses ${args.join(" ")} failed with exit code ${result.status}`,
        result.stdout ? `stdout:\n${result.stdout}` : "",
        result.stderr ? `stderr:\n${result.stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

function findSingleAsset(extractDir, pattern, label) {
  const assetDir = path.join(extractDir, "webview", "assets");
  const entries = fs.readdirSync(assetDir, { withFileTypes: true });
  const matches = entries
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => path.join(assetDir, entry.name));
  if (matches.length !== 1) {
    throw new Error(`Expected one ${label} asset, found ${matches.length}.`);
  }
  return matches[0];
}

function findSingleAssetByContent(extractDir, predicates, label) {
  const assetDir = path.join(extractDir, "webview", "assets");
  const entries = fs.readdirSync(assetDir, { withFileTypes: true });
  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) {
      continue;
    }
    const assetPath = path.join(assetDir, entry.name);
    const text = fs.readFileSync(assetPath, "utf8");
    if (predicates.every((predicate) => predicate(text, entry.name))) {
      matches.push(assetPath);
    }
  }
  if (matches.length !== 1) {
    const names = matches.map((match) => path.basename(match)).join(", ");
    throw new Error(`Expected one ${label} asset by content, found ${matches.length}${names ? `: ${names}` : ""}.`);
  }
  return matches[0];
}

function findAppServerManagerAsset(extractDir) {
  try {
    return findSingleAsset(extractDir, /^app-server-manager-signals-.+\.js$/i, "app-server-manager-signals");
  } catch (error) {
    if (!String(error?.message || "").includes("Expected one app-server-manager-signals asset")) {
      throw error;
    }
  }
  return findSingleAssetByContent(
    extractDir,
    [
      (text) => text.includes("async runRecentConversationRefresh("),
      (text) => text.includes("async listRecentThreads("),
      (text) => text.includes("sendRequest(`thread/list`"),
    ],
    "recent conversation manager"
  );
}

function findAgentSettingsAsset(extractDir) {
  return findSingleAsset(extractDir, /^agent-settings-.+\.js$/i, "agent-settings");
}

function findSettingsSectionsAsset(extractDir) {
  return findSingleAsset(extractDir, /^settings-sections-.+\.js$/i, "settings-sections");
}

function findSettingsSharedAsset(extractDir) {
  return findSingleAsset(extractDir, /^settings-shared-.+\.js$/i, "settings-shared");
}

function findSettingsPageAsset(extractDir) {
  return findSingleAsset(extractDir, /^settings-page-.+\.js$/i, "settings-page");
}

function findProfileDropdownAsset(extractDir) {
  return findSingleAsset(extractDir, /^profile-dropdown-.+\.js$/i, "profile-dropdown");
}

function findAppMainAsset(extractDir) {
  return findSingleAsset(extractDir, /^app-main-.+\.js$/i, "app-main");
}

function findSettingsRouteRegistryAsset(extractDir) {
  const appMainPath = findAppMainAsset(extractDir);
  const appMainText = fs.readFileSync(appMainPath, "utf8");
  if (appMainText.includes('import.meta.url)),"git-settings":')) {
    return appMainPath;
  }

  return findSingleAssetByContent(
    extractDir,
    [
      (text) => text.includes('"git-settings":') && text.includes("GitSettings:e}=await import"),
      (text) => text.includes('"data-controls":') && text.includes("DataControlsSettings"),
      (text) => text.includes("import.meta.url))"),
    ],
    "settings route registry"
  );
}

function findComposerAsset(extractDir) {
  const assetDir = path.join(extractDir, "webview", "assets");
  const entries = fs.readdirSync(assetDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && /^composer-.+\.js$/i.test(entry.name))
    .map((entry) => path.join(assetDir, entry.name));
  const matches = candidates.filter((assetPath) => {
    const text = fs.readFileSync(assetPath, "utf8");
    return (
      (text.includes("function cm(e)") &&
        text.includes("let{data:m}=Et(lr,p)") &&
        text.includes("models:U")) ||
      (text.includes("function FE({conversationId:e,hideLabel:t})") &&
        text.includes("supportedReasoningEfforts") &&
        text.includes("defaultReasoningEffort") &&
        text.includes("onSelectModel:(t,r)=>")) ||
      (text.includes("composer.modelChangeDuringConversationWarning.toast") &&
        text.includes("data-codex-intelligence-trigger") &&
        text.includes("supportedReasoningEfforts") &&
        text.includes("onSelectModel:(e,t)=>"))
    );
  });
  if (matches.length !== 1) {
    throw new Error(
      `Expected one chat composer asset, found ${matches.length} of ${candidates.length} composer assets.`
    );
  }
  return matches[0];
}

function findLocalConversationThreadAsset(extractDir) {
  return findSingleAsset(extractDir, /^local-conversation-thread-.+\.js$/i, "local-conversation-thread");
}

function findHomeAmbientSuggestionsContentAsset(extractDir) {
  return findSingleAsset(
    extractDir,
    /^home-ambient-suggestions-content-.+\.js$/i,
    "home-ambient-suggestions-content"
  );
}

function findMainProcessScript(extractDir) {
  const buildDir = path.join(extractDir, ".vite", "build");
  const entries = fs.readdirSync(buildDir, { withFileTypes: true });
  const matches = entries
    .filter((entry) => entry.isFile() && /^main-.+\.js$/i.test(entry.name))
    .map((entry) => path.join(buildDir, entry.name));
  if (matches.length !== 1) {
    throw new Error(`Expected one desktop main process script, found ${matches.length}.`);
  }
  return matches[0];
}

function replaceExactly(text, from, to, label) {
  const count = text.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`Expected one ${label} patch target, found ${count}.`);
  }
  return { text: text.replace(from, to), count };
}

function replaceRegexExactly(text, pattern, to, label) {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`Expected one ${label} patch target, found ${matches.length}.`);
  }
  return { text: text.replace(pattern, to), count: matches.length };
}

function patchReasoningSummaryRendering(extractDir) {
  const assetPath = findLocalConversationThreadAsset(extractDir);
  const before = fs.readFileSync(assetPath, "utf8");
  let next = before;
  const patches = [];

  const functionStart =
    "function R_(e){let t=(0,Z.c)(53),{item:n,conversationId:r,cwd:i,hideCodeBlocks:a}=e,o=!n.completed,s=W_(o),{body:c}=V_(n.content),l;";
  const functionReplacement =
    "function cpReasoningContent(e){let t=e?.content,n=Array.isArray(t)?t.map(e=>typeof e===`string`?e:e&&typeof e.text===`string`?e.text:``).filter(e=>e.trim().length>0):typeof t===`string`&&t.trim().length>0?[t]:[],r=e?.summary,i=Array.isArray(r)?r.map(e=>typeof e===`string`?e:e&&typeof e.text===`string`?e.text:``).filter(e=>e.trim().length>0):[];return(n.length>0?n:i).join(`\\n\\n`)}function R_(e){let t=(0,Z.c)(53),{item:n,conversationId:r,cwd:i,hideCodeBlocks:a}=e,cpContent=cpReasoningContent(n),o=!n.completed,s=W_(o),{body:c}=V_(cpContent),l;";
  let skipped = false;
  try {
    let patched = replaceExactly(next, functionStart, functionReplacement, "reasoning content normalizer");
    next = patched.text;
    patches.push({ label: "reasoning content normalizer", count: patched.count });

    patched = replaceExactly(
      next,
      "t[3]===n.content?m=t[4]:(m=U_(n.content).trimStart(),t[3]=n.content,t[4]=m)",
      "t[3]===cpContent?m=t[4]:(m=U_(cpContent).trimStart(),t[3]=cpContent,t[4]=m)",
      "reasoning content cache key"
    );
    next = patched.text;
    patches.push({ label: "reasoning content cache key", count: patched.count });
  } catch (error) {
    if (!String(error?.message || "").includes("reasoning content")) {
      throw error;
    }
    skipped = true;
    patches.push({ label: "reasoning renderer current-base skip", count: 0, skipped: true });
  }

  fs.writeFileSync(assetPath, next, "utf8");
  assertJsModuleSyntax(assetPath, "local conversation reasoning renderer asset");
  return {
    assetRelativePath: path.relative(extractDir, assetPath).replace(/\\/g, "/"),
    patches,
    skipped,
    containsReasoningSummaryRenderingPatch:
      next.includes("function cpReasoningContent") &&
      next.includes("cpContent=cpReasoningContent(n)") &&
      next.includes("Array.isArray(t)") &&
      next.includes("V_(cpContent)") &&
      next.includes("U_(cpContent)"),
  };
}

function patchAmbientSuggestionRoleFallback(extractDir) {
  const assetPath = findHomeAmbientSuggestionsContentAsset(extractDir);
  const before = fs.readFileSync(assetPath, "utf8");
  const from = "return rt[a].flatMap(t=>{";
  const to =
    "return (rt[a]??rt.something_else??[]).flatMap(t=>{";
  let patched;
  let next = before;
  let skipped = false;
  try {
    patched = replaceExactly(before, from, to, "ambient suggestion role fallback");
    next = patched.text;
  } catch (error) {
    if (!String(error?.message || "").includes("Expected one ambient suggestion role fallback patch target")) {
      throw error;
    }
    skipped = true;
    patched = { count: 0 };
  }
  fs.writeFileSync(assetPath, next, "utf8");
  assertJsModuleSyntax(assetPath, "home ambient suggestions content asset");
  return {
    assetRelativePath: path.relative(extractDir, assetPath).replace(/\\/g, "/"),
    patches: [{ label: "ambient suggestion role fallback", count: patched.count, skipped }],
    skipped,
    containsAmbientSuggestionRoleFallback:
      next.includes("return (rt[a]??rt.something_else??[]).flatMap(t=>{") &&
      !next.includes("return rt[a].flatMap(t=>{"),
  };
}

function patchReasoningSummaryConversion(extractDir) {
  const assetPath = findAppServerManagerAsset(extractDir);
  const before = fs.readFileSync(assetPath, "utf8");
  const patched = replaceRegexExactly(
    before,
    /function ([A-Za-z_$][\w$]*)\(e\)\{let\[t,\.\.\.n\]=e\?\?\[\];return!t\|\|n\.length===0\?t\?\?``:t\.startsWith\(`\*\*`\)\?\[t,\.\.\.n\]\.join\(`\n\n`\):\[`\*\*\$\{t\}\*\*`,\.\.\.n\]\.join\(`\n\n`\)\}/g,
    "function $1(e){let r=(e??[]).map(e=>typeof e===`string`?e:e&&typeof e.text===`string`?e.text:``).filter(e=>e.trim().length>0),[t,...n]=r;return!t||n.length===0?t??``:t.startsWith(`**`)?[t,...n].join(`\n\n`):[`**${t}**`,...n].join(`\n\n`)}",
    "reasoning summary object conversion"
  );
  const next = patched.text;
  fs.writeFileSync(assetPath, next, "utf8");
  assertJsModuleSyntax(assetPath, "app-server reasoning summary conversion asset");
  return {
    assetRelativePath: path.relative(extractDir, assetPath).replace(/\\/g, "/"),
    patches: [{ label: "reasoning summary object conversion", count: patched.count }],
    containsReasoningSummaryConversionPatch:
      next.includes("let r=(e??[]).map") &&
      next.includes("typeof e.text===`string`") &&
      next.includes("[t,...n]=r"),
  };
}

function patchAsset(assetPath, limit) {
  const before = fs.readFileSync(assetPath, "utf8");
  let next = before;
  const patches = [];

  const currentLoaderBefore =
    "let r=this.params.getHistoryLimit?.()??50,i=(t===`expanded`||n)&&r>50,a=i?r:50";
  const currentLoaderAfter =
    `let r=Math.max(this.params.getHistoryLimit?.()??50,${limit}),i=r>50,a=i?r:50`;
  const currentLoaderPatch = replaceExactly(next, currentLoaderBefore, currentLoaderAfter, "current history limit");
  next = currentLoaderPatch.text;
  patches.push({ label: "current history limit", count: currentLoaderPatch.count });
  const currentLoaderPatched = true;

  const historyDiagnosticBefore =
    "i&&this.params.onHistoryLoaded?.({hasMoreThreads:s.nextCursor!=null,loadDurationMs:Math.round(performance.now()-o),loadedThreadCount:s.data.length,requestedThreadLimit:a})";
  const historyDiagnosticAfter =
    "globalThis.__codexPatchStudioHistoryHydration=Object.freeze({hasMoreThreads:s.nextCursor!=null,loadDurationMs:Math.round(performance.now()-o),loadedThreadCount:s.data.length,requestedThreadLimit:a,capturedAt:new Date().toISOString()}),i&&this.params.onHistoryLoaded?.({hasMoreThreads:s.nextCursor!=null,loadDurationMs:Math.round(performance.now()-o),loadedThreadCount:s.data.length,requestedThreadLimit:a})";
  if (currentLoaderPatched && next.includes(historyDiagnosticBefore)) {
    const patched = replaceExactly(
      next,
      historyDiagnosticBefore,
      historyDiagnosticAfter,
      "current history runtime diagnostic"
    );
    next = patched.text;
    patches.push({ label: "current history runtime diagnostic", count: patched.count });
  }

  const recentProviderFilterAnchor = "modelProviders:null,archived:!1,sourceKinds:";
  if (next.includes(recentProviderFilterAnchor)) {
    const patched = replaceExactly(
      next,
      recentProviderFilterAnchor,
      "modelProviders:[],archived:!1,sourceKinds:",
      "recent list all-provider filter"
    );
    next = patched.text;
    patches.push({ label: "recent list all-provider filter", count: patched.count });
  }

  const projectListProviderFilterAnchor = "recentConversationsSortKey:this.recentConversationSortKey},{modelProviders:e,archived:t})";
  if (next.includes(projectListProviderFilterAnchor)) {
    const patched = replaceExactly(
      next,
      projectListProviderFilterAnchor,
      "recentConversationsSortKey:this.recentConversationSortKey},{modelProviders:e??[],archived:t})",
      "project list all-provider filter"
    );
    next = patched.text;
    patches.push({ label: "project list all-provider filter", count: patched.count });
  }

  const bridgeListProviderFilterAnchor = "limit:null,modelProviders:e,sortKey:`updated_at`";
  if (next.includes(bridgeListProviderFilterAnchor)) {
    const patched = replaceExactly(
      next,
      bridgeListProviderFilterAnchor,
      "limit:null,modelProviders:e??[],sortKey:`updated_at`",
      "bridge list all-provider filter"
    );
    next = patched.text;
    patches.push({ label: "bridge list all-provider filter", count: patched.count });
  }

  fs.writeFileSync(assetPath, next, "utf8");
  return {
    assetRelativePath: path.relative(path.dirname(path.dirname(path.dirname(assetPath))), assetPath).replace(/\\/g, "/"),
    patches,
    containsRefreshPatch: false,
    containsLoadMorePatch: false,
    containsCurrentHistoryLimitPatch:
      currentLoaderPatched &&
      next.includes(`Math.max(this.params.getHistoryLimit?.()??50,${limit})`) &&
      next.includes("useStateDbOnly:i") &&
      next.includes("__codexPatchStudioHistoryHydration"),
    containsChatLimitPatch:
      currentLoaderPatched &&
      next.includes(`Math.max(this.params.getHistoryLimit?.()??50,${limit})`) &&
      next.includes("useStateDbOnly:i"),
  };
}

function patchComposerProviderModels(extractDir) {
  const assetPath = findComposerAsset(extractDir);
  const before = fs.readFileSync(assetPath, "utf8");
  let next = before;
  const patches = [];

  const oldHelperMarker = "function cm(e){";
  const currentHelperMarker = "function FE({conversationId:e,hideLabel:t}){";
  const latestHelperMarker = "function WO({conversationId:e,hideLabel:t}){";
  const helper = [
    "function cpsProviderCatalog(e,t){",
    "let n=t?.config??t??{},r=String(n.model_provider??``).trim(),a={openai:[`gpt-5.5`,`gpt-5.4`,`gpt-5.4-mini`,`gpt-5.3-codex-spark`],deepseek:[`deepseek-v4-flash`,`deepseek-v4-pro`,`deepseek-chat`,`deepseek-reasoner`],zai:[`glm-5.2`,`glm-5.1`,`glm-5`,`glm-4.7`,`glm-4.6`,`glm-4.5`],dashscope:[`qwen3.7-plus`,`qwen3.7-plus-2026-05-26`,`qwen3.7-max`,`qwen3.7-max-2026-06-08`,`qwen3.6-plus`,`qwen3.6-plus-2026-04-02`,`qwen3.6-max-preview`,`qwen3.6-flash`,`qwen3.6-27b`,`qwen3.5-plus`,`qwen3.5-plus-2026-04-20`,`qwen3.5-flash`,`qwen3.5-27b`,`qwen3-max`,`qwen3-max-2026-01-23`,`qwen-plus`,`qwen-plus-2025-12-01`,`qwen-plus-us`,`qwen-plus-2025-12-01-us`,`qwen-plus-character`,`qwen-flash`,`qwen-flash-2025-07-28`,`qwen-flash-us`,`qwen-flash-2025-07-28-us`,`qwen3-coder-next`,`qwen3-coder-plus`,`qwen3-coder-plus-2025-09-23`,`qwen3-coder-flash`,`qwen3-coder-flash-2025-07-28`],cerebras:[`gemma-4-31b`,`gpt-oss-120b`,`zai-glm-4.7`],ollama:[`qwen3:4b`,`gpt-oss:20b`,`qwen3-coder:latest`,`devstral:latest`,`llama3.3:latest`],lmstudio:[`openai/gpt-oss-20b`,`qwen/qwen3-coder`,`devstral-small-2507`]},i={openai:`OpenAI`,deepseek:`DeepSeek`,zai:`Z.ai`,dashscope:`Alibaba Qwen`,cerebras:`Cerebras`,ollama:`Ollama`,lmstudio:`LM Studio`};",
    "let m=r===`oss`?String(n.oss_provider??``).trim():r,j=String(n.model??``).toLowerCase(),o=JSON.stringify(n).toLowerCase(),s={},h={},c=new Map,u=t=>({description:``,reasoningEffort:t}),d=(e,t)=>{if(!e||!e.model)return;let n=String(e.model);c.has(n)||c.set(n,e)},f=(e,t)=>{let r=String(e).toLowerCase(),a=t===`openai`?[`minimal`,`low`,`medium`,`high`,`xhigh`]:t===`deepseek`?r.includes(`chat`)&&!r.includes(`reason`)&&!r.includes(`v4`)?[`none`]:[`none`,`low`,`medium`,`high`,`xhigh`]:t===`zai`?r===`glm-5.2`?[`none`,`low`,`medium`,`high`,`xhigh`]:[`none`,`medium`]:t===`dashscope`?[`none`,`medium`]:t===`cerebras`?r===`gpt-oss-120b`?[`low`,`medium`,`high`]:r===`zai-glm-4.7`?[`none`,`low`,`medium`,`high`]:[`none`]:r.includes(`chat`)&&!r.includes(`reason`)&&!r.includes(`r1`)?[`none`]:[`none`,`low`,`medium`,`high`],o=a.includes(n.model_reasoning_effort)?n.model_reasoning_effort:t===`openai`||r===`glm-5.2`?`xhigh`:a.includes(`medium`)?`medium`:a[0];return{model:e,displayName:e,description:`${i[t]??t} model`,defaultReasoningEffort:o,supportedReasoningEfforts:a.map(u),providerId:t}};",
    "try{let p=JSON.parse(localStorage.getItem(`codex-native-patcher-settings:v1`)||`{}`)?.runtimeFeatures??{};if(p.modelPickerEnhancer===!1)return Array.isArray(e)?e:[]}catch(e){}",
    "try{s=JSON.parse(localStorage.getItem(`codex-native-provider-settings:v1`)||`{}`)?.providers??{}}catch(e){}",
    "try{h=JSON.parse(localStorage.getItem(`codex-native-auto-router-settings:v1`)||`{}`)}catch(e){}",
    "if(Array.isArray(e))for(let t of e)d(t);if(h?.enabled!==false)d({model:`auto`,displayName:`Auto`,description:`Auto model router`,defaultReasoningEffort:`medium`,supportedReasoningEfforts:[`none`,`low`,`medium`,`high`,`xhigh`].map(u),providerId:`auto`});for(let e of a.openai)d(f(e,`openai`));",
    "let p=new Set;if(m&&m!==`openai`)p.add(m);if(!a[m]){if(j.includes(`deepseek`)||o.includes(`deepseek`))p.add(`deepseek`);if(j.startsWith(`glm`)||o.includes(`z.ai`)||o.includes(`bigmodel`))p.add(`zai`);if(j.startsWith(`qwen`)||j.startsWith(`qwq`)||o.includes(`dashscope`)||o.includes(`aliyuncs`)||o.includes(`alibaba`))p.add(`dashscope`);if(j.includes(`cerebras`)||j===`gemma-4-31b`||j===`gpt-oss-120b`||j.startsWith(`zai-glm-`)||o.includes(`cerebras.ai`))p.add(`cerebras`);if(o.includes(`11434`)||j.includes(`:`))p.add(`ollama`);if(o.includes(`lm studio`)||o.includes(`lmstudio`)||o.includes(`1234`))p.add(`lmstudio`)}if(n.model_providers&&typeof n.model_providers===`object`)for(let e of Object.keys(n.model_providers))p.add(e);for(let[e,t]of Object.entries(s))Array.isArray(t?.visibleModels)&&t.visibleModels.length>0&&p.add(e);",
    "for(let e of p){if(e===`oss`)e=String(n.oss_provider??``).trim();if(!a[e]||e===`openai`)continue;let r=s?.[e]?.visibleModels,t=[m===e?n.model:null,...a[e],...(Array.isArray(r)?r:[])].filter(Boolean);if(Array.isArray(r))t=t.filter(e=>new Set(r.map(e=>String(e))).has(String(e)));for(let n of Array.from(new Set(t)))d(f(n,e))}",
    "return Array.from(c.values())",
    "}",
    "function cpsSelectedModel(e){try{let t=JSON.parse(localStorage.getItem(`codex-native-auto-router-settings:v1`)||`{}`);if(t?.enabled!==false&&t?.selected)return`auto`}catch(t){}return e}",
  ].join("");
  if (next.includes(oldHelperMarker)) {
    let patched = replaceExactly(next, oldHelperMarker, `${helper}${oldHelperMarker}`, "composer provider catalog helper");
    next = patched.text;
    patches.push({ label: "composer provider catalog helper", count: patched.count });

    patched = replaceExactly(
      next,
      "let k=O,A=o?.authMethod===`copilot`,j=im(l?.models,d.model),M=am(d.reasoningEffort,j),N=rm(M),P,F,I,L;",
      "let k=O,A=o?.authMethod===`copilot`,cpsModels=cpsProviderCatalog(l?.models,m),j=im(cpsModels,cpsSelectedModel(d.model)),M=am(d.reasoningEffort,j),N=rm(M),P,F,I,L;",
      "composer model catalog source"
    );
    next = patched.text;
    patches.push({ label: "composer model catalog source", count: patched.count });

    const replacements = [
      [
        "if(t[11]!==l?.models||t[12]!==d.model||t[13]!==h.availableOptions||t[14]!==h.effectiveServiceTier)",
        "if(t[11]!==cpsModels||t[12]!==d.model||t[13]!==h.availableOptions||t[14]!==h.effectiveServiceTier)",
        "composer model catalog memo guard",
      ],
      ["let e=ur(l?.models,d.model);", "let e=ur(cpsModels,cpsSelectedModel(d.model));", "composer selected model lookup"],
      ["t[11]=l?.models,t[12]=d.model", "t[11]=cpsModels,t[12]=d.model", "composer selected model cache"],
      [
        "let de=u===`error`||l?.models==null,U=l?.models,fe;",
        "let de=u===`error`||cpsModels==null,U=cpsModels,fe;",
        "composer flyout model list",
      ],
    ];
    for (const [from, to, label] of replacements) {
      patched = replaceExactly(next, from, to, label);
      next = patched.text;
      patches.push({ label, count: patched.count });
    }

    patched = replaceExactly(
      next,
      "s(f,h.find(e=>{let{reasoningEffort:t}=e;return t===i.reasoningEffort})?.reasoningEffort??g),l()",
      "((e)=>{let t=globalThis.__codexNativeProviderSettings?.selectModelFromNativeMenu?.({model:f,providerId:r?.providerId,reasoningEffort:e});t&&typeof t.then===`function`?t.then(()=>{s(f,e),l()}).catch(()=>{l()}):(s(f,e),l())})(h.find(e=>{let{reasoningEffort:t}=e;return t===i.reasoningEffort})?.reasoningEffort??g)",
      "composer provider switch on model select"
    );
    next = patched.text;
    patches.push({ label: "composer provider switch on model select", count: patched.count });
  } else if (next.includes(currentHelperMarker)) {
    let patched = replaceExactly(next, currentHelperMarker, `${helper}${currentHelperMarker}`, "composer provider catalog helper");
    next = patched.text;
    patches.push({ label: "composer provider catalog helper", count: patched.count });

    patched = replaceExactly(
      next,
      "{data:o,status:s}=Pa({hostId:r.hostId}),c=o?.models,{modelSettings:u,setModelAndReasoningEffort:d}=ja(e),f=u.model;",
      "{data:o,status:s}=Pa({hostId:r.hostId}),{modelSettings:u,setModelAndReasoningEffort:d}=ja(e),c=cpsProviderCatalog(o?.models,u),f=cpsSelectedModel(u.model);",
      "current composer provider model catalog source"
    );
    next = patched.text;
    patches.push({ label: "current composer provider model catalog source", count: patched.count });

    const currentSelectTail = "}),{id:`composer.modelChangeDuringConversationWarning.${e}`}),d(t,r)}";
    const currentSelectReplacement =
      "}),{id:`composer.modelChangeDuringConversationWarning.${e}`});let i=Aa(c,t)?.providerId,a=globalThis.__codexNativeProviderSettings?.selectModelFromNativeMenu?.({model:t,providerId:i,reasoningEffort:r});a&&typeof a.then===`function`?a.then(()=>d(t,r)).catch(()=>d(t,r)):d(t,r)}";
    patched = replaceExactly(next, currentSelectTail, currentSelectReplacement, "current composer provider switch tail");
    next = patched.text;
    patches.push({ label: "current composer provider switch on model select", count: patched.count });
  } else if (next.includes(latestHelperMarker)) {
    let patched = replaceExactly(next, latestHelperMarker, `${helper}${latestHelperMarker}`, "latest composer provider catalog helper");
    next = patched.text;
    patches.push({ label: "latest composer provider catalog helper", count: patched.count });

    const latestCatalogEdits = [
      [",m=d?.models,{modelSettings:h", ",{modelSettings:h", "latest composer native model list removal"],
      ["=vo(e),y=h.model;_(Wi,e);", "=vo(e);_(Wi,e);", "latest composer selected model relocation"],
      [
        "let{data:b}=_(to,{cwd:a.cwd,hostId:a.hostId}),{serviceTierSettings:x",
        "let{data:b}=_(to,{cwd:a.cwd,hostId:a.hostId}),m=cpsProviderCatalog(d?.models,b),y=cpsSelectedModel(h.model),{serviceTierSettings:x",
        "latest composer provider model catalog source",
      ],
    ];
    for (const [from, to, label] of latestCatalogEdits) {
      patched = replaceExactly(next, from, to, label);
      next = patched.text;
      patches.push({ label, count: patched.count });
    }

    const latestSelectEdits = [
      ["function Ce(t,r){return t===y?", "function Ce(t,r){t===y?", "latest composer model selection statement"],
      ["):Fa(n,di,{model:t}),T&&t!==y", "):Fa(n,di,{model:t});T&&t!==y", "latest composer warning statement"],
      [
        "}),{id:`composer.modelChangeDuringConversationWarning.${e}`}),g(t,r)}",
        "}),{id:`composer.modelChangeDuringConversationWarning.${e}`});let i=_o(m,t)?.providerId,a=globalThis.__codexNativeProviderSettings?.selectModelFromNativeMenu?.({model:t,providerId:i,reasoningEffort:r});return a&&typeof a.then===`function`?a.then(()=>g(t,r)).catch(()=>g(t,r)):g(t,r)}",
        "latest composer provider switch tail",
      ],
    ];
    for (const [from, to, label] of latestSelectEdits) {
      patched = replaceExactly(next, from, to, label);
      next = patched.text;
      patches.push({ label, count: patched.count });
    }
  } else {
    throw new Error(`Unsupported chat composer shape: ${path.basename(assetPath)}`);
  }

  fs.writeFileSync(assetPath, next, "utf8");
  return {
    assetRelativePath: path.relative(extractDir, assetPath).replace(/\\/g, "/"),
    patches,
    containsProviderCatalogPatch:
      next.includes("function cpsProviderCatalog") &&
      next.includes("deepseek-v4-flash") &&
      next.includes("gemma-4-31b") &&
      next.includes("gpt-oss-120b") &&
      next.includes("gpt-5.3-codex-spark") &&
      next.includes("codex-native-auto-router-settings:v1") &&
      next.includes("cpsSelectedModel") &&
      next.includes("selectModelFromNativeMenu") &&
      (next.includes("providerId:r?.providerId") || next.includes("providerId:i")) &&
      (next.includes("cpsProviderCatalog(l?.models,m)") ||
        next.includes("cpsProviderCatalog(o?.models,u)") ||
        next.includes("cpsProviderCatalog(d?.models,b)")) &&
      (next.includes("models:U") || next.includes("models:c") || next.includes("models:m")),
  };
}

function findPreloadScript(extractDir) {
  const preloadPath = path.join(extractDir, ".vite", "build", "preload.js");
  if (!exists(preloadPath)) {
    throw new Error(`Expected current Codex preload script at ${preloadPath}.`);
  }
  return preloadPath;
}

function patchPreloadOutboundInterceptor(extractDir) {
  const preloadPath = findPreloadScript(extractDir);
  let text = fs.readFileSync(preloadPath, "utf8");
  const marker = "registerSendMessageInterceptor";
  if (text.includes(marker)) {
    return {
      preloadRelativePath: path.relative(extractDir, preloadPath).replace(/\\/g, "/"),
      alreadyPatched: true,
      patches: [],
    };
  }

  const mapAnchor = /var ([A-Za-z_$][\w$]*)=new Map,([A-Za-z_$][\w$]*)=new Map,([A-Za-z_$][\w$]*)=\{/;
  const mapMatch = text.match(mapAnchor);
  if (!mapMatch) {
    throw new Error("Expected current Codex preload bridge map anchor, found 0.");
  }
  const [, subscriptionsName, listenersName, bridgeName] = mapMatch;
  const interceptorName = "codexPatchStudioSendMessageInterceptors";
  text = text.replace(
    mapMatch[0],
    `var ${subscriptionsName}=new Map,${listenersName}=new Map,${interceptorName}=new Set,${bridgeName}={`
  );

  const bridgeStart = `${bridgeName}={windowType:`;
  if (!text.includes(bridgeStart)) {
    throw new Error("Expected current Codex preload bridge object anchor, found 0.");
  }
  text = text.replace(
    bridgeStart,
    `${bridgeName}={registerSendMessageInterceptor:e=>(${interceptorName}.add(e),()=>{${interceptorName}.delete(e)}),windowType:`
  );

  const sendAnchor = "sendMessageFromView:async t=>{t.type===`shared-object-set`";
  if (!text.includes(sendAnchor)) {
    throw new Error("Expected current Codex preload sendMessageFromView anchor, found 0.");
  }
  text = text.replace(
    sendAnchor,
    `sendMessageFromView:async t=>{for(let n of ${interceptorName})t=await n(t)??t;t.type===\`shared-object-set\``
  );
  fs.writeFileSync(preloadPath, text, "utf8");
  assertJsModuleSyntax(preloadPath, "current Codex preload outbound interceptor");
  return {
    preloadRelativePath: path.relative(extractDir, preloadPath).replace(/\\/g, "/"),
    alreadyPatched: false,
    patches: [
      { label: "preload outbound interceptor registry", count: 1 },
      { label: "preload outbound interceptor bridge API", count: 1 },
      { label: "preload outbound interceptor dispatch", count: 1 },
    ],
  };
}

function patchMainProcess(extractDir, options = {}) {
  const mainPath = findMainProcessScript(extractDir);
  const before = fs.readFileSync(mainPath, "utf8");
  let next = before;
  let patched;
  const patches = [];

  if (options.enableRemoteControl) {
    patched = replaceExactly(
      next,
      "Removed remote_control from config before app-server start",
      "Enabled remote_control in config before app-server start",
      "remote_control before-connect success log"
    );
    next = patched.text;
    patches.push({ label: "remote_control before-connect success log", count: patched.count });

    patched = replaceExactly(
      next,
      "Failed to remove remote_control before app-server start",
      "Failed to enable remote_control before app-server start",
      "remote_control before-connect failure log"
    );
    next = patched.text;
    patches.push({ label: "remote_control before-connect failure log", count: patched.count });

    patched = replaceRegexExactly(
      next,
      /function ([A-Za-z_$][\w$]*)\(e\)\{let t=\{\.\.\.e\};if\(Object\.hasOwn\(t,`remote_control`\)&&delete t\.remote_control,!([A-Za-z_$][\w$]*)\(t\.features\)\)return t;let n=\{\.\.\.t\.features\};return Object\.hasOwn\(n,`remote_control`\)&&delete n\.remote_control,Object\.keys\(n\)\.length===0\?\(delete t\.features,t\):\(t\.features=n,t\)\}function ([A-Za-z_$][\w$]*)\(e\)\{return Object\.hasOwn\(e,`remote_control`\)\|\|\2\(e\.features\)&&Object\.hasOwn\(e\.features,`remote_control`\)\}/g,
      "function $1(e){let t={...e},n=$2(t.features)?{...t.features}:{};return Object.hasOwn(t,`remote_control`)&&delete t.remote_control,n.remote_control=!0,t.features=n,t}function $3(e){return!0}",
      "remote_control config remover-to-enabler"
    );
    next = patched.text;
    patches.push({ label: "remote_control config remover-to-enabler", count: patched.count });
  }

  if (options.forceMainWindowStartup) {
    const forceMarker = "/*codex-patch-studio:force-main-window*/";
    const currentAnchor = "let Le=await R.ensureWindow();";
    const legacyAnchor = "E&&he();let _e=ws({listPlugins:e=>le().listPlugins(e)}),ye=xo({";
    if (next.includes(forceMarker)) {
      throw new Error("The force main window startup patch was already present before its module ran.");
    }
    if (next.split(currentAnchor).length - 1 === 1) {
      patched = replaceExactly(
        next,
        currentAnchor,
        `${currentAnchor}${forceMarker}setTimeout(()=>{R.ensureWindow().then(e=>{e&&(e.isMinimized()&&e.restore(),e.show(),e.focus())}).catch(()=>{})},1000).unref?.();`,
        "current force main window startup"
      );
    } else {
      patched = replaceExactly(
        next,
        legacyAnchor,
        `E&&he();${forceMarker}setTimeout(()=>{pe()},1000).unref?.();let _e=ws({listPlugins:e=>le().listPlugins(e)}),ye=xo({`,
        "legacy force main window startup"
      );
    }
    next = patched.text;
    patches.push({ label: "force main window startup", count: patched.count });
  }

  if (options.enableAboutPatcher) {
    const currentHelpBefore = "{label:`Send Feedback`,click:le},{type:`separator`},ot,...Rt";
    const currentHelpAfter =
      "{label:`About Patcher`,click:()=>{c.dialog.showMessageBox({title:`About Patcher`,message:`Codex Patcher`,detail:`Created by Ryan Craighead\\n\\nUser-controlled native Codex patch layer for providers, imports, orchestration, chat hydration, and local build management.`,type:`info`,buttons:[`OK`],defaultId:0,cancelId:0,noLink:!0})}},{type:`separator`},{label:`Send Feedback`,click:le},{type:`separator`},ot,...Rt";
    const legacyHelpBefore =
      "{type:`separator`},{label:`Send Feedback`,click:M},je,...Qe,{type:`separator`},{...y(`showKeyboardShortcuts`),click:async()=>{await j(`showKeyboardShortcuts`)}}";
    const legacyHelpAfter =
      "{type:`separator`},{label:`About Patcher`,click:()=>{n.dialog.showMessageBox({title:`About Patcher`,message:`Codex Patcher`,detail:`Created by Ryan Craighead\\n\\nUser-controlled native Codex patch layer for providers, imports, orchestration, chat hydration, and local build management.`,type:`info`,buttons:[`OK`],defaultId:0,cancelId:0,noLink:!0})}},{type:`separator`},{label:`Send Feedback`,click:M},je,...Qe,{type:`separator`},{...y(`showKeyboardShortcuts`),click:async()=>{await j(`showKeyboardShortcuts`)}}";
    patched = next.split(currentHelpBefore).length - 1 === 1
      ? replaceExactly(next, currentHelpBefore, currentHelpAfter, "current Help menu About Patcher insertion")
      : replaceExactly(next, legacyHelpBefore, legacyHelpAfter, "legacy Help menu About Patcher insertion");
    next = patched.text;
    patches.push({ label: "Help menu About Patcher insertion", count: patched.count });
  }

  fs.writeFileSync(mainPath, next, "utf8");
  assertJsModuleSyntax(mainPath, "current Codex main process");
  return {
    mainRelativePath: path.relative(extractDir, mainPath).replace(/\\/g, "/"),
    patches,
    containsRemoteControlMainProcessPatch:
      options.enableRemoteControl &&
      next.includes("Enabled remote_control in config before app-server start") &&
      next.includes("n.remote_control=!0") &&
      /function [A-Za-z_$][\w$]*\(e\)\{return!0\}/.test(next) &&
      !next.includes("Removed remote_control from config before app-server start"),
    containsForceMainWindowStartupPatch: next.includes("/*codex-patch-studio:force-main-window*/"),
    containsAboutPatcherMenuPatch:
      options.enableAboutPatcher &&
      next.includes("label:`About Patcher`") &&
      next.includes("Created by Ryan Craighead") &&
      next.includes("Codex Patcher"),
  };
}

function patchRemoteControlSettingsVisibility(extractDir) {
  const assetPath = findAgentSettingsAsset(extractDir);
  const before = fs.readFileSync(assetPath, "utf8");
  const hiddenFilter = "&&e.name!==`remote_control`";
  const count = before.split(hiddenFilter).length - 1;
  if (count === 0) {
    return {
      assetRelativePath: path.relative(extractDir, assetPath).replace(/\\/g, "/"),
      removedRemoteControlHideFilter: false,
      skippedRemoteControlHideFilter: true,
      containsRemoteControlHideFilter: false,
    };
  }
  if (count !== 1) {
    throw new Error(`Expected one remote_control settings hide-filter, found ${count}.`);
  }
  const next = before.replace(hiddenFilter, "");
  fs.writeFileSync(assetPath, next, "utf8");
  return {
    assetRelativePath: path.relative(extractDir, assetPath).replace(/\\/g, "/"),
    removedRemoteControlHideFilter: true,
    containsRemoteControlHideFilter: next.includes(hiddenFilter),
  };
}

const NATIVE_SETTINGS_GROUP_ROUTES = Object.freeze({
  providers: Object.freeze(["providers", "auto-router", "prompt-tools", "personas", "swarm"]),
  orchestrations: Object.freeze(["orchestrations"]),
  imports: Object.freeze(["imports"]),
  patcher: Object.freeze(["patcher", "feature-development"]),
});

const NATIVE_SETTINGS_ROUTE_DEFINITIONS = Object.freeze({
  providers: Object.freeze({
    id: "providers",
    objectKey: "providers",
    label: "Providers",
    description: "Title for model provider settings section",
    moduleFile: "codex-native-providers-settings-page.js",
    exportName: "ProvidersSettings",
    resultKey: "providerRouteRelativePath",
  }),
  "auto-router": Object.freeze({
    id: "auto-router",
    objectKey: '"auto-router"',
    label: "Auto Router",
    description: "Title for auto model router settings section",
    moduleFile: "codex-native-auto-router-settings-page.js",
    exportName: "AutoRouterSettings",
    resultKey: "autoRouterRouteRelativePath",
  }),
  "prompt-tools": Object.freeze({
    id: "prompt-tools",
    objectKey: '"prompt-tools"',
    label: "Prompt Tools",
    description: "Title for prompt tools settings section",
    moduleFile: "codex-native-prompt-tools-settings-page.js",
    exportName: "PromptToolsSettings",
    resultKey: "promptToolsRouteRelativePath",
  }),
  personas: Object.freeze({
    id: "personas",
    objectKey: "personas",
    label: "Personas",
    description: "Title for persona settings section",
    moduleFile: "codex-native-personas-settings-page.js",
    exportName: "PersonasSettings",
    resultKey: "personasRouteRelativePath",
  }),
  swarm: Object.freeze({
    id: "swarm",
    objectKey: "swarm",
    label: "Swarm",
    description: "Title for swarm settings section",
    moduleFile: "codex-native-swarm-settings-page.js",
    exportName: "SwarmSettings",
    resultKey: "swarmRouteRelativePath",
  }),
  orchestrations: Object.freeze({
    id: "orchestrations",
    objectKey: "orchestrations",
    label: "Orchestrations",
    description: "Title for orchestration settings section",
    moduleFile: "codex-native-orchestrations-settings-page.js",
    exportName: "OrchestrationsSettings",
    resultKey: "orchestratorRouteRelativePath",
  }),
  imports: Object.freeze({
    id: "imports",
    objectKey: "imports",
    label: "Imports",
    description: "Title for chat import settings section",
    moduleFile: "codex-native-imports-settings-page.js",
    exportName: "ImportsSettings",
    resultKey: "importsRouteRelativePath",
  }),
  patcher: Object.freeze({
    id: "patcher",
    objectKey: "patcher",
    label: "Patcher",
    description: "Title for native patcher settings section",
    moduleFile: "codex-native-patcher-settings-page.js",
    exportName: "PatcherSettings",
    resultKey: "patcherRouteRelativePath",
  }),
  "feature-development": Object.freeze({
    id: "feature-development",
    objectKey: '"feature-development"',
    label: "Feature Development",
    description: "Title for source feature development settings section",
    sectionEntry: "{slug:`feature-development`}",
    labelEntry: '"feature-development":{id:`settings.nav.feature-development`,defaultMessage:`Feature Development`,description:`Title for source feature development settings section`}',
    moduleFile: "codex-native-feature-development-settings-page.js",
    exportName: "FeatureDevelopmentSettings",
    resultKey: "featureDevelopmentRouteRelativePath",
  }),
});

const ALL_NATIVE_SETTINGS_ROUTE_IDS = Object.freeze(
  Object.values(NATIVE_SETTINGS_GROUP_ROUTES).flat()
);

function createNativeSettingsPlan(enabledGroups = {}, options = {}) {
  if (!enabledGroups || typeof enabledGroups !== "object" || Array.isArray(enabledGroups)) {
    throw new Error("Native settings enabledGroups must be an object.");
  }
  const knownGroups = Object.keys(NATIVE_SETTINGS_GROUP_ROUTES);
  const unknownGroups = Object.keys(enabledGroups).filter((group) => !knownGroups.includes(group));
  if (unknownGroups.length) {
    throw new Error(`Unknown native settings groups: ${unknownGroups.join(", ")}.`);
  }
  const normalizedGroups = Object.fromEntries(knownGroups.map((group) => [group, enabledGroups[group] === true]));
  const routeIds = knownGroups.flatMap((group) => normalizedGroups[group] ? NATIVE_SETTINGS_GROUP_ROUTES[group] : []);
  if (!options.allowEmpty && routeIds.length === 0) {
    throw new Error("At least one native settings group must be enabled.");
  }
  if (new Set(routeIds).size !== routeIds.length) {
    throw new Error("Native settings groups produced duplicate route ids.");
  }
  const routes = routeIds.map((id) => NATIVE_SETTINGS_ROUTE_DEFINITIONS[id]);
  return {
    enabledGroups: normalizedGroups,
    routeIds,
    routes,
    quotedSlugs: routeIds.map((id) => `\`${id}\``).join(","),
    sectionEntries: routes.map((route) => route.sectionEntry || `{slug:\`${route.id}\`}`).join(","),
    labelEntries: routes
      .map((route) => route.labelEntry || `${route.objectKey}:{id:\`settings.nav.${route.id}\`,defaultMessage:\`${route.label}\`,description:\`${route.description}\`}`)
      .join(","),
    caseEntries: routeIds.map((id) => `case\`${id}\`:`).join(""),
  };
}

function splitTopLevelJavaScriptEntries(source) {
  const entries = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth -= 1;
    else if (character === "," && depth === 0) {
      entries.push(source.slice(start, index));
      start = index + 1;
    }
    if (depth < 0) throw new Error("Native settings icon map is structurally unbalanced.");
  }
  if (quote || depth !== 0) throw new Error("Native settings icon map is structurally incomplete.");
  entries.push(source.slice(start));
  return entries.filter((entry) => entry.length > 0);
}

function nativeSettingsEntryKey(entry) {
  const colonIndex = entry.indexOf(":");
  if (colonIndex <= 0) throw new Error(`Invalid native settings icon entry: ${entry.slice(0, 80)}`);
  return entry.slice(0, colonIndex).trim().replace(/^["'`]|["'`]$/g, "");
}

function filterNativeSettingsIconMap(source, enabledRouteIds) {
  const enabled = new Set(enabledRouteIds);
  const retainedKeys = new Set(["agent", "git-settings", ...enabledRouteIds]);
  const entries = splitTopLevelJavaScriptEntries(source);
  const seen = new Map();
  for (const entry of entries) {
    const key = nativeSettingsEntryKey(entry);
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  for (const key of retainedKeys) {
    if (seen.get(key) !== 1) {
      throw new Error(`Expected exactly one native settings icon entry for ${key}, found ${seen.get(key) || 0}.`);
    }
  }
  for (const routeId of ALL_NATIVE_SETTINGS_ROUTE_IDS) {
    if (seen.get(routeId) !== 1) {
      throw new Error(`Expected exactly one source icon entry for native settings route ${routeId}, found ${seen.get(routeId) || 0}.`);
    }
  }
  return entries.filter((entry) => retainedKeys.has(nativeSettingsEntryKey(entry))).join(",");
}

function inspectNativeSettingsComposition(input, enabledGroups = {}) {
  const plan = createNativeSettingsPlan(enabledGroups, { allowEmpty: true });
  const enabledRouteIds = new Set(plan.routeIds);
  const routeChecks = {};
  for (const routeId of ALL_NATIVE_SETTINGS_ROUTE_IDS) {
    const route = NATIVE_SETTINGS_ROUTE_DEFINITIONS[routeId];
    const markers = {
      section: input.settingsSectionsText.includes(`slug:\`${routeId}\``),
      label: input.settingsSharedText.includes(`defaultMessage:\`${route.label}\``),
      icon: input.settingsPageText.includes(`${route.objectKey}:e=>(0,`),
      registry: input.appMainText.includes(`./${route.moduleFile}`),
      module: input.routeModuleExists[routeId] === true,
    };
    const expected = enabledRouteIds.has(routeId);
    const values = Object.values(markers);
    routeChecks[routeId] = {
      expected,
      markers,
      ok: expected ? values.every(Boolean) : values.every((value) => !value),
    };
  }
  const missingEnabledRoutes = Object.entries(routeChecks)
    .filter(([, check]) => check.expected && !check.ok)
    .map(([routeId]) => routeId);
  const unexpectedDisabledRoutes = Object.entries(routeChecks)
    .filter(([, check]) => !check.expected && !check.ok)
    .map(([routeId]) => routeId);
  return {
    ok: missingEnabledRoutes.length === 0 && unexpectedDisabledRoutes.length === 0,
    enabledGroups: plan.enabledGroups,
    enabledRouteIds: plan.routeIds,
    disabledRouteIds: ALL_NATIVE_SETTINGS_ROUTE_IDS.filter((routeId) => !enabledRouteIds.has(routeId)),
    missingEnabledRoutes,
    unexpectedDisabledRoutes,
    routeChecks,
  };
}

function writeNativeSettingsRouteModules(extractDir, enabledRouteIds) {
  const assetsDir = path.join(extractDir, "webview", "assets");
  const jsxRuntimeAsset = path.basename(findSingleAsset(extractDir, /^jsx-runtime-.+\.js$/i, "jsx-runtime"));
  const providerModulePath = path.join(assetsDir, "codex-native-providers-settings-page.js");
  const autoRouterModulePath = path.join(assetsDir, "codex-native-auto-router-settings-page.js");
  const promptToolsModulePath = path.join(assetsDir, "codex-native-prompt-tools-settings-page.js");
  const personasModulePath = path.join(assetsDir, "codex-native-personas-settings-page.js");
  const swarmModulePath = path.join(assetsDir, "codex-native-swarm-settings-page.js");
  const orchestratorModulePath = path.join(assetsDir, "codex-native-orchestrations-settings-page.js");
  const importsModulePath = path.join(assetsDir, "codex-native-imports-settings-page.js");
  const patcherModulePath = path.join(assetsDir, "codex-native-patcher-settings-page.js");
  const featureDevelopmentModulePath = path.join(assetsDir, "codex-native-feature-development-settings-page.js");
  const providerModule = `import{t as jsxRuntime}from"./${jsxRuntimeAsset}";
const jsx=jsxRuntime();
function notifyProvidersSettingsRoute(){let attempts=0;const mount=()=>{const host=document.getElementById("codex-native-providers-settings-route");if(!host)return;const api=window.__codexNativeProviderSettings;if(api?.openSettingsRoute){host.dataset.codexNativeMounted="1";api.openSettingsRoute("providers");return}window.dispatchEvent(new CustomEvent("codex-native-settings-route",{detail:{id:"providers"}}));attempts+=1;if(attempts<40)window.setTimeout(mount,100)};requestAnimationFrame(mount)}
function ProvidersSettings(){notifyProvidersSettingsRoute();return jsx.jsx("div",{id:"codex-native-providers-settings-route",className:"h-full min-w-0 overflow-visible"})}
export{ProvidersSettings};
`;
  const autoRouterModule = `import{t as jsxRuntime}from"./${jsxRuntimeAsset}";
const jsx=jsxRuntime();
function notifyAutoRouterSettingsRoute(){let attempts=0;const mount=()=>{const host=document.getElementById("codex-native-auto-router-settings-route");if(!host)return;const api=window.__codexNativeProviderSettings;if(api?.openSettingsRoute){host.dataset.codexNativeMounted="1";api.openSettingsRoute("auto-router");return}window.dispatchEvent(new CustomEvent("codex-native-settings-route",{detail:{id:"auto-router"}}));attempts+=1;if(attempts<40)window.setTimeout(mount,100)};requestAnimationFrame(mount)}
function AutoRouterSettings(){notifyAutoRouterSettingsRoute();return jsx.jsx("div",{id:"codex-native-auto-router-settings-route",className:"h-full min-w-0 overflow-visible"})}
export{AutoRouterSettings};
`;
  const promptToolsModule = `import{t as jsxRuntime}from"./${jsxRuntimeAsset}";
const jsx=jsxRuntime();
function notifyPromptToolsSettingsRoute(){let attempts=0;const mount=()=>{const host=document.getElementById("codex-native-prompt-tools-settings-route");if(!host)return;const api=window.__codexNativeProviderSettings;if(api?.openSettingsRoute){host.dataset.codexNativeMounted="1";api.openSettingsRoute("prompt-tools");return}window.dispatchEvent(new CustomEvent("codex-native-settings-route",{detail:{id:"prompt-tools"}}));attempts+=1;if(attempts<40)window.setTimeout(mount,100)};requestAnimationFrame(mount)}
function PromptToolsSettings(){notifyPromptToolsSettingsRoute();return jsx.jsx("div",{id:"codex-native-prompt-tools-settings-route",className:"h-full min-w-0 overflow-visible"})}
export{PromptToolsSettings};
`;
  const personasModule = `import{t as jsxRuntime}from"./${jsxRuntimeAsset}";
const jsx=jsxRuntime();
function notifyPersonasSettingsRoute(){let attempts=0;const mount=()=>{const host=document.getElementById("codex-native-personas-settings-route");if(!host)return;const api=window.__codexNativeProviderSettings;if(api?.openSettingsRoute){host.dataset.codexNativeMounted="1";api.openSettingsRoute("personas");return}window.dispatchEvent(new CustomEvent("codex-native-settings-route",{detail:{id:"personas"}}));attempts+=1;if(attempts<40)window.setTimeout(mount,100)};requestAnimationFrame(mount)}
function PersonasSettings(){notifyPersonasSettingsRoute();return jsx.jsx("div",{id:"codex-native-personas-settings-route",className:"h-full min-w-0 overflow-visible"})}
export{PersonasSettings};
`;
  const swarmModule = `import{t as jsxRuntime}from"./${jsxRuntimeAsset}";
const jsx=jsxRuntime();
function notifySwarmSettingsRoute(){let attempts=0;const mount=()=>{const host=document.getElementById("codex-native-swarm-settings-route");if(!host)return;const api=window.__codexNativeProviderSettings;if(api?.openSettingsRoute){host.dataset.codexNativeMounted="1";api.openSettingsRoute("swarm");return}window.dispatchEvent(new CustomEvent("codex-native-settings-route",{detail:{id:"swarm"}}));attempts+=1;if(attempts<40)window.setTimeout(mount,100)};requestAnimationFrame(mount)}
function SwarmSettings(){notifySwarmSettingsRoute();return jsx.jsx("div",{id:"codex-native-swarm-settings-route",className:"h-full min-w-0 overflow-visible"})}
export{SwarmSettings};
`;
  const orchestratorModule = `import{t as jsxRuntime}from"./${jsxRuntimeAsset}";
const jsx=jsxRuntime();
function notifyOrchestrationsSettingsRoute(){let attempts=0;const mount=()=>{const host=document.getElementById("codex-native-orchestrations-settings-route");if(!host)return;const api=window.__codexNativeOrchestrator;if(api?.openSettingsRoute){host.dataset.codexNativeMounted="1";api.openSettingsRoute();return}window.dispatchEvent(new CustomEvent("codex-native-settings-route",{detail:{id:"orchestrations"}}));attempts+=1;if(attempts<40)window.setTimeout(mount,100)};requestAnimationFrame(mount)}
function OrchestrationsSettings(){notifyOrchestrationsSettingsRoute();return jsx.jsx("div",{id:"codex-native-orchestrations-settings-route",className:"h-full min-w-0 overflow-visible"})}
export{OrchestrationsSettings};
`;
  const importsModule = `import{t as jsxRuntime}from"./${jsxRuntimeAsset}";
const jsx=jsxRuntime();
function notifyImportsSettingsRoute(){let attempts=0;const mount=()=>{const host=document.getElementById("codex-native-imports-settings-route");if(!host){attempts+=1;if(attempts<60)window.setTimeout(mount,100);return}const api=window.__codexNativeImportSettings;if(api?.openSettingsRoute){host.dataset.codexNativeMounted="1";api.openSettingsRoute();return}window.dispatchEvent(new CustomEvent("codex-native-settings-route",{detail:{id:"imports"}}));attempts+=1;if(attempts<60)window.setTimeout(mount,100)};requestAnimationFrame(mount)}
function ImportsSettings(){notifyImportsSettingsRoute();return jsx.jsx("div",{id:"codex-native-imports-settings-route",className:"h-full min-w-0 overflow-visible",children:jsx.jsx("div",{style:{padding:"28px 34px",fontSize:"13px",color:"var(--color-token-text-secondary, #6b7280)"},children:"Loading native imports..."})})}
export{ImportsSettings};
`;
  const patcherModule = `import{t as jsxRuntime}from"./${jsxRuntimeAsset}";
const jsx=jsxRuntime();
function notifyPatcherSettingsRoute(){let attempts=0;const mount=()=>{const host=document.getElementById("codex-native-patcher-settings-route");if(!host){attempts+=1;if(attempts<60)window.setTimeout(mount,100);return}const api=window.__codexNativePatcherSettings;if(api?.openSettingsRoute){host.dataset.codexNativeMounted="1";api.openSettingsRoute();return}window.dispatchEvent(new CustomEvent("codex-native-settings-route",{detail:{id:"patcher"}}));attempts+=1;if(attempts<60)window.setTimeout(mount,100)};requestAnimationFrame(mount)}
function PatcherSettings(){notifyPatcherSettingsRoute();return jsx.jsx("div",{id:"codex-native-patcher-settings-route",className:"h-full min-w-0 overflow-visible",children:jsx.jsx("div",{style:{padding:"28px 34px",fontSize:"13px",color:"var(--color-token-text-secondary, #6b7280)"},children:"Loading native patcher..."})})}
export{PatcherSettings};
`;
  const featureDevelopmentModule = `import{t as jsxRuntime}from"./${jsxRuntimeAsset}";
const jsx=jsxRuntime();
function notifyFeatureDevelopmentSettingsRoute(){let attempts=0;const mount=()=>{const host=document.getElementById("codex-native-feature-development-settings-route");if(!host){attempts+=1;if(attempts<60)window.setTimeout(mount,100);return}const api=window.__codexNativePatcherSettings;if(api?.openSettingsRoute){host.dataset.codexNativeMounted="1";api.openSettingsRoute("feature-development");return}window.dispatchEvent(new CustomEvent("codex-native-settings-route",{detail:{id:"feature-development"}}));attempts+=1;if(attempts<60)window.setTimeout(mount,100)};requestAnimationFrame(mount)}
function FeatureDevelopmentSettings(){notifyFeatureDevelopmentSettingsRoute();return jsx.jsx("div",{id:"codex-native-feature-development-settings-route",className:"h-full min-w-0 overflow-visible",children:jsx.jsx("div",{style:{padding:"28px 34px",fontSize:"13px",color:"var(--color-token-text-secondary, #6b7280)"},children:"Loading Feature Development..."})})}
export{FeatureDevelopmentSettings};
`;
  const moduleSpecs = {
    providers: [providerModulePath, providerModule],
    "auto-router": [autoRouterModulePath, autoRouterModule],
    "prompt-tools": [promptToolsModulePath, promptToolsModule],
    personas: [personasModulePath, personasModule],
    swarm: [swarmModulePath, swarmModule],
    orchestrations: [orchestratorModulePath, orchestratorModule],
    imports: [importsModulePath, importsModule],
    patcher: [patcherModulePath, patcherModule],
    "feature-development": [featureDevelopmentModulePath, featureDevelopmentModule],
  };
  const routeModules = {};
  for (const routeId of enabledRouteIds) {
    const route = NATIVE_SETTINGS_ROUTE_DEFINITIONS[routeId];
    const moduleSpec = moduleSpecs[routeId];
    if (!route || !moduleSpec) throw new Error(`Unknown native settings route module: ${routeId}.`);
    const [modulePath, moduleText] = moduleSpec;
    fs.writeFileSync(modulePath, moduleText, "utf8");
    routeModules[route.resultKey] = path.relative(extractDir, modulePath).replace(/\\/g, "/");
  }
  return routeModules;
}

function patchCurrentNavigationBridge(extractDir) {
  const assetPath = findProfileDropdownAsset(extractDir);
  let text = fs.readFileSync(assetPath, "utf8");
  const marker = "__codexNativeNavigate";
  if (text.includes(marker)) {
    return {
      assetRelativePath: path.relative(extractDir, assetPath).replace(/\\/g, "/"),
      count: 0,
      alreadyPatched: true,
    };
  }

  const anchor = /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\),\{accountId:/g;
  const matches = [...text.matchAll(anchor)];
  if (matches.length !== 1) {
    throw new Error(`Expected one current profile navigation anchor, found ${matches.length} in ${path.basename(assetPath)}.`);
  }

  const [full, footerState, footerStateHook, navigateName, navigateHook, authName, authHook] = matches[0];
  const replacement = `let ${footerState}=${footerStateHook},${navigateName}=${navigateHook}();globalThis.__codexNativeNavigate=(e,t)=>${navigateName}(e,t);let ${authName}=${authHook}(),{accountId:`;
  text = text.replace(full, replacement);
  fs.writeFileSync(assetPath, text, "utf8");
  assertJsModuleSyntax(assetPath, "current Codex navigation bridge");
  return {
    assetRelativePath: path.relative(extractDir, assetPath).replace(/\\/g, "/"),
    count: 1,
    alreadyPatched: false,
  };
}

function patchNativeSettingsSections(extractDir, enabledGroups) {
  const patches = [];
  const plan = createNativeSettingsPlan(enabledGroups);
  const nativeSettingsSlugs = plan.quotedSlugs;
  const nativeSettingsLabelEntries = plan.labelEntries;

  const sectionsPath = findSettingsSectionsAsset(extractDir);
  let sectionsText = fs.readFileSync(sectionsPath, "utf8");
  let patched = replaceExactly(
    sectionsText,
    "{slug:`agent`},{slug:`personalization`}",
    `{slug:\`agent\`},${plan.sectionEntries},{slug:\`personalization\`}`,
    "settings sections native custom insertion"
  );
  sectionsText = patched.text;
  patches.push({ label: "settings-sections slug list", count: patched.count });
  fs.writeFileSync(sectionsPath, sectionsText, "utf8");

  const sharedPath = findSettingsSharedAsset(extractDir);
  let sharedText = fs.readFileSync(sharedPath, "utf8");
  const sharedOldTarget =
    '"skills-settings":{id:`settings.nav.skills-settings`,defaultMessage:`Skills`,description:`Title for skills settings section`}});function l';
  const sharedOldReplacement =
    `"skills-settings":{id:\`settings.nav.skills-settings\`,defaultMessage:\`Skills\`,description:\`Title for skills settings section\`},${nativeSettingsLabelEntries}});function l`;
  if (sharedText.includes(sharedOldTarget)) {
    patched = replaceExactly(sharedText, sharedOldTarget, sharedOldReplacement, "settings shared labels native custom insertion");
  } else {
    patched = replaceExactly(
      sharedText,
      '"skills-settings":{id:`settings.nav.skills-settings`,defaultMessage:`Skills`,description:`Title for skills settings section`}})}));function',
      `"skills-settings":{id:\`settings.nav.skills-settings\`,defaultMessage:\`Skills\`,description:\`Title for skills settings section\`},${nativeSettingsLabelEntries}})}));function`,
      "settings shared labels native custom insertion"
    );
  }
  sharedText = patched.text;
  patches.push({ label: "settings-shared labels", count: patched.count });
  fs.writeFileSync(sharedPath, sharedText, "utf8");

  const settingsPagePath = findSettingsPageAsset(extractDir);
  let settingsPageText = fs.readFileSync(settingsPagePath, "utf8");
  const generatedNativeSettingsIconMap =
    'agent:ie,providers:e=>(0,Q.jsxs)(`svg`,{width:20,height:20,viewBox:`0 0 20 20`,fill:`none`,xmlns:`http://www.w3.org/2000/svg`,...e,children:[(0,Q.jsx)(`path`,{d:`M7.8 7.25h4.4c.3 0 .55.25 .55.55v4.4c0 .3-.25.55-.55.55H7.8c-.3 0-.55-.25-.55-.55V7.8c0-.3.25-.55.55-.55Z`,stroke:`currentColor`,strokeWidth:1.35,strokeLinejoin:`round`}),(0,Q.jsx)(`path`,{d:`M10 3.45v3.8M10 12.75v3.8M3.45 10h3.8M12.75 10h3.8M5.35 5.35 7.7 7.7M14.65 5.35 12.3 7.7M5.35 14.65 7.7 12.3M14.65 14.65 12.3 12.3`,stroke:`currentColor`,strokeWidth:1.1,strokeLinecap:`round`,opacity:.82}),(0,Q.jsx)(`circle`,{cx:10,cy:3.2,r:1.15,stroke:`#7c3aed`,strokeWidth:1.2}),(0,Q.jsx)(`circle`,{cx:3.2,cy:10,r:1.15,stroke:`#06b6d4`,strokeWidth:1.2}),(0,Q.jsx)(`circle`,{cx:16.8,cy:10,r:1.15,stroke:`#d946ef`,strokeWidth:1.2}),(0,Q.jsx)(`circle`,{cx:10,cy:16.8,r:1.15,stroke:`#7c3aed`,strokeWidth:1.2})]}),orchestrations:e=>(0,Q.jsxs)(`svg`,{width:20,height:20,viewBox:`0 0 20 20`,fill:`none`,xmlns:`http://www.w3.org/2000/svg`,...e,children:[(0,Q.jsx)(`path`,{d:`M10 10.85V7.4M10 10.85 5.6 7.5M10 10.85l4.4-3.35M6.15 13.05h7.7`,stroke:`currentColor`,strokeWidth:1.25,strokeLinecap:`round`,strokeLinejoin:`round`}),(0,Q.jsx)(`rect`,{x:7.25,y:11.15,width:5.5,height:4.65,rx:1.25,stroke:`currentColor`,strokeWidth:1.35}),(0,Q.jsx)(`path`,{d:`M8.55 14.05c.45-.82 2.45-.82 2.9 0M8.95 12.8a1.05 1.05 0 1 0 2.1 0 1.05 1.05 0 0 0-2.1 0Z`,stroke:`#d946ef`,strokeWidth:1.05,strokeLinecap:`round`}),(0,Q.jsx)(`rect`,{x:2.65,y:3.35,width:5.1,height:3.9,rx:1.15,stroke:`currentColor`,strokeWidth:1.25}),(0,Q.jsx)(`rect`,{x:7.45,y:2.25,width:5.1,height:3.9,rx:1.15,stroke:`currentColor`,strokeWidth:1.25}),(0,Q.jsx)(`rect`,{x:12.25,y:3.35,width:5.1,height:3.9,rx:1.15,stroke:`currentColor`,strokeWidth:1.25}),(0,Q.jsx)(`circle`,{cx:5.2,cy:5.3,r:.65,stroke:`#06b6d4`,strokeWidth:1.05}),(0,Q.jsx)(`circle`,{cx:10,cy:4.2,r:.65,stroke:`#06b6d4`,strokeWidth:1.05}),(0,Q.jsx)(`circle`,{cx:14.8,cy:5.3,r:.65,stroke:`#7c3aed`,strokeWidth:1.05})]}),imports:e=>(0,Q.jsxs)(`svg`,{width:20,height:20,viewBox:`0 0 20 20`,fill:`none`,xmlns:`http://www.w3.org/2000/svg`,...e,children:[(0,Q.jsx)(`path`,{d:`M3.35 9.35 4.8 5.6c.16-.41.56-.68 1-.68h8.4c.44 0 .84.27 1 .68l1.45 3.75v5.2c0 .78-.64 1.42-1.42 1.42H4.77c-.78 0-1.42-.64-1.42-1.42v-5.2Z`,stroke:`currentColor`,strokeWidth:1.35,strokeLinejoin:`round`}),(0,Q.jsx)(`path`,{d:`M3.7 10.05h4.05c.44 0 .81.29.96.71l.16.46c.16.43.56.71 1.02.71h.22c.46 0 .86-.28 1.02-.71l.16-.46c.15-.42.52-.71.96-.71h4.05`,stroke:`currentColor`,strokeWidth:1.25,strokeLinejoin:`round`}),(0,Q.jsx)(`path`,{d:`M10 2.65v5.2m0 0L7.9 5.78M10 7.85l2.1-2.07`,stroke:`url(#cpsImportsGradient)`,strokeWidth:1.45,strokeLinecap:`round`,strokeLinejoin:`round`}),(0,Q.jsx)(`path`,{d:`M7 6.6h3.1c.92 0 1.66.64 1.66 1.44s-.74 1.44-1.66 1.44H8.5l-1.5 1.05V6.6Z`,stroke:`#06b6d4`,strokeWidth:1.05,strokeLinejoin:`round`}),(0,Q.jsx)(`path`,{d:`M12.05 8.2h1.45c.72 0 1.3.5 1.3 1.12s-.58 1.12-1.3 1.12h-.75l-.98.76V8.2Z`,stroke:`#d946ef`,strokeWidth:1.05,strokeLinejoin:`round`}),(0,Q.jsx)(`defs`,{children:(0,Q.jsxs)(`linearGradient`,{id:`cpsImportsGradient`,x1:`7.8`,y1:`2.8`,x2:`12.2`,y2:`7.8`,gradientUnits:`userSpaceOnUse`,children:[(0,Q.jsx)(`stop`,{stopColor:`#06b6d4`}),(0,Q.jsx)(`stop`,{offset:1,stopColor:`#d946ef`})]})})]}),"git-settings":v';
  const autoRouterNativeSettingsIconMapEntry =
    '"auto-router":e=>(0,Q.jsxs)(`svg`,{width:20,height:20,viewBox:`0 0 20 20`,fill:`none`,xmlns:`http://www.w3.org/2000/svg`,...e,children:[(0,Q.jsx)(`path`,{d:`M4.2 14.4c1.6-3.45 3.52-5.8 5.8-7.03 2.28-1.23 4.22-1.23 5.82 0`,stroke:`currentColor`,strokeWidth:1.35,strokeLinecap:`round`}),(0,Q.jsx)(`path`,{d:`M10 7.35V3.5m0 3.85 2.22-2.18M10 7.35 7.78 5.17`,stroke:`url(#cpsAutoRouterGradient)`,strokeWidth:1.35,strokeLinecap:`round`,strokeLinejoin:`round`}),(0,Q.jsx)(`path`,{d:`M6.45 14.35a3.55 3.55 0 0 1 7.1 0`,stroke:`currentColor`,strokeWidth:1.35,strokeLinecap:`round`}),(0,Q.jsx)(`circle`,{cx:10,cy:14.35,r:1.55,stroke:`#06b6d4`,strokeWidth:1.25}),(0,Q.jsx)(`path`,{d:`M10 14.35 13.25 9.6`,stroke:`#d946ef`,strokeWidth:1.35,strokeLinecap:`round`}),(0,Q.jsx)(`circle`,{cx:4.2,cy:14.4,r:1.15,stroke:`#7c3aed`,strokeWidth:1.15}),(0,Q.jsx)(`circle`,{cx:15.8,cy:14.4,r:1.15,stroke:`#7c3aed`,strokeWidth:1.15}),(0,Q.jsx)(`defs`,{children:(0,Q.jsxs)(`linearGradient`,{id:`cpsAutoRouterGradient`,x1:`7.7`,y1:`3.6`,x2:`12.4`,y2:`7.4`,gradientUnits:`userSpaceOnUse`,children:[(0,Q.jsx)(`stop`,{stopColor:`#06b6d4`}),(0,Q.jsx)(`stop`,{offset:1,stopColor:`#d946ef`})]})})]})';
  const promptToolsNativeSettingsIconMapEntry =
    '"prompt-tools":e=>(0,Q.jsxs)(`svg`,{width:20,height:20,viewBox:`0 0 20 20`,fill:`none`,xmlns:`http://www.w3.org/2000/svg`,...e,children:[(0,Q.jsx)(`path`,{d:`M4.1 4.45c0-.78.63-1.4 1.4-1.4h9c.77 0 1.4.62 1.4 1.4v7.6c0 .78-.63 1.4-1.4 1.4H9.05L5.35 16.3v-2.85H5.5c-.77 0-1.4-.62-1.4-1.4v-7.6Z`,stroke:`currentColor`,strokeWidth:1.35,strokeLinejoin:`round`}),(0,Q.jsx)(`path`,{d:`M7.1 6.35h5.8M7.1 8.55h3.75`,stroke:`currentColor`,strokeWidth:1.15,strokeLinecap:`round`,opacity:.82}),(0,Q.jsx)(`path`,{d:`M12.25 10.6l1.05-.48.48-1.05.48 1.05 1.05.48-1.05.48-.48 1.05-.48-1.05-1.05-.48Z`,stroke:`#d946ef`,strokeWidth:1.05,strokeLinejoin:`round`}),(0,Q.jsx)(`path`,{d:`M5.7 5.15l.78-.35.35-.78.35.78.78.35-.78.35-.35.78-.35-.78-.78-.35Z`,stroke:`#06b6d4`,strokeWidth:1.05,strokeLinejoin:`round`}),(0,Q.jsx)(`path`,{d:`M9.1 13.45l3.4 3.1 3.4-3.1`,stroke:`url(#cpsPromptToolsGradient)`,strokeWidth:1.3,strokeLinecap:`round`,strokeLinejoin:`round`}),(0,Q.jsx)(`defs`,{children:(0,Q.jsxs)(`linearGradient`,{id:`cpsPromptToolsGradient`,x1:`9.1`,y1:`13.4`,x2:`15.9`,y2:`16.6`,gradientUnits:`userSpaceOnUse`,children:[(0,Q.jsx)(`stop`,{stopColor:`#06b6d4`}),(0,Q.jsx)(`stop`,{offset:1,stopColor:`#7c3aed`})]})})]})';
  const personasNativeSettingsIconMapEntry =
    'personas:e=>(0,Q.jsxs)(`svg`,{width:20,height:20,viewBox:`0 0 20 20`,fill:`none`,xmlns:`http://www.w3.org/2000/svg`,...e,children:[(0,Q.jsx)(`circle`,{cx:10,cy:7.2,r:2.65,stroke:`currentColor`,strokeWidth:1.35}),(0,Q.jsx)(`path`,{d:`M4.75 16.35c.8-3.25 2.55-4.88 5.25-4.88s4.45 1.63 5.25 4.88`,stroke:`currentColor`,strokeWidth:1.35,strokeLinecap:`round`}),(0,Q.jsx)(`path`,{d:`M14.3 4.2l.78-.35.35-.78.35.78.78.35-.78.35-.35.78-.35-.78-.78-.35Z`,stroke:`#d946ef`,strokeWidth:1.05,strokeLinejoin:`round`}),(0,Q.jsx)(`path`,{d:`M3.9 6.85l.62-.28.28-.62.28.62.62.28-.62.28-.28.62-.28-.62-.62-.28Z`,stroke:`#06b6d4`,strokeWidth:1.05,strokeLinejoin:`round`}),(0,Q.jsx)(`path`,{d:`M7.55 14.1c.58-.55 1.4-.82 2.45-.82s1.87.27 2.45.82`,stroke:`url(#cpsPersonasGradient)`,strokeWidth:1.2,strokeLinecap:`round`}),(0,Q.jsx)(`defs`,{children:(0,Q.jsxs)(`linearGradient`,{id:`cpsPersonasGradient`,x1:`7.4`,y1:`13.2`,x2:`12.7`,y2:`14.5`,gradientUnits:`userSpaceOnUse`,children:[(0,Q.jsx)(`stop`,{stopColor:`#06b6d4`}),(0,Q.jsx)(`stop`,{offset:1,stopColor:`#7c3aed`})]})})]})';
  const swarmNativeSettingsIconMapEntry =
    'swarm:e=>(0,Q.jsxs)(`svg`,{width:20,height:20,viewBox:`0 0 20 20`,fill:`none`,xmlns:`http://www.w3.org/2000/svg`,...e,children:[(0,Q.jsx)(`path`,{d:`M10 4.4v4.05M6.15 12.65l2.6-3.05M13.85 12.65l-2.6-3.05M7.55 13.25h4.9M8.35 14.35 10 16.7l1.65-2.35`,stroke:`currentColor`,strokeWidth:1.25,strokeLinecap:`round`,strokeLinejoin:`round`}),(0,Q.jsx)(`circle`,{cx:10,cy:3.55,r:1.6,stroke:`#06b6d4`,strokeWidth:1.2}),(0,Q.jsx)(`circle`,{cx:5.2,cy:13.7,r:1.6,stroke:`#7c3aed`,strokeWidth:1.2}),(0,Q.jsx)(`circle`,{cx:14.8,cy:13.7,r:1.6,stroke:`#7c3aed`,strokeWidth:1.2}),(0,Q.jsx)(`rect`,{x:8.1,y:8.05,width:3.8,height:3.1,rx:.85,stroke:`currentColor`,strokeWidth:1.2}),(0,Q.jsx)(`path`,{d:`M10 16.25v1.6`,stroke:`#d946ef`,strokeWidth:1.2,strokeLinecap:`round`})]})';
  const patcherNativeSettingsIconMapEntry =
    'patcher:e=>(0,Q.jsxs)(`svg`,{width:20,height:20,viewBox:`0 0 20 20`,fill:`none`,xmlns:`http://www.w3.org/2000/svg`,...e,children:[(0,Q.jsx)(`path`,{d:`M4.2 5.35h4.05M11.75 5.35h4.05M4.2 10h4.05M11.75 10h4.05M4.2 14.65h4.05M11.75 14.65h4.05`,stroke:`currentColor`,strokeWidth:1.2,strokeLinecap:`round`}),(0,Q.jsx)(`circle`,{cx:9.75,cy:5.35,r:1.3,stroke:`#06b6d4`,strokeWidth:1.15}),(0,Q.jsx)(`circle`,{cx:10.25,cy:10,r:1.3,stroke:`#7c3aed`,strokeWidth:1.15}),(0,Q.jsx)(`circle`,{cx:9.1,cy:14.65,r:1.3,stroke:`#d946ef`,strokeWidth:1.15}),(0,Q.jsx)(`rect`,{x:2.85,y:2.9,width:14.3,height:14.2,rx:3.1,stroke:`currentColor`,strokeWidth:1.25,opacity:.9})]})';
  const featureDevelopmentNativeSettingsIconMapEntry =
    '"feature-development":e=>(0,Q.jsxs)(`svg`,{width:20,height:20,viewBox:`0 0 20 20`,fill:`none`,xmlns:`http://www.w3.org/2000/svg`,...e,children:[(0,Q.jsx)(`path`,{d:`M4.1 4.25h5.1l1.25 1.5h5.45v9.3c0 .88-.72 1.6-1.6 1.6H5.7c-.88 0-1.6-.72-1.6-1.6V4.25Z`,stroke:`currentColor`,strokeWidth:1.3,strokeLinejoin:`round`}),(0,Q.jsx)(`path`,{d:`M7.05 9.2 5.75 10.5l1.3 1.3M12.95 9.2l1.3 1.3-1.3 1.3M11.25 8.5l-2.5 4`,stroke:`url(#cpsFeatureDevelopmentGradient)`,strokeWidth:1.25,strokeLinecap:`round`,strokeLinejoin:`round`}),(0,Q.jsx)(`circle`,{cx:14.95,cy:4.55,r:1.35,stroke:`#d946ef`,strokeWidth:1.15}),(0,Q.jsx)(`defs`,{children:(0,Q.jsxs)(`linearGradient`,{id:`cpsFeatureDevelopmentGradient`,x1:`5.7`,y1:`8.6`,x2:`14.3`,y2:`12.4`,gradientUnits:`userSpaceOnUse`,children:[(0,Q.jsx)(`stop`,{stopColor:`#06b6d4`}),(0,Q.jsx)(`stop`,{offset:1,stopColor:`#7c3aed`})]})})]})';
  const generatedNativeSettingsIconMapWithTools = generatedNativeSettingsIconMap.replace(
    "orchestrations:e=>",
    `${autoRouterNativeSettingsIconMapEntry},${promptToolsNativeSettingsIconMapEntry},${personasNativeSettingsIconMapEntry},${swarmNativeSettingsIconMapEntry},orchestrations:e=>`
  ).replace(
    '"git-settings":v',
    `${patcherNativeSettingsIconMapEntry},${featureDevelopmentNativeSettingsIconMapEntry},"git-settings":v`
  );
  const generatedEnabledNativeSettingsIconMap = filterNativeSettingsIconMap(
    generatedNativeSettingsIconMapWithTools,
    plan.routeIds
  );
  const currentJsxRuntimeMatch = /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*)=\{"general-settings":/.exec(
    settingsPageText
  );
  const settingsJsxRuntimeAlias = currentJsxRuntimeMatch?.[1] || "Q";
  const generatedNativeSettingsIconMapForBuild = generatedEnabledNativeSettingsIconMap.replaceAll(
    "Q.",
    `${settingsJsxRuntimeAlias}.`
  );

  if (settingsPageText.includes('agent:ie,"git-settings":v')) {
    patched = replaceExactly(settingsPageText, 'agent:ie,"git-settings":v', generatedNativeSettingsIconMapForBuild, "settings page icon map");
  } else {
    const iconMatch = /agent:([A-Za-z_$][\w$]*),"git-settings":([A-Za-z_$][\w$]*)/.exec(settingsPageText);
    if (!iconMatch) {
      throw new Error("Expected one settings page current icon map patch target, found 0.");
    }
    const currentIconMap = generatedNativeSettingsIconMapForBuild
      .replace(/^agent:ie/, `agent:${iconMatch[1]}`)
      .replace(/"git-settings":v$/, `"git-settings":${iconMatch[2]}`);
    patched = replaceExactly(settingsPageText, iconMatch[0], currentIconMap, "settings page icon map");
  }
  settingsPageText = patched.text;
  patches.push({ label: "settings page icon map", count: patched.count });

  const settingsPageReplacements = [
    [
      "`appshots`,`agent`,`personalization`",
      `\`appshots\`,\`agent\`,${nativeSettingsSlugs},\`personalization\``,
      "settings page flat order",
      "`general-settings`,`import`,`profile`,`appearance`,`appshots`,`agent`,`personalization`",
      `\`general-settings\`,\`import\`,\`profile\`,\`appearance\`,\`appshots\`,\`agent\`,${nativeSettingsSlugs},\`personalization\``,
    ],
    [
      "`appshots`,`connections`,`git-settings`,`usage`",
      `\`appshots\`,\`connections\`,\`git-settings\`,${nativeSettingsSlugs},\`usage\``,
      "settings page app group order",
      "slugs:[`general-settings`,`import`,`profile`,`appearance`,`voice`,`agent`,`personalization`",
      `slugs:[\`general-settings\`,\`import\`,\`profile\`,\`appearance\`,\`voice\`,\`agent\`,${nativeSettingsSlugs},\`personalization\``,
    ],
    [
      "case`usage`:return S;case`profile`:return v;",
      `${plan.caseEntries}return!0;case\`usage\`:return S;case\`profile\`:return v;`,
      "settings page visibility switch",
      "case`general-settings`:case`agent`:case`personalization`:return!0;",
      `case\`general-settings\`:case\`agent\`:${plan.caseEntries}case\`personalization\`:return!0;`,
    ],
    [
      "case`appearance`:case`general-settings`:case`agent`:case`git-settings`:case`data-controls`:case`personalization`:H=!1;",
      `case\`appearance\`:case\`general-settings\`:case\`agent\`:${plan.caseEntries}case\`git-settings\`:case\`data-controls\`:case\`personalization\`:H=!1;`,
      "settings page loading redirect switch",
      "case`appearance`:case`pets`:case`general-settings`:case`agent`:case`git-settings`:case`data-controls`:case`code-review`:case`cloud-settings`:case`cloud-environments`:case`personalization`:P=!1;",
      `case\`appearance\`:case\`pets\`:case\`general-settings\`:case\`agent\`:${plan.caseEntries}case\`git-settings\`:case\`data-controls\`:case\`code-review\`:case\`cloud-settings\`:case\`cloud-environments\`:case\`personalization\`:P=!1;`,
    ],
    [
      null,
      null,
      "settings page compact route whitelist",
      "Mr=[`profile`,`agent`,`personalization`",
      `Mr=[\`profile\`,\`agent\`,${nativeSettingsSlugs},\`personalization\``,
    ],
  ];
  for (const [oldFrom, oldTo, label, currentFrom, currentTo] of settingsPageReplacements) {
    const from = oldFrom && settingsPageText.includes(oldFrom) ? oldFrom : currentFrom;
    const to = oldFrom && settingsPageText.includes(oldFrom) ? oldTo : currentTo;
    if (!from) {
      continue;
    }
    patched = replaceExactly(settingsPageText, from, to, label);
    settingsPageText = patched.text;
    patches.push({ label, count: patched.count });
  }
  fs.writeFileSync(settingsPagePath, settingsPageText, "utf8");

  const appMainPath = findSettingsRouteRegistryAsset(extractDir);
  let appMainText = fs.readFileSync(appMainPath, "utf8");
  const legacyLazyAlias = appMainText.match(/"git-settings":\(0,([A-Za-z_$][\w$]*)\.lazy\)/)?.[1];
  const currentLazyAlias = appMainText.match(/agent:([A-Za-z_$][\w$]*)\(async\(\)=>/)?.[1];
  const nativeRouteEntries = currentLazyAlias
    ? plan.routes
        .map((route) => `${route.objectKey}:${currentLazyAlias}(async()=>(await import(\`./${route.moduleFile}\`)).${route.exportName})`)
        .join(",")
    : plan.routes
        .map((route) => `${route.objectKey}:(0,${legacyLazyAlias || "Q"}.lazy)(()=>import(\`./${route.moduleFile}\`).then(e=>({default:e.${route.exportName}})))`)
        .join(",");
  patched = replaceExactly(
    appMainText,
    '"git-settings":',
    `${nativeRouteEntries},"git-settings":`,
    "app-main settings route map"
  );
  appMainText = patched.text;
  patches.push({ label: "app-main settings route map", count: patched.count });
  fs.writeFileSync(appMainPath, appMainText, "utf8");

  return {
    sectionsRelativePath: path.relative(extractDir, sectionsPath).replace(/\\/g, "/"),
    sharedRelativePath: path.relative(extractDir, sharedPath).replace(/\\/g, "/"),
    settingsPageRelativePath: path.relative(extractDir, settingsPagePath).replace(/\\/g, "/"),
    appMainRelativePath: path.relative(extractDir, appMainPath).replace(/\\/g, "/"),
    enabledGroups: plan.enabledGroups,
    routeIds: plan.routeIds,
    routeModules: writeNativeSettingsRouteModules(extractDir, plan.routeIds),
    patches,
  };
}

function injectNativeOrchestrator(extractDir) {
  const sourcePath = path.join(rootDir, "features", "core", "orchestrations", "payload", "codex-native-orchestrator.js");
  if (!exists(sourcePath)) {
    throw new Error(`Missing native orchestrator patch source: ${sourcePath}`);
  }

  const targetRelativePath = path.join("webview", "assets", "codex-native-orchestrator.js");
  const targetPath = path.join(extractDir, targetRelativePath);
  const indexPath = path.join(extractDir, "webview", "index.html");
  if (!exists(indexPath)) {
    throw new Error(`Missing Codex webview index: ${indexPath}`);
  }

  fs.copyFileSync(sourcePath, targetPath);

  const scriptTag = '    <script defer src="./assets/codex-native-orchestrator.js"></script>';
  const before = fs.readFileSync(indexPath, "utf8");
  let next = before;
  let injected = false;
  if (!next.includes(scriptTag)) {
    const marker = "  <meta http-equiv=\"Content-Security-Policy\"";
    const count = next.split(marker).length - 1;
    if (count !== 1) {
      throw new Error(`Expected one CSP meta marker in webview/index.html, found ${count}.`);
    }
    next = next.replace(marker, `${scriptTag}\n${marker}`);
    injected = true;
  }
  if (next !== before) {
    fs.writeFileSync(indexPath, next, "utf8");
  }

  return {
    scriptRelativePath: targetRelativePath.replace(/\\/g, "/"),
    indexRelativePath: "webview/index.html",
    injectedScriptTag: injected,
    scriptBytes: fs.statSync(targetPath).size,
  };
}

function injectProviderSettings(extractDir) {
  const sourcePath = path.join(rootDir, "features", "core", "provider-suite", "payload", "codex-native-provider-settings.js");
  if (!exists(sourcePath)) {
    throw new Error(`Missing native provider settings patch source: ${sourcePath}`);
  }

  const targetRelativePath = path.join("webview", "assets", "codex-native-provider-settings.js");
  const targetPath = path.join(extractDir, targetRelativePath);
  const indexPath = path.join(extractDir, "webview", "index.html");
  if (!exists(indexPath)) {
    throw new Error(`Missing Codex webview index: ${indexPath}`);
  }

  fs.copyFileSync(sourcePath, targetPath);

  const scriptTag = '    <script defer src="./assets/codex-native-provider-settings.js"></script>';
  const before = fs.readFileSync(indexPath, "utf8");
  let next = before;
  let injected = false;
  if (!next.includes(scriptTag)) {
    const marker = "  <meta http-equiv=\"Content-Security-Policy\"";
    const count = next.split(marker).length - 1;
    if (count !== 1) {
      throw new Error(`Expected one CSP meta marker in webview/index.html, found ${count}.`);
    }
    next = next.replace(marker, `${scriptTag}\n${marker}`);
    injected = true;
  }
  if (next !== before) {
    fs.writeFileSync(indexPath, next, "utf8");
  }

  return {
    scriptRelativePath: targetRelativePath.replace(/\\/g, "/"),
    indexRelativePath: "webview/index.html",
    injectedScriptTag: injected,
    scriptBytes: fs.statSync(targetPath).size,
  };
}

function injectPatcherSettings(extractDir) {
  const sourcePath = path.join(rootDir, "features", "core", "patcher-ui", "payload", "codex-native-patcher-settings.js");
  if (!exists(sourcePath)) {
    throw new Error(`Missing native patcher settings patch source: ${sourcePath}`);
  }

  const targetRelativePath = path.join("webview", "assets", "codex-native-patcher-settings.js");
  const targetPath = path.join(extractDir, targetRelativePath);
  const indexPath = path.join(extractDir, "webview", "index.html");
  if (!exists(indexPath)) {
    throw new Error(`Missing Codex webview index: ${indexPath}`);
  }

  fs.copyFileSync(sourcePath, targetPath);

  const scriptTag = '    <script defer src="./assets/codex-native-patcher-settings.js"></script>';
  const before = fs.readFileSync(indexPath, "utf8");
  let next = before;
  let injected = false;
  if (!next.includes(scriptTag)) {
    const marker = "  <meta http-equiv=\"Content-Security-Policy\"";
    const count = next.split(marker).length - 1;
    if (count !== 1) {
      throw new Error(`Expected one CSP meta marker in webview/index.html, found ${count}.`);
    }
    next = next.replace(marker, `${scriptTag}\n${marker}`);
    injected = true;
  }
  if (next !== before) {
    fs.writeFileSync(indexPath, next, "utf8");
  }

  return {
    scriptRelativePath: targetRelativePath.replace(/\\/g, "/"),
    indexRelativePath: "webview/index.html",
    injectedScriptTag: injected,
    scriptBytes: fs.statSync(targetPath).size,
  };
}

function injectImportSettings(extractDir) {
  const sourcePath = path.join(rootDir, "features", "core", "imports", "payload", "codex-native-import-settings.js");
  if (!exists(sourcePath)) {
    throw new Error(`Missing native import settings patch source: ${sourcePath}`);
  }

  const targetRelativePath = path.join("webview", "assets", "codex-native-import-settings.js");
  const targetPath = path.join(extractDir, targetRelativePath);
  const indexPath = path.join(extractDir, "webview", "index.html");
  if (!exists(indexPath)) {
    throw new Error(`Missing Codex webview index: ${indexPath}`);
  }

  fs.copyFileSync(sourcePath, targetPath);

  const scriptTag = '    <script defer src="./assets/codex-native-import-settings.js"></script>';
  const before = fs.readFileSync(indexPath, "utf8");
  let next = before;
  let injected = false;
  if (!next.includes(scriptTag)) {
    const marker = "  <meta http-equiv=\"Content-Security-Policy\"";
    const count = next.split(marker).length - 1;
    if (count !== 1) {
      throw new Error(`Expected one CSP meta marker in webview/index.html, found ${count}.`);
    }
    next = next.replace(marker, `${scriptTag}\n${marker}`);
    injected = true;
  }
  if (next !== before) {
    fs.writeFileSync(indexPath, next, "utf8");
  }

  return {
    scriptRelativePath: targetRelativePath.replace(/\\/g, "/"),
    indexRelativePath: "webview/index.html",
    injectedScriptTag: injected,
    scriptBytes: fs.statSync(targetPath).size,
  };
}

function jsonObjectEndAt(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return -1;
}

function promptString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function normalizePromptName(value) {
  return String(value || "").trim().toLowerCase();
}

function promptModelName(record) {
  return promptString(record?.model || record?.id || record?.slug || record?.name || record?.displayName).trim();
}

function promptRecordFromObject(record) {
  if (!record || typeof record !== "object") {
    return null;
  }
  const model = promptModelName(record);
  const messages =
    record.model_messages && typeof record.model_messages === "object"
      ? record.model_messages
      : record.modelMessages && typeof record.modelMessages === "object"
        ? record.modelMessages
        : {};
  const baseInstructions = promptString(
    record.base_instructions || record.baseInstructions || messages.base_instructions || messages.baseInstructions
  );
  const instructionsTemplate = promptString(
    messages.instructions_template ||
      messages.instructionsTemplate ||
      record.instructions_template ||
      record.instructionsTemplate
  );
  const directInstructions = promptString(record.instructions || record.system_prompt || record.systemPrompt);
  const defaultPrompt = baseInstructions || directInstructions || instructionsTemplate;
  if (!model || !defaultPrompt) {
    return null;
  }
  return {
    model,
    displayName: promptString(record.display_name || record.displayName || record.name || model),
    baseInstructions,
    instructionsTemplate,
    defaultPrompt,
    sourceField: baseInstructions
      ? "base_instructions"
      : directInstructions
        ? "instructions"
        : "model_messages.instructions_template",
  };
}

function extractDefaultPromptRecordsFromBinary(binaryPath) {
  if (!exists(binaryPath)) {
    return [];
  }
  const text = fs.readFileSync(binaryPath).toString("utf8");
  const records = [];
  const seenModels = new Set();
  let index = 0;
  while ((index = text.indexOf("\"base_instructions\"", index)) !== -1) {
    const windowStart = Math.max(0, index - 250000);
    const candidates = [];
    for (let pos = index; pos >= windowStart; pos -= 1) {
      if (text[pos] === "{") {
        candidates.push(pos);
      }
    }
    for (const start of candidates) {
      const end = jsonObjectEndAt(text, start);
      if (end < index || end < 0 || end - start > 600000) {
        continue;
      }
      try {
        const parsed = JSON.parse(text.slice(start, end));
        const record = promptRecordFromObject(parsed);
        if (record && !seenModels.has(normalizePromptName(record.model))) {
          seenModels.add(normalizePromptName(record.model));
          records.push(record);
          break;
        }
      } catch {
        // Keep scanning earlier JSON object starts.
      }
    }
    index += "\"base_instructions\"".length;
  }
  return records;
}

function writeDefaultPromptCatalogAsset(extractDir, resourcesDir) {
  const assetsDir = path.join(extractDir, "webview", "assets");
  const targetRelativePath = path.join("webview", "assets", "codex-native-default-prompts.json");
  const targetPath = path.join(extractDir, targetRelativePath);
  const sourceBinary = path.join(resourcesDir, process.platform === "win32" ? "codex.exe" : "codex");
  const fallbackBinary = path.join(resourcesDir, "codex.exe");
  const records = extractDefaultPromptRecordsFromBinary(exists(sourceBinary) ? sourceBinary : fallbackBinary);
  ensureDir(assetsDir);
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: path.basename(exists(sourceBinary) ? sourceBinary : fallbackBinary),
    count: records.length,
    prompts: records,
  };
  fs.writeFileSync(targetPath, JSON.stringify(payload, null, 2), "utf8");
  return {
    assetRelativePath: targetRelativePath.replace(/\\/g, "/"),
    sourceBinary: payload.source,
    count: records.length,
    models: records.map((record) => record.model),
    scriptBytes: fs.statSync(targetPath).size,
  };
}

function patchWebviewCspLocalConnections(extractDir) {
  const indexPath = path.join(extractDir, "webview", "index.html");
  if (!exists(indexPath)) {
    throw new Error(`Missing Codex webview index: ${indexPath}`);
  }

  const before = fs.readFileSync(indexPath, "utf8");
  const localSources = ["http://127.0.0.1:*", "http://localhost:*"];
  let next = before;
  const encodedConnectSrc = "connect-src &#39;self&#39; https://ab.chatgpt.com https://cdn.openai.com;";
  const plainConnectSrc = "connect-src 'self' https://ab.chatgpt.com https://cdn.openai.com;";
  const additions = localSources.filter((source) => !next.includes(source));
  if (additions.length) {
    if (next.includes(encodedConnectSrc)) {
      next = next.replace(
        encodedConnectSrc,
        `connect-src &#39;self&#39; https://ab.chatgpt.com https://cdn.openai.com ${additions.join(" ")};`
      );
    } else if (next.includes(plainConnectSrc)) {
      next = next.replace(
        plainConnectSrc,
        `connect-src 'self' https://ab.chatgpt.com https://cdn.openai.com ${additions.join(" ")};`
      );
    } else {
      const connectIndex = next.indexOf("connect-src ");
      const contentEnd = connectIndex >= 0 ? next.indexOf('">', connectIndex) : -1;
      const directiveEnd = contentEnd >= 0 ? next.lastIndexOf(";", contentEnd) : -1;
      if (connectIndex < 0 || contentEnd < 0 || directiveEnd < connectIndex) {
        throw new Error("Could not find expected connect-src directive in webview CSP.");
      }
      next = `${next.slice(0, directiveEnd)} ${additions.join(" ")}${next.slice(directiveEnd)}`;
    }
  }
  if (next !== before) {
    fs.writeFileSync(indexPath, next, "utf8");
  }

  return {
    indexRelativePath: "webview/index.html",
    addedSources: additions,
    containsLocalConnectSources: localSources.every((source) => next.includes(source)),
  };
}

function createCoreFeatureVerificationEvidence(featureId, detail = {}) {
  return Object.freeze({
    ok: true,
    featureId,
    phase: String(detail.phase || "unpacked"),
    verification: "manifest-markers-and-host-receipt",
  });
}

function verifyPackedAsar(asarPath, workRoot, options = {}) {
  const verifyDir = path.join(workRoot, "packed-verification");
  ensureDir(verifyDir);
  runAsar(["extract", asarPath, verifyDir]);
  const syntaxCheckedJavaScript = assertJavaScriptPathsSyntax(
    verifyDir,
    options.changedJavaScriptRelativePaths || [],
    "packed app.asar"
  );
  const assetPath = findAppServerManagerAsset(verifyDir);
  const text = fs.readFileSync(assetPath, "utf8");
  const agentSettingsPath = findAgentSettingsAsset(verifyDir);
  const agentSettingsText = fs.readFileSync(agentSettingsPath, "utf8");
  const composerPath = findComposerAsset(verifyDir);
  const composerText = fs.readFileSync(composerPath, "utf8");
  assertJsModuleSyntax(composerPath, "composer model menu asset");
  const localConversationThreadPath = findLocalConversationThreadAsset(verifyDir);
  const localConversationThreadText = fs.readFileSync(localConversationThreadPath, "utf8");
  assertJsModuleSyntax(localConversationThreadPath, "local conversation reasoning renderer asset");
  const homeAmbientSuggestionsContentPath = findHomeAmbientSuggestionsContentAsset(verifyDir);
  const homeAmbientSuggestionsContentText = fs.readFileSync(homeAmbientSuggestionsContentPath, "utf8");
  assertJsModuleSyntax(homeAmbientSuggestionsContentPath, "home ambient suggestions content asset");
  const settingsSectionsPath = findSettingsSectionsAsset(verifyDir);
  const settingsSectionsText = fs.readFileSync(settingsSectionsPath, "utf8");
  const settingsSharedPath = findSettingsSharedAsset(verifyDir);
  const settingsSharedText = fs.readFileSync(settingsSharedPath, "utf8");
  const settingsPagePath = findSettingsPageAsset(verifyDir);
  const settingsPageText = fs.readFileSync(settingsPagePath, "utf8");
  const profileDropdownPath = findProfileDropdownAsset(verifyDir);
  const profileDropdownText = fs.readFileSync(profileDropdownPath, "utf8");
  const appMainPath = findSettingsRouteRegistryAsset(verifyDir);
  const appMainText = fs.readFileSync(appMainPath, "utf8");
  const mainPath = findMainProcessScript(verifyDir);
  const mainText = fs.readFileSync(mainPath, "utf8");
  const preloadPath = findPreloadScript(verifyDir);
  const preloadText = fs.readFileSync(preloadPath, "utf8");
  const orchestratorPath = path.join(verifyDir, "webview", "assets", "codex-native-orchestrator.js");
  const providerSettingsPath = path.join(verifyDir, "webview", "assets", "codex-native-provider-settings.js");
  const importSettingsPath = path.join(verifyDir, "webview", "assets", "codex-native-import-settings.js");
  const patcherSettingsPath = path.join(verifyDir, "webview", "assets", "codex-native-patcher-settings.js");
  const defaultPromptCatalogPath = path.join(verifyDir, "webview", "assets", "codex-native-default-prompts.json");
  const providerSettingsText = exists(providerSettingsPath) ? fs.readFileSync(providerSettingsPath, "utf8") : "";
  const patcherSettingsText = exists(patcherSettingsPath) ? fs.readFileSync(patcherSettingsPath, "utf8") : "";
  const providerSettingsRoutePath = path.join(verifyDir, "webview", "assets", "codex-native-providers-settings-page.js");
  const autoRouterSettingsRoutePath = path.join(verifyDir, "webview", "assets", "codex-native-auto-router-settings-page.js");
  const promptToolsSettingsRoutePath = path.join(verifyDir, "webview", "assets", "codex-native-prompt-tools-settings-page.js");
  const personasSettingsRoutePath = path.join(verifyDir, "webview", "assets", "codex-native-personas-settings-page.js");
  const swarmSettingsRoutePath = path.join(verifyDir, "webview", "assets", "codex-native-swarm-settings-page.js");
  const orchestratorSettingsRoutePath = path.join(verifyDir, "webview", "assets", "codex-native-orchestrations-settings-page.js");
  const importsSettingsRoutePath = path.join(verifyDir, "webview", "assets", "codex-native-imports-settings-page.js");
  const patcherSettingsRoutePath = path.join(verifyDir, "webview", "assets", "codex-native-patcher-settings-page.js");
  const featureDevelopmentSettingsRoutePath = path.join(verifyDir, "webview", "assets", "codex-native-feature-development-settings-page.js");
  const nativeSettingsEnabledGroups = {
    providers: options.enableProviderSettings === true,
    orchestrations: options.enableNativeOrchestrator === true,
    imports: options.enableImportSettings === true,
    patcher: options.enablePatcherSettings === true,
  };
  const nativeSettingsRoutePaths = {
    providers: providerSettingsRoutePath,
    "auto-router": autoRouterSettingsRoutePath,
    "prompt-tools": promptToolsSettingsRoutePath,
    personas: personasSettingsRoutePath,
    swarm: swarmSettingsRoutePath,
    orchestrations: orchestratorSettingsRoutePath,
    imports: importsSettingsRoutePath,
    patcher: patcherSettingsRoutePath,
    "feature-development": featureDevelopmentSettingsRoutePath,
  };
  const indexText = fs.readFileSync(path.join(verifyDir, "webview", "index.html"), "utf8");
  const nativeSettingsComposition = inspectNativeSettingsComposition(
    {
      settingsSectionsText,
      settingsSharedText,
      settingsPageText,
      appMainText,
      routeModuleExists: Object.fromEntries(
        Object.entries(nativeSettingsRoutePaths).map(([routeId, routePath]) => [routeId, exists(routePath)])
      ),
    },
    nativeSettingsEnabledGroups
  );
  const featureModuleVerification = options.resolvedFeatureModules
    ? verifyFeatureModules(options.resolvedFeatureModules, verifyDir, {
        sourceVersion: options.sourceVersion,
        moduleOptions: options.featureModuleOptions,
        verifyCoreFeature: createCoreFeatureVerificationEvidence,
      })
    : [];
  const limit = options.limit;
  const result = {
    syntaxCheckedJavaScript,
    featureModules: featureModuleVerification,
    reasoningSummaryRenderingRequired: options.requireReasoningSummaryRendering === true,
    ambientSuggestionRoleFallbackRequired: options.requireAmbientSuggestionRoleFallback === true,
    assetRelativePath: path.relative(verifyDir, assetPath).replace(/\\/g, "/"),
    containsRefreshPatch: Boolean(
      limit &&
        text.includes("recentConversationHydrationRun") &&
        text.includes(`a<${limit}`) &&
        text.includes("setTimeout(e,16)")
    ),
    containsLoadMorePatch: Boolean(
      limit &&
        text.includes("async loadMoreRecentConversations(){if(!this.hasMoreRecentConversations())return") &&
        text.includes("limit:100,cursor:this.nextRecentConversationCursor") &&
        text.includes("Math.ceil(e.data.length/100)")
    ),
    containsCurrentHistoryLimitPatch: Boolean(
      limit &&
        text.includes(`Math.max(this.params.getHistoryLimit?.()??50,${limit})`) &&
        text.includes("useStateDbOnly:i")
    ),
    containsChatLimitPatch: Boolean(
      limit &&
        ((text.includes("recentConversationHydrationRun") &&
          text.includes(`a<${limit}`) &&
          text.includes("setTimeout(e,16)") &&
          text.includes("Math.ceil(e.data.length/100)")) ||
          (text.includes(`Math.max(this.params.getHistoryLimit?.()??50,${limit})`) &&
            text.includes("useStateDbOnly:i") &&
            text.includes("__codexPatchStudioHistoryHydration")))
    ),
    containsHistoryHydrationDiagnostic:
      text.includes("__codexPatchStudioHistoryHydration") &&
      text.includes("loadedThreadCount:s.data.length") &&
      text.includes("requestedThreadLimit:a"),
    containsReasoningSummaryConversionPatch:
      text.includes("let r=(e??[]).map") &&
      text.includes("typeof e.text===`string`") &&
      text.includes("[t,...n]=r"),
    containsNativeOrchestrator: exists(orchestratorPath) && indexText.includes("codex-native-orchestrator.js"),
    containsProviderSettings: exists(providerSettingsPath) && indexText.includes("codex-native-provider-settings.js"),
    containsAutoRouterSettings:
      providerSettingsText.includes("codex-native-auto-router-settings:v1") &&
      providerSettingsText.includes("Auto Model Router") &&
      providerSettingsText.includes("routeAutoBeforeTurn"),
    containsPromptToolsSettings:
      providerSettingsText.includes("codex-native-prompt-tools-settings:v1") &&
      providerSettingsText.includes("cps-prompt-tools-page") &&
      providerSettingsText.includes("Review prompt viewer") &&
      providerSettingsText.includes("Review prompt test panel") &&
      providerSettingsText.includes("Default prompt viewer") &&
      providerSettingsText.includes("Default prompt editor") &&
      providerSettingsText.includes("Read built-in prompt") &&
      providerSettingsText.includes("model/list") &&
      providerSettingsText.includes("codex-native-default-prompts.json") &&
      providerSettingsText.includes("additionalDeveloperInstructions"),
    containsPersonasSettings:
      providerSettingsText.includes("codex-native-persona-settings:v1") &&
      providerSettingsText.includes("cps-personas-page") &&
      providerSettingsText.includes("Persona Routing") &&
      providerSettingsText.includes("applyPersonaToTurnRequest") &&
      providerSettingsText.includes("Context triggers"),
    containsSwarmSettings:
      providerSettingsText.includes("codex-native-swarm-settings:v1") &&
      providerSettingsText.includes("cps-swarm-page") &&
      providerSettingsText.includes("gemma-4-31b") &&
      providerSettingsText.includes("Swarm Mode"),
    containsDefaultPromptCatalog:
      exists(defaultPromptCatalogPath) &&
      fs.readFileSync(defaultPromptCatalogPath, "utf8").includes("\"defaultPrompt\"") &&
      fs.readFileSync(defaultPromptCatalogPath, "utf8").includes("\"baseInstructions\""),
    containsImportSettings:
      exists(importSettingsPath) &&
      indexText.includes("codex-native-import-settings.js") &&
      fs.readFileSync(importSettingsPath, "utf8").includes("Fix Selected") &&
      fs.readFileSync(importSettingsPath, "utf8").includes("repair-selected") &&
      !fs.readFileSync(importSettingsPath, "utf8").includes("data-import-mode"),
    containsPatcherSettings:
      exists(patcherSettingsPath) &&
      indexText.includes("codex-native-patcher-settings.js") &&
      patcherSettingsText.includes("codex-native-patcher-settings:v1") &&
      patcherSettingsText.includes("Created by Ryan Craighead") &&
      patcherSettingsText.includes("/api/patch/build"),
    containsFeatureDevelopmentSettings:
      exists(patcherSettingsPath) &&
      patcherSettingsText.includes("Feature Development") &&
      patcherSettingsText.includes("/api/patch/feature-development/action") &&
      patcherSettingsText.includes("codex-native-feature-development-settings-route") &&
      exists(featureDevelopmentSettingsRoutePath),
    containsLocalConnectSources: indexText.includes("http://127.0.0.1:*") && indexText.includes("http://localhost:*"),
    containsProviderModelCatalogPatch:
      composerText.includes("function cpsProviderCatalog") &&
      composerText.includes("deepseek-v4-flash") &&
      composerText.includes("gemma-4-31b") &&
      composerText.includes("gpt-oss-120b") &&
      composerText.includes("gpt-5.3-codex-spark") &&
      composerText.includes("codex-native-auto-router-settings:v1") &&
      composerText.includes("cpsSelectedModel") &&
      composerText.includes("selectModelFromNativeMenu") &&
      ((composerText.includes("providerId:r?.providerId") && composerText.includes("cpsProviderCatalog(l?.models,m)")) ||
        (composerText.includes("providerId:i") && composerText.includes("cpsProviderCatalog(o?.models,u)") && composerText.includes("models:c")) ||
        (composerText.includes("providerId:i") && composerText.includes("cpsProviderCatalog(d?.models,b)") && composerText.includes("models:m"))),
    containsReasoningSummaryRenderingPatch:
      localConversationThreadText.includes("function cpReasoningContent") &&
      localConversationThreadText.includes("cpContent=cpReasoningContent(n)") &&
      localConversationThreadText.includes("V_(cpContent)") &&
      localConversationThreadText.includes("U_(cpContent)"),
    containsAmbientSuggestionRoleFallback:
      homeAmbientSuggestionsContentText.includes("return (rt[a]??rt.something_else??[]).flatMap(t=>{") &&
      !homeAmbientSuggestionsContentText.includes("return rt[a].flatMap(t=>{"),
    containsNativeSettingsSections: nativeSettingsComposition.ok,
    nativeSettingsComposition,
    containsNativeNavigationBridge:
      profileDropdownText.includes("__codexNativeNavigate") &&
      profileDropdownText.includes("globalThis.__codexNativeNavigate=(e,t)=>"),
    containsPreloadOutboundInterceptor:
      preloadText.includes("registerSendMessageInterceptor") &&
      preloadText.includes("codexPatchStudioSendMessageInterceptors") &&
      preloadText.includes("for(let n of codexPatchStudioSendMessageInterceptors)"),
    remoteControlSettingsFilterRemoved: !agentSettingsText.includes("&&e.name!==`remote_control`"),
    containsRemoteControlMainProcessPatch:
      mainText.includes("Enabled remote_control in config before app-server start") &&
      mainText.includes("n.remote_control=!0") &&
      /function [A-Za-z_$][\w$]*\(e\)\{return!0\}/.test(mainText) &&
      !mainText.includes("Removed remote_control from config before app-server start"),
    containsForceMainWindowStartupPatch: mainText.includes("/*codex-patch-studio:force-main-window*/"),
    containsAboutPatcherMenuPatch:
      mainText.includes("label:`About Patcher`") &&
      mainText.includes("Created by Ryan Craighead") &&
      mainText.includes("Codex Patcher"),
  };
  const failures = [];
  if (options.enableChatLimit && !result.containsChatLimitPatch) {
    failures.push("chat limit");
  }
  if (!result.containsReasoningSummaryConversionPatch) {
    failures.push("reasoning summary conversion");
  }
  if (options.requireReasoningSummaryRendering && !result.containsReasoningSummaryRenderingPatch) {
    failures.push("reasoning summary rendering");
  }
  if (options.requireAmbientSuggestionRoleFallback && !result.containsAmbientSuggestionRoleFallback) {
    failures.push("ambient suggestion role fallback");
  }
  if (options.enableNativeOrchestrator && !result.containsNativeOrchestrator) {
    failures.push("native orchestrator");
  }
  if (options.enableProviderSettings && !result.containsProviderSettings) {
    failures.push("provider settings");
  }
  if (options.enableProviderSettings && !result.containsAutoRouterSettings) {
    failures.push("auto router provider settings");
  }
  if (options.enableProviderSettings && !result.containsPromptToolsSettings) {
    failures.push("prompt tools provider settings");
  }
  if (options.enableProviderSettings && !result.containsPersonasSettings) {
    failures.push("personas provider settings");
  }
  if (options.enableProviderSettings && !result.containsSwarmSettings) {
    failures.push("swarm provider settings");
  }
  if (options.enableProviderSettings && !result.containsDefaultPromptCatalog) {
    failures.push("default prompt catalog");
  }
  if (options.enableImportSettings && !result.containsImportSettings) {
    failures.push("import settings");
  }
  if (options.enablePatcherSettings && !result.containsPatcherSettings) {
    failures.push("patcher settings");
  }
  if (options.enablePatcherSettings && !result.containsFeatureDevelopmentSettings) {
    failures.push("feature development settings");
  }
  if ((options.enableImportSettings || options.enableProviderSettings || options.enablePatcherSettings) && !result.containsLocalConnectSources) {
    failures.push("local webview connect-src");
  }
  if (options.enableProviderSettings && !result.containsProviderModelCatalogPatch) {
    failures.push("provider model catalog");
  }
  if (!result.containsNativeSettingsSections) {
    failures.push(
      `native settings sections (missing: ${nativeSettingsComposition.missingEnabledRoutes.join(", ") || "none"}; unexpected: ${nativeSettingsComposition.unexpectedDisabledRoutes.join(", ") || "none"})`
    );
  }
  if (options.enableProviderSettings && !result.containsPreloadOutboundInterceptor) {
    failures.push("preload outbound message interceptor");
  }
  if ((options.enableProviderSettings || options.enableNativeOrchestrator || options.enableImportSettings || options.enablePatcherSettings) && !result.containsNativeNavigationBridge) {
    failures.push("native navigation bridge");
  }
  if (options.enableRemoteControlSettings && !result.remoteControlSettingsFilterRemoved) {
    failures.push("remote_control settings");
  }
  if (options.enableRemoteControl && !result.containsRemoteControlMainProcessPatch) {
    failures.push("remote_control main process");
  }
  if (options.forceMainWindowStartup && !result.containsForceMainWindowStartupPatch) {
    failures.push("force main window startup");
  }
  if (options.enablePatcherSettings && !result.containsAboutPatcherMenuPatch) {
    failures.push("About Patcher menu");
  }
  if (failures.length) {
    throw new Error(`Packed app.asar verification failed: ${JSON.stringify(result)}`);
  }
  return result;
}

function disableAsarIntegrityFuse(codexExe) {
  let before;
  try {
    before = runFuses(["read", "--app", codexExe]);
  } catch (error) {
    if (String(error?.message || error).includes("Could not find sentinel in the provided Electron binary")) {
      return {
        before: "",
        after: "",
        skipped: true,
        reason: "Electron fuse sentinel was not present in this Codex executable.",
      };
    }
    throw error;
  }
  runFuses(["write", "--app", codexExe, "EnableEmbeddedAsarIntegrityValidation=off"]);
  const after = runFuses(["read", "--app", codexExe]);
  if (!after.includes("EnableEmbeddedAsarIntegrityValidation is Disabled")) {
    throw new Error(`Failed to disable ASAR integrity fuse on ${codexExe}.\n${after}`);
  }
  return { before, after };
}

function writeJson(filePath, value) {
  writeJsonAtomic(filePath, value);
}

function selectedFeatures(options) {
  return {
    catalogShim: Boolean(options.enableCatalogShim),
    chatLimit: Boolean(options.enableChatLimit),
    remoteControl: Boolean(options.enableRemoteControl),
    remoteControlSettings: Boolean(options.enableRemoteControlSettings),
    nativeOrchestrator: Boolean(options.enableNativeOrchestrator),
    providerSettings: Boolean(options.enableProviderSettings),
    importSettings: Boolean(options.enableImportSettings),
    patcherSettings: Boolean(options.enablePatcherSettings),
    reasoningSummaryConversion: true,
    reasoningSummaryRendering: true,
    ambientSuggestionRoleFallback: true,
    forceMainWindowStartup: Boolean(options.forceMainWindowStartup),
    shortcut: Boolean(options.createShortcut),
  };
}

function selectedCoreFeatureModules(options) {
  const customSettingsEnabled =
    options.enableNativeOrchestrator ||
    options.enableProviderSettings ||
    options.enableImportSettings ||
    options.enablePatcherSettings;
  return new Map([
    ["core.history", Boolean(options.enableCatalogShim)],
    ["core.eager-history", Boolean(options.enableChatLimit)],
    ["core.remote-control", Boolean(options.enableRemoteControl || options.enableRemoteControlSettings)],
    ["core.settings-shell", Boolean(customSettingsEnabled)],
    ["core.reasoning-compat", true],
    ["core.provider-suite", Boolean(options.enableProviderSettings)],
    ["core.orchestrations", Boolean(options.enableNativeOrchestrator)],
    ["core.imports", Boolean(options.enableImportSettings)],
    ["core.patcher-ui", Boolean(options.enablePatcherSettings)],
    ["core.force-main-window", Boolean(options.forceMainWindowStartup)],
  ]);
}

function cloneNameFor(source, options) {
  const historicalDefault =
    !options.enableCatalogShim &&
    options.enableChatLimit &&
    options.enableRemoteControl &&
    options.enableRemoteControlSettings &&
    options.enableNativeOrchestrator &&
    options.enableProviderSettings &&
    options.enableImportSettings &&
    options.enablePatcherSettings &&
    !options.forceMainWindowStartup;

  if (historicalDefault) {
    return `Codex-${source.version}-limit-${options.limit}`;
  }

  const parts = [];
  if (options.enableCatalogShim) parts.push("all-chats-shim");
  parts.push(options.enableChatLimit ? `limit-${options.limit}` : "native-limit");
  if (options.enableRemoteControl) parts.push("remote");
  if (options.enableRemoteControlSettings) parts.push("remote-settings");
  if (options.enableNativeOrchestrator) parts.push("orchestrator");
  if (options.enableProviderSettings) parts.push("providers");
  if (options.enableImportSettings) parts.push("imports");
  if (options.enablePatcherSettings) parts.push("patcher");
  if (options.forceMainWindowStartup) parts.push("startup");
  if (!parts.length) parts.push("plain");
  return `Codex-${source.version}-${parts.join("-")}`;
}

function createLaunchShortcut({ codexExe, options }) {
  if (!options.createShortcut) {
    return null;
  }
  if (process.platform !== "win32") {
    return null;
  }

  const scriptPath = path.join(rootDir, "scripts", "create-patched-codex-shortcut.ps1");
  if (!exists(scriptPath)) {
    throw new Error(`Missing shortcut helper: ${scriptPath}`);
  }

  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-ShortcutName",
    options.shortcutName,
    "-LauncherScript",
    path.join(rootDir, "scripts", "launch-patched-codex.ps1"),
    "-IconPath",
    codexExe,
    "-WorkingDirectory",
    rootDir,
  ];
  if (options.shortcutDir) {
    args.push("-ShortcutDirectory", options.shortcutDir);
  }

  const result = spawnSync("powershell.exe", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      [
        `Failed to create patched Codex shortcut with exit code ${result.status}`,
        result.stdout ? `stdout:\n${result.stdout}` : "",
        result.stderr ? `stderr:\n${result.stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  try {
    return JSON.parse(String(result.stdout || "").trim());
  } catch (error) {
    throw new Error(`Shortcut helper returned invalid JSON: ${error.message}\n${result.stdout || ""}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  let source;
  let sourceMode;
  if (options.sourceAppDir) {
    source = sourceFromAppDir(options.sourceAppDir, options.sourceAsar, "manual");
    sourceMode = "manual";
  } else {
    source = findInstalledCodexAppDir();
    sourceMode = "current-installed";
  }

  if (!exists(source.asarPath)) {
    throw new Error(`Missing source app.asar: ${source.asarPath}`);
  }

  const sourceDesktopExecutable = findDesktopExecutable(source.appDir);
  const sourceAppServerCli = findAppServerCli(source.appDir);
  const compatibility = compatibilityForSource(source);
  const patcherSource = patcherFingerprint(rootDir);
  const sourceAsarSha256 = sha256File(source.asarPath);
  const sourceDesktopExeSha256 = sha256File(sourceDesktopExecutable.filePath);
  const sourceAppServerCliSha256 = sha256File(sourceAppServerCli);
  compatibility.matchesRecordedHash = Boolean(
    compatibility.validatedBuild &&
      String(compatibility.validatedBuild.appAsarSha256 || "").toLowerCase() === sourceAsarSha256 &&
      String(compatibility.validatedBuild.desktopExecutableName || sourceDesktopExecutable.name).toLowerCase() ===
        sourceDesktopExecutable.name.toLowerCase() &&
      String(compatibility.validatedBuild.desktopExeSha256 || compatibility.validatedBuild.codexExeSha256 || "").toLowerCase() ===
        sourceDesktopExeSha256
  );

  const features = selectedFeatures(options);
  const selectedCoreModules = selectedCoreFeatureModules(options);
  const featureCatalog = discoverFeatureModules(rootDir, projectConfig);
  const resolvedFeatureModules = resolveFeatureModules(featureCatalog, {
    sourceVersion: source.version,
    featureModules: projectConfig.featureModules,
    enabledIds: [
      ...options.enabledFeatureModules,
      ...[...selectedCoreModules].filter(([, enabled]) => enabled).map(([id]) => id),
    ],
    disabledIds: [...selectedCoreModules].filter(([, enabled]) => !enabled).map(([id]) => id),
    includeExternalModules: options.enableFeatureModules,
    builtinFeatures: features,
  });
  const featureModuleCatalog = featureCatalog.records.map((record) =>
    publicFeatureRecord(record, resolvedFeatureModules.enabledIds.includes(record.id))
  );
  const cloneName = cloneNameFor(source, options);
  const buildIdentity = `${sourceAsarSha256.slice(0, 8)}-${patcherSource.sha256.slice(0, 8)}`;
  const buildStamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const buildNonce = crypto.randomBytes(3).toString("hex");
  // Every build gets a new immutable destination. The launcher config is switched
  // only after packed verification succeeds, so a failed update cannot damage the
  // last verified clone.
  const cloneRoot = path.join(options.outputRoot, `${cloneName}-build-${buildIdentity}-${buildStamp}-${buildNonce}`);
  const targetAppDir = path.join(cloneRoot, "app");
  const targetResourcesDir = path.join(targetAppDir, "resources");
  const targetAsarPath = path.join(targetResourcesDir, "app.asar");
  const originalAsarPath = path.join(targetResourcesDir, "app.asar.original");
  const workRoot = path.join(options.outputRoot, `.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const extractDir = path.join(workRoot, "app.asar.extracted");

  ensureDir(options.outputRoot);
  assertInside(options.outputRoot, cloneRoot, "clone root");
  assertInside(options.outputRoot, workRoot, "work root");
  assertInside(options.outputRoot, targetAppDir, "target app dir");

  fs.rmSync(targetAppDir, { recursive: true, force: true });
  runRobocopy(source.appDir, targetAppDir);
  fs.copyFileSync(source.asarPath, targetAsarPath);
  fs.copyFileSync(source.asarPath, originalAsarPath);
  if (!exists(originalAsarPath)) {
    fs.copyFileSync(targetAsarPath, originalAsarPath);
  }

  ensureDir(extractDir);
  runAsar(["extract", targetAsarPath, extractDir]);
  const baselineJavaScriptHashes = snapshotJavaScriptHashes(extractDir);
  const assetPath = findAppServerManagerAsset(extractDir);
  const coreOperationDefinitions = new Map([
    ["history.catalog-shim", { owner: "core.history", run: () => Boolean(options.enableCatalogShim) }],
    ["eager-history.patch-loader", { owner: "core.eager-history", run: () => patchAsset(assetPath, options.limit) }],
    [
      "remote-control.main-process",
      {
        owner: "core.remote-control",
        run: () => options.enableRemoteControl ? patchMainProcess(extractDir, { enableRemoteControl: true }) : null,
      },
    ],
    [
      "remote-control.settings",
      {
        owner: "core.remote-control",
        run: () => options.enableRemoteControlSettings ? patchRemoteControlSettingsVisibility(extractDir) : null,
      },
    ],
    [
      "force-main-window.main-process",
      { owner: "core.force-main-window", run: () => patchMainProcess(extractDir, { forceMainWindowStartup: true }) },
    ],
    [
      "reasoning-compat.summary-conversion",
      { owner: "core.reasoning-compat", run: () => patchReasoningSummaryConversion(extractDir) },
    ],
    [
      "reasoning-compat.summary-rendering",
      { owner: "core.reasoning-compat", run: () => patchReasoningSummaryRendering(extractDir) },
    ],
    [
      "reasoning-compat.ambient-role",
      { owner: "core.reasoning-compat", run: () => patchAmbientSuggestionRoleFallback(extractDir) },
    ],
    [
      "settings-shell.navigation",
      { owner: "core.settings-shell", run: () => patchCurrentNavigationBridge(extractDir) },
    ],
    [
      "settings-shell.sections",
      {
        owner: "core.settings-shell",
        run: () => patchNativeSettingsSections(extractDir, {
          providers: options.enableProviderSettings,
          orchestrations: options.enableNativeOrchestrator,
          imports: options.enableImportSettings,
          patcher: options.enablePatcherSettings,
        }),
      },
    ],
    [
      "settings-shell.csp",
      { owner: "core.settings-shell", run: () => patchWebviewCspLocalConnections(extractDir) },
    ],
    [
      "provider-suite.catalog",
      { owner: "core.provider-suite", run: () => patchComposerProviderModels(extractDir) },
    ],
    [
      "provider-suite.preload",
      { owner: "core.provider-suite", run: () => patchPreloadOutboundInterceptor(extractDir) },
    ],
    [
      "provider-suite.settings",
      { owner: "core.provider-suite", run: () => injectProviderSettings(extractDir) },
    ],
    [
      "provider-suite.prompt-catalog",
      { owner: "core.provider-suite", run: () => writeDefaultPromptCatalogAsset(extractDir, targetResourcesDir) },
    ],
    ["orchestrations.inject", { owner: "core.orchestrations", run: () => injectNativeOrchestrator(extractDir) }],
    ["imports.inject", { owner: "core.imports", run: () => injectImportSettings(extractDir) }],
    [
      "patcher-ui.main-process",
      { owner: "core.patcher-ui", run: () => patchMainProcess(extractDir, { enableAboutPatcher: true }) },
    ],
    ["patcher-ui.settings", { owner: "core.patcher-ui", run: () => injectPatcherSettings(extractDir) }],
  ]);
  const coreOperationResults = new Map();
  const runCoreOperation = (featureId, operationId) => {
    const definition = coreOperationDefinitions.get(operationId);
    if (!definition) throw new Error(`${featureId}: unknown core patch operation ${operationId}.`);
    if (definition.owner !== featureId) {
      throw new Error(`${featureId}: core patch operation ${operationId} is owned by ${definition.owner}.`);
    }
    if (!coreOperationResults.has(operationId)) coreOperationResults.set(operationId, definition.run());
    return coreOperationResults.get(operationId);
  };
  const featureModuleApplication = applyFeatureModules(resolvedFeatureModules, extractDir, {
    sourceVersion: source.version,
    moduleOptions: projectConfig.featureModuleOptions,
    runCoreOperation,
    verifyCoreFeature: createCoreFeatureVerificationEvidence,
  });
  const featureModuleResults = new Map(featureModuleApplication.map((record) => [record.id, record.result || {}]));
  const eagerHistoryStep = featureModuleResults.get("core.eager-history") || {};
  const remoteControlStep = featureModuleResults.get("core.remote-control") || {};
  const reasoningStep = featureModuleResults.get("core.reasoning-compat") || {};
  const settingsShellStep = featureModuleResults.get("core.settings-shell") || {};
  const providerSuiteStep = featureModuleResults.get("core.provider-suite") || {};
  const orchestrationsStep = featureModuleResults.get("core.orchestrations") || {};
  const importsStep = featureModuleResults.get("core.imports") || {};
  const patcherUiStep = featureModuleResults.get("core.patcher-ui") || {};
  const patchResult = eagerHistoryStep.patchResult || null;
  const remoteControlMainProcess = remoteControlStep.mainProcess || null;
  const remoteControlSettings = remoteControlStep.settings || null;
  const providerModelCatalog = providerSuiteStep.providerModelCatalog || null;
  const preloadOutboundInterceptor = providerSuiteStep.preloadOutboundInterceptor || null;
  const reasoningSummaryConversion = reasoningStep.summaryConversion || { skipped: true, assetRelativePath: null };
  const reasoningSummaryRendering = reasoningStep.summaryRendering || { skipped: true, assetRelativePath: null };
  const ambientSuggestionRoleFallback = reasoningStep.ambientSuggestionRoleFallback || { skipped: true, assetRelativePath: null };
  const nativeNavigationBridge = settingsShellStep.navigationBridge || null;
  const nativeSettingsSections = settingsShellStep.settingsSections || null;
  const localConnectSrc = settingsShellStep.localConnectSrc || null;
  const patcherSettings = patcherUiStep.patcherSettings || null;
  const nativeOrchestrator = orchestrationsStep.nativeOrchestrator || null;
  const providerSettings = providerSuiteStep.providerSettings || null;
  const importSettings = importsStep.importSettings || null;
  const defaultPromptCatalog = providerSuiteStep.defaultPromptCatalog || null;
  const changedJavaScriptRelativePaths = changedJavaScriptPaths(extractDir, baselineJavaScriptHashes);
  assertJavaScriptPathsSyntax(extractDir, changedJavaScriptRelativePaths, "patched app.asar source");
  fs.rmSync(targetAsarPath, { force: true });
  runAsar(["pack", extractDir, targetAsarPath]);
  const packedVerification = verifyPackedAsar(targetAsarPath, workRoot, {
    limit: options.limit,
    enableChatLimit: options.enableChatLimit,
    enableRemoteControl: options.enableRemoteControl,
    enableRemoteControlSettings: options.enableRemoteControlSettings,
    enableNativeOrchestrator: options.enableNativeOrchestrator,
    enableProviderSettings: options.enableProviderSettings,
    enableImportSettings: options.enableImportSettings,
    enablePatcherSettings: options.enablePatcherSettings,
    forceMainWindowStartup: options.forceMainWindowStartup,
    sourceVersion: source.version,
    resolvedFeatureModules,
    featureModuleOptions: projectConfig.featureModuleOptions,
    changedJavaScriptRelativePaths,
    requireReasoningSummaryRendering: reasoningSummaryRendering.skipped !== true,
    requireAmbientSuggestionRoleFallback: ambientSuggestionRoleFallback.skipped !== true,
  });

  const codexExe = path.join(targetAppDir, sourceDesktopExecutable.name);
  const appServerCli = path.join(targetResourcesDir, "codex.exe");
  if (!exists(appServerCli) || sha256File(appServerCli) !== sourceAppServerCliSha256) {
    throw new Error("The cloned Codex app-server CLI is missing or changed during the build.");
  }
  const fuseResult = disableAsarIntegrityFuse(codexExe);
  // Keep browser auth/storage outside versioned clones so rebuilds do not log the patched app out.
  const stableProfileRoot = path.dirname(options.outputRoot);
  const electronUserDataPath = path.join(stableProfileRoot, "electron-user-data");
  assertInside(stableProfileRoot, electronUserDataPath, "electron user-data path");
  fs.mkdirSync(stableProfileRoot, { recursive: true });
  const launcherConfig = {
    version: 2,
    mode: "patched-clone",
    productName: projectConfig.productName || "Codex Patch Studio Current",
    limit: options.limit,
    features,
    featureModules: featureModuleCatalog,
    builtAt: new Date().toISOString(),
    sourceMode,
    cloneBaseName: cloneName,
    buildIdentity,
    sourceVersion: source.version,
    sourcePackageDirName: source.packageDirName,
    sourceAppDir: source.appDir,
    sourceAsarPath: source.asarPath,
    sourceAsarSha256,
    sourceDesktopExecutableName: sourceDesktopExecutable.name,
    sourceDesktopExeSha256,
    sourceAppServerCliSha256,
    compatibility,
    patcherSource,
    updatePolicy: ["off", "notify", "auto"].includes(String(projectConfig.updatePolicy || "").toLowerCase())
      ? String(projectConfig.updatePolicy).toLowerCase()
      : projectConfig.autoRebuildOnLaunch === false
        ? "off"
        : "notify",
    updatePolicyConfigured: projectConfig.updatePolicyConfigured === true,
    autoRebuildOnLaunch: String(projectConfig.updatePolicy || "").toLowerCase() === "auto",
    outputRoot: options.outputRoot,
    forceMainWindowStartup: options.forceMainWindowStartup,
    cloneRoot,
    appDir: targetAppDir,
    resourcesDir: targetResourcesDir,
    codexExe,
    catalogShim: {
      enabled: Boolean(options.enableCatalogShim),
      implementation: "lazy-thread-list-cursor-proxy",
      sourceProject: "https://github.com/RyanCraighead/codex-all-chats-shim",
      upstreamCli: appServerCli,
      upstreamCliSha256: sourceAppServerCliSha256,
      basePort: Number(projectConfig.catalogShimPort || 47851),
      maxThreads: Number(projectConfig.catalogShimMaxThreads || 10000),
    },
    electronUserDataPath,
    appAsar: targetAsarPath,
    originalAppAsarBackup: originalAsarPath,
    patchedAssetRelativePath: patchResult ? path.relative(extractDir, assetPath).replace(/\\/g, "/") : null,
    nativeOrchestratorRelativePath: nativeOrchestrator?.scriptRelativePath || null,
    providerSettingsRelativePath: providerSettings?.scriptRelativePath || null,
    importSettingsRelativePath: importSettings?.scriptRelativePath || null,
    patcherSettingsRelativePath: patcherSettings?.scriptRelativePath || null,
    defaultPromptCatalogRelativePath: defaultPromptCatalog?.assetRelativePath || null,
    localConnectSrcRelativePath: localConnectSrc?.indexRelativePath || null,
    nativeSettingsSectionsRelativePath: nativeSettingsSections?.settingsPageRelativePath || null,
    nativeNavigationBridgeRelativePath: nativeNavigationBridge?.assetRelativePath || null,
    preloadOutboundInterceptorRelativePath: preloadOutboundInterceptor?.preloadRelativePath || null,
    providerModelCatalogRelativePath: providerModelCatalog?.assetRelativePath || null,
    reasoningSummaryConversionRelativePath: reasoningSummaryConversion.assetRelativePath,
    reasoningSummaryRenderingRelativePath: reasoningSummaryRendering.assetRelativePath,
    ambientSuggestionRoleFallbackRelativePath: ambientSuggestionRoleFallback.assetRelativePath,
    syntaxCheckedJavaScriptRelativePaths: changedJavaScriptRelativePaths,
    remoteControlMainProcessRelativePath: remoteControlMainProcess?.mainRelativePath || null,
    remoteControlSettingsRelativePath: remoteControlSettings?.assetRelativePath || null,
  };
  const launchShortcut = createLaunchShortcut({ codexExe, options });
  if (launchShortcut?.ShortcutPath) {
    launcherConfig.shortcutPath = launchShortcut.ShortcutPath;
    launcherConfig.shortcutName = options.shortcutName;
    launcherConfig.shortcutCreatedAt = new Date().toISOString();
  }
  launcherConfig.candidateFinalizedAt = new Date().toISOString();
  const patchManifestPath = path.join(cloneRoot, "patch-manifest.json");
  const patchManifest = {
    ...launcherConfig,
    launchShortcut,
    patchResult,
    remoteControlMainProcess,
    remoteControlSettings,
    providerModelCatalog,
    nativeNavigationBridge,
    preloadOutboundInterceptor,
    nativeSettingsSections,
    nativeOrchestrator,
    providerSettings,
    importSettings,
    patcherSettings,
    defaultPromptCatalog,
    localConnectSrc,
    reasoningSummaryConversion,
    reasoningSummaryRendering,
    ambientSuggestionRoleFallback,
    featureModuleApplication,
    packedVerification,
    fuseResult,
  };
  writeJson(patchManifestPath, patchManifest);
  const finalizedManifest = readJsonSafe(patchManifestPath);
  if (
    !exists(codexExe) ||
    !exists(targetAsarPath) ||
    !finalizedManifest?.packedVerification ||
    finalizedManifest.cloneRoot !== cloneRoot ||
    finalizedManifest.codexExe !== codexExe
  ) {
    throw new Error("Candidate finalization failed before launcher promotion.");
  }
  promoteVerifiedJson(launcherConfigPath, launcherConfig, () => ({
    packedVerification,
    patchManifestPath,
    candidateFinalizedAt: launcherConfig.candidateFinalizedAt,
  }));

  if (!options.keepWork) {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }

  const result = {
    ok: true,
    limit: options.limit,
    features,
    featureModules: featureModuleCatalog,
    sourceMode,
    sourceVersion: source.version,
    sourceAppDir: source.appDir,
    sourceAsarPath: source.asarPath,
    sourceAsarSha256,
    sourceDesktopExecutableName: sourceDesktopExecutable.name,
    sourceDesktopExeSha256,
    sourceAppServerCliSha256,
    compatibility,
    patcherSource,
    updatePolicy: launcherConfig.updatePolicy,
    forceMainWindowStartup: options.forceMainWindowStartup,
    cloneRoot,
    codexExe,
    launcherConfigPath,
    originalAsarPath,
    electronUserDataPath,
    patchedAsset: launcherConfig.patchedAssetRelativePath,
    nativeOrchestrator,
    providerSettings,
    importSettings,
    patcherSettings,
    defaultPromptCatalog,
    localConnectSrc,
    nativeNavigationBridge,
    preloadOutboundInterceptor,
    nativeSettingsSections,
    providerModelCatalog,
    reasoningSummaryConversion,
    reasoningSummaryRendering,
    ambientSuggestionRoleFallback,
    featureModuleApplication,
    remoteControlMainProcess,
    remoteControlSettings,
    launchShortcut,
    patchResult,
    packedVerification,
    fuseResult: {
      after: fuseResult.after,
    },
    workRoot: options.keepWork ? workRoot : null,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

try {
  withBuildLockSync(rootDir, main);
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
