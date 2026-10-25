import { z } from "zod";
import { builderKeySchema, fieldIdSchema } from "../../../catalogue/identifiers";
import type { RecordsTableActionContract } from "./row-actions";
import type { ComponentSettingValue } from "../block-property-schema";
import type { RecordsTableFeatures } from "./index";
import type { ProtectedQueryRow } from "../../../queries/protected-query-contracts";
import type {
  ConditionalFormattingProjection,
  RecordsTableInlineEditField,
  RecordsTableInlineEditor,
} from "../../../pages/records-table-feature-projection";
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
export const recordsTableColumnPins = ["start", "end", "unpinned"] as const;
/** Row height of the grid: comfortable rows are 44px, compact rows 32px. */
export const recordsTableDensities = ["comfortable", "compact"] as const;
export const recordsTableSortDirections = ["ascending", "descending"] as const;
/** The calendar units a date dimension (a pivot axis or a grouping) buckets by. */
export const recordsTablePivotDateUnits = ["day", "week", "month", "quarter", "year"] as const;
export type RecordsTablePivotDateUnit = (typeof recordsTablePivotDateUnits)[number];

/**
 * A setting the Data grid readers cannot read: the path names where, so a refusal and its log say
 * which part of the authored settings is at fault. Readers never repair or skip what they cannot
 * read; the whole table, or the whole feature, is refused.
 */
export class UnreadableSettingError extends Error {
  constructor(readonly path: string) {
    super(`DATA_GRID_SETTING_UNREADABLE path=${path}`);
    this.name = "UnreadableSettingError";
  }
}

export const unreadable = (path: string): never => {
  throw new UnreadableSettingError(path);
};

/** Prefixes the path of an unreadable setting raised by `read`, so it names the part it sits in. */
export const withSettingPath = <Result>(prefix: string, read: () => Result): Result => {
  try {
    return read();
  } catch (error) {
    if (error instanceof UnreadableSettingError)
      throw new UnreadableSettingError(`${prefix}.${error.path}`);
    throw error;
  }
};

/**
 * The strict readers: a setting the catalogue defaults fill in must be present with its kind,
 * otherwise it is unreadable. The `optional` readers serve a setting that is absent until the
 * builder names it, and refuse one that is present but of another kind or value.
 */
export const requiredGroup = (
  value: ComponentSettingValue | undefined,
  path: string,
): SettingsRecord => settingGroup(value) ?? unreadable(path);
export const requiredItems = (
  value: ComponentSettingValue | undefined,
  path: string,
): readonly ComponentSettingValue[] => settingItems(value) ?? unreadable(path);
export const requiredBoolean = (value: ComponentSettingValue | undefined, path: string): boolean =>
  value?.kind === "boolean" ? value.value : unreadable(path);
export const requiredNumber = (value: ComponentSettingValue | undefined, path: string): number =>
  value?.kind === "number" ? value.value : unreadable(path);
export const requiredText = (value: ComponentSettingValue | undefined, path: string): string =>
  settingText(value) ?? unreadable(path);
export const requiredField = (value: ComponentSettingValue | undefined, path: string): string =>
  settingField(value) ?? unreadable(path);
export const requiredChoice = <Choice extends string>(
  value: ComponentSettingValue | undefined,
  allowed: readonly Choice[],
  path: string,
): Choice =>
  value?.kind === "choice" && (allowed as readonly string[]).includes(value.value)
    ? (value.value as Choice)
    : unreadable(path);
/** Every item of a required list of field references; one that is not a field refuses the list. */
export const requiredFieldList = (
  value: ComponentSettingValue | undefined,
  path: string,
): string[] =>
  requiredItems(value, path).map((item, index) => requiredField(item, `${path}[${index}]`));
export const optionalText = (
  value: ComponentSettingValue | undefined,
  path: string,
): string | undefined => (value === undefined ? undefined : requiredText(value, path));
export const optionalField = (
  value: ComponentSettingValue | undefined,
  path: string,
): string | undefined => (value === undefined ? undefined : requiredField(value, path));
export const optionalNumber = (
  value: ComponentSettingValue | undefined,
  path: string,
): number | undefined => (value === undefined ? undefined : requiredNumber(value, path));
export const optionalChoice = <Choice extends string>(
  value: ComponentSettingValue | undefined,
  allowed: readonly Choice[],
  path: string,
): Choice | undefined => (value === undefined ? undefined : requiredChoice(value, allowed, path));

