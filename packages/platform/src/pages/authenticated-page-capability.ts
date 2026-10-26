import "server-only";

import type { SelectedOrganizationScope } from "../access/identity-access";
import type {
  OrganizationAccessDeclaration,
  OrganizationRecordAccessDeclaration,
} from "../access/organization-access-decision";
import {
  compiledItemSlots,
  type ApplicationShell,
  type CompiledItem,
} from "../definition/application-composition/page-composition";
import { pageDefinitionSchema, type PageDefinition } from "../definition/application-contracts";
import { canonicalJson } from "../definition/canonical-json";
import type { ConditionNode } from "../definition/module-foundation-contracts";
import { isTrustedInstalledPageComposition } from "../definition/installed-page-bundle-context";
import type { InstalledRuntimeContext } from "../definition/installed-runtime-context";
import type { RequestDatabaseTransaction } from "../db/request-transaction";
import { decideOrganizationAccessBatch } from "../access/organization-access-decision-access";
import { evaluateOrganizationRecordPermissionAvailability } from "../access/organization-record-permission-availability";
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

/** The decisions a page capability projection takes in its own verified transaction. */
export type PageCapabilityEvaluators = Readonly<{
  /** Server-owned operand resolution, under the same verified transaction as the view gates. */
  evaluateVisibilityCondition: (
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
    page: PageDefinition,
    condition: ConditionNode,
  ) => Promise<boolean>;
  /**
   * Whether the action a placement is bound to can run on the page's subject for the viewer,
   * decided by that action's own preview under the same verified transaction. `undefined`
   * means the placement is bound to no action, or the preview cannot decide before the person
   * supplies inputs; only `false` hides the placement. One decision per action per projection.
   */
  evaluateActionAvailability: (
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
    page: PageDefinition,
    placementId: string,
  ) => Promise<boolean | undefined>;
  /** Final current-context and database-clock check for the earliest private Access deadline. */
  validateAccessEligibilityUntil: (
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
  items: readonly CompiledItem[],
  result: RequiredPlacement[],
  ancestorPlacementIds: readonly string[] = [],
): void => {
  for (const item of items) {
    const placementId = item.props.id;
    const candidate = item.props.vortex;
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
    for (const [, child] of compiledItemSlots(item))
      collectSlot(child, result, [...ancestorPlacementIds, placementId]);
  }
};

const requiredPlacements = (resolved: ResolvedPageComposition): RequiredPlacement[] => {
  const result: RequiredPlacement[] = [];
  if (resolved.roots.kind === "page") collectSlot(resolved.roots.main.content, result);
  else
    for (const root of Object.values(resolved.roots.stepContent)) collectSlot(root.content, result);
  return result;
};

const isRecordPlacementBinding = (
  binding: PermissionBinding | PlacementPermissionBinding,
): binding is Extract<PlacementPermissionBinding, Readonly<{ kind: "record" }>> =>
  "kind" in binding && binding.kind === "record";

type GateDecision = Readonly<{
  allowed: boolean;
  correlationId: string;
  validUntil?: string;
}>;

/** Record placement availability carries no row decision and invokes no operation callback. */
const evaluateRecordGate = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  binding: Extract<PlacementPermissionBinding, Readonly<{ kind: "record" }>>,
): Promise<GateDecision> => {
  const result = await evaluateOrganizationRecordPermissionAvailability(
    transaction,
    scope,
    binding.declaration,
  );
  return result.outcome === "eligible"
    ? { allowed: true, correlationId: result.correlationId, validUntil: result.validUntil }
    : { allowed: false, correlationId: result.correlationId };
};

const gateDecision = (
  decision: Awaited<ReturnType<typeof decideOrganizationAccessBatch>>[number],
): GateDecision => ({
  allowed: decision.allowed,
  correlationId: decision.correlationId,
  ...(decision.validUntil === undefined ? {} : { validUntil: decision.validUntil }),
});

const sameKey = (left: string, right: string): boolean => left === right;

/**
 * Projects one loaded page capability for the viewer: the page gate, then each placement's view and
 * use gates, visibility condition and bound action, all decided in this one verified transaction.
 * The page gate and every placement's permission gate are decided together in one batch
 * statement; a record placement gate keeps its own availability read. Undefined when the page is
 * not the viewer's to open.
 */
