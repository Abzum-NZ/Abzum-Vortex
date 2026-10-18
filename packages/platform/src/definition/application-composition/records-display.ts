import type { ComponentSettingValue } from "./block-property-schema";

export const recordsDisplayFormats = [
  "automatic",
  "text",
  "number",
  "currency",
  "percent",
  "date",
  "date_time",
  "boolean",
] as const;
export type RecordsDisplayFormat = (typeof recordsDisplayFormats)[number];

export const recordsTableColumnWidths = ["auto", "narrow", "medium", "wide"] as const;
export const recordsTableColumnAlignments = ["start", "center", "end"] as const;
/** Low priority columns hide first on small screens; an essential column never hides. */
export const recordsTableColumnPriorities = ["essential", "high", "medium", "low"] as const;
export const recordsTableSelectionModes = ["none", "single", "multiple"] as const;

/** The record action kinds a configured row or bulk action may require of the viewer. */
export const recordsTableActionCapabilities = ["update", "delete", "restore"] as const;
export type RecordsTableActionCapability = (typeof recordsTableActionCapabilities)[number];

/**
 * One declared Records table column. `field` is the authored qualified field when read from a
 * source document and the canonical field identity when read from compiled settings.
 */
export type RecordsTableColumnContract = Readonly<{
  field: string;
  label?: string;
  format: RecordsDisplayFormat;
  width: (typeof recordsTableColumnWidths)[number];
  alignment: (typeof recordsTableColumnAlignments)[number];
  priority: (typeof recordsTableColumnPriorities)[number];
}>;

export type RecordsTableParameterContract = Readonly<{
  input: string;
  source: "fixed" | "page";
  fixedValue?: string;
  pageParameter?: string;
}>;

/** Authored messages a Records table or Record detail shows in place of its fixed neutral text. */
export type RecordsDisplayMessages = Readonly<{
  empty?: string;
  refused?: string;
  error?: string;
}>;

/**
 * One named row action or bulk action. `eventId` is the stable identity of the flow binding the
 * command runs; it is unique across one placement's declared behaviours, so a click reaches
 * exactly one flow. `capability`, when declared, names the record action the command needs: the
 * renderer hides it for a row whose per-row capabilities do not include that kind. A command that
 * declares no capability (an open, read or custom command) stays shown, and the server still
 * re-checks every action it runs.
 */
export type RecordsTableActionContract = Readonly<{
  eventId: string;
  label: string;
  capability?: RecordsTableActionCapability;
}>;

/** A row click held as a binding to a flow; the bound flow decides what opening the row does. */
export type RecordsTableRowClickContract = Readonly<{
  eventId: string;
}>;

/** Inline edit of permitted fields, with one commit binding shared by those fields. */
export type RecordsTableInlineEditContract = Readonly<{
  eventId: string;
  fields: readonly string[];
}>;

/** The configured row behaviours of one Records table placement. */
export type RecordsTableRowBehaviourContract = Readonly<{
  rowClick?: RecordsTableRowClickContract;
  rowActions: readonly RecordsTableActionContract[];
  bulkActions: readonly RecordsTableActionContract[];
  inlineEdit?: RecordsTableInlineEditContract;
}>;

/**
 * The data contract a Records table placement declares in its settings (decision 5). The data
 * source is the placement's own bound query; every field here must be a field that query allows.
 */
export type RecordsTableContract = Readonly<{
  columns: readonly RecordsTableColumnContract[];
  defaultSort?: Readonly<{ field: string; direction: "ascending" | "descending" }>;
  sortableFields: readonly string[];
  filterableFields: readonly string[];
  search: boolean;
  savedViews: boolean;
  pageSize: number;
  selectionMode: (typeof recordsTableSelectionModes)[number];
  parameters: readonly RecordsTableParameterContract[];
  messages: RecordsDisplayMessages;
  /** Configured row behaviours; empty for a placement that declares none. */
  rowBehaviours: RecordsTableRowBehaviourContract;
}>;

