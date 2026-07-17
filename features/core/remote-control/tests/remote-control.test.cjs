const assert = require("node:assert/strict");
const test = require("node:test");

const adapter = require("../adapters/26.707.x.cjs");
const implementation = require("../implementation.cjs");

test("core.remote-control composes its main-process and settings operations", () => {
  const calls = [];
  const context = {
    runCoreOperation(operationId) { calls.push(["apply", operationId]); return { operationId }; },
    verifyCoreFeature(phase) { calls.push(["verify", phase]); return { phase }; },
  };
  assert.equal(implementation.id, "core.remote-control");
  assert.deepEqual(implementation.operations, ["remote-control.main-process", "remote-control.settings"]);
  assert.equal(Object.isFrozen(implementation.operations), true);
  assert.equal(adapter.apiVersion, 1);
  assert.equal(adapter.codexVersion, "26.707.x");
  assert.deepEqual(adapter.apply(context), {
    mainProcess: { operationId: "remote-control.main-process" },
    settings: { operationId: "remote-control.settings" },
  });
  assert.deepEqual(adapter.verify(context, "packed"), { phase: "packed" });
  assert.deepEqual(calls, [["apply", "remote-control.main-process"], ["apply", "remote-control.settings"], ["verify", "packed"]]);
});

test("core.remote-control requires its new context methods", () => {
  assert.throws(() => implementation.apply({}), /core\.remote-control: context\.runCoreOperation must be a function\./);
  assert.throws(() => implementation.verify({}, "packed"), /core\.remote-control: context\.verifyCoreFeature must be a function\./);
});
