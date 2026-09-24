import "server-only";

export {
  createStoredApplicationPermissionSource,
  type StoredApplicationPermissionSourceDependencies,
  type StoredApplicationPermissionSourceEvidence,
} from "./stored-application-permission-source";
export {
  applicationRoleTemplatePreparationErrorCodes,
  ApplicationRoleTemplatePreparationError,
  createApplicationRoleTemplateAdapter,
  verifyPreparedApplicationRoleTemplates,
  type ApplicationRoleTemplateAdapterDependencies,
  type ApplicationRoleTemplatePreparationErrorCode,
  type PrepareApplicationRoleRegistrationCandidateCommand,
  type PrepareCurrentApplicationRoleTemplatesCommand,
} from "./application-role-template-adapter";
export {
  acceptOrganizationInvitation,
  AccessVersionError,
  accessVersionErrorCodes,
  createAccessVersionStore,
  type AccessVersionErrorCode,
} from "./access-version";
export {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "./human-organization-request";
export {
  createOrganizationRuntimeSettingsAdministrationService,
  readCurrentOrganizationDefaultApplicationAfterAuthorization,
  readCurrentOrganizationRuntimeSettingsAfterAuthorization,
  type UpdateOrganizationRuntimeSettingsCommand,
} from "./organization-runtime-settings-administration";
export {
  createOrganizationLocalAdministrationService,
  type OrganizationLocalAdministrationDependencies,
} from "./organization-local-administration";
export {
  runOrganizationAccessOperation,
  type OrganizationAccessOperationResult,
} from "./organization-access-decision";
export {
  runOrganizationRecordAccessOperation,
  type FixedOrganizationRecordAccessAdapter,
  type OrganizationRecordAccessOperationResult,
} from "./organization-record-access-operation";
export {
  createOrganizationDirectRecordShareService,
  type FixedOrganizationDirectRecordShareAdapter,
  type OrganizationDirectRecordShareDependencies,
} from "./organization-direct-record-share";
export {
  createOrganizationAccessAdministrationService,
  type OrganizationAccessAdministrationDependencies,
} from "./organization-access-administration";
export { fingerprintPermissionMeaning } from "./permission-fingerprints";
export {
  organizationDelegationScopeEvidenceErrorCodes,
  OrganizationDelegationScopeEvidenceError,
  prepareOrganizationDelegationScope,
  verifyPreparedOrganizationDelegationScope,
  type OrganizationDelegationScopeEvidenceErrorCode,
} from "./organization-delegation-scope-evidence";
export {
  organizationRoleChangeEvidenceErrorCodes,
  OrganizationRoleChangeEvidenceError,
  prepareOrganizationRoleChangeEvidence,
  verifyPreparedOrganizationRoleChangeEvidence,
  type OrganizationRoleChangeEvidenceErrorCode,
} from "./organization-role-change-evidence";
export {
  createPermissionRegistryDefinitionAdapter,
  PermissionRegistryPreparationError,
  permissionRegistryPreparationErrorCodes,
  prepareApplicationPermissionRegistrationFromReleaseSet,
  verifyPreparedApplicationPermissionRegistration,
  type PermissionRegistryDefinitionSetReader,
  type PermissionRegistryPreparationErrorCode,
  type PrepareApplicationPermissionRegistrationCommand,
} from "./permission-registry-definition-adapter";
export {
  platformPermissionCatalogue,
  platformPermissionCatalogueV1,
  platformPermissionCatalogueV1_0_1,
  platformPermissionCatalogueOwnerId,
  platformPermissionCatalogueVersion,
  platformPermissionCatalogueVersionV1,
  platformPermissionCatalogueVersionV1_0_1,
} from "./platform-permission-catalogue";
export {
  createPermissionRegistryPrivateRepository,
  PermissionRegistryRepositoryError,
  permissionRegistryRepositoryErrorCodes,
  type PermissionRegistryPrivateRepository,
  type PermissionRegistryRepositoryErrorCode,
} from "./permission-registry-repository";
export {
  assignCapabilityPolicy,
  capabilityPolicyAdministratorAuthoritySchema,
  capabilityPolicyAppliedScopeSchema,
  capabilityPolicyAssignmentCommandSchema,
  capabilityPolicyAssignmentResultSchema,
  capabilityPolicyAssignmentSchema,
  capabilityPolicyDefinitionCommandSchema,
  capabilityPolicyDefinitionSchema,
  capabilityPolicyMutationResultSchema,
  capabilityPolicyQuantitySchema,
  capabilityPolicyRevocationCommandSchema,
  capabilityPolicyRevocationResultSchema,
  capabilityPolicyScopeSchema,
  capabilityPolicySubjectSchema,
  effectiveCapabilityPolicyRequestSchema,
  effectiveCapabilityPolicySchema,
  publishCapabilityPolicyDefinition,
  resolveEffectiveCapabilityPolicy,
  resolveEffectiveCapabilityPolicyForEntitlement,
  revokeCapabilityPolicyAssignment,
  type CapabilityPolicyAdministratorAuthority,
  type CapabilityPolicyAppliedScope,
  type CapabilityPolicyAssignment,
  type CapabilityPolicyAssignmentCommand,
  type CapabilityPolicyAssignmentResult,
  type CapabilityPolicyDefinition,
  type CapabilityPolicyDefinitionCommand,
  type CapabilityPolicyMutationResult,
  type CapabilityPolicyRevocationCommand,
  type CapabilityPolicyRevocationResult,
  type CapabilityPolicySubject,
  type EffectiveCapabilityPolicy,
  type EffectiveCapabilityPolicyRequest,
} from "./capability-policy";
export {
  capabilityBalanceRecordSchema,
  capabilityBalanceSchema,
  capabilityConsumptionResultSchema,
  capabilityPolicyEvidenceSchema,
  capabilityReleaseResultSchema,
  capabilityReservationResultSchema,
  consumeCapabilityReservation,
  consumeCapabilityReservationCommandSchema,
  consumeReservation,
  expireStaleCapabilityReservations,
  expireStaleCapabilityReservationsCommandSchema,
  expireStaleCapabilityReservationsResultSchema,
  readCapabilityBalance,
  readCapabilityBalanceRequestSchema,
  releaseCapabilityReservation,
  releaseCapabilityReservationCommandSchema,
  releaseReservation,
  reserveCapabilityCommandSchema,
  reserveCapabilityQuantity,
  type CapabilityBalance,
  type CapabilityBalanceRecord,
  type CapabilityConsumptionResult,
  type CapabilityPolicyEvidence,
  type CapabilityReleaseResult,
  type CapabilityReservationResult,
  type ConsumeCapabilityReservationCommand,
  type ExpireStaleCapabilityReservationsCommand,
  type ExpireStaleCapabilityReservationsResult,
  type ReadCapabilityBalanceRequest,
  type ReleaseCapabilityReservationCommand,
  type ReserveCapabilityCommand,
} from "./capability-reservation";
export {
  flowExecutionBindingAdministratorAuthoritySchema,
  flowExecutionBindingErrorCodes,
  FlowExecutionBindingError,
  flowExecutionBindingMutationResultSchema,
  flowExecutionBindingReadResultSchema,
  readFlowExecutionBinding,
  readFlowExecutionBindingCommandSchema,
  registerFlowExecutionBinding,
  registerFlowExecutionBindingCommandSchema,
  revokeFlowExecutionBinding,
  revokeFlowExecutionBindingCommandSchema,
  type FlowExecutionBindingAdministratorAuthority,
  type FlowExecutionBindingErrorCode,
  type FlowExecutionBindingMutationResult,
  type FlowExecutionBindingReadResult,
  type ReadFlowExecutionBindingCommand,
  type RegisterFlowExecutionBindingCommand,
  type RevokeFlowExecutionBindingCommand,
} from "./flow-execution-bindings";
export {
  meteringEventErrorCodes,
  meteringEventRecordResultSchema,
  recordMeteringEvent,
  type MeteringEvent,
  type MeteringEventErrorCode,
  type MeteringEventRecordResult,
  type RecordMeteringEventCommand,
} from "./metering-events";
export {
  flowEffectiveActorDelegationUseSchema,
  flowEffectiveActorErrorCodes,
  FlowEffectiveActorError,
  flowEffectiveActorIdentitySchema,
  flowEffectiveActorNodeRequestSchema,
  flowEffectiveActorPurposeSchema,
  flowEffectiveActorRefusalReasonSchema,
  flowEffectiveActorRequestSchema,
  flowEffectiveActorResolutionSchema,
  flowEffectiveActorRunActorSchema,
  flowEffectiveActorStateSchema,
  openFlowEffectiveActorTransaction,
  readFlowEffectiveActorCurrentAuthority,
  resolveFlowEffectiveActor,
  type FlowEffectiveActorAuthorityReader,
  type FlowEffectiveActorCurrentAuthority,
  type FlowEffectiveActorDelegationUse,
  type FlowEffectiveActorDependencies,
  type FlowEffectiveActorEffectiveResolution,
  type FlowEffectiveActorErrorCode,
  type FlowEffectiveActorIdentity,
  type FlowEffectiveActorNodeRequest,
  type FlowEffectiveActorPurpose,
  type FlowEffectiveActorRefusalReason,
  type FlowEffectiveActorRequest,
  type FlowEffectiveActorResolution,
  type FlowEffectiveActorRunActor,
  type FlowEffectiveActorScopeResolver,
  type FlowEffectiveActorState,
  type FlowEffectiveActorTransactionAccess,
  type FlowEffectiveActorTransactionDependencies,
  type FlowEffectiveActorTransactionRunner,
} from "./flow-effective-actor";

export const AccessService = Object.freeze({
  key: "access",
  boundary: "@vortex/access",
});
