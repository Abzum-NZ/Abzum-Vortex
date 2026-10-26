import "server-only";

import type { JsonValue } from "../../catalogue/common";
import { isRecord } from "../../catalogue/runtime-primitives";
import type { BlockPropertyValueContract } from "../../definition/application-composition/block-property-values";
import {
  protectedQueryCommandSchema,
  type ProtectedQueryRow,
} from "../../queries/protected-query-contracts";
import {
  readyPlacementData,
  logPlacementFailure,
  placementSettingsOf,
  queryRecordType,
  type PlacementModule,
  type PlacementQuery,
  type PlacementReadEntry,
} from "./shared";
import type { LauncherQueryRow, PlacementReadInput } from "./types";
import { launcherRowsPayloadSchema } from "../display-payload-launcher";

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
 * A query-bound application launcher: one bounded keyset page of its query, intersected with the
 * applications the viewer may open. It projects only the key, name, icon and optional description
 * fields it displays.
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
  const settings = placementSettingsOf(placement);
  const nameKey = launcherCellKey(settings, "name_key", "name");
  const iconKey = launcherCellKey(settings, "icon_key", "icon");
  const selectedFieldIds = new Set(bound.query.selectedFieldIds.map((id) => id.toLowerCase()));
  const displayFields = ["key", nameKey, iconKey].map((key) =>
    targetRecordType.fields.find((field) => field.key === key),
  );
  const requestedFieldIds = [...new Set(displayFields.flatMap((field) => field?.fieldId ?? []))];
  if (
    displayFields.some((field) => field === undefined) ||
    requestedFieldIds.some((fieldId) => !selectedFieldIds.has(String(fieldId).toLowerCase()))
  ) {
    logPlacementFailure(address, placementId, "launcher_query_invalid");
    data[placementId] = { status: "error" };
    return;
  }
  // The launcher also shows the optional fixed `description` cell when the query selects it.
  const descriptionField = targetRecordType.fields.find((field) => field.key === "description");
  if (
    descriptionField !== undefined &&
    selectedFieldIds.has(String(descriptionField.fieldId).toLowerCase()) &&
    !requestedFieldIds.includes(descriptionField.fieldId)
  )
    requestedFieldIds.push(descriptionField.fieldId);
  const command = protectedQueryCommandSchema.safeParse({
    moduleRootId: bound.module.rootId,
    queryId: bound.query.queryId,
    inputValues,
    requestedFieldIds,
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

  const result = await read.services.queries.run(read.session, read.selection, command.data);
  if (result.kind === "temporarily_unavailable") {
    logPlacementFailure(address, placementId, "launcher_query_unavailable");
    data[placementId] = { status: "error" };
    return;
  }
  if (result.kind !== "available" || result.value.outcome !== "completed") {
    const failureCause =
      result.kind === "available" && result.value.outcome === "refused"
        ? result.value.reasonCode
        : result.kind;
    logPlacementFailure(address, placementId, "launcher_query_refused", failureCause);
    data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }
  const queryRows: ProtectedQueryRow[] = result.value.rows;

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
  data[placementId] = readyPlacementData(
    read.address,
    placementId,
    launcherRowsPayloadSchema,
    read.services.launcherValues(launcherRows, permittedApplicationKeys, nameKey, iconKey),
  );
};
