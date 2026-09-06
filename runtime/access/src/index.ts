import "server-only";

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
export { fingerprintPermissionMeaning } from "./permission-fingerprints";
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
  platformPermissionCatalogueOwnerId,
  platformPermissionCatalogueVersion,
  platformPermissionCatalogueVersionV1,
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
