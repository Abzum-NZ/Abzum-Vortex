import catalogueSources from "../../catalogue/catalogue/application-composition-catalogue.source.json";
import {
  readRecordsTableRowActions,
  type RecordsTableActionContract,
} from "./records-table-features/row-actions";
import {
  readRecordsTableFeatures,
  recordsTableFeatureDefinitions,
  type RecordsTableFeatures,
} from "./records-table-features";
import {
  UnreadableSettingError,
  optionalField,
  optionalPage,
  optionalQuery,
  optionalText,
  recordsTableColumnPins,
  recordsTableDensities,
  recordsTableSortDirections,
  requiredBoolean,
  requiredChoice,
  requiredField,
  requiredFieldList,
  requiredGroup,
  requiredItems,
  requiredText,
  requiredNumber,
  unreadable,
  type SettingsRecord,
  type GridFeatureSettingsDeclaration,
} from "./records-table-features/shared";
import type { ComponentSettingValue } from "./block-property-schema";
export {
  UnreadableSettingError,
  recordsTableColumnPins,
  recordsTableDensities,
  recordsTableSortDirections,
} from "./records-table-features/shared";

const recordsDisplayFormats = [
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

const recordsTableColumnWidths = ["auto", "narrow", "medium", "wide"] as const;
/** Starting pixel widths shared by the grid and its spreadsheet export. */
const columnWidths = { auto: 180, narrow: 120, medium: 220, wide: 320 } as const;
export const recordsTableColumnWidth = (column: RecordsTableColumnContract): number =>
  columnWidths[column.width];
export type RecordsTableColumnPin = (typeof recordsTableColumnPins)[number];
/**
 * The narrowest and widest a person may resize a column, in pixels. The authored width token is
 * the column's starting width; a resize, and a stored layout, stays within these bounds.
 */
export const RECORDS_TABLE_COLUMN_MINIMUM_WIDTH = 64;
export const RECORDS_TABLE_COLUMN_MAXIMUM_WIDTH = 640;
const recordsTableColumnAlignments = ["start", "center", "end"] as const;
/** Low priority columns hide first on small screens; an essential column never hides. */
const recordsTableColumnPriorities = ["essential", "high", "medium", "low"] as const;
export type RecordsTableDensity = (typeof recordsTableDensities)[number];
/** How the table presents on a phone: cards built from the column priorities, or the grid. */
const recordsTablePhonePresentations = ["cards", "grid"] as const;
type RecordsTablePhonePresentation = (typeof recordsTablePhonePresentations)[number];
/**
 * Where the rows scroll: `bounded` keeps them in the grid's own scroll area (at most 70% of the
 * screen height), under the header when it is sticky; `page` lets the grid grow with its page. A
 * page of more than one hundred rows needs the bounded area.
 */
const recordsTableViewports = ["bounded", "page"] as const;
type RecordsTableViewport = (typeof recordsTableViewports)[number];
/** The most rows a page mounts without virtualization; a larger page mounts only its window. */
export { RECORDS_TABLE_UNVIRTUALIZED_ROW_LIMIT } from "./records-table-features/shared";

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
  pin: RecordsTableColumnPin;
  /** People may fit the column to the content of the page they see, from its column menu. */
  autoSize: boolean;
}>;

export type RecordsTableSortDirection = (typeof recordsTableSortDirections)[number];

/** One key of an ordered sort: a field and its direction. */
type RecordsTableSortContract = Readonly<{
  field: string;
  direction: RecordsTableSortDirection;
}>;

/** Authored messages a Records table or Record detail shows in place of its fixed neutral text. */
type RecordsDisplayMessages = Readonly<{
  empty?: string;
  refused?: string;
  error?: string;
}>;

/** A row click held as a binding to a flow; the bound flow decides what opening the row does. */
type RecordsTableRowClickContract = Readonly<{
  eventId: string;
  selectsRecord: boolean;
}>;

/** The configured row behaviours of one Records table placement: a row click and named row actions. */
type RecordsTableRowBehaviourContract = Readonly<{
  rowClick?: RecordsTableRowClickContract;
  rowActions: readonly RecordsTableActionContract[];
}>;

/**
 * The data contract a Records table placement declares in its settings (decision 5). The data
 * source is the placement's own bound query; every field here must be a field that query allows.
 */
