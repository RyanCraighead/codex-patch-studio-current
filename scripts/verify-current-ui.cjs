#!/usr/bin/env node

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const WebSocket = require("ws");

const port = Number(process.argv[2] || process.env.CODEX_PATCHED_REMOTE_DEBUGGING_PORT || 9229);
const root = path.resolve(__dirname, "..");
const launcherPath = path.resolve(
  process.env.CODEX_PATCHED_LAUNCHER_CONFIG || path.join(root, "codex-launcher.local.json"),
);
const launcher = JSON.parse(fs.readFileSync(launcherPath, "utf8").replace(/^\uFEFF/, ""));
const outputDir = path.join(root, ".tmp", "ui-smoke");
fs.mkdirSync(outputDir, { recursive: true });

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

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pageTarget() {
  let targets = null;
  let lastError = null;
  for (const host of ["127.0.0.1", "localhost"]) {
    try {
      const response = await fetch(`http://${host}:${port}/json/list`);
      if (!response.ok) throw new Error(`CDP endpoint returned ${response.status}.`);
      targets = await response.json();
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!targets) {
    const detail = lastError?.message ? ` Last error: ${lastError.message}` : "";
    throw new Error(
      `Codex CDP is unavailable on port ${port}. Set CODEX_PATCHED_REMOTE_DEBUGGING_PORT=${port} and relaunch the patched app before running test:ui.${detail}`,
    );
  }
  const target = targets.find((entry) => entry.type === "page" && entry.url === "app://-/index.html") || targets[0];
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`No Codex page target is exposed by CDP on port ${port}. Relaunch the patched app and retry.`);
  }
  return target;
}

