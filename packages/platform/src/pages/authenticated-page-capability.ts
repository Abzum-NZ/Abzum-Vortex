import "server-only";

import {
  canonicalJson,
  pageDefinitionSchema,
  type ApplicationShell,
  type ConditionNode,
  type IdentitySession,
  type OrganizationAccessDeclaration,
  type OrganizationRecordAccessDeclaration,
  type OrganizationSelectionCandidate,
  type PageDefinition,
  type SelectedOrganizationScope,
} from "../schema";
import {
  isTrustedInstalledPageComposition,
  type InstalledRuntimeContext,
} from "../definition/app-index";
import type { RequestDatabaseTransaction } from "../db/index";
import {
  createHumanOrganizationRequestService,
  evaluateOrganizationRecordPermissionAvailability,
  runOrganizationAccessOperation,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "../access/index";
import {
  projectPageCapability,
  type PageCapabilityState,
  type ProjectedPageCapability,
} from "./page-capability-projection";
import {
  resolvePageComposition,
  type ResolvedPageComposition,
} from "./page-composition-resolution";

type PermissionBinding = Readonly<{
  permissionKey: string;
  declaration: OrganizationAccessDeclaration;
}>;

type PlacementPermissionBinding =
  | (PermissionBinding & Readonly<{ kind: "permission" }>)
  | Readonly<{
      kind: "record";
      permissionKey: string;
      declaration: OrganizationRecordAccessDeclaration;
    }>;

export type FixedAuthenticatedPageCapability = Readonly<{
  page: PageDefinition;
  applicationShells?: readonly ApplicationShell[];
  /** Exact request-context-bound resolved roots from the validated immutable format-2 bundle. */
  resolvedComposition?: ResolvedPageComposition;
  resolvedCompositionContext?: InstalledRuntimeContext;
  sourceCorrelationId?: string;
  /**
   * The exact installed application release revision this fixed capability was loaded from. It is
   * carried onto the projected page so browser history, cache and late responses can be refused.
   */
  applicationReleaseRevision?: number;
  pagePermission: PermissionBinding;
  placements: Readonly<
    Record<
      string,
      Readonly<{
        viewPermission?: PlacementPermissionBinding;
        usePermission?: PlacementPermissionBinding;
        /**
         * The placement's bindings reach an operation or cannot be proved, so even without a use
         * gate it is available only when `operationBound`. Omitted means it binds no operation.
         */
        operationRequired?: boolean;
        operationBound: boolean;
        visibilityConditionAllowed?: boolean;
      }>
    >
  >;
}>;

export interface FixedAuthenticatedPageCapabilityAdapter<Command> {
  load(
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
    command: Command,
  ): Promise<FixedAuthenticatedPageCapability>;
}

export type AuthenticatedPageCapabilityDependencies<Command> =
  HumanOrganizationRequestDependencies &
    Readonly<{
      adapter: FixedAuthenticatedPageCapabilityAdapter<Command>;
      /** Server-owned operand resolution, under the same verified transaction as the view gates. */
      evaluateVisibilityCondition?: (
        transaction: RequestDatabaseTransaction,
        scope: SelectedOrganizationScope,
        page: PageDefinition,
        condition: ConditionNode,
      ) => Promise<boolean>;
      /** Final current-context and database-clock check for the earliest private Access deadline. */
      validateAccessEligibilityUntil?: (
        transaction: RequestDatabaseTransaction,
        scope: SelectedOrganizationScope,
        validUntil: string,
      ) => Promise<boolean>;
    }>;

type RequiredPlacement = Readonly<{
  placementId: string;
  viewPermissionKey?: string;
  usePermissionKey?: string;
  visibilityCondition?: ConditionNode;
  ancestorPlacementIds: readonly string[];
}>;

const collectSlot = (
  slot: ApplicationShell["layout"],
  result: RequiredPlacement[],
  ancestorPlacementIds: readonly string[] = [],
): void => {
  for (const [placementId, candidate] of Object.entries(slot.placements)) {
    result.push({
      placementId,
      ancestorPlacementIds,
      ...(candidate.viewPermissionKey === undefined
        ? {}
        : { viewPermissionKey: String(candidate.viewPermissionKey) }),
      ...(candidate.usePermissionKey === undefined
        ? {}
        : { usePermissionKey: String(candidate.usePermissionKey) }),
      ...(candidate.visibilityCondition === undefined
        ? {}
        : { visibilityCondition: candidate.visibilityCondition }),
    });
    for (const child of Object.values(candidate.slots))
      collectSlot(child, result, [...ancestorPlacementIds, placementId]);
  }
};

const requiredPlacements = (resolved: ResolvedPageComposition): RequiredPlacement[] => {
  const result: RequiredPlacement[] = [];
  if (resolved.roots.kind === "page")
    collectSlot(resolved.roots.main, result);
  else
    for (const root of Object.values(resolved.roots.stepContent))
      collectSlot(root, result);
  return result;
};

const isRecordPlacementBinding = (
  binding: PermissionBinding | PlacementPermissionBinding,
): binding is Extract<PlacementPermissionBinding, Readonly<{ kind: "record" }>> =>
  "kind" in binding && binding.kind === "record";

const evaluate = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  binding: PermissionBinding | PlacementPermissionBinding,
): Promise<Readonly<{
  allowed: boolean;
  correlationId: string;
  validUntil?: string;
}>> => {
  // Record placement availability carries no row decision and invokes no operation callback.
  // Page-level and non-record gates still use their original generic permission operation.
  const result = isRecordPlacementBinding(binding)
    ? await evaluateOrganizationRecordPermissionAvailability(transaction, scope, binding.declaration)
    : await runOrganizationAccessOperation(
        transaction,
        scope,
        binding.declaration,
        async (decision) => ({
          correlationId: decision.correlationId,
          validUntil: decision.validUntil,
        }),
      );
  const evaluated = result.outcome === "completed"
    ? { allowed: true, correlationId: result.value.correlationId }
    : { allowed: result.outcome === "eligible", correlationId: result.correlationId };
  const validUntil = result.outcome === "eligible"
    ? result.validUntil
    : result.outcome === "completed" ? result.value.validUntil : undefined;
  return { ...evaluated, ...(validUntil === undefined ? {} : { validUntil }) };
};

