import "server-only";

import {
  pageDefinitionSchema,
  pageDefinitionV2Schema,
  type IdentitySession,
  type OrganizationAccessDeclaration,
  type OrganizationSelectionCandidate,
  type PageDefinition,
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

type PermissionBinding = Readonly<{
  permissionKey: string;
  declaration: OrganizationAccessDeclaration;
}>;

export type FixedAuthenticatedPageCapability = Readonly<{
  page: PageDefinition | PageDefinitionV2;
  pagePermission: PermissionBinding;
  placements: Readonly<
    Record<
      string,
      Readonly<{
        viewPermission?: PermissionBinding;
        usePermission?: PermissionBinding;
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
    Readonly<{ adapter: FixedAuthenticatedPageCapabilityAdapter<Command> }>;

type RequiredPlacement = Readonly<{
  placementId: string;
  viewPermissionKey?: string;
  usePermissionKey?: string;
}>;

const collectV2Slot = (slot: Record<string, unknown>, result: RequiredPlacement[]): void => {
  for (const [placementId, candidate] of Object.entries(
    slot.placements as Record<string, Record<string, unknown>>,
  )) {
    result.push({
      placementId,
      ...(candidate.viewPermissionKey === undefined
        ? {}
        : { viewPermissionKey: String(candidate.viewPermissionKey) }),
      ...(candidate.usePermissionKey === undefined
        ? {}
        : { usePermissionKey: String(candidate.usePermissionKey) }),
    });
    for (const child of Object.values(candidate.slots as Record<string, Record<string, unknown>>))
      collectV2Slot(child, result);
  }
};

const requiredPlacements = (page: PageDefinition | PageDefinitionV2): RequiredPlacement[] => {
  const result: RequiredPlacement[] = [];
  if ("layout" in page) {
    const placements =
      page.type === "guided_form"
        ? page.steps.flatMap((step) => step.blocks)
        : "blocks" in page
          ? page.blocks
          : [];
    return placements.map((placement) => ({
      placementId: placement.placementId,
      viewPermissionKey: placement.viewPermissionKey,
      ...(placement.usePermissionKey === undefined
        ? {}
        : { usePermissionKey: placement.usePermissionKey }),
    }));
  }
  const composition = page.composition;
  if ("main" in composition)
    collectV2Slot(composition.main as unknown as Record<string, unknown>, result);
  else if ("content" in composition)
    for (const slot of Object.values(composition.content))
      collectV2Slot(slot as unknown as Record<string, unknown>, result);
  else
    for (const step of Object.values(composition.stepContent))
      if ("placements" in step) collectV2Slot(step as unknown as Record<string, unknown>, result);
      else
        for (const slot of Object.values(step))
          collectV2Slot(slot as unknown as Record<string, unknown>, result);
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
        const parsed = pageDefinitionV2Schema.safeParse(loaded.page);
        const page = parsed.success ? parsed.data : pageDefinitionSchema.parse(loaded.page);
        if (!sameKey(loaded.pagePermission.permissionKey, page.accessPermissionKey))
          throw new Error("PAGE_CAPABILITY_BINDING_UNAVAILABLE");

        const pageAccess = await evaluate(transaction, scope, loaded.pagePermission);
        if (!pageAccess.allowed) return undefined;
        const correlations = new Set([pageAccess.correlationId.toLowerCase()]);
        const states: Record<string, PageCapabilityState["placements"][string]> = {};
        for (const required of requiredPlacements(page)) {
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
          states[required.placementId] = {
            viewAllowed: view.allowed,
            useAllowed: use.allowed,
            operationBound: binding.operationBound,
            ...(binding.visibilityConditionAllowed === undefined
              ? {}
              : { conditionAllowed: binding.visibilityConditionAllowed }),
          };
        }
        if (correlations.size !== 1) throw new Error("PAGE_CAPABILITY_EVIDENCE_UNAVAILABLE");
        return projectPageCapability(page, { pageAllowed: true, placements: states });
      }),
  });
};
