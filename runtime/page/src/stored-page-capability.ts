import "server-only";

import {
  applicationRootIdSchema,
  pageIdSchema,
  revisionSchema,
  type IdentitySession,
  type ApplicationRootId,
  type OrganizationAccessDeclaration,
  type OrganizationSelectionCandidate,
  type PermissionRegistryEntryCandidate,
  type CurrentUserFlow,
  type ProtectedReadModelKey,
} from "@vortex/contracts";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
import { requireInstalledRuntimeContext, type InstalledRuntimeContext } from "@vortex/app";
import {
  createAuthenticatedPageCapabilityService,
  type FixedAuthenticatedPageCapability,
} from "./authenticated-page-capability";
import type { ProjectedPageCapability } from "./page-capability-projection";
import { resolvePageComposition } from "./page-composition-resolution";
import {
  createProtectedReadModelResolver,
  type ProtectedReadModelReaders,
} from "./protected-read-model-resolution";

/** The browser address may select only a page; organisation, installation and release come from context. */
export type StoredPageCapabilitySelection = Readonly<{
  pageId: string;
}>;

export type StoredPageCapabilityDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    /**
     * The single trusted installed context assembled by App. Page projects only from this exact
     * release set and never re-reads or rebuilds organisation, release or permission authority.
     */
    context: InstalledRuntimeContext;
    selection: StoredPageCapabilitySelection;
    /**
     * The existing protected Access and Identity readers, composed by the server. A read-model
     * placement is refused while they are not supplied; Page never reads those tables itself.
     */
    protectedReadModelReaders?: ProtectedReadModelReaders;
  }>;

/** Live protected data for one visible read-model placement; never stored or copied. */
export type StoredPageReadModelValue = Readonly<{
  model: ProtectedReadModelKey;
  value: unknown;
}>;

type FlowActionTarget = Extract<CurrentUserFlow["nodes"][number], { kind: "action" }>["target"];

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

/**
 * A placement is operation-bound when its compiled component flow bindings reach at least one
 * operation Action target and every such target resolves in this exact installed release: the
 * Application's verified dependency manifest carries the identical release evidence and, for a
 * Module-owned target, the bound release set carries that exact Module release. The operation is
 * never named by the placement or the browser, and this only proves the binding resolves; the
 * owning operation still re-checks its own authority when invoked.
 */
const operationBoundPlacements = (context: InstalledRuntimeContext): ReadonlySet<string> => {
  const release = context.releaseSet;
  const application = release.application;
  const flows = new Map(application.content.flows.map((flow) => [flow.flowId.toLowerCase(), flow]));
  const manifest = application.dependencyManifest;
  const sameEvidence = (
    entry: { releaseVersion: string; contentFingerprint: string; resolutionFingerprint: string },
    target: { releaseVersion: string; contentFingerprint: string; resolutionFingerprint: string },
  ): boolean =>
    entry.releaseVersion === target.releaseVersion &&
    entry.contentFingerprint === target.contentFingerprint &&
    entry.resolutionFingerprint === target.resolutionFingerprint;
  const moduleReleased = (
    moduleRootId: string,
    releaseVersion: string,
    resolutionFingerprint: string,
  ): boolean =>
    release.modules.some(
      (module) =>
        sameUuid(module.rootId, moduleRootId) &&
        module.releaseVersion === releaseVersion &&
        module.resolutionFingerprint === resolutionFingerprint,
    );
  const resolves = (target: FlowActionTarget): boolean => {
    switch (target.kind) {
      case "protected_operation": {
        const owner = target.operation.owner;
        const ownerId =
          owner.kind === "application"
            ? owner.applicationRootId
            : owner.kind === "module"
              ? owner.moduleRootId
              : owner.serviceId;
        if (
          owner.kind === "module" &&
          !moduleReleased(owner.moduleRootId, target.releaseVersion, target.resolutionFingerprint)
        )
          return false;
        return manifest.some(
          (entry) =>
            entry.kind === "protected_operation" &&
            entry.operation.owner.kind === owner.kind &&
            sameUuid(
              entry.operation.owner.kind === "application"
                ? entry.operation.owner.applicationRootId
                : entry.operation.owner.kind === "module"
                  ? entry.operation.owner.moduleRootId
                  : entry.operation.owner.serviceId,
              ownerId,
            ) &&
            sameUuid(entry.operation.operationId, target.operation.operationId) &&
            sameEvidence(entry, target),
        );
      }
      case "application_action":
        return manifest.some(
          (entry) =>
            entry.kind === "application_action" &&
            sameUuid(entry.applicationRootId, target.applicationRootId) &&
            sameUuid(entry.actionId, target.actionId) &&
            sameEvidence(entry, target),
        );
      case "durable_workflow_start":
        return manifest.some(
          (entry) =>
            entry.kind === "application_workflow" &&
            sameUuid(entry.applicationRootId, target.applicationRootId) &&
            sameUuid(entry.workflowId, target.workflowId) &&
            sameEvidence(entry, target),
        );
      case "record_save":
        return moduleReleased(target.moduleRootId, target.releaseVersion, target.resolutionFingerprint);
      default:
        return false;
    }
  };
  const targetsByPlacement = new Map<string, boolean[]>();
  for (const binding of application.content.flowBindings) {
    const flow =
      binding.flow.kind === "application_owned"
        ? flows.get(binding.flow.flowId.toLowerCase())
        : undefined;
    const placementId = binding.controlId.toLowerCase();
    const outcomes = targetsByPlacement.get(placementId) ?? [];
    targetsByPlacement.set(placementId, outcomes);
    // An unresolved or platform-managed flow cannot prove its operations, so it fails closed.
    if (flow === undefined || flow.contentFingerprint !== binding.flow.contentFingerprint) {
      outcomes.push(false);
      continue;
    }
    for (const node of flow.nodes)
      if (node.kind === "action" && node.target.kind !== "form_continuation")
        outcomes.push(resolves(node.target));
  }
  return new Set(
    [...targetsByPlacement].flatMap(([placementId, outcomes]) =>
      outcomes.length > 0 && outcomes.every(Boolean) ? [placementId] : [],
    ),
  );
};

