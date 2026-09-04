import "server-only";

export {
  acceptOrganizationInvitation,
  AccessVersionError,
  accessVersionErrorCodes,
  createAccessVersionStore,
  readCurrentOrganizationAccessVersion,
  type AccessVersionErrorCode,
} from "./access-version";

export const AccessService = Object.freeze({
  key: "access",
  boundary: "@vortex/access",
});
