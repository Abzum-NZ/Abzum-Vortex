import "server-only";

import {
  resolveApplicationTheme,
  resolveApplicationThemeTokens,
} from "./app-theme";
import { projectFlowResultHandoff } from "./flow-result-handoff";
import { createAppTelemetryCollector } from "./telemetry";

export {
  resolveApplicationTheme,
  resolveApplicationThemeTokens,
} from "./app-theme";
export {
  createAppTelemetryCollector,
  type AppTelemetryCollectorDependencies,
} from "./telemetry";
export {
  flowResultDeclarationSchema,
  flowResultHandoffContractVersion,
  flowResultHandoffRefusalReasonSchema,
  flowResultHandoffRequestSchema,
  flowResultHandoffSchema,
  flowResultOperationResultSchema,
  flowResultProtectedValueReferenceSchema,
  flowResultViewerAuthoritySchema,
  projectFlowResultHandoff,
  type FlowResultDeclaration,
  type FlowResultHandoff,
  type FlowResultHandoffDependencies,
  type FlowResultHandoffRefusalReason,
  type FlowResultHandoffRequest,
  type FlowResultOperationResult,
  type FlowResultPresentation,
  type FlowResultProtectedValueReference,
  type FlowResultViewerAuthority,
  type FlowResultWithheld,
} from "./flow-result-handoff";

export const AppService = Object.freeze({
  key: "app",
  boundary: "@vortex/app",
  resolveApplicationTheme,
  resolveApplicationThemeTokens,
  createAppTelemetryCollector,
  projectFlowResultHandoff,
});
