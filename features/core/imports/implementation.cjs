const id = "core.imports";
const operations = Object.freeze(["imports.inject"]);

function requireContextMethod(context, method) {
  if (!context || typeof context[method] !== "function") {
    throw new Error(`${id}: context.${method} must be a function.`);
  }
}

function apply(context) {
  requireContextMethod(context, "runCoreOperation");
  return { importSettings: context.runCoreOperation(operations[0]) };
}

function verify(context, phase) {
  requireContextMethod(context, "verifyCoreFeature");
  return context.verifyCoreFeature(phase);
}

module.exports = { id, operations, apply, verify };
