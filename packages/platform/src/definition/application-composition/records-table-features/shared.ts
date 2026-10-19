import type { DefinitionValidationErrorCode } from "../../../catalogue/validation-errors";
import { definitionValidationErrorCatalogue } from "../../../catalogue/validation-errors";
import type { ComponentSettingValue } from "../block-property-schema";

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
  /** For a calculation or total, the type of the value it produces. */
  resultType?: string;
}>;

/** The type of value a field holds: a calculation's or total's result type, else its own type. */
export const factsValueType = (field: RecordsTableFieldFacts): string =>
  field.resultType ?? field.type;

/**
 * What a Records table's bound query offers, the input of every feature check: the fields it
 * selects with their canonical type and flags, its relationships and the record type's named
 * actions. Publication builds it from the compiled release; Studio from the draft being edited.
 */
export type RecordsTableQueryFacts = Readonly<{
  recordTypeLabel: string;
  fields: readonly RecordsTableFieldFacts[];
  relationships: readonly Readonly<{ key: string; label: string }>[];
  actions: readonly Readonly<{ key: string; label: string }>[];
  /** The query groups or aggregates its rows, so rows are not records a person can act on. */
  grouped: boolean;
}>;

/** The field types whose stored value people change directly. */
export const recordsTableEditableFieldTypes: readonly string[] = Object.freeze([
  "text",
  "long_text",
  "whole_number",
  "decimal_number",
  "money",
  "yes_no",
  "email_address",
  "phone_number",
  "web_address",
]);

/** A feature's codes: each is a validation catalogue entry whose message is the business sentence. */
export type RecordsTableFeatureRefusalCode = Extract<
  DefinitionValidationErrorCode,
  | "definition_records_table_search"
  | "definition_records_table_column_filters"
  | "definition_records_table_saved_views"
  | "definition_records_table_bulk_actions"
  | "definition_records_table_inline_edit"
  | "definition_records_table_conditional_formatting"
>;

/** The outcome of one feature check: available, or not possible with its one business sentence. */
export type RecordsTableFeatureCheck =
  | Readonly<{ kind: "available" }>
  | Readonly<{ kind: "not_possible"; code: RecordsTableFeatureRefusalCode; reason: string }>;

export const featureAvailable: RecordsTableFeatureCheck = Object.freeze({ kind: "available" });

export const featureNotPossible = (
  code: RecordsTableFeatureRefusalCode,
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
  read(group: SettingsRecord): RecordsTableFeatureState<Settings>;
  check(
    state: RecordsTableFeatureState<Settings>,
    facts: RecordsTableQueryFacts,
  ): RecordsTableFeatureCheck;
}>;
