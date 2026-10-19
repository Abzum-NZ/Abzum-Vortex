import type { DefinitionValidationErrorCode } from "../../catalogue/validation-errors";
import type { ComponentSettingValue } from "./block-property-schema";
import { readRecordsTableFeatures, type RecordsTableFeatures } from "./records-table-features";
import {
  readActionList,
  settingField,
  settingGroup,
  settingItems,
  settingOptionalChoice,
  settingText,
  fieldList,
  type RecordsTableActionContract,
  type SettingsRecord,
} from "./records-table-features/shared";

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
/** Row height of the grid: comfortable rows are 44px, compact rows 32px. */
export const recordsTableDensities = ["comfortable", "compact"] as const;
export type RecordsTableDensity = (typeof recordsTableDensities)[number];
/** How the table presents on a phone: cards built from the column priorities, or the grid. */
export const recordsTablePhonePresentations = ["cards", "grid"] as const;
export type RecordsTablePhonePresentation = (typeof recordsTablePhonePresentations)[number];
/**
 * Where the rows scroll: `bounded` keeps them in the grid's own scroll area (at most 70% of the
 * screen height), under the header when it is sticky; `page` lets the grid grow with its page. A
 * page of more than one hundred rows needs the bounded area.
 */
export const recordsTableViewports = ["bounded", "page"] as const;
export type RecordsTableViewport = (typeof recordsTableViewports)[number];
/** The most rows a page mounts without virtualization; a larger page mounts only its window. */
export const RECORDS_TABLE_UNVIRTUALIZED_ROW_LIMIT = 100;

/**
 * One declared Records table column. `field` is the authored qualified field when read from a
 * source document and the canonical field identity when read from compiled settings. `visible` is
 * the authored default visibility: the column shows until a person chooses other columns.
 */
export type RecordsTableColumnContract = Readonly<{
  field: string;
  label?: string;
  format: RecordsDisplayFormat;
  width: (typeof recordsTableColumnWidths)[number];
  alignment: (typeof recordsTableColumnAlignments)[number];
  priority: (typeof recordsTableColumnPriorities)[number];
  visible: boolean;
}>;

export const recordsTableSortDirections = ["ascending", "descending"] as const;
export type RecordsTableSortDirection = (typeof recordsTableSortDirections)[number];

