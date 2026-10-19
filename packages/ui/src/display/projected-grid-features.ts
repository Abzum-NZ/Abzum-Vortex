import {
  recordsTableActionCapabilities,
  type RecordsTableActionContract,
  type RecordsTableFeatureProjection,
} from "@vortex/platform/schema";
import type { DefinitionRenderErrorLocation } from "../definition-error";
import {
  fail,
  requireArray,
  requireExactKeys,
  requireFieldKey,
  requireNonEmptyString,
  requireRecord,
  requirePositiveInteger,
} from "./projected-data";
import { parseConditionalFormatting } from "./projected-format";

/** One projected bulk command: its flow binding's event identity, label and optional capability. */
const parseTableAction = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): RecordsTableActionContract => {
  const action = requireRecord(value, "A projected bulk command must be an object", location);
  requireExactKeys(action, ["eventId", "label", "capability"], location);
  const eventId = requireNonEmptyString(action.eventId, "A bulk command needs its event", location);
  const label = requireNonEmptyString(action.label, "A bulk command needs its label", location);
  if (
    action.capability !== undefined &&
    !(recordsTableActionCapabilities as readonly unknown[]).includes(action.capability)
  )
    fail("A bulk command names an unknown capability", location);
  return Object.freeze({
    eventId,
    label,
    ...(action.capability === undefined
      ? {}
      : { capability: action.capability as RecordsTableActionContract["capability"] & string }),
  });
};

const parseFieldKeys = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): readonly string[] => {
  const fields = requireArray(value, message, location).map((field) =>
    requireFieldKey(field, message, location),
  );
  if (
    fields.length === 0 ||
    new Set(fields.map((field) => field.toLowerCase())).size !== fields.length
  )
    fail(message, location);
  return Object.freeze(fields);
};

/** The grid features the server projected for the viewer: each present feature is on. */
export const parseTableFeatures = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): RecordsTableFeatureProjection => {
  const record = requireRecord(value, "Projected table features are invalid", location);
  requireExactKeys(
    record,
    [
      "search",
      "columnFilters",
      "savedViews",
      "bulkActions",
      "inlineEdit",
      "masterDetail",
      "conditionalFormatting",
    ],
    location,
  );
  if (Object.keys(record).length === 0) fail("Projected table features name no feature", location);
  if (record.search !== undefined && record.search !== true)
    fail("A projected search feature is only ever on", location);
  if (record.savedViews !== undefined && record.savedViews !== true)
    fail("A projected saved views feature is only ever on", location);
  const columnFilters =
    record.columnFilters === undefined
      ? undefined
      : parseFieldKeys(record.columnFilters, "Projected filter fields are invalid", location);
  const bulkActions =
    record.bulkActions === undefined
      ? undefined
      : requireArray(record.bulkActions, "Projected bulk commands are invalid", location).map(
          (action) => parseTableAction(action, location),
        );
  if (bulkActions !== undefined && bulkActions.length === 0)
    fail("Projected bulk commands are empty", location);
  let inlineEdit: RecordsTableFeatureProjection["inlineEdit"];
  if (record.inlineEdit !== undefined) {
    const inline = requireRecord(
      record.inlineEdit,
      "Projected inline editing is invalid",
      location,
    );
    requireExactKeys(inline, ["eventId", "fields"], location);
    inlineEdit = Object.freeze({
      eventId: requireNonEmptyString(inline.eventId, "Inline editing needs its event", location),
      fields: parseFieldKeys(inline.fields, "Projected editable fields are invalid", location),
    });
  }
  let masterDetail: RecordsTableFeatureProjection["masterDetail"];
  if (record.masterDetail !== undefined) {
    const related = requireRecord(
      record.masterDetail,
      "Projected related records are invalid",
      location,
    );
    requireExactKeys(related, ["pageSize"], location);
    masterDetail = Object.freeze({
      pageSize: requirePositiveInteger(
        related.pageSize,
        "Related records need their page size",
        location,
      ),
    });
  }
  return Object.freeze({
    ...(record.search === true ? { search: true as const } : {}),
    ...(columnFilters === undefined ? {} : { columnFilters }),
    ...(record.savedViews === true ? { savedViews: true as const } : {}),
    ...(bulkActions === undefined ? {} : { bulkActions: Object.freeze(bulkActions) }),
    ...(inlineEdit === undefined ? {} : { inlineEdit }),
    ...(masterDetail === undefined ? {} : { masterDetail }),
    ...(record.conditionalFormatting === undefined
      ? {}
      : {
          conditionalFormatting: parseConditionalFormatting(record.conditionalFormatting, location),
        }),
  });
};
