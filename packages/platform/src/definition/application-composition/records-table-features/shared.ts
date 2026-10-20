import type { DefinitionValidationErrorCode } from "../../../catalogue/validation-errors";
import { definitionValidationErrorCatalogue } from "../../../catalogue/validation-errors";
import type { ComponentSettingValue } from "../block-property-schema";
import type {
  QueryBindingField,
  QueryBindingInput,
  QueryBindingPageFacts,
} from "../query-binding-check";

/**
 * The setting readers a Records table contract and its features share. They read settings that
 * already passed the shared setting validator and never widen what a release declares.
 */
export type SettingsRecord = Readonly<Record<string, ComponentSettingValue>>;

export const settingGroup = (
  value: ComponentSettingValue | undefined,
): SettingsRecord | undefined => (value?.kind === "group" ? value.properties : undefined);
export const settingItems = (
  value: ComponentSettingValue | undefined,
): readonly ComponentSettingValue[] | undefined =>
  value?.kind === "list" ? value.items : undefined;
export const settingText = (value: ComponentSettingValue | undefined): string | undefined =>
  value?.kind === "text" && value.value.trim().length > 0 ? value.value.trim() : undefined;
/** A field reference as the contract keeps it: the authored qualified field or the canonical identity. */
export const settingField = (value: ComponentSettingValue | undefined): string | undefined =>
  value?.kind !== "field_reference"
    ? undefined
    : "fieldId" in value
      ? String(value.fieldId)
      : String(value.field);
/** A choice setting read only when it names one of the allowed values; otherwise absent. */
export const settingOptionalChoice = <Choice extends string>(
  value: ComponentSettingValue | undefined,
  allowed: readonly Choice[],
): Choice | undefined =>
  value?.kind === "choice" && (allowed as readonly string[]).includes(value.value)
    ? (value.value as Choice)
    : undefined;
export const fieldList = (value: ComponentSettingValue | undefined): string[] =>
  (settingItems(value) ?? []).flatMap((item) => settingField(item) ?? []);

/** The record action kinds a configured row or bulk action may require of the viewer. */
export const recordsTableActionCapabilities = ["update", "delete", "restore"] as const;
export type RecordsTableActionCapability = (typeof recordsTableActionCapabilities)[number];

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

/** Reads one declared row-action or bulk-action list, keeping only entries with both parts. */
export const readActionList = (
  value: ComponentSettingValue | undefined,
): RecordsTableActionContract[] =>
  (settingItems(value) ?? []).flatMap((item): RecordsTableActionContract[] => {
    const action = settingGroup(item);
    if (action === undefined) return [];
    const eventId = settingText(action["event_id"]);
    const label = settingText(action["label"]);
    if (eventId === undefined || label === undefined) return [];
    const capability = settingOptionalChoice(action["capability"], recordsTableActionCapabilities);
    return [{ eventId, label, ...(capability === undefined ? {} : { capability }) }];
  });

/**
 * A feature is off, holding nothing else, or on with its own typed settings. Only an enabled feature
 * carries settings, so a feature that is off compiles to nothing.
 */
export type RecordsTableFeatureState<Settings extends object> =
  Readonly<{ enabled: false }> | Readonly<{ enabled: true } & Settings>;

/** Reads the `enabled` switch of one feature group; undefined when the group does not declare it. */
export const featureEnabled = (group: SettingsRecord | undefined): boolean | undefined => {
  const enabled = group?.["enabled"];
  return enabled?.kind === "boolean" ? enabled.value : undefined;
};

/**
 * One field of the bound query as a feature check sees it. `field` is spelled as the table's
 * settings spell it: the authored qualified field in a draft, the canonical identity in a release.
 */
export type RecordsTableFieldFacts = Readonly<{
  field: string;
  label: string;
  /** The canonical field type, for example `text`, `choice` or `date`. */
  type: string;
  sortable: boolean;
  filterable: boolean;
  /** The record type marks the field searchable (it has a search priority). */
  searchable: boolean;
  /** People may change the value: a stored value, not a calculation, total or system value. */
  editable: boolean;
  /** For a choice field, how many options it declares. */
  choiceCount?: number;
  /** The stored option values, used to check fixed values in formatting conditions. */
  choiceValues?: readonly string[];
  /** For a calculation or total, the type of the value it produces. */
  resultType?: string;
  /** The field is a one-record link from the record type to itself, so a record names its parent. */
  parentLink: boolean;
}>;

/** The type of value a field holds: a calculation's or total's result type, else its own type. */
export const factsValueType = (field: RecordsTableFieldFacts): string =>
  field.resultType ?? field.type;

/**
 * One query the application may read, as a row's related records see it: the record type it reads,
 * the fields it selects and the inputs a binding fills. Identities are spelled as the table's
 * settings spell them: qualified references in a draft, canonical identities in a release.
 */
export type RecordsTableRelatedQueryFacts = Readonly<{
  query: string;
  label: string;
  recordType: string;
  fields: readonly Readonly<{ field: string; label: string }>[];
  inputs: readonly QueryBindingInput[];
  /** The query groups or totals its rows, so its rows are not records that open. */
  grouped: boolean;
}>;

/**
 * What the application offers a row's related records: every link from another record type to the
 * table's record type, the queries the application may read, the fields of the table's row (which
 * a This row binding may name) and the page's own binding facts.
 */
export type RecordsTableRelatedRecordsFacts = Readonly<{
  /** The table's record type, as the settings spell record types. */
  recordType: string;
  links: readonly Readonly<{
    relationship: string;
    label: string;
    childRecordType: string;
    childRecordTypeLabel: string;
  }>[];
  queries: readonly RecordsTableRelatedQueryFacts[];
  rowFields: readonly QueryBindingField[];
  page: Omit<QueryBindingPageFacts, "blockLabel" | "rowFields" | "rowRecordType">;
}>;

