import "server-only";

import {
  pageDefinitionV2Schema,
  type ApplicationShellV2,
  type ConditionNode,
  type IdentitySession,
  type OrganizationAccessDeclaration,
  type OrganizationSelectionCandidate,
  type PageDefinitionV2,
  type SelectedOrganizationScope,
} from "@vortex/contracts";
import type { RequestDatabaseTransaction } from "@vortex/db";
import {
  createHumanOrganizationRequestService,
  runOrganizationAccessOperation,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
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

export type FixedAuthenticatedPageCapability = Readonly<{
  page: PageDefinitionV2;
  applicationShells?: readonly ApplicationShellV2[];
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
        viewPermission?: PermissionBinding;
        usePermission?: PermissionBinding;
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
        page: PageDefinitionV2,
        condition: ConditionNode,
      ) => Promise<boolean>;
      /** Diagnostic metadata only, latched by the original serial condition invocation. */
      visibilityConditionReason?: () =>
        | "SUPPORTED_TRUE" | "SUPPORTED_FALSE" | "UNSUPPORTED_OPERAND"
        | "SUBJECT_UNAVAILABLE" | "FIELD_UNAVAILABLE" | "DECLARATION_UNPROVABLE" | "UNKNOWN";
      /** Optional server-only sink; immutable decisions cannot influence projection authority. */
      observeProjectionDecision?: (observation: Readonly<{
        placements: readonly Readonly<{
          placementId: string;
          ancestorPlacementIds: readonly string[];
          viewGate: "ABSENT" | "ALLOWED" | "REFUSED";
          condition: "ABSENT" | "TRUE" | "NOT_TRUE" | "SKIPPED_VIEW" | "SKIPPED_ANCESTOR";
          conditionReason: "ABSENT" | "SUPPORTED_TRUE" | "SUPPORTED_FALSE" | "UNSUPPORTED_OPERAND"
            | "SUBJECT_UNAVAILABLE" | "FIELD_UNAVAILABLE" | "DECLARATION_UNPROVABLE"
            | "SKIPPED_VIEW" | "SKIPPED_ANCESTOR" | "UNKNOWN";
          useState: "PLAIN_CONTENT" | "AVAILABLE" | "DISABLED";
        }>[];
      }>) => void;
    }>;

type RequiredPlacement = Readonly<{
  placementId: string;
  viewPermissionKey?: string;
  usePermissionKey?: string;
  visibilityCondition?: ConditionNode;
  ancestorPlacementIds: readonly string[];
}>;

const collectV2Slot = (
  slot: ApplicationShellV2["layout"],
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
      collectV2Slot(child, result, [...ancestorPlacementIds, placementId]);
  }
};

const requiredPlacements = (resolved: ResolvedPageComposition): RequiredPlacement[] => {
  const result: RequiredPlacement[] = [];
  if (resolved.roots.kind === "page")
    collectV2Slot(resolved.roots.main, result);
  else
    for (const root of Object.values(resolved.roots.stepContent))
      collectV2Slot(root, result);
  return result;
};

const evaluate = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  binding: PermissionBinding,
): Promise<Readonly<{ allowed: boolean; correlationId: string }>> => {
  const result = await runOrganizationAccessOperation(
    transaction,
    scope,
    binding.declaration,
    async (decision) => decision.correlationId,
  );
  return result.outcome === "completed"
    ? { allowed: true, correlationId: result.value }
    : { allowed: false, correlationId: result.correlationId };
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
        const page = pageDefinitionV2Schema.parse(loaded.page);
        const resolved = resolvePageComposition(page, loaded.applicationShells);
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
        const states: Record<string, PageCapabilityState["placements"][string]> = {};
        const hiddenPlacements = new Set<string>();
        // Observation has its own finite custody and never changes the authoritative states.
        const observed: Array<Parameters<NonNullable<
          AuthenticatedPageCapabilityDependencies<Command>["observeProjectionDecision"]
        >>[0]["placements"][number]> = [];
        let observer: AuthenticatedPageCapabilityDependencies<Command>["observeProjectionDecision"];
        let observationValid = false;
        try {
          observer = dependencies.observeProjectionDecision;
          observationValid = typeof observer === "function";
        } catch {
          // An unavailable sink must not turn a normal projection into a failure.
        }
        for (const required of requiredPlacements(resolved)) {
          if (states[required.placementId] !== undefined) continue;
          const binding = loaded.placements[required.placementId];
          if (binding === undefined) throw new Error("PAGE_CAPABILITY_BINDING_UNAVAILABLE");
          const view =
            required.viewPermissionKey === undefined
              ? { allowed: true, correlationId: pageAccess.correlationId }
              : binding.viewPermission !== undefined &&
                  sameKey(binding.viewPermission.permissionKey, required.viewPermissionKey)
                ? await evaluate(transaction, scope, binding.viewPermission)
                : undefined;
          const use =
            required.usePermissionKey === undefined
              ? { allowed: true, correlationId: pageAccess.correlationId }
              : binding.usePermission !== undefined &&
                  sameKey(binding.usePermission.permissionKey, required.usePermissionKey)
                ? await evaluate(transaction, scope, binding.usePermission)
                : undefined;
          if (view === undefined || use === undefined)
            throw new Error("PAGE_CAPABILITY_BINDING_UNAVAILABLE");
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
          if (observationValid) {
            try {
              if (observed.length >= 4096 || required.ancestorPlacementIds.length > 64)
                observationValid = false;
              else {
                const condition = required.visibilityCondition === undefined ? "ABSENT"
                  : !view.allowed ? "SKIPPED_VIEW" : ancestorHidden ? "SKIPPED_ANCESTOR"
                  : conditionAllowed === true ? "TRUE" : "NOT_TRUE";
                observed.push(Object.freeze({
                  placementId: required.placementId,
                  ancestorPlacementIds: Object.freeze([...required.ancestorPlacementIds]),
                  viewGate: required.viewPermissionKey === undefined ? "ABSENT"
                    : view.allowed ? "ALLOWED" : "REFUSED",
                  condition,
                  conditionReason: condition === "ABSENT" || condition === "SKIPPED_VIEW" ||
                    condition === "SKIPPED_ANCESTOR" ? condition
                    : dependencies.visibilityConditionReason?.() ?? "UNKNOWN",
                  useState: required.usePermissionKey === undefined &&
                    binding.operationRequired !== true && !binding.operationBound ? "PLAIN_CONTENT"
                    : use.allowed && binding.operationBound ? "AVAILABLE" : "DISABLED",
                }));
              }
            } catch {
              observationValid = false;
            }
          }
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
        if (projected !== undefined && observationValid) {
          try {
            observer?.call(dependencies, Object.freeze({
              placements: Object.freeze(observed),
            }));
          } catch {
            // A diagnostic sink never changes the original return or genuine error.
          }
        }
        return projected;
      }),
  });
};
