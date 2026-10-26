import "server-only";

import type { JsonValue } from "../../catalogue/common";
import { describeFailure, sameId } from "../../catalogue/runtime-primitives";
import type { RecordsTableContract } from "../../definition/application-composition/records-display";
import type { RecordsTableBoardMode } from "../../definition/application-composition/records-table-features";
import { buildRecordsTableNarrowing } from "../records-table-query";
import {
  conditionalFormattingRelativeDates,
  conditionalFormattingUsesRelativeDates,
  logRecordsTableRequestRefusal,
  type ConditionalFormattingContext,
} from "../records-table-features";
import { readRecordsTableQueryState, readRecordsTableView } from "../records-table-state";
import { projectBoardPlacement } from "../board-query";
import { boardPayloadSchema } from "../display-payload-board";
import { filterTimeZone } from "./records-table";
import {
  fieldFilterTargetsOf,
  fieldLabelsOf,
  logPlacementFailure,
  type PlacementModule,
  type PlacementQuery,
  type PlacementReadEntry,
} from "./shared";
import type { PlacementReadInput } from "./types";

/**
 * A Records table in Board mode: only requested columns carry counts, totals and member pages.
 * The viewer's filters come from the page address through the one table state codec, are checked
 * against the declared Column filters and the fields the viewer can read, and narrow every column
 * read and total; a board has no sort, search, grouping, page position or saved view of its own, so
 * an address naming one is refused rather than ignored.
 */
export const readBoard = async (
  read: PlacementReadInput,
  placement: PlacementReadEntry,
  bound: Readonly<{ module: PlacementModule; query: PlacementQuery }>,
  contract: RecordsTableContract,
  board: RecordsTableBoardMode,
  inputValues: Readonly<Record<string, JsonValue>>,
): Promise<void> => {
  const { placementId } = placement;
  const columnRead = read.boardReads?.find((target) =>
    sameId(target.placementId, placementId),
  )?.request;

  const addressEntries = Object.entries(read.parameters).flatMap(
    ([name, value]): [string, string][] =>
      (typeof value === "string" ? [value] : (value ?? [])).map((text) => [name, text]),
  );
  const addressed = readRecordsTableQueryState(placementId, addressEntries);
  if (addressed.kind === "malformed") {
    logPlacementFailure(read.address, placementId, "table_state_malformed", addressed.part);
    read.data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }
  const { state } = addressed;
  if (
    state.sort.length > 0 ||
    state.search !== null ||
    state.page !== undefined ||
    state.group !== undefined ||
    state.pivot !== undefined ||
    readRecordsTableView(placementId, addressEntries) !== undefined
  ) {
    logPlacementFailure(read.address, placementId, "board_state_unsupported");
    read.data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }

  let filters: Parameters<typeof projectBoardPlacement>[0]["filters"];
  const columnFilters = contract.features.columnFilters;
  if (columnFilters.enabled) {
    const recordType = bound.query.recordType;
    const readable =
      read.gridLayouts.readable === undefined
        ? undefined
        : (read.gridLayouts.readable.get(
            recordType.state === "resolved" ? String(recordType.recordTypeId).toLowerCase() : "",
          ) ?? new Set<string>());
    const filterTargets = Object.fromEntries(
      Object.entries(fieldFilterTargetsOf(bound.module)).filter(
        ([fieldId]) => readable === undefined || readable.has(fieldId),
      ),
    );
    const timeZone = await filterTimeZone(
      read,
      columnFilters.fields.some(
        (field) => filterTargets[field.toLowerCase()]?.type === "date_time",
      ),
    );
    if (timeZone === "unavailable") {
      logPlacementFailure(read.address, placementId, "table_time_zone_unavailable");
      read.data[placementId] = { status: "error" };
      return;
    }
    // Only fields the viewer can read are offered; a filter on any other is refused.
    const offered = [...new Set(columnFilters.fields.map((field) => field.toLowerCase()))].filter(
      (fieldId) => readable === undefined || readable.has(fieldId),
    );
    const narrowing = buildRecordsTableNarrowing(
      contract,
      {
        state,
        filterTargets,
        ...(timeZone === undefined ? {} : { timeZone }),
        fieldLabels: fieldLabelsOf(bound.module),
      },
      offered,
    );
    if (narrowing.kind === "refused") {
      logRecordsTableRequestRefusal(narrowing, "board_read");
      logPlacementFailure(read.address, placementId, "board_filter_refused", narrowing.reason);
      read.data[placementId] = { status: "refused", reason: "not_permitted" };
      return;
    }
    filters = {
      fieldIds: columnFilters.fields,
      filter: narrowing.filter,
      fields: Object.values(narrowing.filterFields),
      applied: narrowing.appliedFilters,
    };
  } else if (state.filters.length > 0) {
    logPlacementFailure(read.address, placementId, "board_filter_refused", "feature_off");
    read.data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }

  // Formatting rules are evaluated with the bound record type's declared fields and, when a rule
  // compares with a relative date, the dates counted in the organisation's time zone.
  let formatting: Parameters<typeof projectBoardPlacement>[0]["formatting"];
  if (contract.features.conditionalFormatting.enabled) {
    const recordType = bound.query.recordType;
    const recordTypeId =
      recordType.state === "resolved" ? String(recordType.recordTypeId).toLowerCase() : undefined;
    const recordFields =
      bound.module.content.recordTypes.find(
        (candidate) => String(candidate.recordTypeId).toLowerCase() === recordTypeId,
      )?.fields ?? [];
    let relativeDates: ConditionalFormattingContext["relativeDates"];
    if (conditionalFormattingUsesRelativeDates(contract, [])) {
      const timeZone = await read.bindings.timeZone();
      if (timeZone === undefined)
        logPlacementFailure(read.address, placementId, "table_formatting_time_zone_unavailable");
      else relativeDates = conditionalFormattingRelativeDates(read.bindings.now, timeZone);
    }
    formatting = { contract, context: { recordFields, relativeDates } };
  }

  const projection = await projectBoardPlacement({
    context: read.context,
    session: read.session,
    selection: read.selection,
    placement: placement.item as unknown as Parameters<
      typeof projectBoardPlacement
    >[0]["placement"],
    inputValues,
    queries: read.services.queries,
    board,
    resolveRecordLinks: read.services.resolveRecordLinks,
    ...(filters === undefined ? {} : { filters }),
    ...(formatting === undefined ? {} : { formatting }),
    ...(columnRead === undefined ? {} : { read: columnRead }),
  });
  if (projection.outcome === "ready") {
    try {
      // The board payload is checked against the board contract where the server builds it.
      read.data[placementId] = {
        status: "ready",
        values: boardPayloadSchema.parse(projection.values),
      };
    } catch (error) {
      logPlacementFailure(
        read.address,
        placementId,
        "board_payload_invalid",
        describeFailure(error),
      );
      read.data[placementId] = { status: "error" };
    }
    return;
  }
  logPlacementFailure(read.address, placementId, projection.cause, projection.detail);
  read.data[placementId] =
    projection.outcome === "unavailable"
      ? { status: "error" }
      : { status: "refused", reason: "not_permitted" };
};
