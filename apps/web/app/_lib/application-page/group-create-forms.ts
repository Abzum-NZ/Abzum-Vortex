import { readCurrentRecordOwnerGroupsAfterAuthorization } from "@vortex/platform/server";
import type { InstalledRuntimeContext } from "@vortex/platform/server";
import type { HumanOrganizationRequestDependencies } from "@vortex/platform/server";
import { FORM_CONTAINER_BLOCK_RELEASE } from "@vortex/platform/server";
import {
  isRecord,
  sameId,
  type IdentitySession,
  type OrganizationSelectionCandidate,
} from "@vortex/platform/schema";
import { humanOrganizationRequests } from "../server-composition";
import { flowCreatedRecordTypeIds } from "./form-field-access";
import type { collectPlacements } from "./placement-helpers";
import type { ApplicationPageInternalResult, PageDataState, PlacementFlowBinding } from "./types";

/**
 * A Group-owned create form needs an explicit owner from the viewer's current memberships. Every
 * Group returned here is eligible for initial Group ownership; the Record writer still locks and
 * rechecks the selected membership at save time. Returns a refusal to answer the page with, or
 * undefined once the forms' owner choices are in `data`.
 */
export const projectGroupCreateForms = async (
  input: Readonly<{
    context: InstalledRuntimeContext;
    placements: ReturnType<typeof collectPlacements>;
    bindings: Readonly<Record<string, PlacementFlowBinding[]>>;
    dependencies: HumanOrganizationRequestDependencies;
    session: IdentitySession;
    selection: OrganizationSelectionCandidate;
    accessVersion: unknown;
    data: Record<string, PageDataState>;
  }>,
): Promise<ApplicationPageInternalResult | undefined> => {
  const { context, placements, bindings, dependencies, session, selection, data } = input;
  const application = context.releaseSet.application;
  const ownershipByRecordType = new Map(
    context.releaseSet.modules.flatMap((module) =>
      module.content.recordTypes.map(
        (recordType) =>
          [String(recordType.recordTypeId).toLowerCase(), recordType.ownershipMode] as const,
      ),
    ),
  );
  const createsGroupRecord = (flowId: string): boolean =>
    [...flowCreatedRecordTypeIds(application.content.flows, flowId)].some(
      (recordTypeId) => ownershipByRecordType.get(recordTypeId) === "group",
    );
  const groupCreateBindings = placements.flatMap(({ placementId, vortex }) => {
    const block = vortex.block;
    if (
      !isRecord(block) ||
      typeof block.blockId !== "string" ||
      !sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId)
    )
      return [];
    return (bindings[placementId] ?? [])
      .filter((binding) => binding.event === "form_submit" && createsGroupRecord(binding.flowId))
      .map((binding) => ({ formId: placementId, binding }));
  });
  if (groupCreateBindings.length > 0) {
    if (
      groupCreateBindings.some(
        ({ binding }) => !binding.callerInputs.includes("selected_owner_group_id"),
      )
    )
      return { kind: "temporarily_unavailable" };
    const choices = await humanOrganizationRequests(dependencies.identityAuthorityId).run(
      session,
      selection,
      async (transaction, scope) => {
        return {
          accessVersion: scope.accessVersion,
          groups: await readCurrentRecordOwnerGroupsAfterAuthorization(transaction),
        };
      },
    );
    if (choices.kind !== "available") return choices;
    if (choices.value.accessVersion !== input.accessVersion)
      return { kind: "temporarily_unavailable" };
    for (const formId of new Set(groupCreateBindings.map(({ formId }) => formId)))
      data[formId] = {
        status: "ready",
        values: { kind: "form", ownerGroups: choices.value.groups },
      };
  }

  return undefined;
};
