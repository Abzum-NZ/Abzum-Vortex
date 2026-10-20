import "server-only";

import { readRecordDetailContract, readRecordsTableContract } from "../../schema";
import {
  APPLICATION_PAGE_LINK_TILES_BLOCK_RELEASE,
  ATTACHMENT_LIST_BLOCK_RELEASE,
  CALENDAR_BLOCK_RELEASE,
  CHART_BLOCK_RELEASE,
  LINK_TILES_BLOCK_RELEASE,
  QUERY_NOTICE_BLOCK_RELEASE,
  RECORD_PIN_LINK_TILES_BLOCK_RELEASE,
  SUMMARY_VALUES_BLOCK_RELEASE,
} from "../../definition/index";
import { readCalendarPlacementContract } from "../calendar-query";
import { resolvePlacementInputs } from "./bindings";
import { readBoard } from "./board";
import { readCalendar } from "./calendar";
import { readLauncher } from "./launcher";
import { readLinkTiles } from "./link-tiles";
import { readQueryNotice } from "./query-notice";
import { readQueryDetail, readSubjectDetail } from "./record-detail";
import { readRecordsTable } from "./records-table";
import {
  findModuleQuery,
  isApplicationLauncherPlacement,
  isBoardPlacement,
  logPlacementFailure,
  placementBlockIs,
  placementReleaseVersion,
  placementSettingsOf,
  projectedUseAvailability,
  resolvedQueryRecordTypeId,
  type PageDataState,
  type PlacementReadEntry,
} from "./shared";
import { readSummaryOrChart } from "./summary-chart";
import type { PlacementReadInput } from "./types";

const linkTileReleases = new Set([
  LINK_TILES_BLOCK_RELEASE.releaseVersion,
  RECORD_PIN_LINK_TILES_BLOCK_RELEASE.releaseVersion,
  APPLICATION_PAGE_LINK_TILES_BLOCK_RELEASE.releaseVersion,
]);

/**
 * Whether a placement's data comes only from its own bound query: nothing else on the page waits
 * for it and it never decides the page's availability, so the page may stream it after the frame.
 * Every placement this accepts writes its data entry in {@link readQueryPlacement}.
 */
export const isStreamableQueryPlacement = (placement: PlacementReadEntry): boolean => {
  if (typeof placement.vortex.queryId !== "string") return false;
  if (
    placementBlockIs(placement, ATTACHMENT_LIST_BLOCK_RELEASE) ||
    placementBlockIs(placement, CALENDAR_BLOCK_RELEASE)
  )
    return false;
  const settings = placementSettingsOf(placement);
  return (
    readRecordsTableContract(settings) !== undefined ||
    readRecordDetailContract(settings) !== undefined ||
    placementBlockIs(placement, QUERY_NOTICE_BLOCK_RELEASE) ||
    placementBlockIs(placement, LINK_TILES_BLOCK_RELEASE) ||
    placementBlockIs(placement, SUMMARY_VALUES_BLOCK_RELEASE) ||
    placementBlockIs(placement, CHART_BLOCK_RELEASE) ||
    isApplicationLauncherPlacement(placement) ||
    isBoardPlacement(placement)
  );
};

/**
 * Reads one data placement of a page: a query-bound block's rows for the inputs its bindings
 * resolve, or a Record detail's page subject. A placement that is neither is left without data.
 * Each block family has its own reader; every query-bound one takes its inputs from the one binding
 * resolver, and a block waiting for a required input, or whose binding is refused, reads nothing.
 */
