const id = "core.settings-shell";
const operations = Object.freeze([
  "settings-shell.navigation",
  "settings-shell.sections",
  "settings-shell.csp",
]);

function requireContextMethod(context, method) {
  if (!context || typeof context[method] !== "function") {
    throw new Error(`${id}: context.${method} must be a function.`);
  }
}

function apply(context) {
  requireContextMethod(context, "runCoreOperation");
  return {
    navigationBridge: context.runCoreOperation(operations[0]),
    settingsSections: context.runCoreOperation(operations[1]),
    localConnectSrc: context.runCoreOperation(operations[2]),
  };
}

function verify(context, phase) {
  requireContextMethod(context, "verifyCoreFeature");
  return context.verifyCoreFeature(phase);
}

module.exports = { id, operations, apply, verify };
