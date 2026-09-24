import "server-only";

import {
  correlationIdSchema,
  identityIdSchema,
  identitySessionSchema,
  organizationAccessDeclarationSchema,
  organizationIdSchema,
  platformIdSchema,
  type IdentitySession,
  type OrganizationAccessDeclaration,
} from "@vortex/contracts";
import {
  createHumanOrganizationRequestService,
  platformPermissionCatalogue,
  platformPermissionCatalogueOwnerId,
  runOrganizationAccessOperation,
  type HumanOrganizationRequestDependencies,
} from "@vortex/access";
import { z } from "zod";

/**
 * The App coordination operation for environment-wide identity disablement.
 *
 * It composes two owners without either importing the other: Access decides
 * whether the operator holds `platform.security.identities.disable`, and the
 * fixed server-only Identity Authority adapter disables the identity, revokes
 * its provider sessions and records the attributable command. Because the
 * disablement affects every organisation the identity belongs to, the
 * permission counts only in the environment's root (platform) organisation:
 * the operation is refused when the operator selected any other organisation,
 * and Access evaluates the permission only in the configured root, so the
 * permission held in a tenant or child organisation never reaches Identity.
 *
 * Access evaluates the operator's own verified session inside a protected
 * request for the root organisation, and that same session's identity is the
 * recorded actor, so the actor cannot differ from the identity Access checked.
 *
 * There is no browser endpoint for this operation: the trusted server supplies
 * the verified session, the configured root organisation and the Identity
 * Authority adapter.
 */

export const identityDisablementRefusalCodes = [
  "invalid_request",
  "root_organization_required",
  "access_refused",
  "recent_authentication_required",
  "self_disablement",
  "command_conflict",
  "subject_not_found",
  "authority_unavailable",
] as const;

export type IdentityDisablementRefusalCode = (typeof identityDisablementRefusalCodes)[number];

export const identityDisablementRequestSchema = z
  .object({
    /** The organisation the operator is working in; it must be the environment root. */
    selectedOrganizationId: organizationIdSchema,
    /** Stable across retries: an exact retry replays the recorded result. */
    commandId: platformIdSchema,
    subjectIdentityId: identityIdSchema,
    correlationId: correlationIdSchema,
  })
  .strict();

export type IdentityDisablementRequest = z.infer<typeof identityDisablementRequestSchema>;

export type IdentityDisablementOperationResult =
  | Readonly<{
      outcome: "disabled";
      commandId: string;
      subjectIdentityId: string;
      sessionsRevoked: number;
      correlationId: string;
      replayed: boolean;
    }>
  | Readonly<{ outcome: "refused"; code: IdentityDisablementRefusalCode }>;

/** The structural shape of the Identity Authority adapter this operation calls. */
export interface IdentityAuthorityDisabler {
  disable(command: {
    readonly commandId: string;
    readonly actorIdentityId: string;
    readonly subjectIdentityId: string;
    readonly correlationId: string;
  }): Promise<
    | Readonly<{
        outcome: "disabled";
        commandId: string;
        subjectIdentityId: string;
        sessionsRevoked: number;
        correlationId: string;
        replayed: boolean;
      }>
    | Readonly<{
        outcome: "refused";
        code:
          | "invalid_command"
          | "self_disablement"
          | "command_conflict"
          | "subject_not_found"
          | "authority_unavailable";
      }>
  >;
}

export type IdentityDisablementDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    /**
     * The environment's root (platform) organisation, from trusted server
     * configuration. It is never taken from the request or the operator's input.
     */
    environmentRootOrganizationId: string;
    identityAuthority: IdentityAuthorityDisabler;
  }>;

const disableIdentitiesPermission = platformPermissionCatalogue.permissions.find(
  (permission) => permission.key === "platform.security.identities.disable",
);

/**
 * Server-owned declaration. The operator supplies none of it; a permission is
 * never inferred from input.
 */
const buildDeclaration = (): OrganizationAccessDeclaration => {
  if (disableIdentitiesPermission === undefined)
    throw new Error("The identity disablement permission is not in the platform catalogue");
  return organizationAccessDeclarationSchema.parse({
    operationKey: disableIdentitiesPermission.key,
    action: { actionKind: disableIdentitiesPermission.actionKind },
    target: { kind: "organization" },
    requiredPermission: {
      ownerKind: "platform",
      ownerId: platformPermissionCatalogueOwnerId,
      permissionId: disableIdentitiesPermission.permissionId,
    },
    recentAuthentication: { kind: "primary", maximumAgeSeconds: 900 },
    authority: { kind: "permission" },
  });
};

export const createIdentityDisablementCoordinator = (
  dependencies: IdentityDisablementDependencies,
) => {
  const rootOrganizationId = organizationIdSchema.parse(dependencies.environmentRootOrganizationId);
  const declaration = buildDeclaration();
  const requests = createHumanOrganizationRequestService(dependencies);

  return Object.freeze({
    async disableIdentity(
      sessionCandidate: IdentitySession,
      requestCandidate: IdentityDisablementRequest,
    ): Promise<IdentityDisablementOperationResult> {
      const session = identitySessionSchema.safeParse(sessionCandidate);
      const request = identityDisablementRequestSchema.safeParse(requestCandidate);
      if (!session.success || !request.success)
        return { outcome: "refused", code: "invalid_request" };

      // Environment-wide authority exists only in the root organisation.
      if (request.data.selectedOrganizationId.toLowerCase() !== rootOrganizationId.toLowerCase())
        return { outcome: "refused", code: "root_organization_required" };
      if (session.data.identityId.toLowerCase() === request.data.subjectIdentityId.toLowerCase())
        return { outcome: "refused", code: "self_disablement" };

      // Access decides for this session in the root organisation, or nothing is disabled.
      const checked = await requests.run(
        session.data,
        { organizationId: rootOrganizationId },
        (transaction, scope) =>
          runOrganizationAccessOperation(transaction, scope, declaration, async () => true),
      );
      if (checked.kind === "temporarily_unavailable")
        return { outcome: "refused", code: "authority_unavailable" };
      if (checked.kind === "unavailable") return { outcome: "refused", code: "access_refused" };
      if (checked.value.outcome !== "completed")
        return {
          outcome: "refused",
          code:
            checked.value.reasonCode === "authentication_required"
              ? "recent_authentication_required"
              : "access_refused",
        };

      const result = await dependencies.identityAuthority
        .disable({
          commandId: request.data.commandId,
          actorIdentityId: session.data.identityId,
          subjectIdentityId: request.data.subjectIdentityId,
          correlationId: request.data.correlationId,
        })
        .catch(() => undefined);
      if (result === undefined) return { outcome: "refused", code: "authority_unavailable" };
      if (result.outcome === "disabled") return result;
      return {
        outcome: "refused",
        code: result.code === "invalid_command" ? "invalid_request" : result.code,
      };
    },
  });
};

export type IdentityDisablementCoordinator = ReturnType<
  typeof createIdentityDisablementCoordinator
>;