export const readQueryPlacement = async (
  read: PlacementReadInput,
  placement: PlacementReadEntry,
): Promise<void> => {
  const { placementId } = placement;
  const settings = placementSettingsOf(placement);
  const isLinkTiles = placementBlockIs(placement, LINK_TILES_BLOCK_RELEASE);
  if (
    isLinkTiles &&
    (!linkTileReleases.has(placementReleaseVersion(placement)) ||
      projectedUseAvailability(placement) !== "available")
  ) {
    read.data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }
  const isCalendar = placementBlockIs(placement, CALENDAR_BLOCK_RELEASE);
  const calendarContract = isCalendar ? readCalendarPlacementContract(settings) : undefined;
  if (isCalendar && calendarContract === undefined) {
    logPlacementFailure(read.address, placementId, "calendar_settings_invalid");
    read.data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }
  const tableContract = readRecordsTableContract(settings);
  const detailContract =
    tableContract === undefined ? readRecordDetailContract(settings) : undefined;
  const queryId =
    typeof placement.vortex.queryId === "string" ? placement.vortex.queryId : undefined;
  const isNotice = placementBlockIs(placement, QUERY_NOTICE_BLOCK_RELEASE);
  const isSummary = placementBlockIs(placement, SUMMARY_VALUES_BLOCK_RELEASE);
  const isChart = placementBlockIs(placement, CHART_BLOCK_RELEASE);
  const isLauncher = isApplicationLauncherPlacement(placement);
  const isBoard = isBoardPlacement(placement);
  if (
    tableContract === undefined &&
    detailContract === undefined &&
    !isCalendar &&
    !isNotice &&
    !isLinkTiles &&
    (queryId === undefined || !(isLauncher || isSummary || isChart || isBoard))
  )
    return;
  if (detailContract !== undefined && queryId === undefined) {
    await readSubjectDetail(read, placement);
    return;
  }
  const bound = queryId === undefined ? undefined : findModuleQuery(read.context, queryId);
  if (queryId === undefined || bound === undefined) {
    logPlacementFailure(read.address, placementId, "query_not_bound");
    read.data[placementId] = { status: "error" };
    return;
  }
  const inputValues = await resolvePlacementInputs(read, placement, bound.query);
  if (inputValues === undefined) return;
  if (isLinkTiles) await readLinkTiles(read, placement, queryId, inputValues);
  else if (isNotice) await readQueryNotice(read, placement, queryId, inputValues);
  else if (isBoard) await readBoard(read, placement, inputValues);
  else if (isLauncher) await readLauncher(read, placement, bound, inputValues);
  else if (isSummary || isChart)
    await readSummaryOrChart(read, placement, bound, inputValues, isChart);
  else if (calendarContract !== undefined)
    await readCalendar(read, placement, bound, calendarContract, inputValues);
  else if (tableContract !== undefined)
    await readRecordsTable(read, placement, bound, tableContract, inputValues);
  else await readQueryDetail(read, placement, bound, inputValues);
};

/** One page of one level of a tree table: the records beneath one record, as the table shows rows. */
export type TreeLevelResult =
  | Readonly<{ status: "ready"; values: unknown }>
  | Readonly<{ status: "empty" | "refused" | "error" }>;

/** Whether a placement is a Records table whose rows open to the records beneath them. */
export const isTreeTablePlacement = (placement: PlacementReadEntry): boolean =>
  readRecordsTableContract(placementSettingsOf(placement))?.features.tree.enabled === true;

/**
 * Reads one level of a tree table: the children of one record, a page at a time, through the
 * table's own read, so they show the table's columns, formatting and the viewer's search, filters
 * and sort. The parent is read again under the viewer's current access, so a record the viewer
 * cannot read opens nothing. Undefined when the placement is not a tree table.
 */
export const readRecordsTableTreeLevel = async (
  read: PlacementReadInput,
  placement: PlacementReadEntry,
  request: Readonly<{ parentRecordId: string; continuationToken?: string }>,
): Promise<TreeLevelResult | undefined> => {
  if (!isTreeTablePlacement(placement)) return undefined;
  const { placementId } = placement;
  const recordTypeId =
    typeof placement.vortex.queryId === "string"
      ? resolvedQueryRecordTypeId(read.context, placement.vortex.queryId)
      : undefined;
  if (recordTypeId === undefined) {
    logPlacementFailure(read.address, placementId, "query_not_bound");
    return { status: "error" };
  }
  const parent = await read.services.readSubject(recordTypeId, request.parentRecordId);
  if (parent.kind === "temporarily_unavailable") return { status: "error" };
  if (parent.kind !== "read") return { status: "refused" };
  const data: Record<string, PageDataState> = {};
  await readQueryPlacement(
    {
      ...read,
      data,
      treeLevel: {
        placementId,
        parentRecordId: request.parentRecordId,
        ...(request.continuationToken === undefined
          ? {}
          : { continuationToken: request.continuationToken }),
      },
    },
    placement,
  );
  const state = data[placementId];
  switch (state?.status) {
    case "ready":
      return { status: "ready", values: state.values };
    case "empty":
    case "refused":
      return { status: state.status };
    default:
      return { status: "error" };
  }
};

export { pageQueryBindingContext, placementParameterDependencies } from "./bindings";
export {
  findModuleQuery,
  isApplicationLauncherPlacement,
  isBoardPlacement,
  logPlacementFailure,
  projectedUseAvailability,
  resolvedQueryRecordTypeId,
  type PageDataState,
  type PageSubjectType,
  type PlacementLogPlace,
  type PlacementFailureReason,
  type PlacementReadEntry,
} from "./shared";
export type {
  LauncherQueryRow,
  PlacementGridLayouts,
  PlacementReadInput,
  PlacementReadServices,
} from "./types";
