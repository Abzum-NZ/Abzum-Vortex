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
  verifyPreparedApplicationPermissionRegistration,
  type PermissionRegistryDefinitionReader,
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

export const AccessService = Object.freeze({
  key: "access",
  boundary: "@vortex/access",
});
