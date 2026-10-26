import type { PlatformPermissionSource } from "../access/platform-permissions";
import "server-only";

import type {
  IdentitySession,
  OrganizationSelectionCandidate,
  SelectedOrganizationScope,
} from "../access/identity-access";
import type { OrganizationAccessDeclaration } from "../access/organization-access-decision";
import type { PermissionRegistryEntryCandidate } from "../access/permission-registry";
import type { PermissionDeclaration } from "../access/permissions";
import {
  applicationRootIdSchema,
  revisionSchema,
  type ApplicationRootId,
  type PlatformId,
} from "../catalogue/identifiers";
import { sameId } from "../catalogue/runtime-primitives";
import type { NavigationItem } from "../definition/application-contracts";
import {
  type ProjectedNavigation,
  collectNavigationPermissionKeys,
  projectNavigation,
} from "./projected-navigation";
import type { RequestDatabaseTransaction } from "../db/request-transaction";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "../access/human-organization-request";
import { decideOrganizationAccessBatch } from "../access/organization-access-decision-access";
import {
  requireInstalledRuntimeContext,
  type InstalledRuntimeContext,
} from "../definition/installed-runtime-context";
import { describeFailure } from "../catalogue/runtime-primitives";

export type NavigationPermissionBinding = Readonly<{
  permissionKey: string;
  declaration: OrganizationAccessDeclaration;
}>;

/**
 * The exact installed application's navigation and the Access declaration for each permission
 * key it names. The declaration comes from the release's prepared registration, never from the
 * browser, so the projection evaluates only authority the server can prove.
 */
export type FixedAuthenticatedNavigationProjection = Readonly<{
  navigation: readonly NavigationItem[];
  permissionBindings: Readonly<Record<string, NavigationPermissionBinding>>;
  sourceCorrelationId: string;
}>;

/**
 * Evaluates each distinct navigation permission through the same live Access decision path as
 * page capability, then projects the ordered tree. Every item the viewer does not currently
 * hold is dropped with its heading when that leaves the heading empty. Missing evidence is a
 * refusal to project, never a silently visible item.
 */
const projectDecidedNavigation = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  loaded: FixedAuthenticatedNavigationProjection,
): Promise<ProjectedNavigation> => {
  const bindings = loaded.permissionBindings;
  const correlations = new Set([loaded.sourceCorrelationId.toLowerCase()]);
  const decisions: Record<string, boolean> = {};
  const permissionKeys = collectNavigationPermissionKeys(loaded.navigation);
  const declarations = permissionKeys.map((permissionKey) => {
    const binding = Object.hasOwn(bindings, permissionKey) ? bindings[permissionKey] : undefined;
    if (binding === undefined || binding.permissionKey !== permissionKey)
      throw new Error("NAVIGATION_PERMISSION_BINDING_UNAVAILABLE");
    return binding.declaration;
  });
  // Every distinct permission is decided through the same live eligibility evaluation, all in
  // one statement of this request instead of one round trip each. Each decision is still
  // bound to this request's scope and access version, and its correlation must be this one
  // request's.
  const evaluated = await decideOrganizationAccessBatch(transaction, scope, declarations);
  if (evaluated.length !== permissionKeys.length)
    throw new Error("NAVIGATION_PERMISSION_EVIDENCE_UNAVAILABLE");
  for (const [index, permissionKey] of permissionKeys.entries()) {
    const decision = evaluated[index];
    if (decision === undefined) throw new Error("NAVIGATION_PERMISSION_EVIDENCE_UNAVAILABLE");
    correlations.add(decision.correlationId.toLowerCase());
    decisions[permissionKey] = decision.allowed;
  }
  if (correlations.size !== 1) throw new Error("NAVIGATION_PERMISSION_EVIDENCE_UNAVAILABLE");
  return projectNavigation(loaded.navigation, decisions);
};

/**
 * One resolved navigation requirement: an application or bound-Module permission from the
 * release's prepared registration, or an exact platform administration permission from the
 * shipped platform catalogue. The two carry different authority shapes, so they stay distinct
 * until the declaration is built.
 */
type NavigationPermissionBindingValue =
  | Readonly<{ kind: "definition"; entry: PermissionRegistryEntryCandidate }>
  | Readonly<{ kind: "platform"; ownerId: PlatformId; permission: PermissionDeclaration }>;

const declaration = (
  operationKey: string,
  applicationRootId: ApplicationRootId,
  binding: NavigationPermissionBindingValue,
): OrganizationAccessDeclaration =>
  binding.kind === "platform"
    ? {
        operationKey,
        action: {
          actionKind: binding.permission.actionKind,
          ...(binding.permission.namedAction === undefined
            ? {}
            : { namedAction: binding.permission.namedAction }),
        },
        target: { kind: "organization" },
        requiredPermission: {
          ownerKind: "platform",
          ownerId: binding.ownerId,
          permissionId: binding.permission.permissionId,
        },
        recentAuthentication: { kind: "none" },
        authority: { kind: "permission" },
      }
    : {
        operationKey,
        action: {
          actionKind: binding.entry.permission.actionKind,
          ...(binding.entry.permission.namedAction === undefined
            ? {}
            : { namedAction: binding.entry.permission.namedAction }),
        },
        target: { kind: "application", applicationRootId },
        requiredPermission: {
          applicationRootId: binding.entry.applicationRootId,
          ownerKind: binding.entry.ownerKind,
          ownerId: binding.entry.ownerId,
          permissionId: binding.entry.permission.permissionId,
        },
        recentAuthentication: { kind: "none" },
        authority: { kind: "permission" },
      };

