import "server-only";

import {
  resolveApplicationTheme,
  resolveApplicationThemeTokens,
} from "./app-theme";
import { projectFlowResultHandoff } from "./flow-result-handoff";
import { createApplicationInstallationCoordinator } from "./installation-coordinator";
import { createInstalledRuntimeContextLoader } from "./installed-runtime-context";
import { createOperationsAlertSink, readOpenOperationsAlertSignals } from "./operations-alert-sink";
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
  createOperationsAlertSink,
  operationsAlertSignalSchema,
  readOpenOperationsAlertSignals,
  type OperationsAlertSignal,
  type OperationsAlertSinkDependencies,
} from "./operations-alert-sink";
export {
  isReservedTenantSegment,
  permittedApplicationSchema,
  permittedApplicationsReadSchema,
  readPermittedApplicationsAtAddress,
  resolvePermittedApplicationAddress,
  type PermittedApplication,
  type PermittedApplicationsRead,
} from "./application-address";
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

export {
  createInstalledRuntimeContextLoader,
  InstalledRuntimeContextError,
  installedRuntimeContextErrorCodes,
  requireInstalledRuntimeContext,
  type InstalledRuntimeActiveInstallationReader,
  type InstalledRuntimeContext,
  type InstalledRuntimeContextDependencies,
  type InstalledRuntimeContextErrorCode,
  type InstalledRuntimeContextLoader,
} from "./installed-runtime-context";

export {
  applicationInstallationActivationRequestSchema,
  ApplicationInstallationCoordinatorError,
  applicationInstallationCoordinatorErrorCodes,
  applicationInstallationPreparationRequestSchema,
  applicationInstallationWithdrawalRequestSchema,
  createApplicationInstallationCoordinator,
  type ActiveApplicationInstallationSummary,
  type ApplicationInstallationActivationRequest,
  type ApplicationInstallationActivationResult,
  type ApplicationInstallationCoordinator,
  type ApplicationInstallationCoordinatorDependencies,
  type ApplicationInstallationCoordinatorErrorCode,
  type ApplicationInstallationPreparationRequest,
  type ApplicationInstallationPreparationResult,
  type ApplicationInstallationWithdrawalRequest,
  type ApplicationInstallationWithdrawalResult,
  type OptionalInstallationReader,
} from "./installation-coordinator";

export {
  createFirstOwnerApplicationEntryComposition,
  FirstOwnerApplicationEntryError,
  firstOwnerApplicationEntryErrorCodes,
  firstOwnerApplicationEntryRequestSchema,
  type FirstOwnerApplicationEntryComposition,
  type FirstOwnerApplicationEntryCompositionDependencies,
  type FirstOwnerApplicationEntryErrorCode,
  type FirstOwnerApplicationEntryRequest,
  type FirstOwnerApplicationEntryResult,
} from "./first-owner-entry";

export const AppService = Object.freeze({
  key: "app",
  boundary: "@vortex/app",
  resolveApplicationTheme,
  resolveApplicationThemeTokens,
  createAppTelemetryCollector,
  createOperationsAlertSink,
  readOpenOperationsAlertSignals,
  projectFlowResultHandoff,
  createApplicationInstallationCoordinator,
  createInstalledRuntimeContextLoader,
});