/** One key of an ordered sort: a field and its direction. */
export type RecordsTableSortContract = Readonly<{
  field: string;
  direction: RecordsTableSortDirection;
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

/** A row click held as a binding to a flow; the bound flow decides what opening the row does. */
export type RecordsTableRowClickContract = Readonly<{
  eventId: string;
}>;

/** The configured row behaviours of one Records table placement: a row click and named row actions. */
export type RecordsTableRowBehaviourContract = Readonly<{
  rowClick?: RecordsTableRowClickContract;
  rowActions: readonly RecordsTableActionContract[];
}>;

/**
 * The data contract a Records table placement declares in its settings (decision 5). The data
 * source is the placement's own bound query; every field here must be a field that query allows.
 */
export type RecordsTableContract = Readonly<{
  columns: readonly RecordsTableColumnContract[];
  /** The authored ordered default sort; empty orders by the bound query's own sort. */
  defaultSort: readonly RecordsTableSortContract[];
  sortableFields: readonly string[];
  pageSize: number;
  parameters: readonly RecordsTableParameterContract[];
  messages: RecordsDisplayMessages;
  /** Configured row behaviours; empty for a placement that declares none. */
  rowBehaviours: RecordsTableRowBehaviourContract;
  density: RecordsTableDensity;
  /** The header row stays in view while the rows scroll; it applies to the bounded viewport. */
  stickyHeader: boolean;
  /** The first visible data column (after any selection column) stays in view on a wide scroll. */
  stickyFirstColumn: boolean;
  phonePresentation: RecordsTablePhonePresentation;
  viewport: RecordsTableViewport;
  /** The optional grid features (search, column filters, saved views, bulk actions, inline editing). */
  features: RecordsTableFeatures;
}>;

export type RecordDetailFieldContract = Readonly<{
  field: string;
  label?: string;
  format: RecordsDisplayFormat;
}>;

/** The declared list of detail fields a Record detail placement shows. */
export type RecordDetailContract = Readonly<{
  fields: readonly RecordDetailFieldContract[];
  headingField?: string;
  messages: RecordsDisplayMessages;
}>;

const settingChoice = <Choice extends string>(
  value: ComponentSettingValue | undefined,
  allowed: readonly Choice[],
  fallback: Choice,
): Choice =>
  value?.kind === "choice" && (allowed as readonly string[]).includes(value.value)
    ? (value.value as Choice)
    : fallback;

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

/**
 * Reads the configured row behaviours from settings that already passed the shared validator. A
 * behaviour appears only when it carries the event identity that names its flow binding, so a
 * partially authored setting never invents a control.
 */
const readRowBehaviours = (settings: SettingsRecord): RecordsTableRowBehaviourContract => {
  const click = settingGroup(settings["row_click"]);
  const clickEventId = click === undefined ? undefined : settingText(click["event_id"]);
  return {
    ...(clickEventId === undefined ? {} : { rowClick: { eventId: clickEventId } }),
    rowActions: readActionList(settings["row_actions"]),
  };
};

/**
 * Reads a Records table placement's declared data contract from its settings, applying the
 * declared defaults. Returns undefined when the settings do not declare a table's `columns`, or a
 * column does not declare its default visibility.
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
    const visible = column["visible"];
    return [
      {
        field,
        ...(label === undefined ? {} : { label }),
        format: settingChoice(column["format"], recordsDisplayFormats, "automatic"),
        width: settingChoice(column["width"], recordsTableColumnWidths, "auto"),
        alignment: settingChoice(column["alignment"], recordsTableColumnAlignments, "start"),
        priority: settingChoice(column["priority"], recordsTableColumnPriorities, "medium"),
        visible: visible?.kind === "boolean" && visible.value,
      },
    ];
  });
  // Default visibility is explicit on every column; a column that does not declare it is not read.
  if (columnItems.some((item) => settingGroup(item)?.["visible"]?.kind !== "boolean"))
    return undefined;
  // Every default sort key declares its field and direction; a key missing either is not read, so
  // the table never runs an order other than the authored one.
  const defaultSort: RecordsTableSortContract[] = [];
  for (const item of settingItems(settings["default_sort"]) ?? []) {
    const key = settingGroup(item);
    const field = key === undefined ? undefined : settingField(key["field"]);
    const direction = key?.["direction"];
    if (
      field === undefined ||
      direction?.kind !== "choice" ||
      !recordsTableSortDirections.some((candidate) => candidate === direction.value)
    )
      return undefined;
    defaultSort.push({ field, direction: direction.value as RecordsTableSortDirection });
  }
  const pageSize = settings["page_size"];
  // The catalogue default is the only source of the page size; a table without one is not read.
  if (pageSize?.kind !== "number") return undefined;
  // The grid presentation settings are equally explicit: the catalogue defaults fill them in, and a
  // table missing one is not read, so no renderer chooses a presentation the definition did not.
  const density = settingOptionalChoice(settings["density"], recordsTableDensities);
  const phonePresentation = settingOptionalChoice(
    settings["phone_presentation"],
    recordsTablePhonePresentations,
  );
  const viewport = settingOptionalChoice(settings["viewport"], recordsTableViewports);
  const stickyHeader = settings["sticky_header"];
  const stickyFirstColumn = settings["sticky_first_column"];
  const features = readRecordsTableFeatures(settings["features"]);
  if (
    features === undefined ||
    density === undefined ||
    phonePresentation === undefined ||
    viewport === undefined ||
    stickyHeader?.kind !== "boolean" ||
    stickyFirstColumn?.kind !== "boolean"
  )
    return undefined;
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
  return {
    columns,
    defaultSort,
    sortableFields: fieldList(settings["sortable_fields"]),
    pageSize: pageSize.value,
    parameters,
    messages: displayMessages(settings),
    rowBehaviours: readRowBehaviours(settings),
    density,
    stickyHeader: stickyHeader.value,
    stickyFirstColumn: stickyFirstColumn.value,
    phonePresentation,
    viewport,
    features,
  };
};

/**
 * Why a readable Records table contract cannot be published as authored, as the validation
 * catalogue code whose message is the business sentence, or undefined when it can. The grid mounts
 * only the visible window of a page of more than one hundred rows, which needs its own bounded
 * scroll area.
 */
export const recordsTableContractRefusal = (
  contract: RecordsTableContract,
):
  | Extract<DefinitionValidationErrorCode, "definition_records_table_bounded_scrolling">
  | undefined =>
  contract.viewport === "page" && contract.pageSize > RECORDS_TABLE_UNVIRTUALIZED_ROW_LIMIT
    ? "definition_records_table_bounded_scrolling"
    : undefined;

/** Reads a Record detail placement's declared detail fields; undefined for earlier releases. */
export const readRecordDetailContract = (
  settings: SettingsRecord,
): RecordDetailContract | undefined => {
  const items = settingItems(settings["detail_fields"]);
  if (items === undefined) return undefined;
  const headingSource = settings["heading_source"];
  if (headingSource?.kind !== "choice" || !["title", "field"].includes(headingSource.value))
    return undefined;
  const headingField =
    headingSource.value === "field" ? settingField(settings["heading_field"]) : undefined;
  if (headingSource.value === "field" && headingField === undefined) return undefined;
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
  return {
    fields,
    ...(headingField === undefined ? {} : { headingField }),
    messages: displayMessages(settings),
  };
};
