import "server-only";

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
  platformPermissionCatalogueOwnerId,
  platformPermissionCatalogueVersion,
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
