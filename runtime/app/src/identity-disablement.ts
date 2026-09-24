import "server-only";

import {
  correlationIdSchema,
  identitySessionSchema,
  organizationAccessDeclarationSchema,
  organizationIdSchema,
  platformIdSchema,
  selectedOrganizationScopeSchema,
  identityIdSchema,
  type IdentitySession,
  type OrganizationAccessDeclaration,
  type SelectedOrganizationScope,
} from "@vortex/contracts";
import {
  platformPermissionCatalogue,
  platformPermissionCatalogueOwnerId,
  type OrganizationAccessOperationResult,
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
 * permission counts only when the operator selected the environment's root
 * (platform) organisation; it is refused in any other organisation, and the
 * permission alone in a tenant or child organisation never reaches Identity.
 *
 * There is no browser endpoint for this operation: the trusted server supplies
 * the verified session, the selected scope, the root organisation and the
 * Access and Identity dependencies.
 */

export const identityDisablementRefusalCodes = [
  "invalid_request",
  "root_organization_required",
  "access_refused",
  "self_disablement",
  "command_conflict",
  "subject_not_found",
  "authority_unavailable",
] as const;

export type IdentityDisablementRefusalCode = (typeof identityDisablementRefusalCodes)[number];

export const identityDisablementRequestSchema = z
  .object({
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
        code: "invalid_command" | IdentityDisablementRefusalCode;
      }>
  >;
}

export type IdentityDisablementDependencies = Readonly<{
  /**
   * The environment's root (platform) organisation, from trusted server
   * configuration. It is never taken from the request or the operator's input.
   */
  environmentRootOrganizationId: string;
  /**
   * Runs Access's own permission decision for the operator in the selected
   * scope (`runOrganizationAccessOperation` bound to the operator's request
   * transaction). The callback runs only when the permission is effective.
   */
  authorize: <Result>(
    scope: SelectedOrganizationScope,
    declaration: OrganizationAccessDeclaration,
    operation: () => Promise<Result>,
  ) => Promise<OrganizationAccessOperationResult<Result>>;
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

  return Object.freeze({
    async disableIdentity(
      sessionCandidate: IdentitySession,
      scopeCandidate: SelectedOrganizationScope,
      requestCandidate: IdentityDisablementRequest,
    ): Promise<IdentityDisablementOperationResult> {
      const session = identitySessionSchema.safeParse(sessionCandidate);
      const scope = selectedOrganizationScopeSchema.safeParse(scopeCandidate);
      const request = identityDisablementRequestSchema.safeParse(requestCandidate);
      if (!session.success || !scope.success || !request.success)
        return { outcome: "refused", code: "invalid_request" };

      // Environment-wide authority exists only in the root organisation.
      if (scope.data.organizationId.toLowerCase() !== rootOrganizationId.toLowerCase())
        return { outcome: "refused", code: "root_organization_required" };
      if (session.data.identityId.toLowerCase() === request.data.subjectIdentityId.toLowerCase())
        return { outcome: "refused", code: "self_disablement" };

      // Access decides; the decision must be exact for this scope, or nothing is disabled.
      let decision: OrganizationAccessOperationResult<true>;
      try {
        decision = await dependencies.authorize(scope.data, declaration, async () => true);
      } catch {
        return { outcome: "refused", code: "authority_unavailable" };
      }
      if (decision.outcome !== "completed") return { outcome: "refused", code: "access_refused" };

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
