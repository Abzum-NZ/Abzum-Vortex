import "server-only";

import {
  applicationRootIdSchema,
  revisionSchema,
  type ApplicationRootId,
  type IdentitySession,
  type NavigationItem,
  type OrganizationAccessDeclaration,
  type OrganizationSelectionCandidate,
  type PermissionRegistryEntryCandidate,
  type ProjectedNavigation,
  type ProjectedNavigationItem,
  type SelectedOrganizationScope,
} from "@vortex/contracts";
import type { RequestDatabaseTransaction } from "@vortex/db";
import {
  createHumanOrganizationRequestService,
  runOrganizationAccessOperation,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
import { requireInstalledRuntimeContext, type InstalledRuntimeContext } from "@vortex/app";

/**
 * The projected navigation shape is shared with the browser renderer in `@vortex/contracts`: the
 * server projects into it and the client renders it, so both use the same type.
 */
export type { ProjectedNavigation, ProjectedNavigationItem };

/** One permission decision per distinct navigation permission key, from the viewer's live access. */
export type NavigationPermissionDecisions = Readonly<Record<string, boolean>>;

const held = (decisions: NavigationPermissionDecisions, permissionKey: string): boolean =>
  Object.hasOwn(decisions, permissionKey) && decisions[permissionKey] === true;

const projectNavigationItem = (
  item: NavigationItem,
  decisions: NavigationPermissionDecisions,
): ProjectedNavigationItem | undefined => {
  switch (item.type) {
    case "page":
      return held(decisions, item.permissionKey)
        ? { type: "page", id: item.id, label: item.label, pageId: item.pageId }
        : undefined;
    case "external":
      return held(decisions, item.permissionKey)
        ? { type: "external", id: item.id, label: item.label, address: item.address }
        : undefined;
    case "heading": {
      const children = item.children.flatMap((child) => {
        const projected = projectNavigationItem(child, decisions);
        return projected === undefined ? [] : [projected];
      });
      // An empty heading is not a navigation item: it disappears with its children.
      return children.length === 0
        ? undefined
        : { type: "heading", id: item.id, label: item.label, children };
    }
  }
};

/**
 * Filters one compiled navigation tree to the items the viewer holds, preserving definition
 * order. A missing decision is treated exactly like a refusal, so the pure projection fails
 * closed when it is handed incomplete evidence.
 */
export const projectNavigation = (
  navigation: readonly NavigationItem[],
  decisions: NavigationPermissionDecisions,
): ProjectedNavigation =>
  navigation.flatMap((item) => {
    const projected = projectNavigationItem(item, decisions);
    return projected === undefined ? [] : [projected];
  });

/** Every distinct permission key the compiled navigation declares, for one evaluation each. */
export const collectNavigationPermissionKeys = (
  navigation: readonly NavigationItem[],
): readonly string[] => {
  const keys = new Set<string>();
  const visit = (items: readonly NavigationItem[]): void => {
    for (const item of items) {
      if (item.type === "heading") visit(item.children);
      else keys.add(item.permissionKey);
    }
  };
  visit(navigation);
  return [...keys];
};

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

export interface FixedAuthenticatedNavigationProjectionAdapter<Command> {
  load(
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
    command: Command,
  ): Promise<FixedAuthenticatedNavigationProjection>;
}

export type AuthenticatedNavigationProjectionDependencies<Command> =
  HumanOrganizationRequestDependencies &
    Readonly<{ adapter: FixedAuthenticatedNavigationProjectionAdapter<Command> }>;

/**
 * Evaluates each distinct navigation permission through the same live Access decision path as
 * page capability, then projects the ordered tree. Every item the viewer does not currently
 * hold is dropped with its heading when that leaves the heading empty. Missing evidence is a
 * refusal to project, never a silently visible item.
 */
export const createAuthenticatedNavigationProjectionService = <Command>(
  dependencies: AuthenticatedNavigationProjectionDependencies<Command>,
) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  return Object.freeze({
    project: (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      command: Command,
    ): Promise<HumanOrganizationRequestResult<ProjectedNavigation>> =>
      requests.run(session, candidate, async (transaction, scope) => {
        const loaded = await dependencies.adapter.load(transaction, scope, command);
        const bindings = loaded.permissionBindings;
        const correlations = new Set([loaded.sourceCorrelationId.toLowerCase()]);
        const decisions: Record<string, boolean> = {};
        for (const permissionKey of collectNavigationPermissionKeys(loaded.navigation)) {
          const binding = Object.hasOwn(bindings, permissionKey)
            ? bindings[permissionKey]
            : undefined;
          if (binding === undefined || binding.permissionKey !== permissionKey)
            throw new Error("NAVIGATION_PERMISSION_BINDING_UNAVAILABLE");
          const evaluated = await runOrganizationAccessOperation(
            transaction,
            scope,
            binding.declaration,
            async (decision) => decision.correlationId,
          );
          // An allowed decision carries its correlation as the operation value; a refusal carries
          // it directly. Both must belong to this one request.
          const allowed = evaluated.outcome === "completed";
          correlations.add((allowed ? evaluated.value : evaluated.correlationId).toLowerCase());
          decisions[permissionKey] = allowed;
        }
        if (correlations.size !== 1) throw new Error("NAVIGATION_PERMISSION_EVIDENCE_UNAVAILABLE");
        return projectNavigation(loaded.navigation, decisions);
      }),
  });
};

const sameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const declaration = (
  operationKey: string,
  applicationRootId: ApplicationRootId,
  entry: PermissionRegistryEntryCandidate,
): OrganizationAccessDeclaration => ({
  operationKey,
  action: {
    actionKind: entry.permission.actionKind,
    ...(entry.permission.namedAction === undefined
      ? {}
      : { namedAction: entry.permission.namedAction }),
  },
  target: { kind: "application", applicationRootId },
  requiredPermission: {
    applicationRootId: entry.applicationRootId,
    ownerKind: entry.ownerKind,
    ownerId: entry.ownerId,
    permissionId: entry.permission.permissionId,
  },
  recentAuthentication: { kind: "none" },
  authority: { kind: "permission" },
});

export type StoredNavigationProjectionDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    /**
     * The single trusted installed context assembled by App. Navigation projects only from this
     * exact release set and never re-reads or rebuilds organisation, release or permission
     * authority.
     */
    context: InstalledRuntimeContext;
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
    const permission = (key: string): PermissionRegistryEntryCandidate => {
      const matches = registration.entries.filter((entry) => entry.permission.key === key);
      if (matches.length !== 1 || matches[0] === undefined)
        throw new Error("STORED_NAVIGATION_PERMISSION_BINDING_UNAVAILABLE");
      return matches[0];
    };
    const permissionBindings = Object.fromEntries(
      collectNavigationPermissionKeys(applicationRelease.content.navigation).map((permissionKey) => [
        permissionKey,
        {
          permissionKey,
          declaration: declaration(
            "application.navigation.discover",
            applicationRootId,
            permission(permissionKey),
          ),
        },
      ]),
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
      !sameUuid(candidate.organizationId, context.organizationId) ||
      candidate.applicationRootId === undefined ||
      !sameUuid(candidate.applicationRootId, applicationRootId)
    )
      return { kind: "unavailable" };
    // Prove the person's current authority over this exact application scope before projecting,
    // so an unauthorised caller gets the same answer whatever the release declares.
    const verified = await requests.run(session, candidate, async () => undefined);
    if (verified.kind !== "available") return verified;
    let fixed: FixedAuthenticatedNavigationProjection;
    try {
      fixed = load();
    } catch {
      return { kind: "temporarily_unavailable" };
    }
    const stored = fixed;
    return createAuthenticatedNavigationProjectionService({
      ...requestDependencies,
      adapter: {
        load: async (_transaction, scope) => {
          if (
            scope.applicationRootId === undefined ||
            !sameUuid(scope.organizationId, context.organizationId) ||
            !sameUuid(scope.applicationRootId, applicationRootId)
          )
            throw new Error("STORED_NAVIGATION_HUMAN_SCOPE_UNAVAILABLE");
          return stored;
        },
      },
    }).project(session, candidate, undefined);
  };

  return Object.freeze({ project });
};
