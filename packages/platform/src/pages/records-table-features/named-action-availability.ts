import "server-only";

import { randomUUID } from "node:crypto";
import { isRecord, recordsTableContractOrLog, sameId, type IdentitySession } from "../../schema";
import { createHumanOrganizationRequestService } from "../../access/index";
import type { RequestDatabaseTransaction } from "../../db/index";
import {
  placementSettings,
  TABLE_BLOCK_RELEASE,
} from "../../definition/application-composition-catalogue";
import { createHumanInstalledPageBundleContextLoader } from "../../definition/installed-page-bundle-context";
import { installedNamedActions } from "../../definition/installed-named-actions";
import { collectActionFlowTasks, flowLibraryOf } from "../../rules/index";
import type {
  NamedActionAvailability,
  NamedActionAvailabilityRequest,
  NamedActionAvailabilityResult,
} from "../named-action-availability-schema";
import {
  logRecordsTableRequestRefusal,
  recordsTableBulkActions,
  recordsTableRequestRefusal,
} from ".";
import type { RecordsTableBulkAddress, RecordsTableBulkDependencies } from "./bulk-run";
import { installedPlacementProps } from "./flow-dispatch";
import {
  readNamedActionEligibility,
  type NamedActionEligibilityAction,
} from "./named-action-eligibility";

/** Shared projection for bulk menus and row controls: one evaluator call for every record/action. */
export const projectNamedActionAvailability = async (
  transaction: RequestDatabaseTransaction,
  recordTypeId: string,
  targets: NamedActionAvailabilityRequest["targets"],
  actions: readonly (NamedActionEligibilityAction & Readonly<{ key: string }>)[],
  issuedAt: string,
): Promise<NamedActionAvailability> => {
  if (targets.length === 0) return [];
  const rows = await readNamedActionEligibility(
    transaction,
    recordTypeId,
    actions,
    targets.map((target) => ({ recordId: target.recordId, commandId: randomUUID() })),
    issuedAt,
  );
  return rows.map((row, index) => ({
    recordId: targets[index]!.recordId,
    revision: targets[index]!.revision,
    actions: row.actions.map((action, actionIndex) => {
      const key = actions[actionIndex]!.key;
      const eligibility =
        row.revision !== undefined && row.revision !== targets[index]!.revision
          ? "changed"
          : action.eligibility;
      return eligibility === "eligible"
        ? { action: key, eligible: true as const }
        : {
            action: key,
            eligible: false as const,
            reason: eligibility === "replayed" ? ("refused" as const) : eligibility,
          };
    }),
  }));
};

/** Re-resolve the placement and its opt-in projection under current human access on every request. */
export const readRecordsTableNamedActionAvailability = async (
  dependencies: RecordsTableBulkDependencies,
  session: IdentitySession,
  address: RecordsTableBulkAddress,
  request: NamedActionAvailabilityRequest,
): Promise<NamedActionAvailabilityResult> => {
  const refuse = (reason: string): NamedActionAvailabilityResult => {
    logRecordsTableRequestRefusal(
      recordsTableRequestRefusal("bulk_action", reason),
      request.placementId,
    );
    return { kind: "refused", reason: "not_available" };
  };
  const result = await createHumanOrganizationRequestService(dependencies).run(
    session,
    address.selection,
    async (transaction, scope, issuedAt): Promise<NamedActionAvailabilityResult> => {
      if (scope.applicationRootId === undefined) return refuse("application_scope_missing");
      // Load in this request transaction rather than trusting a previous read's projection.
      const installed = await createHumanInstalledPageBundleContextLoader({
        transaction,
        scope: {
          organizationId: scope.organizationId,
          organizationAccountId: scope.organizationAccountId,
          applicationRootId: scope.applicationRootId,
          ...(scope.previewInstallationId === undefined
            ? {}
            : { previewInstallationId: scope.previewInstallationId }),
        },
      }).load();
      const page = installed.releaseSet.application.content.pages.find(
        (candidate) => candidate.key === request.pageKey,
      );
      if (page === undefined) return refuse("page_not_installed");
      const props = installedPlacementProps(page.composition, request.placementId);
      if (props === undefined) return refuse("placement_not_installed");
      const vortex = props.vortex;
      if (!isRecord(vortex) || !isRecord(vortex.block) || typeof vortex.queryId !== "string")
        return refuse("placement_metadata_unreadable");
      if (vortex.block.blockId !== TABLE_BLOCK_RELEASE.blockId) return refuse("not_a_table");
      const contract = recordsTableContractOrLog(
        placementSettings(props),
        "named action availability",
      );
      if (contract === undefined) return refuse("contract_unreadable");
      const declared = recordsTableBulkActions(contract);
      if (declared.length === 0) return refuse("bulk_actions_not_offered");
      if (declared.length > 20) return refuse("too_many_declared_actions");
      const queries = installed.releaseSet.modules.flatMap((module) =>
        module.content.queries.filter((query) => sameId(query.queryId, vortex.queryId as string)),
      );
      const query = queries.length === 1 ? queries[0] : undefined;
      if (query?.recordType.state !== "resolved") return refuse("query_not_installed");
      const recordTypeId = String(query.recordType.recordTypeId);
      const application = installed.releaseSet.application;
      const named = installedNamedActions(application, installed.releaseSet.modules);
      const flows = new Map<string, unknown>();
      for (const flow of [
        ...application.content.flows,
        ...installed.releaseSet.modules.flatMap((module) => module.content.flows),
      ])
        flows.set(String(flow.id), flow);
      const library = flowLibraryOf(flows);
      const actions: (NamedActionEligibilityAction & { key: string })[] = [];
      for (const declaration of declared) {
        const action = named.get(declaration.action);
        if (action === undefined || !sameId(action.subjectRecordTypeId, recordTypeId))
          return refuse("action_not_installed");
        const flowId = action.action.actionId;
        const flow = library(flowId);
        if (
          flow === undefined ||
          flow.execution !== "transaction" ||
          flow.runAs.kind !== "saver" ||
          flow.triggers.length > 0
        )
          return refuse("action_flow_unavailable");
        const runId = randomUUID();
        actions.push({
          key: declaration.action,
          action: action.action,
          run: (seed) => collectActionFlowTasks(library, flowId, runId, seed),
        });
      }
      return {
        kind: "available",
        records: await projectNamedActionAvailability(
          transaction,
          recordTypeId,
          request.targets,
          actions,
          issuedAt,
        ),
      };
    },
  );
  if (result.kind !== "available") {
    logRecordsTableRequestRefusal(
      recordsTableRequestRefusal("bulk_action", `availability_${result.kind}`),
      request.placementId,
    );
    return { kind: "unavailable" };
  }
  return result.value;
};
