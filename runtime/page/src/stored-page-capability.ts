import "server-only";

import {
  applicationRootIdSchema,
  pageIdSchema,
  revisionSchema,
  safeHttpsUrlSchema,
  type IdentitySession,
  type ApplicationRootId,
  type OrganizationAccessDeclaration,
  type OrganizationSelectionCandidate,
  type PermissionRegistryEntryCandidate,
  type CurrentUserFlowActionTarget as FlowActionTarget,
  type CurrentUserFlowQueryTarget as FlowQueryTarget,
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
import {
  projectUnavailableLinkDestination,
  type ProjectedLinkDestination,
  type ProjectedPageCapability,
} from "./page-capability-projection";
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

/**
 * One declared link target the browser asks the server to re-check when a link is activated. It
 * names a target kind and that target's permanent identity (or an external address); it carries no
 * authority, so resolving it can never grant access to what it names.
 */
export type StoredLinkTargetDeclaration =
  | Readonly<{ kind: "page"; pageId: string }>
  | Readonly<{ kind: "application"; applicationRootId: string }>
  | Readonly<{ kind: "external"; address: string }>;

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

type OperationOwner = Extract<FlowActionTarget, { kind: "protected_operation" }>["operation"]["owner"];

type ReleaseEvidence = Readonly<{
  releaseVersion: string;
  contentFingerprint: string;
  resolutionFingerprint: string;
}>;

/** Whether a placement's flow bindings reach an operation, and whether all of them resolve. */
type PlacementOperationBinding = Readonly<{ required: boolean; bound: boolean }>;

const operationOwnerId = (owner: OperationOwner): string =>
  owner.kind === "application"
    ? owner.applicationRootId
    : owner.kind === "module"
      ? owner.moduleRootId
      : owner.serviceId;

/**
 * Resolves every placement's compiled component flow bindings against this exact installed release.
 * A placement requires an operation when one of its bound flows reaches an Action target, or when
 * any binding cannot be proved (a platform-managed flow, or a flow or target missing from this
 * release), so an unprovable binding fails closed even without a use gate. It is operation-bound
 * only when it requires an operation and every flow and target it reaches resolves: application
 * evidence names this exact Application release and its verified dependency manifest carries the
 * identical entry, and Module evidence names the exact bound Module release. The operation is
 * never named by the placement or the browser, and this only proves the binding resolves; the
 * owning operation still re-checks its own authority when invoked.
 */
const placementOperationBindings = (
  context: InstalledRuntimeContext,
): ReadonlyMap<string, PlacementOperationBinding> => {
  const release = context.releaseSet;
  const application = release.application;
  const manifest = application.dependencyManifest;
  const flows = new Map(application.content.flows.map((flow) => [flow.flowId.toLowerCase(), flow]));
  const sameEvidence = (entry: ReleaseEvidence, target: ReleaseEvidence): boolean =>
    entry.releaseVersion === target.releaseVersion &&
    entry.contentFingerprint === target.contentFingerprint &&
    entry.resolutionFingerprint === target.resolutionFingerprint;
  const applicationReleased = (applicationRootId: string, evidence: ReleaseEvidence): boolean =>
    sameUuid(applicationRootId, application.rootId) &&
    evidence.releaseVersion === application.releaseVersion &&
    evidence.resolutionFingerprint === application.resolutionFingerprint;
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
  const queryResolves = (target: FlowQueryTarget): boolean => {
    switch (target.kind) {
      case "application_query":
        return (
          applicationReleased(target.applicationRootId, target) &&
          manifest.some(
            (entry) =>
              entry.kind === "application_query" &&
              sameUuid(entry.applicationRootId, target.applicationRootId) &&
              sameUuid(entry.queryId, target.queryId) &&
              sameEvidence(entry, target),
          )
        );
      case "query":
        return (
          moduleReleased(
            target.moduleRootId,
            target.moduleReleaseVersion,
            target.resolutionFingerprint,
          ) &&
          manifest.some(
            (entry) =>
              entry.kind === "module_query" &&
              sameUuid(entry.moduleRootId, target.moduleRootId) &&
              sameUuid(entry.queryId, target.queryId) &&
              sameEvidence(entry, { ...target, releaseVersion: target.moduleReleaseVersion }),
          )
        );
      default:
        return false;
    }
  };
  const actionResolves = (target: FlowActionTarget): boolean => {
    switch (target.kind) {
      case "protected_operation": {
        const owner = target.operation.owner;
        if (
          (owner.kind === "application" && !applicationReleased(owner.applicationRootId, target)) ||
          (owner.kind === "module" &&
            !moduleReleased(
              owner.moduleRootId,
              target.releaseVersion,
              target.resolutionFingerprint,
            )) ||
          (owner.kind === "platform_service" && target.catalogueFingerprint === undefined)
        )
          return false;
        return manifest.some(
          (entry) =>
            entry.kind === "protected_operation" &&
            entry.operation.owner.kind === owner.kind &&
            sameUuid(operationOwnerId(entry.operation.owner), operationOwnerId(owner)) &&
            sameUuid(entry.operation.operationId, target.operation.operationId) &&
            sameEvidence(entry, target) &&
            entry.catalogueFingerprint === target.catalogueFingerprint,
        );
      }
      case "form_continuation":
        return (
          applicationReleased(target.applicationRootId, target) &&
          manifest.some(
            (entry) =>
              entry.kind === "application_form" &&
              sameUuid(entry.applicationRootId, target.applicationRootId) &&
              sameUuid(entry.formId, target.formId) &&
              sameEvidence(entry, target),
          )
        );
      case "durable_workflow_start":
        return (
          applicationReleased(target.applicationRootId, target) &&
          manifest.some(
            (entry) =>
              entry.kind === "application_workflow" &&
              sameUuid(entry.applicationRootId, target.applicationRootId) &&
              sameUuid(entry.workflowId, target.workflowId) &&
              sameEvidence(entry, target),
          )
        );
      case "application_action":
        return (
          applicationReleased(target.applicationRootId, target) &&
          manifest.some(
            (entry) =>
              entry.kind === "application_action" &&
              sameUuid(entry.applicationRootId, target.applicationRootId) &&
              sameUuid(entry.actionId, target.actionId) &&
              sameEvidence(entry, target),
          )
        );
      // A generic record save is pinned only by its owning Module's exact bound release.
      case "record_save":
        return (
          sameUuid(target.applicationRootId, application.rootId) &&
          moduleReleased(target.moduleRootId, target.releaseVersion, target.resolutionFingerprint)
        );
      default:
        return false;
    }
  };
  const outcomes = new Map<string, { required: boolean; resolved: boolean }>();
  for (const binding of application.content.flowBindings) {
    const placementId = binding.controlId.toLowerCase();
    const outcome = outcomes.get(placementId) ?? { required: false, resolved: true };
    outcomes.set(placementId, outcome);
    const reference = binding.flow;
    const flow =
      reference.kind === "application_owned" ? flows.get(reference.flowId.toLowerCase()) : undefined;
    // A platform-managed flow's operations cannot be read here, so it fails closed like any flow
    // whose exact evidence is not this release's.
    if (
      reference.kind !== "application_owned" ||
      flow === undefined ||
      !applicationReleased(reference.applicationRootId, reference) ||
      !applicationReleased(application.rootId, flow) ||
      flow.contentFingerprint !== reference.contentFingerprint ||
      !manifest.some(
        (entry) =>
          entry.kind === "application_flow" &&
          sameUuid(entry.applicationRootId, application.rootId) &&
          sameUuid(entry.flowId, flow.flowId) &&
          sameEvidence(entry, reference),
      )
    ) {
      outcome.required = true;
      outcome.resolved = false;
      continue;
    }
    for (const node of flow.nodes) {
      if (node.kind === "action") {
        outcome.required = true;
        if (!actionResolves(node.target)) outcome.resolved = false;
      } else if (node.kind === "query" && !queryResolves(node.target)) {
        outcome.required = true;
        outcome.resolved = false;
      }
    }
  }
  return new Map(
    [...outcomes].map(([placementId, outcome]) => [
      placementId,
      { required: outcome.required, bound: outcome.required && outcome.resolved },
    ]),
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
  const load = async (pageId: string): Promise<FixedAuthenticatedPageCapability | undefined> => {
    const pages = applicationRelease.content.pages.filter((page) => sameUuid(page.pageId, pageId));
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
    const operationBindings = placementOperationBindings(context);
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
          const operation = operationBindings.get(placementId.toLowerCase());
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
              operationRequired: operation?.required === true,
              operationBound: operation?.bound === true,
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
      fixed = await load(selectedPageId);
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
    /**
     * Re-checks one declared link target against the viewer's current access at navigation time.
     * An external address is always available once it satisfies the bounded HTTPS contract and is
     * never fetched. An internal application or page is proven only through this exact installed
     * release and the viewer's current authority; a target that is missing, refused, withdrawn or
     * outside the installed release collapses to the same opaque unavailable state, which carries
     * no name, icon, address or reason. A caller without authority over this scope gets the same
     * neutral refusal as the page itself.
     */
    async resolveLinkTarget(
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      target: StoredLinkTargetDeclaration,
    ): Promise<HumanOrganizationRequestResult<ProjectedLinkDestination>> {
      if (target.kind === "external") {
        const address = safeHttpsUrlSchema.safeParse(target.address);
        return address.success
          ? {
              kind: "available",
              value: { availability: "available", kind: "external", address: address.data },
            }
          : { kind: "available", value: projectUnavailableLinkDestination() };
      }
      if (
        !sameUuid(candidate.organizationId, context.organizationId) ||
        candidate.applicationRootId === undefined ||
        !sameUuid(candidate.applicationRootId, applicationRootId)
      )
        return { kind: "unavailable" };

      if (target.kind === "application") {
        const parsed = applicationRootIdSchema.safeParse(target.applicationRootId);
        if (!parsed.success || !sameUuid(parsed.data, applicationRootId))
          return { kind: "available", value: projectUnavailableLinkDestination() };
        const verified = await requests.run(session, candidate, async () => undefined);
        return verified.kind === "available"
          ? {
              kind: "available",
              value: { availability: "available", kind: "application", applicationRootId },
            }
          : { kind: "available", value: projectUnavailableLinkDestination() };
      }

      const parsed = pageIdSchema.safeParse(target.pageId);
      if (!parsed.success) return { kind: "available", value: projectUnavailableLinkDestination() };
      let fixed: FixedAuthenticatedPageCapability | undefined;
      try {
        fixed = await load(parsed.data);
      } catch {
        return { kind: "available", value: projectUnavailableLinkDestination() };
      }
      if (fixed === undefined)
        return { kind: "available", value: projectUnavailableLinkDestination() };
      const stored = fixed;
      const projected = await createAuthenticatedPageCapabilityService({
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
      return projected.kind === "available" && projected.value !== undefined
        ? {
            kind: "available",
            value: { availability: "available", kind: "page", pageId: parsed.data },
          }
        : { kind: "available", value: projectUnavailableLinkDestination() };
    },
  });
};
