import {
  readRecordsTableContract,
  type BlockPropertyValueContract,
  type RecordsTableActionContract,
  type RecordsTableContract,
} from "../../schema";
import type { ProtectedQueryRow } from "../../queries/protected-query-contracts";
import { placementSettings } from "../../definition/application-composition-catalogue";

/**
 * The grid features one viewer may use on one Records table read: each feature the release turns
 * on (publication already refused any that does not fit the bound query), narrowed to what the
 * viewer may do now. It is computed once per read, from the same rows and per-row capabilities the
 * Query engine decided under the viewer's current access and field policy, and travels in the
 * table payload; there is no separate request and nothing is cached. A feature that is off for the
 * viewer is absent, and a table with every feature off carries no projection at all.
 */
export type RecordsTableFeatureProjection = Readonly<{
  search?: true;
  /** The filterable fields the viewer may filter by. */
  columnFilters?: readonly string[];
  savedViews?: true;
  /** The bulk commands at least one row of the page lets the viewer run. */
  bulkActions?: readonly RecordsTableActionContract[];
  /** The fields the viewer may change on at least one row, and the flow binding that commits a change. */
  inlineEdit?: Readonly<{ eventId: string; fields: readonly string[] }>;
}>;

/** The part of a Records table request a refusal names, kept only in the server log. */
export type RecordsTableRequestPart =
  | "contract"
  | "columns"
  | "parameters"
  | "sort"
  | "filter"
  | "search"
  | "command"
  | "bulk_action"
  | "inline_edit";

/**
 * Why the server refused a Records table request: the part and the cause. The viewer only ever
 * sees the neutral refusal; this is logged with the placement so the cause is never lost.
 */
export type RecordsTableRequestRefusal = Readonly<{
  kind: "refused";
  part: RecordsTableRequestPart;
  reason: string;
}>;

export const recordsTableRequestRefusal = (
  part: RecordsTableRequestPart,
  reason: string,
): RecordsTableRequestRefusal => Object.freeze({ kind: "refused", part, reason });

/** Logs a refused Records table request with its part and cause; the response stays neutral. */
export const logRecordsTableRequestRefusal = (
  refusal: RecordsTableRequestRefusal,
  where: string,
): void => {
  console.error(
    `[records-table] request refused where=${where} part=${refusal.part} reason=${refusal.reason}`,
  );
};

const sameField = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

/**
 * Projects the enabled features for the viewer of one read. `visibleFieldIds` are the columns the
 * read requested; a requested column that every returned row withholds is a field the viewer may
 * not read, so it is not offered as a filter. A bulk command that names a capability is offered
 * when some row allows it, and inline editing keeps only fields some row lets the viewer change.
 * Every request a projected control makes is still re-checked by the server.
 */
export const projectRecordsTableFeatures = (
  contract: RecordsTableContract,
  visibleFieldIds: readonly string[],
  rows: readonly ProtectedQueryRow[],
): RecordsTableFeatureProjection | undefined => {
  const { features } = contract;
  const withheld = (field: string): boolean =>
    rows.length > 0 &&
    visibleFieldIds.some((fieldId) => sameField(fieldId, field)) &&
    rows.every((row) => !Object.keys(row.values).some((key) => sameField(key, field)));
  const columnFilters = features.columnFilters.enabled
    ? features.columnFilters.fields.filter((field) => !withheld(field))
    : [];
  const bulkActions = features.bulkActions.enabled
    ? features.bulkActions.actions.filter(
        (action) =>
          action.capability === undefined ||
          rows.some((row) => row.capabilities?.actions.includes(action.capability!) === true),
      )
    : [];
  const inlineEdit = features.inlineEdit;
  const editableFields =
    inlineEdit.enabled && inlineEdit.eventId !== undefined
      ? inlineEdit.fields.filter((field) =>
          rows.some(
            (row) =>
              row.capabilities?.actions.includes("update") === true &&
              row.capabilities.changeableFieldIds.some((fieldId) => sameField(fieldId, field)),
          ),
        )
      : [];
  const projection: RecordsTableFeatureProjection = {
    ...(features.search.enabled ? { search: true as const } : {}),
    ...(columnFilters.length === 0 ? {} : { columnFilters }),
    ...(features.savedViews.enabled ? { savedViews: true as const } : {}),
    ...(bulkActions.length === 0 ? {} : { bulkActions }),
    ...(editableFields.length === 0 || !inlineEdit.enabled || inlineEdit.eventId === undefined
      ? {}
      : { inlineEdit: { eventId: inlineEdit.eventId, fields: editableFields } }),
  };
  return Object.keys(projection).length === 0 ? undefined : projection;
};