/**
 * What a Board needs of the bound query and its record type: every field of the record type, what
 * the query selects, groups by and totals, and the stage fields of the record type's pipelines.
 * Identities are spelled as the table's settings spell them.
 */
export type RecordsTableBoardFacts = Readonly<{
  queryLabel: string;
  fields: readonly Readonly<{
    field: string;
    label: string;
    type: string;
    filterable: boolean;
    /** For a choice field, how many options it declares. */
    choiceCount?: number;
  }>[];
  selected: readonly string[];
  groupBy: readonly string[];
  /** The aliases of the query's own totals. */
  aggregates: readonly string[];
  relationshipHops: number;
  pageSize: number;
  stageFields: readonly string[];
}>;

/**
 * What a Records table's bound query offers, the input of every feature check: the fields it
 * selects with their canonical type and flags, its relationships and the record type's named
 * actions, and what the application offers its rows' related records. Publication builds it from
 * the compiled release; Studio from the draft being edited.
 */
export type RecordsTableQueryFacts = Readonly<{
  /** The page requires a person to sign in before using its table. */
  signedIn: boolean;
  recordTypeLabel: string;
  /** The bound query's ceiling, absent while no query has been chosen in Studio. */
  maximumPageSize: number | undefined;
  fields: readonly RecordsTableFieldFacts[];
  relationships: readonly Readonly<{ key: string; label: string }>[];
  /**
   * The record type's named actions. `acceptsSelection` says it can run on several records, each
   * on its own: it needs no input a person types for one record.
   */
  actions: readonly Readonly<{ key: string; label: string; acceptsSelection: boolean }>[];
  /** The query groups or aggregates its rows, so rows are not records a person can act on. */
  grouped: boolean;
  relatedRecords: RecordsTableRelatedRecordsFacts;
  /** What a Board needs; undefined when the query's record type is judged only at publication. */
  board: RecordsTableBoardFacts | undefined;
  /** The record type's fields the query does not select, so a check can name one a setting chose. */
  unselectedFields?: readonly Readonly<{ field: string; label: string }>[];
}>;

/**
 * The field types whose stored value people change directly in a cell: text, numbers, yes/no,
 * choices, dates and the address types. Calculations, totals, generated numbers, money, formatted
 * text, several choices, links, tables and attachments are never edited in a cell.
 */
export const recordsTableEditableFieldTypes: readonly string[] = Object.freeze([
  "text",
  "long_text",
  "whole_number",
  "decimal_number",
  "yes_no",
  "choice",
  "date",
  "date_time",
  "email_address",
  "phone_number",
  "web_address",
]);

/** Why a field of the bound query cannot be edited in a cell, as a business sentence; undefined when it can. */
export const recordsTableFieldNotEditableReason = (
  field: RecordsTableFieldFacts,
): string | undefined => {
  if (field.editable) return undefined;
  switch (field.type) {
    case "calculation":
    case "total":
      return `${field.label} is calculated, so it cannot be edited here`;
    case "reference_number":
      return `${field.label} is numbered by the system, so it cannot be edited here`;
    default:
      return `${field.label} cannot be edited in a cell`;
  }
};

/** A feature's codes: each is a validation catalogue entry whose message is the business sentence. */
export type RecordsTableFeatureRefusalCode = Extract<
  DefinitionValidationErrorCode,
  | "definition_records_table_search"
  | "definition_records_table_column_filters"
  | "definition_records_table_saved_views"
  | "definition_records_table_bulk_actions"
  | "definition_records_table_inline_edit"
  | "definition_records_table_row_edit"
  | "definition_records_table_master_detail"
  | "definition_records_table_tree"
  | "definition_records_table_conditional_formatting"
  | "definition_records_table_pinning"
  | "definition_records_table_pivot"
  | "definition_records_table_spreadsheet"
  | "definition_records_table_board"
>;

/** The outcome of one feature check: available, or not possible with its one business sentence. */
export type RecordsTableFeatureCheck =
  | Readonly<{ kind: "available" }>
  | Readonly<{ kind: "not_possible"; code: RecordsTableFeatureRefusalCode; reason: string }>;

export const featureAvailable: RecordsTableFeatureCheck = Object.freeze({ kind: "available" });

/** A feature that is not possible: the catalogue sentence, or one that names the field at fault. */
export const featureNotPossible = (
  code: RecordsTableFeatureRefusalCode,
  /** The sentence naming the part that does not fit, for a feature whose sentence is not fixed. */
  reason: string = definitionValidationErrorCatalogue[code].message,
): RecordsTableFeatureCheck => Object.freeze({ kind: "not_possible", code, reason });

/** The facts of a field the settings name, compared without regard to case. */
export const factsOf = (
  facts: RecordsTableQueryFacts,
  field: string,
): RecordsTableFieldFacts | undefined =>
  facts.fields.find((candidate) => candidate.field.toLowerCase() === field.toLowerCase());

/**
 * One grid feature of the Records table: its key in the `features` setting group, its business
 * name, the reader of its typed settings and its one capability check. The check answers for an
 * enabled feature whether its settings fit the bound query, and for a feature that is off whether
 * it could be turned on at all, so Studio shows the same sentence beside the switch either way.
 */
export type RecordsTableFeatureDefinition<Settings extends object> = Readonly<{
  key: string;
  label: string;
  /** One short line saying what the feature lets people do. */
  description: string;
  read(group: SettingsRecord): RecordsTableFeatureState<Settings> | undefined;
  check(
    state: RecordsTableFeatureState<Settings>,
    facts: RecordsTableQueryFacts,
  ): RecordsTableFeatureCheck;
}>;