export type RecordsTableContract = Readonly<{
  /** The authored one-line purpose shown above the rows. */
  purpose?: string;
  /** Adding a record from the list: the create form page it opens, when the block offers one. */
  createPage?: string;
  columns: readonly RecordsTableColumnContract[];
  /** The authored ordered default sort; empty orders by the bound query's own sort. */
  defaultSort: readonly RecordsTableSortContract[];
  sortableFields: readonly string[];
  pageSize: number;
  messages: RecordsDisplayMessages;
  /** Configured row behaviours; empty for a placement that declares none. */
  rowBehaviours: RecordsTableRowBehaviourContract;
  density: RecordsTableDensity;
  /** The header row stays in view while the rows scroll; it applies to the bounded viewport. */
  stickyHeader: boolean;
  /** People may expand the table to fill the screen from its toolbar. */
  allowFullScreen: boolean;
  /** Table columns or the List preset's cards at every screen size. */
  presentation: "grid" | "cards";
  phonePresentation: RecordsTablePhonePresentation;
  viewport: RecordsTableViewport;
  /** The optional grid features (search, column filters, saved views, bulk actions, inline editing). */
  features: RecordsTableFeatures;
}>;

type RecordDetailFieldContract = Readonly<{
  field: string;
  label?: string;
  format: RecordsDisplayFormat;
}>;

/** One card of a Record detail page: its stable key, optional heading and its fields. */
type RecordDetailSectionContract = Readonly<{
  key: string;
  title?: string;
  fields: readonly RecordDetailFieldContract[];
}>;

/** One related-list card: the query it lists, its columns and where a new record opens. */
type RecordDetailRelatedListContract = Readonly<{
  key: string;
  title: string;
  query: string;
  /** The query input that takes the record this detail shows. */
  parentInput: string;
  columns: readonly Readonly<{ field: string; label?: string }>[];
  addPage?: string;
  addField?: string;
}>;

/** The declared shape of a Record detail placement. */
type RecordDetailContract = Readonly<{
  /** Up to four key facts shown beside the heading. */
  headerFields: readonly string[];
  /** The choice field whose pipeline shows as the record's stage strip. */
  stageField?: string;
  sections: readonly RecordDetailSectionContract[];
  relatedLists: readonly RecordDetailRelatedListContract[];
  headingField?: string;
  messages: RecordsDisplayMessages;
}>;

const displayMessages = (settings: SettingsRecord): RecordsDisplayMessages => {
  const empty = optionalText(settings["empty_message"], "empty_message");
  const refused = optionalText(settings["refused_message"], "refused_message");
  const error = optionalText(settings["error_message"], "error_message");
  return {
    ...(empty === undefined ? {} : { empty }),
    ...(refused === undefined ? {} : { refused }),
    ...(error === undefined ? {} : { error }),
  };
};

/**
 * Reads the configured row behaviours: the row click, when the settings declare one, and the row
 * actions. A click bound to a flow appears only when it names the event that identifies its flow
 * binding; a row click that is declared but malformed refuses the table.
 */
const readRowBehaviours = (settings: SettingsRecord): RecordsTableRowBehaviourContract => {
  const rowActions = readRecordsTableRowActions(settings["row_actions"]);
  const click =
    settings["row_click"] === undefined
      ? undefined
      : requiredGroup(settings["row_click"], "row_click");
  if (click === undefined) return { rowActions };
  const mode = requiredChoice(click["mode"], ["flow", "select"] as const, "row_click.mode");
  if (mode === "select")
    return { rowClick: { eventId: "select", selectsRecord: true }, rowActions };
  const eventId = optionalText(click["event_id"], "row_click.event_id");
  return {
    ...(eventId === undefined ? {} : { rowClick: { eventId, selectsRecord: false } }),
    rowActions,
  };
};