export const projectAuthenticatedPageCapability = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  loaded: FixedAuthenticatedPageCapability,
  evaluators: PageCapabilityEvaluators,
): Promise<ProjectedPageCapability | undefined> => {
  const page = pageDefinitionSchema.parse(loaded.page);
  if (
    loaded.resolvedComposition !== undefined &&
    (loaded.resolvedCompositionContext === undefined ||
      !isTrustedInstalledPageComposition(
        loaded.resolvedCompositionContext,
        loaded.resolvedComposition,
      ) ||
      canonicalJson(loaded.resolvedComposition.page) !== canonicalJson(page))
  )
    throw new Error("PAGE_CAPABILITY_BINDING_UNAVAILABLE");
  const resolved =
    loaded.resolvedComposition ?? resolvePageComposition(page, loaded.applicationShells);
  if (!sameKey(loaded.pagePermission.permissionKey, page.accessPermissionKey))
    throw new Error("PAGE_CAPABILITY_BINDING_UNAVAILABLE");

  // One projection transaction decides each exact declaration once; repeated declarations
  // reuse the decision and its validity deadline.
  const decided = new Map<string, GateDecision>();
  const keyOf = (binding: PermissionBinding | PlacementPermissionBinding) =>
    canonicalJson({
      kind: isRecordPlacementBinding(binding) ? "record" : "permission",
      declaration: binding.declaration,
    });
  const placementGates = requiredPlacements(resolved).flatMap((required) => {
    const binding = loaded.placements[required.placementId];
    return [
      required.viewPermissionKey !== undefined &&
      binding?.viewPermission !== undefined &&
      sameKey(binding.viewPermission.permissionKey, required.viewPermissionKey)
        ? binding.viewPermission
        : undefined,
      required.usePermissionKey !== undefined &&
      binding?.usePermission !== undefined &&
      sameKey(binding.usePermission.permissionKey, required.usePermissionKey)
        ? binding.usePermission
        : undefined,
    ].filter((gate) => gate !== undefined);
  });
  const batched = new Map<string, OrganizationAccessDeclaration>();
  for (const gate of [loaded.pagePermission, ...placementGates])
    if (!isRecordPlacementBinding(gate)) batched.set(keyOf(gate), gate.declaration);
  const batchDecisions = await decideOrganizationAccessBatch(transaction, scope, [
    ...batched.values(),
  ]);
  if (batchDecisions.length !== batched.size)
    throw new Error("PAGE_CAPABILITY_EVIDENCE_UNAVAILABLE");
  [...batched.keys()].forEach((key, index) => {
    decided.set(key, gateDecision(batchDecisions[index]!));
  });
  const decide = async (binding: PermissionBinding | PlacementPermissionBinding) => {
    const key = keyOf(binding);
    let decision = decided.get(key);
    if (decision === undefined) {
      if (!isRecordPlacementBinding(binding))
        throw new Error("PAGE_CAPABILITY_BINDING_UNAVAILABLE");
      decision = await evaluateRecordGate(transaction, scope, binding);
      decided.set(key, decision);
    }
    return decision;
  };
  const pageAccess = await decide(loaded.pagePermission);
  if (!pageAccess.allowed) return undefined;
  const correlations = new Set([
    pageAccess.correlationId.toLowerCase(),
    ...(loaded.sourceCorrelationId === undefined ? [] : [loaded.sourceCorrelationId.toLowerCase()]),
  ]);
  let earliestAccessEligibilityUntil: string | undefined;
  const retainEarliestAccessEligibility = (candidateUntil: string | undefined): void => {
    if (candidateUntil === undefined) return;
    if (
      earliestAccessEligibilityUntil === undefined ||
      Date.parse(candidateUntil) < Date.parse(earliestAccessEligibilityUntil)
    )
      earliestAccessEligibilityUntil = candidateUntil;
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
          ? await decide(binding.viewPermission)
          : undefined;
    const use =
      required.usePermissionKey === undefined
        ? { allowed: true, correlationId: pageAccess.correlationId, validUntil: undefined }
        : binding.usePermission !== undefined &&
            sameKey(binding.usePermission.permissionKey, required.usePermissionKey)
          ? await decide(binding.usePermission)
          : undefined;
    if (view === undefined || use === undefined)
      throw new Error("PAGE_CAPABILITY_BINDING_UNAVAILABLE");
    retainEarliestAccessEligibility(view.validUntil);
    retainEarliestAccessEligibility(use.validUntil);
    correlations.add(view.correlationId.toLowerCase());
    correlations.add(use.correlationId.toLowerCase());
    const ancestorHidden = required.ancestorPlacementIds.some((id) => hiddenPlacements.has(id));
    const conditionAllowed =
      required.visibilityCondition === undefined
        ? binding.visibilityConditionAllowed
        : !view.allowed || ancestorHidden
          ? false
          : await evaluators.evaluateVisibilityCondition(
              transaction,
              scope,
              page,
              required.visibilityCondition,
            );
    const actionAvailable =
      ancestorHidden || !view.allowed
        ? undefined
        : await evaluators.evaluateActionAvailability(
            transaction,
            scope,
            page,
            required.placementId,
          );
    if (
      ancestorHidden ||
      !view.allowed ||
      (required.visibilityCondition !== undefined && conditionAllowed !== true) ||
      actionAvailable === false
    )
      hiddenPlacements.add(required.placementId);
    states[required.placementId] = {
      viewAllowed: view.allowed,
      useAllowed: use.allowed,
      ...(binding.operationRequired === undefined
        ? {}
        : { operationRequired: binding.operationRequired }),
      operationBound: binding.operationBound,
      ...(conditionAllowed === undefined ? {} : { conditionAllowed }),
      ...(actionAvailable === undefined ? {} : { actionAvailable }),
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
      !(await evaluators.validateAccessEligibilityUntil(
        transaction,
        scope,
        earliestAccessEligibilityUntil,
      ))
    )
      return undefined;
  }
  return projected;
};