export type StoredNavigationProjectionDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    /**
     * The single trusted installed context assembled by App. Navigation projects only from this
     * exact release set and never re-reads or rebuilds organisation, release or permission
     * authority.
     */
    context: InstalledRuntimeContext;
    /** The shipped platform permission catalogue navigation requirements may name. */
    permissions: PlatformPermissionSource;
  }>;

/**
 * Projects navigation for the exact application release the installed context names. The
 * permission declarations are read from that release's prepared registration, so a navigation
 * key the release does not publish fails the projection closed instead of granting visibility.
 */
export const createStoredNavigationProjectionService = (
  dependencies: StoredNavigationProjectionDependencies,
) => {
  const context = requireInstalledRuntimeContext(dependencies.context);
  const applicationRootId = applicationRootIdSchema.parse(context.applicationRootId);
  const releaseRevision = revisionSchema
    .max(Number.MAX_SAFE_INTEGER)
    .parse(context.applicationReleaseRevision);

  // The loader has already verified this; Page still refuses, rather than projects, a context
  // whose exact release, registration and scope disagree.
  const applicationRelease = context.releaseSet.application;
  const registration = context.permissionRegistration;
  if (
    applicationRelease.organizationId !== context.organizationId ||
    applicationRelease.rootId !== context.applicationRootId ||
    applicationRelease.releaseRevision !== releaseRevision ||
    registration.organizationId !== context.organizationId ||
    registration.applicationRootId !== context.applicationRootId ||
    registration.applicationRelease.releaseRevision !== releaseRevision
  )
    throw new Error("STORED_NAVIGATION_TRUSTED_CONTEXT_UNAVAILABLE");

  const requestDependencies = {
    ...dependencies,
    correlationId: () => context.correlationId,
  };
  const requests = createHumanOrganizationRequestService(requestDependencies);

  const load = (): FixedAuthenticatedNavigationProjection => {
    const permission = (key: string): NavigationPermissionBindingValue => {
      const platform = dependencies.permissions.forKey(key);
      if (platform !== undefined)
        return {
          kind: "platform",
          ownerId: dependencies.permissions.ownerId,
          permission: platform,
        };
      const matches = registration.entries.filter((entry) => entry.permission.key === key);
      if (matches.length !== 1 || matches[0] === undefined)
        throw new Error("STORED_NAVIGATION_PERMISSION_BINDING_UNAVAILABLE");
      return { kind: "definition", entry: matches[0] };
    };
    const permissionBindings = Object.fromEntries(
      collectNavigationPermissionKeys(applicationRelease.content.navigation).map(
        (permissionKey) => [
          permissionKey,
          {
            permissionKey,
            declaration: declaration(
              "application.navigation.discover",
              applicationRootId,
              permission(permissionKey),
            ),
          },
        ],
      ),
    );
    return {
      navigation: applicationRelease.content.navigation,
      permissionBindings,
      sourceCorrelationId: applicationRelease.correlationId,
    };
  };

  const project = async (
    session: IdentitySession,
    candidate: OrganizationSelectionCandidate,
  ): Promise<HumanOrganizationRequestResult<ProjectedNavigation>> => {
    if (
      !sameId(candidate.organizationId, context.organizationId) ||
      candidate.applicationRootId === undefined ||
      !sameId(candidate.applicationRootId, applicationRootId)
    )
      return { kind: "unavailable" };
    // An unauthorised caller gets the same answer whatever the release declares. The projection
    // below runs the same HUMAN request over this exact application scope, so it proves the
    // person's current authority itself; only a release that cannot be projected proves that
    // authority first, on its own.
    let fixed: FixedAuthenticatedNavigationProjection;
    try {
      fixed = load();
    } catch (error) {
      console.error(`[page] NAVIGATION_PROJECTION_LOAD_FAILED: ${describeFailure(error)}`);
      const verified = await requests.run(session, candidate, async () => undefined);
      if (verified.kind !== "available") return verified;
      return { kind: "temporarily_unavailable" };
    }
    const stored = fixed;
    return requests.run(session, candidate, async (transaction, scope) => {
      if (
        scope.applicationRootId === undefined ||
        !sameId(scope.organizationId, context.organizationId) ||
        !sameId(scope.applicationRootId, applicationRootId)
      )
        throw new Error("STORED_NAVIGATION_HUMAN_SCOPE_UNAVAILABLE");
      return projectDecidedNavigation(transaction, scope, stored);
    });
  };

  return Object.freeze({ project });
};
