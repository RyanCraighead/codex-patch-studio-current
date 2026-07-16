const assert = require("node:assert/strict");
const test = require("node:test");

const adapter = require("../adapters/26.707.x.cjs");
const implementation = require("../implementation.cjs");

test("core.settings-shell composes its navigation, sections, and CSP operations", () => {
  const calls = [];
  const context = {
    runCoreOperation(operationId) { calls.push(["apply", operationId]); return { operationId }; },
    verifyCoreFeature(phase) { calls.push(["verify", phase]); return { phase }; },
  };
  assert.equal(implementation.id, "core.settings-shell");
  assert.deepEqual(implementation.operations, ["settings-shell.navigation", "settings-shell.sections", "settings-shell.csp"]);
  assert.equal(Object.isFrozen(implementation.operations), true);
  assert.equal(adapter.apiVersion, 1);
  assert.equal(adapter.codexVersion, "26.707.x");
  assert.deepEqual(adapter.apply(context), {
    navigationBridge: { operationId: "settings-shell.navigation" },
    settingsSections: { operationId: "settings-shell.sections" },
    localConnectSrc: { operationId: "settings-shell.csp" },
  });
  assert.deepEqual(adapter.verify(context, "packed"), { phase: "packed" });
  assert.deepEqual(calls, [["apply", "settings-shell.navigation"], ["apply", "settings-shell.sections"], ["apply", "settings-shell.csp"], ["verify", "packed"]]);
});

test("core.settings-shell requires its new context methods", () => {
  assert.throws(() => implementation.apply({}), /core\.settings-shell: context\.runCoreOperation must be a function\./);
  assert.throws(() => implementation.verify({}, "packed"), /core\.settings-shell: context\.verifyCoreFeature must be a function\./);
});