/**
 * The server gate for a Records table flow event. A bulk command or inline edit reaches its flow
 * only while the placement's release turns that feature on and declares that command (or, for an
 * inline edit, every changed field); anything else is a forged request and is refused. The flow's
 * own record write still re-checks the viewer's current permission and field policy.
 */
export const recordsTableFlowEventRefusal = (
  settings: Readonly<Record<string, BlockPropertyValueContract>>,
  event: string,
  eventId: string,
  changedFieldIds: readonly string[] | undefined,
): RecordsTableRequestRefusal | undefined => {
  if (event !== "bulk_action" && event !== "inline_edit") return undefined;
  const contract = readRecordsTableContract(settings);
  if (contract === undefined)
    return recordsTableRequestRefusal("contract", "placement_contract_unreadable");
  if (event === "bulk_action") {
    const bulk = contract.features.bulkActions;
    if (!bulk.enabled) return recordsTableRequestRefusal("bulk_action", "feature_off");
    return bulk.actions.some((action) => sameField(action.eventId, eventId))
      ? undefined
      : recordsTableRequestRefusal("bulk_action", "command_not_declared");
  }
  const inline = contract.features.inlineEdit;
  if (!inline.enabled) return recordsTableRequestRefusal("inline_edit", "feature_off");
  if (inline.eventId === undefined || !sameField(inline.eventId, eventId))
    return recordsTableRequestRefusal("inline_edit", "binding_not_declared");
  // A binding that takes the edited field must name a declared editable one; a binding that takes
  // no field cannot be steered by it.
  if (
    changedFieldIds !== undefined &&
    (changedFieldIds.length === 0 ||
      changedFieldIds.some((fieldId) => !inline.fields.some((field) => sameField(field, fieldId))))
  )
    return recordsTableRequestRefusal("inline_edit", "field_not_editable");
  return undefined;
};

/** The compiled item with this placement identity anywhere in the installed content, if any. */
const installedPlacementProps = (
  content: unknown,
  placementId: string,
): Readonly<Record<string, unknown>> | undefined => {
  let found: Readonly<Record<string, unknown>> | undefined;
  const visit = (value: unknown): void => {
    if (found !== undefined || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const record = value as Record<string, unknown>;
    const props = record["props"];
    if (
      typeof record["type"] === "string" &&
      props !== null &&
      typeof props === "object" &&
      sameField(String((props as Record<string, unknown>)["id"]), placementId)
    ) {
      found = props as Record<string, unknown>;
      return;
    }
    for (const nested of Object.values(record)) visit(nested);
  };
  visit(content);
  return found;
};

/**
 * The flow-dispatch gate: a binding of a Records table bulk command or inline edit starts its flow
 * only when the installed placement turns that feature on for exactly this command and, for an
 * inline edit, the edited field (the `field` value the surface supplies, when the binding takes
 * one) is a declared editable field. Every other event passes; a refusal is logged by the caller with its part and cause.
 */
export const recordsTableBindingRefusal = (
  content: unknown,
  binding: Readonly<{ controlId: string; event: string; eventId: string }>,
  callerInputs: Readonly<Record<string, unknown>>,
): RecordsTableRequestRefusal | undefined => {
  if (binding.event !== "bulk_action" && binding.event !== "inline_edit") return undefined;
  const props = installedPlacementProps(content, binding.controlId);
  if (props === undefined) return recordsTableRequestRefusal("contract", "placement_not_installed");
  let settings: Readonly<Record<string, BlockPropertyValueContract>>;
  try {
    settings = placementSettings(props);
  } catch (error) {
    return recordsTableRequestRefusal(
      "contract",
      `placement_settings_unreadable ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const field = callerInputs["field"];
  return recordsTableFlowEventRefusal(
    settings,
    binding.event,
    binding.eventId,
    binding.event !== "inline_edit" || !Object.hasOwn(callerInputs, "field")
      ? undefined
      : typeof field === "string"
        ? [field]
        : [],
  );
};