export type RecordDetailFieldContract = Readonly<{
  field: string;
  label?: string;
  format: RecordsDisplayFormat;
}>;

/** The declared list of detail fields a Record detail placement shows. */
export type RecordDetailContract = Readonly<{
  fields: readonly RecordDetailFieldContract[];
  messages: RecordsDisplayMessages;
}>;

type SettingsRecord = Readonly<Record<string, ComponentSettingValue>>;

const settingGroup = (value: ComponentSettingValue | undefined): SettingsRecord | undefined =>
  value?.kind === "group" ? value.properties : undefined;
const settingItems = (
  value: ComponentSettingValue | undefined,
): readonly ComponentSettingValue[] | undefined =>
  value?.kind === "list" ? value.items : undefined;
const settingText = (value: ComponentSettingValue | undefined): string | undefined =>
  value?.kind === "text" && value.value.trim().length > 0 ? value.value.trim() : undefined;
const settingChoice = <Choice extends string>(
  value: ComponentSettingValue | undefined,
  allowed: readonly Choice[],
  fallback: Choice,
): Choice =>
  value?.kind === "choice" && (allowed as readonly string[]).includes(value.value)
    ? (value.value as Choice)
    : fallback;
const settingField = (value: ComponentSettingValue | undefined): string | undefined =>
  value?.kind !== "field_reference"
    ? undefined
    : "fieldId" in value
      ? String(value.fieldId)
      : String(value.field);
const settingFlag = (value: ComponentSettingValue | undefined): boolean =>
  value?.kind === "boolean" && value.value;

/** A choice setting read only when it names one of the allowed values; otherwise absent. */
const settingOptionalChoice = <Choice extends string>(
  value: ComponentSettingValue | undefined,
  allowed: readonly Choice[],
): Choice | undefined =>
  value?.kind === "choice" && (allowed as readonly string[]).includes(value.value)
    ? (value.value as Choice)
    : undefined;

const displayMessages = (settings: SettingsRecord): RecordsDisplayMessages => {
  const empty = settingText(settings["empty_message"]);
  const refused = settingText(settings["refused_message"]);
  const error = settingText(settings["error_message"]);
  return {
    ...(empty === undefined ? {} : { empty }),
    ...(refused === undefined ? {} : { refused }),
    ...(error === undefined ? {} : { error }),
  };
};

const fieldList = (value: ComponentSettingValue | undefined): string[] =>
  (settingItems(value) ?? []).flatMap((item) => settingField(item) ?? []);

const settingEventId = (value: ComponentSettingValue | undefined): string | undefined =>
  settingText(value);

/** Reads one declared row-action or bulk-action list, keeping only entries with both parts. */
const readRowActionList = (
  value: ComponentSettingValue | undefined,
): RecordsTableActionContract[] =>
  (settingItems(value) ?? []).flatMap((item): RecordsTableActionContract[] => {
    const action = settingGroup(item);
    if (action === undefined) return [];
    const eventId = settingEventId(action["event_id"]);
    const label = settingText(action["label"]);
    if (eventId === undefined || label === undefined) return [];
    const capability = settingOptionalChoice(action["capability"], recordsTableActionCapabilities);
    return [{ eventId, label, ...(capability === undefined ? {} : { capability }) }];
  });

/**
 * Reads the configured row behaviours from settings that already passed the shared validator. A
 * behaviour appears only when it carries the event identity that names its flow binding, so a
 * partially authored setting never invents a control.
 */
const readRowBehaviours = (settings: SettingsRecord): RecordsTableRowBehaviourContract => {
  const click = settingGroup(settings["row_click"]);
  const clickEventId = click === undefined ? undefined : settingEventId(click["event_id"]);
  const inline = settingGroup(settings["inline_edit"]);
  const inlineEventId = inline === undefined ? undefined : settingEventId(inline["event_id"]);
  const inlineFields = inline === undefined ? [] : fieldList(inline["fields"]);
  return {
    ...(clickEventId === undefined ? {} : { rowClick: { eventId: clickEventId } }),
    rowActions: readRowActionList(settings["row_actions"]),
    bulkActions: readRowActionList(settings["bulk_actions"]),
    ...(inlineEventId === undefined || inlineFields.length === 0
      ? {}
      : { inlineEdit: { eventId: inlineEventId, fields: inlineFields } }),
  };
};

