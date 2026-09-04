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

export const AccessService = Object.freeze({
  key: "access",
  boundary: "@vortex/access",
});
