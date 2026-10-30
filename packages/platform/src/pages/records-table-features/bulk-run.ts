import "server-only";

import type { IdentitySession, OrganizationSelectionCandidate } from "../../access/identity-access";
import type { JsonValue } from "../../catalogue/common";
import { sameId } from "../../catalogue/runtime-primitives";
import { authoredGridLayout } from "../grid-layout-resolution";
import type {
  RecordsSelectionCountRequest,
  RecordsSelectionCountResult,
} from "../records-selection";
import type { RecordsTableFilterValue } from "../records-table-filters";
import type { RecordsTableSortKey } from "../records-table-state";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
} from "../../access/human-organization-request";
import type { QueryContinuationKey } from "../../queries/continuation-token";
import { createProtectedQueryService } from "../../queries/protected-query-service";
import { tableReadCandidatesPerRequest } from "../../queries/protected-query-table";
import {
  fieldChoiceLabelsOf,
  fieldDateTypesOf,
  fieldFilterTargetsOf,
  fieldLabelsOf,
  fieldLinkTypesOf,
} from "../placement-read/shared";
import { buildRecordsTableQueryCommand } from "../records-table-query";
import { recordsSelectionCountCeiling } from "../records-selection";
import { openRecordsSelection, type RecordsSelectionDescriptor } from "../records-selection-seal";
import {
  loadRecordsTablePlacement,
  type RecordsTableCommandAddress,
  type RecordsTablePlacement,
} from "./placement";

/**
 * The count behind "Select all matching records". It re-reads the installed placement and decides
 * under the person's current access: the sealed descriptor of every matching record is opened for
 * this person and release and counted through the query summary path. A bulk action itself runs
 * the flow its table binds, never code of this file.
 */

export type RecordsTableBulkDependencies = HumanOrganizationRequestDependencies &
  Readonly<{ continuationKey: QueryContinuationKey }>;

/** The application the request's own address resolved, and the installed context it read. */
export type RecordsTableBulkAddress = RecordsTableCommandAddress;

type BulkPlacement = RecordsTablePlacement;

/**
 * The most scan-limited reader requests one "matching" enumeration follows. A full page is bounded
 * by the run's own limit; a scan-limited page spent its whole budget of
 * `tableReadCandidatesPerRequest` candidates, so this many of them examine the candidate ceiling
 * the count uses (`recordsSelectionCountCeiling`) before the run refuses as "too many".
 */
export const enumerationScanLimitedCeiling = Math.ceil(
  recordsSelectionCountCeiling / tableReadCandidatesPerRequest,
);

const refuse = (cause: string): undefined => {
  console.error(`[records-table] bulk request refused cause=${cause}`);
  return undefined;
};

/** The query command of the descriptor, rebuilt from the installed placement's own contract. */
export const matchingQueryCommand = (
  placement: RecordsTablePlacement,
  descriptor: RecordsSelectionDescriptor,
) => {
  const authored = authoredGridLayout(placement.contract);
  if (authored === undefined) return refuse("layout_unavailable");
  // Only the record identities are needed: the read shows one column, the first declared one.
  const layout = {
    ...authored,
    columns: authored.columns.map((column, index) => ({ ...column, visible: index === 0 })),
  };
  const built = buildRecordsTableQueryCommand({
    moduleRootId: placement.module.rootId,
    queryId: placement.query.queryId,
    settings: placement.settings,
    inputValues: descriptor.inputValues as Readonly<Record<string, JsonValue>>,
    state: {
      sort: descriptor.sort as unknown as readonly RecordsTableSortKey[],
      filters: descriptor.filters as unknown as readonly RecordsTableFilterValue[],
      search: descriptor.search,
      page: undefined,
    },
    layout: {
      storage: "preview",
      queryId: String(placement.query.queryId).toLowerCase(),
      revision: null,
      layout,
      authored: layout,
      reset: false,
    },
    filterTargets: fieldFilterTargetsOf(placement.module),
    ...(descriptor.timeZone === undefined ? {} : { timeZone: descriptor.timeZone }),
    fieldLabels: fieldLabelsOf(placement.module),
    fieldChoiceLabels: fieldChoiceLabelsOf(placement.module),
    fieldDateTypes: fieldDateTypesOf(placement.module),
    fieldLinkTypes: fieldLinkTypesOf(placement.module),
  });
  if (built.kind === "refused") return refuse(`command_${built.part}_${built.reason}`);
  return built;
};

