"use strict";

const BASE_REQUIRED_PACKED_VERIFICATION = Object.freeze([
  "containsReasoningSummaryConversionPatch",
  "containsNativeOrchestrator",
  "containsProviderSettings",
  "containsAutoRouterSettings",
  "containsPromptToolsSettings",
  "containsPersonasSettings",
  "containsSwarmSettings",
  "containsDefaultPromptCatalog",
  "containsImportSettings",
  "containsPatcherSettings",
  "containsFeatureDevelopmentSettings",
  "containsLocalConnectSources",
  "containsProviderModelCatalogPatch",
  "containsNativeSettingsSections",
  "containsNativeNavigationBridge",
  "containsPreloadOutboundInterceptor",
  "containsRemoteControlMainProcessPatch",
]);

function requiredPackedVerification(features = {}) {
  const required = [...BASE_REQUIRED_PACKED_VERIFICATION];
  if (features?.chatLimit === true) {
    required.unshift("containsHistoryHydrationDiagnostic");
    required.unshift("containsChatLimitPatch");
  }
  return required;
}

module.exports = {
  BASE_REQUIRED_PACKED_VERIFICATION,
  requiredPackedVerification,
};
