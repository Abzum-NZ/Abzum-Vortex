import "server-only";

import { isRecord, type BlockPropertyValueContract, type JsonValue } from "../../schema";
import { protectedQueryCommandSchema, type ProtectedQueryRow } from "../../queries/index";
import {
  logPlacementFailure,
  placementSettingsOf,
  queryRecordType,
  type PlacementModule,
  type PlacementQuery,
  type PlacementReadEntry,
} from "./shared";
import type { LauncherQueryRow, PlacementReadInput } from "./types";

/** The most application rows a query-bound launcher reads before it refuses. */
export const MAXIMUM_LAUNCHER_QUERY_ROWS = 10_000;

const launcherCellKey = (
  settings: Readonly<Record<string, BlockPropertyValueContract>>,
  settingKey: string,
  fallback: string,
): string => {
  const value = settings[settingKey];
  return isRecord(value) && value.kind === "text" && typeof value.value === "string"
    ? value.value
    : fallback;
};

/**
 * A query-bound application launcher: every application row its query returns, intersected with
 * the applications the viewer may open. Its rows are read page by page up to a fixed bound; a
 * repeated continuation or too many rows is refused rather than shown in part.
 */
export const readLauncher = async (
  read: PlacementReadInput,
  placement: PlacementReadEntry,
  bound: Readonly<{ module: PlacementModule; query: PlacementQuery }>,
  inputValues: Readonly<Record<string, JsonValue>>,
): Promise<void> => {
  const { placementId } = placement;
  const { address, data } = read;
  const permittedApplicationKeys = read.permittedApplicationKeys;
  if (permittedApplicationKeys === undefined) {
    data[placementId] = read.permittedApplicationsUnavailable
      ? { status: "error" }
      : { status: "refused", reason: "not_permitted" };
    return;
  }
  const targetRecordType = queryRecordType(read.context, bound.query);
  if (targetRecordType === undefined) {
    logPlacementFailure(address, placementId, "launcher_query_invalid");
    data[placementId] = { status: "error" };
    return;
  }
  const command = protectedQueryCommandSchema.safeParse({
    moduleRootId: bound.module.rootId,
    queryId: bound.query.queryId,
    inputValues,
    requestedFieldIds: bound.query.selectedFieldIds,
    requestedSystemFieldKeys: [],
    sort: [],
    sortableFieldIds: [],
    filterableFieldIds: [],
    searchableFieldIds: [],
    pageSize: bound.query.pageSize,
  });
  if (!command.success) {
    logPlacementFailure(address, placementId, "launcher_query_invalid");
    data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }

  const queryRows: ProtectedQueryRow[] = [];
  const seenContinuationTokens = new Set<string>();
  let continuationToken: string | undefined;
  let failure: "unavailable" | "refused" | "too_many_rows" | undefined;
  let failureCause: string | undefined;
  do {
    const result = await read.services.queries.run(read.session, read.selection, {
      ...command.data,
      ...(continuationToken === undefined ? {} : { continuationToken }),
    });
    if (result.kind === "temporarily_unavailable") {
      failure = "unavailable";
      break;
    }
    if (result.kind !== "available" || result.value.outcome !== "completed") {
      failure = "refused";
      failureCause =
        result.kind === "available" && result.value.outcome === "refused"
          ? result.value.reasonCode
          : result.kind;
      break;
    }
    queryRows.push(...result.value.rows);
    const nextToken = result.value.nextContinuationToken;
    if (
      queryRows.length > MAXIMUM_LAUNCHER_QUERY_ROWS ||
      (nextToken !== undefined && seenContinuationTokens.has(nextToken))
    ) {
      failure = "too_many_rows";
      break;
    }
    if (nextToken !== undefined) seenContinuationTokens.add(nextToken);
    continuationToken = nextToken;
  } while (continuationToken !== undefined);

  if (failure !== undefined) {
    logPlacementFailure(
      address,
      placementId,
      failure === "unavailable" ? "launcher_query_unavailable" : "launcher_query_refused",
      failureCause,
    );
    data[placementId] =
      failure === "unavailable"
        ? { status: "error" }
        : { status: "refused", reason: "not_permitted" };
    return;
  }

  const fieldKeys = new Map(
    targetRecordType.fields.map(
      (field) => [String(field.fieldId).toLowerCase(), field.key] as const,
    ),
  );
  const launcherRows: LauncherQueryRow[] = queryRows.map((row) => {
    const cells: Record<string, { kind: "text"; text: string }> = {};
    for (const [fieldId, value] of Object.entries(row.values)) {
      const fieldKey = fieldKeys.get(fieldId.toLowerCase());
      if (fieldKey !== undefined && typeof value === "string")
        cells[fieldKey] = { kind: "text", text: value };
    }
    return { applicationKey: cells.key?.text, cells };
  });
  const settings = placementSettingsOf(placement);
  data[placementId] = {
    status: "ready",
    values: read.services.launcherValues(
      launcherRows,
      permittedApplicationKeys,
      launcherCellKey(settings, "name_key", "name"),
      launcherCellKey(settings, "icon_key", "icon"),
    ),
  };
};
