const id = "core.patcher-ui";
const operations = Object.freeze(["patcher-ui.main-process", "patcher-ui.settings"]);

function requireContextMethod(context, method) {
  if (!context || typeof context[method] !== "function") {
    throw new Error(`${id}: context.${method} must be a function.`);
  }
}

function apply(context) {
  requireContextMethod(context, "runCoreOperation");
  return {
    mainProcess: context.runCoreOperation(operations[0]),
    patcherSettings: context.runCoreOperation(operations[1]),
  };
}

function verify(context, phase) {
  requireContextMethod(context, "verifyCoreFeature");
  return context.verifyCoreFeature(phase);
}

module.exports = { id, operations, apply, verify };
