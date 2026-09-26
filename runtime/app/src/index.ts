import "server-only";

import { createDatabaseFlowStores } from "./flow-continuation-store";
import { createFlowOrchestrator } from "./flow-orchestrator";
import { createFormContinuationService } from "./form-continuation";
import { createIdentityDisablementCoordinator } from "./identity-disablement";
import { createApplicationInstallationCoordinator } from "./installation-coordinator";
import { createInstalledRuntimeContextLoader } from "./installed-runtime-context";
import { createOperationsAlertSink, readOpenOperationsAlertSignals } from "./operations-alert-sink";
import { createProtectedOperationExecutor } from "./protected-operation-executor";
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
  applicationExperienceSchema,
  isReservedTenantSegment,
  permittedApplicationSchema,
  permittedApplicationsReadSchema,
  readAddressedApplicationAtAddress,
  readPermittedApplicationsAtAddress,
  resolvePermittedApplicationAddress,
  type AddressedApplicationRead,
  type ApplicationExperience,
  type PermittedApplication,
  type PermittedApplicationsRead,
} from "./application-address";
export {
  createHumanInstalledRuntimeContextLoader,
  createInstalledRuntimeContextLoader,
  InstalledRuntimeContextError,
  type HumanInstalledRuntimeContextDependencies,
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

export {
  createProtectedOperationExecutor,
  protectedOperationIdentitySchema,
  type ProtectedOperationExecution,
  type ProtectedOperationExecutionRequest,
  type ProtectedOperationExecutor,
  type ProtectedOperationExecutorDependencies,
  type ProtectedOperationIdentity,
  type ProtectedOperationValue,
} from "./protected-operation-executor";

export {
  createFlowOrchestrator,
  flowContinuationLifetimeSeconds,
  type FlowOrchestrator,
  type FlowOrchestratorDependencies,
  type FlowOrchestratorResponse,
  type FlowRelease,
  type FlowRunExpectation,
  type FlowResumeRequest,
  type FlowStartRequest,
  type FlowUnavailableNotice,
  type NamedActionExecutionResult,
  type NamedActionRecordPort,
} from "./flow-orchestrator";

export {
  createFormContinuationService,
  type FormContinuationInstallationResolver,
  type FormContinuationInstalledRelease,
  type FormContinuationServiceDependencies,
} from "./form-continuation";

export {
  createDatabaseFlowStores,
  type FlowContinuationBinding,
  type FlowContinuationStore,
  type FlowEffectClaim,
  type FlowEffectKey,
  type FlowEffectLedger,
} from "./flow-continuation-store";

export const AppService = Object.freeze({
  key: "app",
  boundary: "@vortex/app",
  createAppTelemetryCollector,
  createOperationsAlertSink,
  readOpenOperationsAlertSignals,
  createApplicationInstallationCoordinator,
  createInstalledRuntimeContextLoader,
  createIdentityDisablementCoordinator,
  createProtectedOperationExecutor,
  createFlowOrchestrator,
  createFormContinuationService,
  createDatabaseFlowStores,
});
