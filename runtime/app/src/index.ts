import "server-only";

import { createApplicationInstallationCoordinator } from "./installation-coordinator";
import { createInstalledRuntimeContextLoader } from "./installed-runtime-context";
import { createOperationsAlertSink, readOpenOperationsAlertSignals } from "./operations-alert-sink";
import { createAppTelemetryCollector } from "./telemetry";

export {
  createAppTelemetryCollector,
  type AppTelemetryCollectorDependencies,
} from "./telemetry";
export {
  createOperationsAlertSink,
  operationsAlertSignalReadLimitSchema,
  operationsAlertSignalSchema,
  readOpenOperationsAlertSignals,
  type OpenOperationsAlertSignalsRead,
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

export {
  createIdentityDisablementCoordinator,
  identityDisablementRefusalCodes,
  identityDisablementRequestSchema,
  type IdentityAuthorityDisabler,
  type IdentityDisablementCoordinator,
  type IdentityDisablementDependencies,
  type IdentityDisablementOperationResult,
  type IdentityDisablementRefusalCode,
  type IdentityDisablementRequest,
} from "./identity-disablement";

export const AppService = Object.freeze({
  key: "app",
  boundary: "@vortex/app",
  createAppTelemetryCollector,
  createOperationsAlertSink,
  readOpenOperationsAlertSignals,
  createApplicationInstallationCoordinator,
  createInstalledRuntimeContextLoader,
  createIdentityDisablementCoordinator,
});