/** Reads the `enabled` switch of one feature group; a group that does not declare it is unreadable. */
export const featureEnabled = (group: SettingsRecord): boolean =>
  requiredBoolean(group["enabled"], "enabled");

/**
 * A feature is off, holding nothing else, or on with its own typed settings. Only an enabled feature
 * carries settings, so a feature that is off compiles to nothing.
 */
export type RecordsTableFeatureState<Settings extends object> =
  Readonly<{ enabled: false }> | Readonly<{ enabled: true } & Settings>;

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
  /** A link or choice that takes its choices from another field of the record type: that field, spelled as `field` is. */
  dependsOn?: string;
}>;

/**
 * Why a chosen edit field cannot be edited without the field it depends on, or undefined
 * when it has no such dependency or the parent is chosen as well: a parent's chosen record or option is
 * what narrows the child's choices, and changing it must be able to clear the child in the same draft.
 */
export const recordsTableDependencyMissing = (
  facts: RecordsTableQueryFacts,
  chosen: readonly string[],
): string | undefined => {
  for (const name of chosen) {
    const field = facts.fields.find(
      (candidate) => candidate.field.toLowerCase() === name.toLowerCase(),
    );
    if (field?.dependsOn === undefined) continue;
    if (chosen.some((other) => other.toLowerCase() === field.dependsOn!.toLowerCase())) continue;
    const parent = facts.fields.find(
      (candidate) => candidate.field.toLowerCase() === field.dependsOn!.toLowerCase(),
    );
    return `${field.label} depends on ${parent?.label ?? "another field"}: choose ${parent?.label ?? "it"} as well`;
  }
  return undefined;
};

/** The type of value a field holds: a calculation's or total's result type, else its own type. */
export const factsValueType = (
  field: Pick<RecordsTableFieldFacts, "type" | "resultType">,
): string => field.resultType ?? field.type;

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
  /** The maximum page size accepted by this query. */
  maximumPageSize: number;
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
    /** The stored option values, used to check fixed values in a card's formatting conditions. */
    choiceValues?: readonly string[];
    /** For a calculation or total, the type of the value it produces. */
    resultType?: string;
  }>[];
  selected: readonly string[];
  groupBy: readonly string[];
  /**
   * The query's own totals: each alias with its operation, the field it is taken of (absent for a
   * count of records) and the business label it is offered under.
   */
  aggregates: readonly Readonly<{
    alias: string;
    operation: string;
    field?: string;
    label: string;
  }>[];
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
  /** Authored table behaviour, judged with the query by the one feature check. */
  table: Readonly<{
    rowActions: readonly Readonly<{ placement: string }>[];
    viewport: "bounded" | "page";
  }>;
  recordTypeLabel: string;
  /** The bound query's ceiling, absent while no query has been chosen in Studio. */
  maximumPageSize: number | undefined;
  fields: readonly RecordsTableFieldFacts[];
  /** The fields the table shows as columns, as its settings name them. */
  columnFieldIds: readonly string[];
  relationships: readonly Readonly<{ key: string; label: string }>[];
  /**
   * The record type's named actions. `acceptsSelection` says it can run on several records, each
   * on its own: it needs no input a person types for one record.
   */
  actions: readonly Readonly<{ key: string; label: string; acceptsSelection: boolean }>[];
  /** The query groups or aggregates its rows, so rows are not records a person can act on. */
  grouped: boolean;
  /** The bound query's business name, for the sentences that name it. */
  queryLabel: string;
  /** The fields the bound query groups by, in its order, as the table's settings spell them. */
  groupBy: readonly string[];
  /** The record type declares the standard export action, so its records can be exported. */
  exportable: boolean;
  relatedRecords: RecordsTableRelatedRecordsFacts;
  /** What a Board needs; undefined when the query's record type is judged only at publication. */
  board: RecordsTableBoardFacts | undefined;
  /** The record type's fields the query does not select, so a check can name one a setting chose. */
  unselectedFields?: readonly Readonly<{ field: string; label: string }>[];
}>;

/**
 * The field types whose stored value people change directly in a cell: text, numbers, yes/no,
 * choices, dates, the address types and single-target links. Calculations, totals, generated
 * numbers, money, formatted text, several choices, links to one of several record types, tables and
 * attachments are never edited in a cell.
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
  "link",
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
    case "link_to_one_of_several":
      return `${field.label} links to one of several record types, so it cannot be edited here`;
    default:
      return `${field.label} cannot be edited in a cell`;
  }
};

/**
 * The refusal codes of the Records table's grid features. Each code belongs to exactly one feature
 * definition (or, for the viewport, to the feature registry), which declares its business sentence;
 * the definition validation catalogue lists them from there.
 */