async function waitForCatalogShim(timeoutMs = 60_000) {
  const basePort = Number(launcher.catalogShim?.basePort || 47851);
  const expectedSourceSha256 = sha256(path.join(root, "scripts", "codex-all-chats-shim.cjs"));
  const expectedUpstreamCli = launcher.catalogShim?.upstreamCli;
  const expectedCliSha256 = launcher.sourceAppServerCliSha256;
  const expectedMaxThreads = Number(launcher.catalogShim?.maxThreads || 10000);
  const deadline = Date.now() + timeoutMs;
  let health = null;
  while (Date.now() < deadline) {
    for (let shimPort = basePort; shimPort < basePort + 50; shimPort += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${shimPort}/health`, {
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
    await delay(1_000);
  }
  return health;
}

class CdpClient {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime evaluation failed.");
    return result.result?.value;
  }

  close() {
    this.ws.close();
  }
}

function normalizedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function screenshot(client, name) {
  const result = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const filePath = path.join(outputDir, `${name}.png`);
  fs.writeFileSync(filePath, Buffer.from(result.data, "base64"));
  return filePath;
}

async function pressEscape(client) {
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
}

async function openSettingsShortcut(client) {
  const modifiers = 2;
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
    modifiers,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: ",",
    code: "Comma",
    windowsVirtualKeyCode: 188,
    modifiers,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: ",",
    code: "Comma",
    windowsVirtualKeyCode: 188,
    modifiers,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
  });
  await delay(1800);
}

async function clickByText(client, label) {
  return client.evaluate(`(() => {
    const wanted = ${JSON.stringify(label.toLowerCase())};
    const candidates = [...document.querySelectorAll('[role="menuitem"],button,a,[role="button"],[role="link"]')]
      .filter((item) => item.getClientRects().length > 0 && getComputedStyle(item).visibility !== 'hidden');
    const matches = candidates.filter((item) => {
      const text = (item.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      return text === wanted || (wanted.endsWith('s') && text === wanted.slice(0, -1));
    });
    const element = matches.find((item) => item.getAttribute('role') === 'menuitem') || matches[0];
    if (!element) return { clicked: false, candidates: candidates.map((item) => (item.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 120) };
    element.click();
    return { clicked: true, tag: element.tagName, text: element.textContent.trim() };
  })()`);
}

async function clickByTitle(client, title) {
  return client.evaluate(`(() => {
    const wanted = ${JSON.stringify(title.toLowerCase())};
    const element = [...document.querySelectorAll('[title]')].find((item) =>
      (item.getAttribute('title') || '').trim().toLowerCase() === wanted && item.getClientRects().length > 0
    );
    if (!element) return { clicked: false };
    element.click();
    return { clicked: true, tag: element.tagName, title: element.getAttribute('title') || '' };
  })()`);
}

async function clickByAriaLabel(client, label) {
  return client.evaluate(`(() => {
    const wanted = ${JSON.stringify(label.toLowerCase())};
    const candidates = [...document.querySelectorAll('[aria-label]')];
    const element = candidates.find((item) => (item.getAttribute('aria-label') || '').trim().toLowerCase() === wanted);
    if (!element) return { clicked: false };
    element.click();
    return { clicked: true, tag: element.tagName, ariaLabel: element.getAttribute('aria-label') || '' };
  })()`);
}

async function clickNativeSettingsMenuItem(client) {
  return client.evaluate(`(() => {
    const candidates = [...document.querySelectorAll('[role="menuitem"],button,a,[role="button"],[role="link"]')]
      .filter((item) => item.getClientRects().length > 0 && getComputedStyle(item).visibility !== 'hidden')
      .filter((item) => !item.closest('[id^="codex-native-"]'))
      .filter((item) => (item.getAttribute('aria-label') || '').toLowerCase() !== 'open profile menu');
    const matches = candidates.filter((item) => /^settings?$/i.test((item.textContent || '').replace(/\\s+/g, ' ').trim()));
    const element = matches.find((item) => item.getAttribute('role') === 'menuitem') || matches.at(-1);
    if (!element) {
      return {
        clicked: false,
        candidates: candidates.map((item) => ({
          tag: item.tagName,
          role: item.getAttribute('role') || '',
          text: (item.textContent || '').replace(/\\s+/g, ' ').trim(),
          ariaLabel: item.getAttribute('aria-label') || ''
        })).filter((item) => /setting|preference|account|profile/i.test(item.text + ' ' + item.ariaLabel)).slice(0, 40)
      };
    }
    element.click();
    return { clicked: true, tag: element.tagName, role: element.getAttribute('role') || '', text: (element.textContent || '').trim() };
  })()`);
}

async function snapshot(client, name) {
  const state = await client.evaluate(`(() => ({
    href: location.href,
    title: document.title,
    text: document.body?.innerText || '',
    globals: {
      providers: Boolean(window.__codexNativeProviderSettings),
      orchestrator: Boolean(window.__codexNativeOrchestrator),
      imports: Boolean(window.__codexNativeImportSettings),
      patcher: Boolean(window.__codexNativePatcherSettings),
      featureDevelopment: typeof window.__codexNativePatcherSettings?.openSettingsRoute === 'function',
      preloadInterceptor: typeof window.electronBridge?.registerSendMessageInterceptor === 'function',
      historyHydration: window.__codexPatchStudioHistoryHydration || null
    },
    customHosts: [...document.querySelectorAll('[id^="codex-native-"]')].map((element) => element.id),
    clickables: [...document.querySelectorAll('button,a,[role="button"],[role="link"]')].map((element) => ({
      tag: element.tagName,
      text: (element.textContent || '').replace(/\s+/g, ' ').trim(),
      ariaLabel: element.getAttribute('aria-label') || '',
      title: element.getAttribute('title') || '',
      href: element.getAttribute('href') || ''
    })).filter((item) => item.text || item.ariaLabel || item.title || item.href).slice(0, 240),
    bottomElements: [20, 60, 120, 180, 240, 300].flatMap((x) =>
      document.elementsFromPoint(x, Math.max(0, innerHeight - 24)).slice(0, 4).map((element) => ({
        x,
        tag: element.tagName,
        text: (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        ariaLabel: element.getAttribute?.('aria-label') || '',
        role: element.getAttribute?.('role') || '',
        className: typeof element.className === 'string' ? element.className.slice(0, 180) : ''
      }))
    )
  }))()`);
  const imagePath = await screenshot(client, name);
  return { ...state, text: normalizedText(state.text), imagePath };
}

async function main() {
  const target = await pageTarget();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.open();
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await delay(1200);

  const catalogShimEnabled = launcher.features?.catalogShim === true && launcher.catalogShim?.enabled === true;
  const hydrationDeadline = Date.now() + 60_000;
  let hydration = null;
  let catalogShim = null;
  while (!catalogShimEnabled && Date.now() < hydrationDeadline) {
    hydration = await client.evaluate("globalThis.__codexPatchStudioHistoryHydration || null");
    if (hydration && hydration.requestedThreadLimit === 1000 && hydration.loadedThreadCount >= 1) break;
    await delay(1_000);
  }
  if (catalogShimEnabled) catalogShim = await waitForCatalogShim();

  const results = { target: { title: target.title, url: target.url }, catalogShim, views: {} };
  const navigationBridgeReady = await client.evaluate(`typeof globalThis.__codexNativeNavigate === 'function'`);
  if (!navigationBridgeReady) throw new Error("Current Codex navigation bridge did not initialize.");
  await client.evaluate(`globalThis.__codexNativeNavigate('/')`);
  await delay(1800);
  results.views.main = await snapshot(client, "01-main");
  const visibleSettingsRoutes = results.views.main.customHosts.filter((id) => /settings-route$/.test(id));
  if (visibleSettingsRoutes.length > 0) {
    throw new Error(`Main view remained on a settings route: ${visibleSettingsRoutes.join(", ")}`);
  }
  for (const enabled of Object.entries(results.views.main.globals)) {
    if (enabled[0] !== "historyHydration" && !enabled[1]) throw new Error(`Native payload did not initialize: ${enabled[0]}`);
  }
  hydration = results.views.main.globals.historyHydration;
  if (catalogShimEnabled && (!catalogShim || catalogShim.service !== "codex-all-chats-shim" || catalogShim.lastCatalogCount < 1)) {
    throw new Error(`Native all-chats catalog shim did not report a valid runtime result: ${JSON.stringify(catalogShim)}`);
  }
  if (!catalogShimEnabled && (!hydration || hydration.requestedThreadLimit !== 1000 || hydration.loadedThreadCount < 1)) {
    throw new Error(`Native 1,000-chat hydration did not report a valid runtime result: ${JSON.stringify(hydration)}`);
  }

  await client.evaluate(`globalThis.__codexNativeNavigate('/settings/providers')`);
  await delay(1800);
  results.views.settings = await snapshot(client, "02-settings");

  if (!results.views.settings.text.toLowerCase().includes("general") || !results.views.settings.text.toLowerCase().includes("provider")) {
    throw new Error(`Native settings did not open. URL: ${results.views.settings.href}. DOM text: ${results.views.settings.text.slice(0, 800)}. Bottom: ${JSON.stringify(results.views.settings.bottomElements)}. Clickables: ${JSON.stringify(results.views.settings.clickables.slice(0, 40))}`);
  }

  let click;
  const settingsSections = [
    { label: "Providers", key: "providers" },
    { label: "Orchestrations", key: "orchestrations" },
    { label: "Imports", key: "imports" },
    { label: "Patcher", key: "patcher" },
    { label: "Feature Development", key: "feature-development" },
  ];
  for (const section of settingsSections) {
    click = await clickByText(client, section.label);
    if (!click.clicked) {
      throw new Error(`Could not find native settings navigation item: ${section.label}. Candidates: ${JSON.stringify(click.candidates || [])}`);
    }
    await delay(1200);
    if (section.key === "imports") {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const bodyText = await client.evaluate("document.body?.innerText || ''");
        if (/Loaded\s+\d+\s+source projects?\./i.test(bodyText) || /Import manager is not reachable|RangeError:/i.test(bodyText)) break;
        await delay(500);
      }
    }
    const key = section.key;
    results.views[key] = await snapshot(client, `03-${key}`);
    if (/403 Forbidden|Cross-site POST requests are not allowed|RangeError:|Import manager is not reachable/i.test(results.views[key].text)) {
      throw new Error(`${section.label} route rendered a fatal bridge error: ${results.views[key].text.slice(0, 1200)}`);
    }
    if (!results.views[key].text.toLowerCase().includes(section.label.toLowerCase())) {
      throw new Error(`${section.label} route rendered without recognizable content.`);
    }
  }

  client.close();
  const summaryPath = path.join(outputDir, "summary.json");
  fs.writeFileSync(summaryPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, summaryPath, views: Object.fromEntries(Object.entries(results.views).map(([key, value]) => [key, { href: value.href, imagePath: value.imagePath, customHosts: value.customHosts }])) }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
