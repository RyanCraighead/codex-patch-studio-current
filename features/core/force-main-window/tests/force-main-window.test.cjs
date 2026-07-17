const assert = require("node:assert/strict");
const test = require("node:test");

const adapter = require("../adapters/26.707.x.cjs");
const implementation = require("../implementation.cjs");

test("core.force-main-window composes its main-process operation", () => {
  const calls = [];
  const context = {
    runCoreOperation(operationId) { calls.push(["apply", operationId]); return { operationId }; },
    verifyCoreFeature(phase) { calls.push(["verify", phase]); return { phase }; },
  };
  assert.equal(implementation.id, "core.force-main-window");
  assert.deepEqual(implementation.operations, ["force-main-window.main-process"]);
  assert.equal(Object.isFrozen(implementation.operations), true);
  assert.equal(adapter.apiVersion, 1);
  assert.equal(adapter.codexVersion, "26.707.x");
  assert.deepEqual(adapter.apply(context), { mainProcess: { operationId: "force-main-window.main-process" } });
  assert.deepEqual(adapter.verify(context, "packed"), { phase: "packed" });
  assert.deepEqual(calls, [["apply", "force-main-window.main-process"], ["verify", "packed"]]);
});

test("core.force-main-window requires its new context methods", () => {
  assert.throws(() => implementation.apply({}), /core\.force-main-window: context\.runCoreOperation must be a function\./);
  assert.throws(() => implementation.verify({}, "packed"), /core\.force-main-window: context\.verifyCoreFeature must be a function\./);
});