/** Finds a placement the viewer can see in the already permission-filtered projection. */
const findProjectedPlacement = (
  slot: unknown,
  placementId: string,
): Record<string, unknown> | undefined => {
  const placements = (slot as { placements?: Record<string, Record<string, unknown>> } | undefined)
    ?.placements;
  if (placements === undefined) return undefined;
  for (const [candidateId, placement] of Object.entries(placements)) {
    if (sameUuid(candidateId, placementId)) return placement;
    for (const child of Object.values((placement.slots ?? {}) as Record<string, unknown>)) {
      const found = findProjectedPlacement(child, placementId);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

const projectedRoots = (projected: Readonly<Record<string, unknown>>): unknown[] => {
  const composition = projected.composition as Record<string, unknown> | undefined;
  if (composition === undefined) return [];
  if ("main" in composition) return [composition.main];
  return Object.values((composition.stepContent ?? {}) as Record<string, unknown>);
};

const v2Placements = (slot: unknown): Record<string, unknown>[] => {
  const candidate = slot as { placements: Record<string, Record<string, unknown>> };
  return Object.entries(candidate.placements).flatMap(([placementId, placement]) => [
    { placementId, ...placement },
    ...Object.values(placement.slots as Record<string, unknown>).flatMap(v2Placements),
  ]);
};

export const createStoredPageCapabilityService = (
  dependencies: StoredPageCapabilityDependencies,
) => {
  // Only a context App assembled is accepted; a missing or look-alike object fails closed here.
  const context = requireInstalledRuntimeContext(dependencies.context);
  const applicationRootId = applicationRootIdSchema.parse(context.applicationRootId);
  const releaseRevision = revisionSchema
    .max(Number.MAX_SAFE_INTEGER)
    .parse(context.applicationReleaseRevision);
  const selectedPageId = pageIdSchema.parse(dependencies.selection.pageId);

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
    throw new Error("STORED_PAGE_TRUSTED_CONTEXT_UNAVAILABLE");

  const requestDependencies = {
    ...dependencies,
    correlationId: () => context.correlationId,
  };
  const requests = createHumanOrganizationRequestService(requestDependencies);

  // Undefined means the selected page is not in the release: a lasting answer, not a fault.
  const load = async (): Promise<FixedAuthenticatedPageCapability | undefined> => {
    const pages = applicationRelease.content.pages.filter((page) =>
      sameUuid(page.pageId, selectedPageId),
    );
    if (pages.length === 0) return undefined;
    if (pages.length !== 1 || pages[0] === undefined)
      throw new Error("STORED_PAGE_DEFINITION_EVIDENCE_UNAVAILABLE");
    const page = pages[0];
    const permission = (key: string) => {
      const matches = registration.entries.filter((entry) => entry.permission.key === key);
      if (matches.length !== 1 || matches[0] === undefined)
        throw new Error("STORED_PAGE_PERMISSION_BINDING_UNAVAILABLE");
      return matches[0];
    };
    const boundPlacements = operationBoundPlacements(context);
    const pageEntry = permission(page.accessPermissionKey);
    const resolved = resolvePageComposition(page, applicationRelease.content.shells);
    const placements: Record<string, unknown>[] =
      resolved.roots.kind === "page"
        ? v2Placements(resolved.roots.main)
        : Object.values(resolved.roots.stepContent).flatMap(v2Placements);
    return {
      page,
      applicationShells: applicationRelease.content.shells,
      sourceCorrelationId: applicationRelease.correlationId,
      pagePermission: {
        permissionKey: page.accessPermissionKey,
        declaration: declaration("application.page.discover", applicationRootId, pageEntry),
      },
      placements: Object.fromEntries(
        placements.map((placement) => {
          const placementId = String(placement.placementId);
          const viewPermissionKey = placement.viewPermissionKey as string | undefined;
          const usePermissionKey = placement.usePermissionKey as string | undefined;
          const viewEntry =
            viewPermissionKey === undefined ? undefined : permission(viewPermissionKey);
          const useEntry =
            usePermissionKey === undefined ? undefined : permission(usePermissionKey);
          return [
            placementId,
            {
              ...(viewEntry === undefined || viewPermissionKey === undefined
                ? {}
                : {
                    viewPermission: {
                      permissionKey: viewPermissionKey,
                      declaration: declaration(
                        "application.page.placement.view",
                        applicationRootId,
                        viewEntry,
                      ),
                    },
                  }),
              ...(useEntry === undefined || usePermissionKey === undefined
                ? {}
                : {
                    usePermission: {
                      permissionKey: usePermissionKey,
                      declaration: declaration(
                        "application.page.placement.use",
                        applicationRootId,
                        useEntry,
                      ),
                    },
                  }),
              operationBound: boundPlacements.has(placementId.toLowerCase()),
            },
          ];
        }),
      ),
    };
  };

  const project = async (
    session: IdentitySession,
    candidate: OrganizationSelectionCandidate,
  ): Promise<HumanOrganizationRequestResult<ProjectedPageCapability>> => {
    if (
      !sameUuid(candidate.organizationId, context.organizationId) ||
      candidate.applicationRootId === undefined ||
      !sameUuid(candidate.applicationRootId, applicationRootId)
    )
      return { kind: "unavailable" };
    // Verify the session and application scope before projecting, so a caller without access
    // gets the same answer whether or not the page exists. The context read is already done by
    // App; the human request only proves the person's current authority over this scope.
    const verified = await requests.run(session, candidate, async () => undefined);
    if (verified.kind !== "available") return verified;
    let fixed: FixedAuthenticatedPageCapability | undefined;
    try {
      fixed = await load();
    } catch {
      return { kind: "temporarily_unavailable" };
    }
    if (fixed === undefined) return { kind: "unavailable" };
    const stored = fixed;
    return createAuthenticatedPageCapabilityService({
      ...requestDependencies,
      adapter: {
        load: async (_transaction, scope) => {
          if (
            scope.applicationRootId === undefined ||
            !sameUuid(scope.organizationId, context.organizationId) ||
            !sameUuid(scope.applicationRootId, applicationRootId)
          )
            throw new Error("STORED_PAGE_HUMAN_SCOPE_UNAVAILABLE");
          return stored;
        },
      },
    }).project(session, candidate, undefined);
  };

  const readModels =
    dependencies.protectedReadModelReaders === undefined
      ? undefined
      : createProtectedReadModelResolver(dependencies.protectedReadModelReaders);

  return Object.freeze({
    project,
    /**
     * Reads one read-model placement of the selected page live, at request time. The binding comes
     * only from the exact release; the viewer must be able to see the page and that placement, and
     * the owning reader then applies its own authority to the viewer's current session. Every
     * refusal is the same neutral answer and is never an empty page.
     */
    async readModel(
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      placementId: string,
      requestCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<StoredPageReadModelValue>> {
      const projected = await project(session, candidate);
      if (projected.kind !== "available") return projected;
      if (projected.value === undefined || readModels === undefined) return { kind: "unavailable" };
      const placement = projectedRoots(projected.value)
        .map((root) => findProjectedPlacement(root, placementId))
        .find((found) => found !== undefined);
      if (placement?.readModel === undefined) return { kind: "unavailable" };
      // The tenant is the verified scope's own tenant, never page or browser input.
      const scoped = await requests.run(session, candidate, async (_transaction, scope) =>
        String(scope.tenantId),
      );
      if (scoped.kind !== "available") return scoped;
      const resolved = await readModels.resolve(
        { session, selection: candidate, tenantId: scoped.value },
        placement.readModel,
        requestCandidate,
      );
      return resolved.kind === "available"
        ? { kind: "available", value: { model: resolved.model, value: resolved.value } }
        : resolved.kind === "unavailable"
          ? { kind: "temporarily_unavailable" }
          : { kind: "unavailable" };
    },
  });
};