const readContract = (settings: SettingsRecord): RecordsTableContract => {
  const columns = requiredItems(settings["columns"], "columns").map(
    (item, index): RecordsTableColumnContract => {
      const at = `columns[${index}]`;
      const column = requiredGroup(item, at);
      const label = optionalText(column["label"], `${at}.label`);
      return {
        field: requiredField(column["field"], `${at}.field`),
        ...(label === undefined ? {} : { label }),
        format: requiredChoice(column["format"], recordsDisplayFormats, `${at}.format`),
        width: requiredChoice(column["width"], recordsTableColumnWidths, `${at}.width`),
        alignment: requiredChoice(
          column["alignment"],
          recordsTableColumnAlignments,
          `${at}.alignment`,
        ),
        priority: requiredChoice(
          column["priority"],
          recordsTableColumnPriorities,
          `${at}.priority`,
        ),
        visible: requiredBoolean(column["visible"], `${at}.visible`),
        pin: requiredChoice(column["pin"], recordsTableColumnPins, `${at}.pin`),
        autoSize: requiredBoolean(column["auto_size"], `${at}.auto_size`),
      };
    },
  );
  const defaultSort = requiredItems(settings["default_sort"], "default_sort").map(
    (item, index): RecordsTableSortContract => {
      const at = `default_sort[${index}]`;
      const key = requiredGroup(item, at);
      return {
        field: requiredField(key["field"], `${at}.field`),
        direction: requiredChoice(key["direction"], recordsTableSortDirections, `${at}.direction`),
      };
    },
  );
  const features = readRecordsTableFeatures(settings["features"]);
  if (features.kind === "unreadable") return unreadable(features.path);
  const purpose = optionalText(settings["purpose"], "purpose");
  // Adding from the list is off unless it is on, and an on list names the form it opens.
  const createPage = requiredBoolean(settings["inline_create"], "inline_create")
    ? (optionalPage(settings["create_page"], "create_page") ?? unreadable("create_page"))
    : undefined;
  return {
    ...(purpose === undefined ? {} : { purpose }),
    ...(createPage === undefined ? {} : { createPage }),
    columns,
    defaultSort,
    sortableFields: requiredFieldList(settings["sortable_fields"], "sortable_fields"),
    pageSize: requiredNumber(settings["page_size"], "page_size"),
    messages: displayMessages(settings),
    rowBehaviours: readRowBehaviours(settings),
    density: requiredChoice(settings["density"], recordsTableDensities, "density"),
    stickyHeader: requiredBoolean(settings["sticky_header"], "sticky_header"),
    allowFullScreen: requiredBoolean(settings["allow_full_screen"], "allow_full_screen"),
    presentation: requiredChoice(
      settings["presentation"],
      recordsTablePhonePresentations,
      "presentation",
    ),
    phonePresentation: requiredChoice(
      settings["phone_presentation"],
      recordsTablePhonePresentations,
      "phone_presentation",
    ),
    viewport: requiredChoice(settings["viewport"], recordsTableViewports, "viewport"),
    features: features.features,
  };
};

/** A Records table's settings read whole, or the path of the setting that cannot be read. */
type RecordsTableContractRead =
  | Readonly<{ kind: "read"; contract: RecordsTableContract }>
  | Readonly<{ kind: "unreadable"; path: string }>;

/**
 * Reads a Records table placement's declared data contract from its settings. Every setting the
 * catalogue defaults fill in must be present with its kind, every entry of a list must be whole,
 * and every feature must be readable; one that is not makes the whole table unreadable and names
 * where. It reads settings that already passed the shared setting validator and never widens what
 * a release declares; the same reader serves the publication rule, the server query request and
 * the renderer.
 */
export const readRecordsTableContract = (settings: SettingsRecord): RecordsTableContractRead => {
  try {
    return { kind: "read", contract: readContract(settings) };
  } catch (error) {
    if (error instanceof UnreadableSettingError) return { kind: "unreadable", path: error.path };
    throw error;
  }
};

/**
 * The contract of a Records table placement, or undefined after logging where its settings cannot
 * be read. `where` names the caller, so the log says which read refused the table.
 */
export const recordsTableContractOrLog = (
  settings: SettingsRecord,
  where: string,
): RecordsTableContract | undefined => {
  const read = readRecordsTableContract(settings);
  if (read.kind === "read") return read.contract;
  console.error(`[grid] ${where} refused: DATA_GRID_SETTING_UNREADABLE path=${read.path}`);
  return undefined;
};

/**
 * Reads a Record detail placement's declared shape: its sections of fields, its header key facts,
 * its stage field and its related lists. Undefined when the settings are not a detail's or a
 * setting cannot be read whole. A placement that is not a detail block has no `sections`, which is
 * how a caller tells the two apart.
 */