/**
 * Reads a Records table placement's declared data contract from its settings, applying the
 * declared defaults. Returns undefined when the settings do not declare a table's `columns`.
 * It reads settings that already passed the
 * shared setting validator and never widens what a release declares; the same reader serves the
 * publication rule, the server query request and the renderer.
 */
export const readRecordsTableContract = (
  settings: SettingsRecord,
): RecordsTableContract | undefined => {
  const columnItems = settingItems(settings["columns"]);
  if (columnItems === undefined) return undefined;
  const columns = columnItems.flatMap((item): RecordsTableColumnContract[] => {
    const column = settingGroup(item);
    const field = column === undefined ? undefined : settingField(column["field"]);
    if (column === undefined || field === undefined) return [];
    const label = settingText(column["label"]);
    return [
      {
        field,
        ...(label === undefined ? {} : { label }),
        format: settingChoice(column["format"], recordsDisplayFormats, "automatic"),
        width: settingChoice(column["width"], recordsTableColumnWidths, "auto"),
        alignment: settingChoice(column["alignment"], recordsTableColumnAlignments, "start"),
        priority: settingChoice(column["priority"], recordsTableColumnPriorities, "medium"),
      },
    ];
  });
  const sort = settingGroup(settings["default_sort"]);
  const sortField = sort === undefined ? undefined : settingField(sort["field"]);
  const pageSize = settings["page_size"];
  // The catalogue default is the only source of the page size; a table without one is not read.
  if (pageSize?.kind !== "number") return undefined;
  const parameters = (settingItems(settings["query_parameters"]) ?? []).flatMap(
    (item): RecordsTableParameterContract[] => {
      const parameter = settingGroup(item);
      const input = parameter === undefined ? undefined : settingText(parameter["input"]);
      if (parameter === undefined || input === undefined) return [];
      const fixed = parameter["fixed_value"];
      const pageParameter = settingText(parameter["page_parameter"]);
      return [
        {
          input,
          source: settingChoice(parameter["source"], ["fixed", "page"] as const, "fixed"),
          ...(fixed?.kind === "text" ? { fixedValue: fixed.value } : {}),
          ...(pageParameter === undefined ? {} : { pageParameter }),
        },
      ];
    },
  );
  const direction = sort?.["direction"];
  return {
    columns,
    ...(sortField === undefined
      ? {}
      : {
          defaultSort: {
            field: sortField,
            direction:
              direction?.kind === "choice" && direction.value === "descending"
                ? "descending"
                : "ascending",
          },
        }),
    sortableFields: fieldList(settings["sortable_fields"]),
    filterableFields: fieldList(settings["filterable_fields"]),
    search: settingFlag(settings["search"]),
    savedViews: settingFlag(settings["saved_views"]),
    pageSize: pageSize.value,
    selectionMode: settingChoice(settings["selection_mode"], recordsTableSelectionModes, "none"),
    parameters,
    messages: displayMessages(settings),
    rowBehaviours: readRowBehaviours(settings),
  };
};

/** Reads a Record detail placement's declared detail fields; undefined for earlier releases. */
export const readRecordDetailContract = (
  settings: SettingsRecord,
): RecordDetailContract | undefined => {
  const items = settingItems(settings["detail_fields"]);
  if (items === undefined) return undefined;
  const fields = items.flatMap((item): RecordDetailFieldContract[] => {
    const entry = settingGroup(item);
    const field = entry === undefined ? undefined : settingField(entry["field"]);
    if (entry === undefined || field === undefined) return [];
    const label = settingText(entry["label"]);
    return [
      {
        field,
        ...(label === undefined ? {} : { label }),
        format: settingChoice(entry["format"], recordsDisplayFormats, "automatic"),
      },
    ];
  });
  return { fields, messages: displayMessages(settings) };
};