export const recordsTableFeatureRefusalCodes = [
  "definition_records_table_bounded_scrolling",
  "definition_records_table_search",
  "definition_records_table_column_filters",
  "definition_records_table_saved_views",
  "definition_records_table_bulk_actions",
  "definition_records_table_inline_edit",
  "definition_records_table_row_edit",
  "definition_records_table_row_actions",
  "definition_records_table_row_action_limit",
  "definition_records_table_board_row_action",
  "definition_records_table_master_detail",
  "definition_records_table_tree",
  "definition_records_table_grouping",
  "definition_records_table_totals",
  "definition_records_table_conditional_formatting",
  "definition_records_table_pinning",
  "definition_records_table_pivot",
  "definition_records_table_spreadsheet",
  "definition_records_table_board",
  "definition_records_table_export",
] as const;
export type RecordsTableFeatureRefusalCode = (typeof recordsTableFeatureRefusalCodes)[number];

/**
 * One refusal a feature can give: its stable code, its place in the validation catalogue, and the
 * business sentence and guidance publication and Studio show when no more specific sentence applies.
 */
export type GridFeatureRefusal = Readonly<{
  code: RecordsTableFeatureRefusalCode;
  order: number;
  message: string;
  guidance: string;
}>;

/** The outcome of one feature check: available, or not possible with its one business sentence. */
export type RecordsTableFeatureCheck =
  | Readonly<{ kind: "available" }>
  | Readonly<{ kind: "not_possible"; code: RecordsTableFeatureRefusalCode; reason: string }>;

export const featureAvailable: RecordsTableFeatureCheck = Object.freeze({ kind: "available" });

/** A feature that is not possible: the refusal's own sentence, or one that names the part at fault. */
export const featureNotPossible = (
  refusal: GridFeatureRefusal,
  /** The sentence naming the part that does not fit, for a feature whose sentence is not fixed. */
  reason: string = refusal.message,
): RecordsTableFeatureCheck => Object.freeze({ kind: "not_possible", code: refusal.code, reason });

/** The facts of a field the settings name, compared without regard to case. */
export const factsOf = <Field extends Readonly<{ field: string }>>(
  facts: Readonly<{ fields: readonly Field[] }>,
  field: string,
): Field | undefined =>
  facts.fields.find((candidate) => candidate.field.toLowerCase() === field.toLowerCase());

/**
 * A feature's setting group as the Table release declares it inside its `features` group: the
 * catalogue entry of one feature, whose `defaultValue` turns the feature off. Puck `defaultProps`
 * and every Studio draft take it from here, so a strict reader never meets a missing group. The
 * release contract validates the declared properties when the catalogue loads.
 */
export type GridFeatureSettingsDeclaration = Readonly<{
  kind: "group";
  key: string;
  label: string;
  help: string;
  required: boolean;
  defaultValue: Readonly<{
    kind: "group";
    properties: Readonly<{ enabled: Readonly<{ kind: "boolean"; value: false }> }> &
      Readonly<Record<string, unknown>>;
  }>;
  properties: readonly object[];
}>;

/** What a feature check knows beside its own state: the table's other features and its shape. */
export type GridFeatureCheckContext = Readonly<{
  features: RecordsTableFeatures;
  presentation: "grid" | "cards";
  /** The table's own page size; a tree's opened levels share one row budget with it. */
  tablePageSize: number | undefined;
}>;

/**
 * What one viewer's read decides for a feature's part of the viewer's projection. Every part is
 * narrowed to what this viewer may do now; the server rechecks every request it allows.
 */
export type GridFeatureProjectionContext = Readonly<{
  /** The viewer is guaranteed to see the field on every record they may read. */
  readable: (field: string) => boolean;
  /** Some searchable field is among the fields the viewer is guaranteed to see. */
  searchable: boolean;
  /** The filter control of each filterable field, by lower-cased field identity. */
  filterFields: Readonly<Record<string, object>> | undefined;
  /** The business label of each field, by lower-cased field identity. */
  fieldLabels: Readonly<Record<string, string>> | undefined;
  /** The page of pivot rows this read asked for, carried back with the projection. */
  pivotView: Readonly<{ cursor?: string | undefined }> | undefined;
  /** The formatting this read evaluated for the viewer's rows; undefined when no rule applies. */
  conditionalFormatting: ConditionalFormattingProjection | undefined;
  /** The viewer holds an export permission that reaches every record, decided in this read. */
  exportAllowed: boolean;
  features: RecordsTableFeatures;
  columns: readonly Readonly<{ field: string }>[];
  rowBehaviours: Readonly<{ rowActions: readonly RecordsTableActionContract[] }>;
  rows: readonly ProtectedQueryRow[];
  editors: Readonly<Record<string, RecordsTableInlineEditor>> | undefined;
}>;

