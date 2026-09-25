import "server-only";

export {
  registerKestraFlowCandidate,
  kestraFlowRegistrationErrorCodes,
  kestraFlowRegistrationRefusalReasons,
  kestraFlowRegistrationStatuses,
  KestraFlowRegistrationError,
  type KestraFlowRegistration,
  type KestraFlowRegistrationCommand,
  type KestraFlowRegistrationErrorCode,
  type KestraFlowRegistrationRefusalReason,
  type KestraFlowRegistrationResult,
  type KestraFlowRegistrationStatus,
} from "./flow-registration-repository";

export {
  compileKestraFlow,
  kestraFlowCompilerEnvironments,
  kestraFlowCompilerRefusalReasons,
  kestraProtectedOperationContractVersion,
  kestraProtectedOperationRuntimeFields,
  type KestraFlowCandidate,
  type KestraFlowCompilation,
  type KestraFlowCompilerEnvironment,
  type KestraFlowCompilerInput,
  type KestraFlowCompilerRefusalReason,
  type KestraFlowIdentity,
  type KestraFlowSequencedEdge,
  type KestraFlowTask,
  type KestraFlowTrigger,
  type KestraProtectedOperationBinding,
} from "./kestra-compiler";

export {
  planInstallationWorkflowActivation,
  reconcileInstallationWorkflowWithdrawal,
  installationWorkflowReadinessErrorCodes,
  InstallationWorkflowReadinessError,
  type AcceptedInstallationWorkflowStart,
  type InstallationWorkflowActivationRequest,
  type InstallationWorkflowExpectedCandidate,
  type InstallationWorkflowInstallationIdentity,
  type InstallationWorkflowReadinessErrorCode,
  type InstallationWorkflowWithdrawalRequest,
} from "./installation-workflow-readiness";

export {
  parseApplicationKestraInstanceTarget,
  resolveApplicationKestraInstanceTarget,
  applicationKestraBaseUrlEnvironmentKey,
  applicationKestraCallbackKeySecretName,
  kestraInstanceKinds,
  kestraInstanceTargetErrorCodes,
  workflowServiceKestraInstanceKind,
  KestraInstanceTargetError,
  type ApplicationKestraInstanceTarget,
  type KestraInstanceKind,
  type KestraInstanceTargetErrorCode,
} from "./kestra-instance";

export const WorkflowService = Object.freeze({
  key: "workflow",
  boundary: "@vortex/workflow",
});