export const readRecordDetailContract = (
  settings: SettingsRecord,
): RecordDetailContract | undefined => {
  if (settings["sections"] === undefined) return undefined;
  try {
    const detailField = (
      item: ComponentSettingValue | undefined,
      at: string,
    ): RecordDetailFieldContract => {
      const entry = requiredGroup(item, at);
      const label = optionalText(entry["label"], `${at}.label`);
      return {
        field: requiredField(entry["field"], `${at}.field`),
        ...(label === undefined ? {} : { label }),
        format: requiredChoice(entry["format"], recordsDisplayFormats, `${at}.format`),
      };
    };
    const sections = requiredItems(settings["sections"], "sections").map(
      (item, index): RecordDetailSectionContract => {
        const at = `sections[${index}]`;
        const entry = requiredGroup(item, at);
        const title = optionalText(entry["title"], `${at}.title`);
        return {
          key: requiredText(entry["key"], `${at}.key`),
          ...(title === undefined ? {} : { title }),
          fields: requiredItems(entry["fields"], `${at}.fields`).map((field, fieldIndex) =>
            detailField(field, `${at}.fields[${fieldIndex}]`),
          ),
        };
      },
    );
    const headerFields =
      settings["header_fields"] === undefined
        ? []
        : requiredItems(settings["header_fields"], "header_fields").map((item, index) => {
            const at = `header_fields[${index}]`;
            return requiredField(requiredGroup(item, at)["field"], `${at}.field`);
          });
    const relatedLists =
      settings["related_lists"] === undefined
        ? []
        : requiredItems(settings["related_lists"], "related_lists").map(
            (item, index): RecordDetailRelatedListContract => {
              const at = `related_lists[${index}]`;
              const entry = requiredGroup(item, at);
              const addPage = optionalPage(entry["add_page"], `${at}.add_page`);
              const addField = optionalField(entry["add_field"], `${at}.add_field`);
              if ((addPage === undefined) !== (addField === undefined)) unreadable(at);
              return {
                key: requiredText(entry["key"], `${at}.key`),
                title: requiredText(entry["title"], `${at}.title`),
                query: optionalQuery(entry["query"], `${at}.query`) ?? unreadable(`${at}.query`),
                parentInput: requiredText(entry["parent_input"], `${at}.parent_input`),
                columns: requiredItems(entry["columns"], `${at}.columns`).map(
                  (column, columnIndex) => {
                    const columnAt = `${at}.columns[${columnIndex}]`;
                    const group = requiredGroup(column, columnAt);
                    const label = optionalText(group["label"], `${columnAt}.label`);
                    return {
                      field: requiredField(group["field"], `${columnAt}.field`),
                      ...(label === undefined ? {} : { label }),
                    };
                  },
                ),
                ...(addPage === undefined ? {} : { addPage }),
                ...(addField === undefined ? {} : { addField }),
              };
            },
          );
    const headingSource = requiredChoice(
      settings["heading_source"],
      ["title", "field"] as const,
      "heading_source",
    );
    const headingField =
      headingSource === "field"
        ? requiredField(settings["heading_field"], "heading_field")
        : undefined;
    return {
      headerFields,
      ...(settings["stage_field"] === undefined
        ? {}
        : { stageField: requiredField(settings["stage_field"], "stage_field") }),
      sections,
      relatedLists,
      ...(headingField === undefined ? {} : { headingField }),
      messages: displayMessages(settings),
    };
  } catch (error) {
    if (error instanceof UnreadableSettingError) {
      console.error(
        `[grid] record detail refused: DATA_GRID_SETTING_UNREADABLE path=${error.path}`,
      );
      return undefined;
    }
    throw error;
  }
};

/** A custom editor reads the same list bound as the catalogue validator. Missing bounds are defects. */
export const recordsTableSettingMaximumItems = (
  root: string | GridFeatureSettingsDeclaration,
  ...nested: readonly string[]
): number => {
  const path = typeof root === "string" ? [root, ...nested] : nested;
  let properties: readonly {
    key?: string | undefined;
    kind?: string | undefined;
    maximumItems?: number | undefined;
    properties?: readonly unknown[] | undefined;
  }[] =
    typeof root === "string" ? catalogueSources.TABLE_BLOCK_RELEASE.properties : root.properties;
  for (const [index, key] of path.entries()) {
    const property = properties.find((candidate) => candidate.key === key);
    if (
      index === path.length - 1 &&
      property?.kind === "list" &&
      typeof property.maximumItems === "number"
    )
      return property.maximumItems;
    // The `features` group holds each grid feature's setting group from its definition.
    if (property !== undefined && "gridFeatures" in property) {
      properties = recordsTableFeatureDefinitions.map((definition) => definition.settings);
      continue;
    }
    if (property?.kind !== "group" || property.properties === undefined) break;
    properties = property.properties as typeof properties;
  }
  throw new Error(`Data grid catalogue list limit is missing: ${path.join(".")}`);
};