const sameKey = (left: string, right: string): boolean => left === right;

export const createAuthenticatedPageCapabilityService = <Command>(
  dependencies: AuthenticatedPageCapabilityDependencies<Command>,
) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  return Object.freeze({
    project: (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      command: Command,
    ): Promise<HumanOrganizationRequestResult<ProjectedPageCapability>> =>
      requests.run(session, candidate, async (transaction, scope) => {
        const loaded = await dependencies.adapter.load(transaction, scope, command);
        const page = pageDefinitionSchema.parse(loaded.page);
        if (loaded.resolvedComposition !== undefined && (
          loaded.resolvedCompositionContext === undefined ||
          !isTrustedInstalledPageComposition(
            loaded.resolvedCompositionContext,
            loaded.resolvedComposition,
          ) ||
          canonicalJson(loaded.resolvedComposition.page) !== canonicalJson(page)
        )) throw new Error("PAGE_CAPABILITY_BINDING_UNAVAILABLE");
        const resolved = loaded.resolvedComposition ??
          resolvePageComposition(page, loaded.applicationShells);
        if (!sameKey(loaded.pagePermission.permissionKey, page.accessPermissionKey))
          throw new Error("PAGE_CAPABILITY_BINDING_UNAVAILABLE");

        const pageAccess = await evaluate(transaction, scope, loaded.pagePermission);
        if (!pageAccess.allowed) return undefined;
        const correlations = new Set([
          pageAccess.correlationId.toLowerCase(),
          ...(loaded.sourceCorrelationId === undefined
            ? []
            : [loaded.sourceCorrelationId.toLowerCase()]),
        ]);
        let earliestAccessEligibilityUntil: string | undefined;
        const retainEarliestAccessEligibility = (candidateUntil: string | undefined): void => {
          if (candidateUntil === undefined) return;
          if (
            earliestAccessEligibilityUntil === undefined ||
            Date.parse(candidateUntil) < Date.parse(earliestAccessEligibilityUntil)
          ) earliestAccessEligibilityUntil = candidateUntil;
        };
        retainEarliestAccessEligibility(pageAccess.validUntil);
        const states: Record<string, PageCapabilityState["placements"][string]> = {};
        const hiddenPlacements = new Set<string>();
        for (const required of requiredPlacements(resolved)) {
          if (states[required.placementId] !== undefined) continue;
          const binding = loaded.placements[required.placementId];
          if (binding === undefined) throw new Error("PAGE_CAPABILITY_BINDING_UNAVAILABLE");
          const view =
            required.viewPermissionKey === undefined
              ? { allowed: true, correlationId: pageAccess.correlationId, validUntil: undefined }
              : binding.viewPermission !== undefined &&
                  sameKey(binding.viewPermission.permissionKey, required.viewPermissionKey)
                ? await evaluate(transaction, scope, binding.viewPermission)
                : undefined;
          const use =
            required.usePermissionKey === undefined
              ? { allowed: true, correlationId: pageAccess.correlationId, validUntil: undefined }
              : binding.usePermission !== undefined &&
                  sameKey(binding.usePermission.permissionKey, required.usePermissionKey)
                ? await evaluate(transaction, scope, binding.usePermission)
                : undefined;
          if (view === undefined || use === undefined)
            throw new Error("PAGE_CAPABILITY_BINDING_UNAVAILABLE");
          retainEarliestAccessEligibility(view.validUntil);
          retainEarliestAccessEligibility(use.validUntil);
          correlations.add(view.correlationId.toLowerCase());
          correlations.add(use.correlationId.toLowerCase());
          const ancestorHidden = required.ancestorPlacementIds.some((id) =>
            hiddenPlacements.has(id),
          );
          const conditionAllowed =
            required.visibilityCondition === undefined
              ? binding.visibilityConditionAllowed
              : !view.allowed || ancestorHidden
                ? false
                : dependencies.evaluateVisibilityCondition === undefined
                  ? binding.visibilityConditionAllowed
                  : await dependencies.evaluateVisibilityCondition(
                      transaction,
                      scope,
                      page,
                      required.visibilityCondition,
                    );
          if (
            ancestorHidden ||
            !view.allowed ||
            (required.visibilityCondition !== undefined && conditionAllowed !== true)
          )
            hiddenPlacements.add(required.placementId);
          states[required.placementId] = {
            viewAllowed: view.allowed,
            useAllowed: use.allowed,
            ...(binding.operationRequired === undefined
              ? {}
              : { operationRequired: binding.operationRequired }),
            operationBound: binding.operationBound,
            ...(conditionAllowed === undefined
              ? {}
              : { conditionAllowed }),
          };
        }
        if (correlations.size !== 1) throw new Error("PAGE_CAPABILITY_EVIDENCE_UNAVAILABLE");
        const projected = projectPageCapability(resolved, {
          pageAllowed: true,
          placements: states,
          accessVersion: scope.accessVersion,
          ...(loaded.applicationReleaseRevision === undefined
            ? {}
            : { applicationReleaseRevision: loaded.applicationReleaseRevision }),
        });
        if (projected !== undefined && earliestAccessEligibilityUntil !== undefined) {
          if (
            dependencies.validateAccessEligibilityUntil === undefined ||
            !(await dependencies.validateAccessEligibilityUntil(
              transaction,
              scope,
              earliestAccessEligibilityUntil,
            ))
          ) return undefined;
        }
        return projected;
      }),
  });
};