/** Whether the read lets this viewer update this field on this row now. */
export const rowMayChangeField = (
  row: Pick<ProtectedQueryRow, "capabilities">,
  field: string,
): boolean =>
  row.capabilities?.actions.includes("update") === true &&
  row.capabilities.changeableFieldIds.some(
    (fieldId) => fieldId.toLowerCase() === field.toLowerCase(),
  );

/** Editable fields share the same row, field-policy and installed-editor narrowing. */
export const projectedEditableFields = (
  feature: RecordsTableFeatures["inlineEdit"] | RecordsTableFeatures["rowEdit"],
  { rows, readable, editors }: GridFeatureProjectionContext,
): readonly RecordsTableInlineEditField[] => {
  if (!feature.enabled || feature.eventId === undefined) return [];
  return feature.fields.flatMap((field): RecordsTableInlineEditField[] => {
    const editor = editors?.[field.toLowerCase()];
    return editor !== undefined &&
      readable(field) &&
      rows.some((row) => rowMayChangeField(row, field))
      ? [{ field, editor }]
      : [];
  });
};

/**
 * One grid feature of the Records table, declared once: its key in the `features` setting group,
 * the property that names its state in the read contract and in the viewer's projection, its
 * business name, its setting group with the defaults, its refusals with their sentences, the reader
 * of its typed settings and its one capability check. Studio, publication and the runtime use this
 * definition and nothing else, so they never disagree.
 *
 * The check answers for an enabled feature whether its settings fit the bound query and the other
 * features, and for a feature that is off whether it could be turned on at all, so Studio shows the
 * same sentence beside the switch either way. `conflicts` decides first (the table's shape and the
 * other features); then a board refuses a feature it does not draw (`onBoard: "unsupported"`) or
 * judges one it borrows with `boardCheck`; then `check` decides against the bound query.
 */
export type RecordsTableFeatureDefinition<
  Settings extends object,
  Key extends string = string,
> = Readonly<{
  key: Key;
  property: keyof RecordsTableFeatures;
  /** The strict wire schema for this feature's viewer projection, absent for a separate payload. */
  projectionSchema?: z.ZodType;
  label: string;
  /** One short line saying what the feature lets people do. */
  description: string;
  settings: GridFeatureSettingsDeclaration;
  /** Every refusal the feature gives; the first is the one a reader without context sees. */
  refusals: readonly [GridFeatureRefusal, ...GridFeatureRefusal[]];
  /** How a board treats the feature: draws it, refuses it, or the feature decides itself. */
  onBoard: "supported" | "unsupported" | "own";
  /** The Records table events the feature's controls raise, with the switch that offers each. */
  events?: Readonly<Record<string, Readonly<{ offeredBy?: string }>>>;
  /** Reads the enabled feature's settings; a setting it cannot read throws `UnreadableSettingError`. */
  read(group: SettingsRecord): RecordsTableFeatureState<Settings>;
  conflicts?(
    state: RecordsTableFeatureState<Settings>,
    facts: RecordsTableQueryFacts,
    context: GridFeatureCheckContext,
  ): RecordsTableFeatureCheck | undefined;
  boardCheck?(
    state: RecordsTableFeatureState<Settings>,
    board: RecordsTableBoardFacts,
  ): RecordsTableFeatureCheck | undefined;
  check(
    state: RecordsTableFeatureState<Settings>,
    facts: RecordsTableQueryFacts,
    context: GridFeatureCheckContext,
  ): RecordsTableFeatureCheck;
  /**
   * The feature's part of one viewer's projection, under the feature's `property`, or undefined
   * when the feature is off for this viewer. Publication has already refused any combination the
   * feature does not support, so the projection never repeats a check.
   */
  project?(
    state: RecordsTableFeatureState<Settings>,
    context: GridFeatureProjectionContext,
  ): unknown;
}>;

export const RECORDS_TABLE_UNVIRTUALIZED_ROW_LIMIT = 100;

/** A field key as the table's columns spell it: an authored key or a field identity. */
export const projectionFieldKeySchema = z
  .string()
  .refine(
    (value) => builderKeySchema.safeParse(value).success || fieldIdSchema.safeParse(value).success,
    "A field is named by its key or identity",
  );
