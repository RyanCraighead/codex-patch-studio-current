const assert = require("node:assert/strict");
const test = require("node:test");

const adapter = require("../adapters/26.707.x.cjs");
const implementation = require("../implementation.cjs");

test("core.patcher-ui composes its main-process and settings operations", () => {
  const calls = [];
  const context = {
    runCoreOperation(operationId) { calls.push(["apply", operationId]); return { operationId }; },
    verifyCoreFeature(phase) { calls.push(["verify", phase]); return { phase }; },
  };
  assert.equal(implementation.id, "core.patcher-ui");
  assert.deepEqual(implementation.operations, ["patcher-ui.main-process", "patcher-ui.settings"]);
  assert.equal(Object.isFrozen(implementation.operations), true);
  assert.equal(adapter.apiVersion, 1);
  assert.equal(adapter.codexVersion, "26.707.x");
  assert.deepEqual(adapter.apply(context), {
    mainProcess: { operationId: "patcher-ui.main-process" },
    patcherSettings: { operationId: "patcher-ui.settings" },
  });
  assert.deepEqual(adapter.verify(context, "packed"), { phase: "packed" });
  assert.deepEqual(calls, [["apply", "patcher-ui.main-process"], ["apply", "patcher-ui.settings"], ["verify", "packed"]]);
});

test("core.patcher-ui requires its new context methods", () => {
  assert.throws(() => implementation.apply({}), /core\.patcher-ui: context\.runCoreOperation must be a function\./);
  assert.throws(() => implementation.verify({}, "packed"), /core\.patcher-ui: context\.verifyCoreFeature must be a function\./);
});