export const createRecordsTableBulkService = (dependencies: RecordsTableBulkDependencies) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const queries = createProtectedQueryService(dependencies);

  const selectionOf = (address: RecordsTableBulkAddress): OrganizationSelectionCandidate =>
    address.selection;

  /**
   * The installed Records table placement under the person's own scope, with the feature that
   * uses it on: bulk actions run and count over a selection, and Export counts the same one.
   */
  const placementFor = async (
    session: IdentitySession,
    address: RecordsTableBulkAddress,
    placementId: string,
    use: "run" | "count",
  ): Promise<BulkPlacement | undefined> => {
    const loaded = await loadRecordsTablePlacement(requests, session, address, placementId);
    if ("refused" in loaded) return refuse(loaded.refused);
    const { bulkActions, export: exported } = loaded.contract.features;
    if (!bulkActions.enabled && !(use === "count" && exported.enabled))
      return refuse("feature_off");
    return loaded;
  };

  /** The sealed descriptor of a matching selection, opened for this person and this release. */
  const descriptorFor = (
    session: IdentitySession,
    address: RecordsTableBulkAddress,
    placement: BulkPlacement,
    placementId: string,
    token: string,
  ): RecordsSelectionDescriptor | undefined => {
    const descriptor = openRecordsSelection(token, dependencies.continuationKey, {
      session,
      selection: selectionOf(address),
      installationRevision: placement.installed.applicationReleaseRevision,
      pageId: address.pageId,
      placementId,
    });
    if (descriptor === undefined) return undefined;
    if (
      !sameId(descriptor.moduleRootId, String(placement.module.rootId)) ||
      !sameId(descriptor.queryId, String(placement.query.queryId))
    )
      return refuse("descriptor_other_query");
    return descriptor;
  };

  return Object.freeze({
    /** The one capped count of "Select all matching records", through the query summary path. */
    async count(
      session: IdentitySession,
      address: RecordsTableBulkAddress,
      request: RecordsSelectionCountRequest,
    ): Promise<RecordsSelectionCountResult> {
      const placement = await placementFor(session, address, request.placementId, "count");
      if (placement === undefined) return { kind: "refused", reason: "not_available" };
      const descriptor = descriptorFor(
        session,
        address,
        placement,
        request.placementId,
        request.token,
      );
      if (descriptor === undefined) return { kind: "refused", reason: "not_available" };
      const built = matchingQueryCommand(placement, descriptor);
      if (built === undefined) return { kind: "refused", reason: "not_available" };
      const summary = await queries.summarise(session, selectionOf(address), {
        mode: "published",
        moduleRootId: built.command.moduleRootId,
        queryId: built.command.queryId,
        inputValues: built.command.inputValues,
        ...(built.command.filter === undefined ? {} : { filter: built.command.filter }),
        filterableFieldIds: built.command.filterableFieldIds,
        ...(built.command.search === undefined ? {} : { search: built.command.search }),
        searchableFieldIds: built.command.searchableFieldIds,
      });
      if (summary.kind === "temporarily_unavailable") return { kind: "unavailable" };
      if (summary.kind !== "available") {
        refuse(`selection_count_${summary.kind}`);
        return { kind: "refused", reason: "not_available" };
      }
      if (summary.value.outcome === "completed")
        return { kind: "counted", count: summary.value.totalRowCount };
      if (summary.value.reasonCode === "dataset_limit_exceeded") return { kind: "too_many" };
      console.error(`[records-table] selection count refused code=${summary.value.reasonCode}`);
      return { kind: "refused", reason: "not_available" };
    },
  });
};
