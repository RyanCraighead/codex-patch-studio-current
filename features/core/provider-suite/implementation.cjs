const id = "core.provider-suite";
const operations = Object.freeze([
  "provider-suite.catalog",
  "provider-suite.preload",
  "provider-suite.settings",
  "provider-suite.prompt-catalog",
]);

function requireContextMethod(context, method) {
  if (!context || typeof context[method] !== "function") {
    throw new Error(`${id}: context.${method} must be a function.`);
  }
}

function apply(context) {
  requireContextMethod(context, "runCoreOperation");
  return {
    providerModelCatalog: context.runCoreOperation(operations[0]),
    preloadOutboundInterceptor: context.runCoreOperation(operations[1]),
    providerSettings: context.runCoreOperation(operations[2]),
    defaultPromptCatalog: context.runCoreOperation(operations[3]),
  };
}

function verify(context, phase) {
  requireContextMethod(context, "verifyCoreFeature");
  return context.verifyCoreFeature(phase);
}

module.exports = { id, operations, apply, verify };
