import "server-only";

import { createComponentContextResolver } from "./component-context-resolver";
import { createComponentEventDispatcher } from "./component-event-dispatch";
import { createDatabaseFlowStores } from "./flow-continuation-store";
import { createFlowOrchestrator } from "./flow-orchestrator";
import { createFlowTestRunner } from "./flow-test-run";
import { createFormContinuationService } from "./form-continuation";
import { createIdentityDisablementCoordinator } from "./identity-disablement";
import { createApplicationInstallationCoordinator } from "./installation-coordinator";
import { createPreviewInstallationCoordinator } from "./preview-installation-coordinator";
import { createInstalledRuntimeContextLoader } from "./installed-runtime-context";
import { createViewerSafeRecordLinkService } from "./viewer-safe-record-link";
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
  createViewerSafeRecordLinkService,
  type ViewerSafeRecordLinkInstalledContextLoaderFactory,
  type ViewerSafeRecordLinkService,
  type ViewerSafeRecordLinkServiceDependencies,
} from "./viewer-safe-record-link";

export {
  componentContextMismatchCodes,
  componentContextSchema,
  componentFlowInputRequestSchema,
  componentRecordReferenceSchema,
  componentRecordSelectionSchema,
  createComponentContextResolver,
  resolveComponentFlowInputs,
  resolveComponentQueryInputs,
  type ComponentContext,
  type ComponentContextMismatch,
  type ComponentContextMismatchCode,
  type ComponentContextResolver,
  type ComponentFlowInputRequest,
  type ComponentFlowInputsResolution,
  type ComponentPlacement,
  type ComponentQueryInputsResolution,
  type ComponentRecordReference,
  type ComponentRecordSelection,
  type ResolvedComponentFlowInputs,
  type ResolvedComponentQueryInputs,
} from "./component-context-resolver";

export {
  componentDatasetViewEvents,
  componentEventDispatchRefusalCodes,
  componentEventDispatchRequestSchema,
  componentLocalDisplayFilterConditionSchema,
  componentLocalDisplayFilterSchema,
  createComponentEventDispatcher,
  type ComponentEventDataRefusal,
  type ComponentEventDataResult,
  type ComponentEventDataRow,
  type ComponentEventDispatchDependencies,
  type ComponentEventDispatchRefusalCode,
  type ComponentEventDispatchRequest,
  type ComponentEventDispatchResult,
  type ComponentEventDispatcher,
  type ComponentEventView,
  type ComponentLocalDisplayFilter,
  type ComponentLocalDisplayFilterCondition,
} from "./component-event-dispatch";

export {
  acceptComponentReread,
  acceptComponentResult,
  beginComponentInvocation,
  componentDisplayOutcomeKinds,
  componentDisplayRefusalReasons,
  componentDisplayUnavailableReasons,
  componentInvocationCauseSchema,
  componentInvocationIdSchema,
  componentSelectionSchema,
  openComponentResultState,
  projectComponentResult,
  refreshComponentAfterSave,
  type ComponentConfirmedWrite,
  type ComponentDatasetReread,
  type ComponentDatasetRereader,
  type ComponentDisplayOutcome,
  type ComponentDisplayOutcomeKind,
  type ComponentDisplayRecovery,
  type ComponentDisplayRefusalReason,
  type ComponentDisplayUnavailableReason,
  type ComponentFlowDisplay,
  type ComponentInvocation,
  type ComponentInvocationCause,
  type ComponentInvocationId,
  type ComponentInvocationStart,
  type ComponentInvocationStartInput,
  type ComponentRefreshAfterSave,
  type ComponentResultReduction,
  type ComponentResultReductionReason,
  type ComponentResultState,
  type ComponentSelection,
} from "./component-result-state";

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
  type HumanInstallationDefinitionAccess,
  type InstallationReleaseTarget,
  type OptionalInstallationReader,
} from "./installation-coordinator";

export {
  createPreviewInstallationCoordinator,
  PreviewInstallationCoordinatorError,
  previewInstallationCoordinatorErrorCodes,
  type PreviewInstallationCoordinatorDependencies,
  type PreviewInstallationCoordinatorErrorCode,
} from "./preview-installation-coordinator";

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
  type FlowNamedAction,
  type FlowOrchestratorResponse,
  type FlowRecordType,
  type FlowRelease,
  type FlowRunExpectation,
  type FlowResumeRequest,
  type FlowStartRequest,
  type FlowSubject,
  type FlowUnavailableNotice,
  type NamedActionExecutionResult,
  type NamedActionRecordPort,
  type RecordSaveTaskPort,
} from "./flow-orchestrator";

export {
  createFlowTestRunner,
  type FlowTestRunDependencies,
  type FlowTestRunner,
} from "./flow-test-run";

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
  createPreviewInstallationCoordinator,
  createInstalledRuntimeContextLoader,
  createViewerSafeRecordLinkService,
  createComponentContextResolver,
  createComponentEventDispatcher,
  createIdentityDisablementCoordinator,
  createProtectedOperationExecutor,
  createFlowOrchestrator,
  createFlowTestRunner,
  createFormContinuationService,
  createDatabaseFlowStores,
});
