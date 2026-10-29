import type { PlatformPermissionSource } from "../access/platform-permissions";
import "server-only";

import type { OrganizationAccessDeclaration } from "../access/organization-access-decision";
import type { PermissionRegistryEntryCandidate } from "../access/permission-registry";
import type { PermissionDeclaration } from "../access/permissions";
import {
  applicationRootIdSchema,
  revisionSchema,
  type ApplicationRootId,
  type PlatformId,
} from "../catalogue/identifiers";
import type { NavigationItem } from "../definition/application-contracts";
import {
  type ProjectedNavigation,
  collectNavigationPermissionKeys,
  projectNavigation,
} from "./projected-navigation";
import type { decideOrganizationAccessBatch } from "../access/organization-access-decision-access";
import {
  requireInstalledRuntimeContext,
  type InstalledRuntimeContext,
} from "../definition/installed-runtime-context";

type NavigationPermissionBinding = Readonly<{
  permissionKey: string;
  declaration: OrganizationAccessDeclaration;
}>;

/**
 * The exact installed application's navigation and the Access declaration for each permission
 * key it names. The declaration comes from the release's prepared registration, never from the
 * browser, so the projection evaluates only authority the server can prove.
 */
type FixedAuthenticatedNavigationProjection = Readonly<{
  navigation: readonly NavigationItem[];
  permissionBindings: Readonly<Record<string, NavigationPermissionBinding>>;
  sourceCorrelationId: string;
}>;

/** One decision of the batch a navigation projection's declarations were decided in. */
type NavigationDecision = Awaited<ReturnType<typeof decideOrganizationAccessBatch>>[number];

/**
 * Projects the ordered tree from the live Access decisions of each distinct navigation permission,
 * decided through the same eligibility evaluation as page capability, in the page projection's own
 * request. Every item the viewer does not currently hold is dropped with its heading when that
 * leaves the heading empty. Missing evidence is a refusal to project, never a silently visible item.
 */
const projectDecidedNavigation = (
  loaded: FixedAuthenticatedNavigationProjection,
  permissionKeys: readonly string[],
  evaluated: readonly NavigationDecision[],
): ProjectedNavigation => {
  const correlations = new Set([loaded.sourceCorrelationId.toLowerCase()]);
  const decisions: Record<string, boolean> = {};
  if (evaluated.length !== permissionKeys.length)
    throw new Error("NAVIGATION_PERMISSION_EVIDENCE_UNAVAILABLE");
  for (const [index, permissionKey] of permissionKeys.entries()) {
    const decision = evaluated[index];
    if (decision === undefined) throw new Error("NAVIGATION_PERMISSION_EVIDENCE_UNAVAILABLE");
    correlations.add(decision.correlationId.toLowerCase());
    decisions[permissionKey] = decision.allowed;
  }
  // Each decision is bound to the request's scope and access version, and its correlation must
  // be this one request's.
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

type StoredNavigationProjectionDependencies = Readonly<{
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
 * The navigation of the exact application release the installed context names, ready to be
 * decided in the page projection's request: the declaration of each distinct navigation permission
 * (in the order `project` takes their decisions) and the projection of the tree from them.
 */
export type StoredNavigationProjection = Readonly<{
  declarations: readonly OrganizationAccessDeclaration[];
  project: (decisions: readonly NavigationDecision[]) => ProjectedNavigation;
}>;

/**
 * Loads the navigation of the exact application release the installed context names. The
 * permission declarations are read from that release's prepared registration, so a navigation key
 * the release does not publish fails the load closed instead of granting visibility.
 */
export const loadStoredNavigationProjection = (
  dependencies: StoredNavigationProjectionDependencies,
): StoredNavigationProjection => {
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
  const loaded: FixedAuthenticatedNavigationProjection = {
    navigation: applicationRelease.content.navigation,
    permissionBindings: Object.fromEntries(
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
    ),
    sourceCorrelationId: applicationRelease.correlationId,
  };
  const permissionKeys = collectNavigationPermissionKeys(loaded.navigation);
  const declarations = permissionKeys.map((permissionKey) => {
    const binding = Object.hasOwn(loaded.permissionBindings, permissionKey)
      ? loaded.permissionBindings[permissionKey]
      : undefined;
    if (binding === undefined || binding.permissionKey !== permissionKey)
      throw new Error("NAVIGATION_PERMISSION_BINDING_UNAVAILABLE");
    return binding.declaration;
  });
  return Object.freeze({
    declarations,
    project: (decisions: readonly NavigationDecision[]) =>
      projectDecidedNavigation(loaded, permissionKeys, decisions),
  });
};
