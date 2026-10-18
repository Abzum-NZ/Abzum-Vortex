import type { fieldTypeKeys } from "../catalogue/catalogues";
import {
  plainSourceSettingValue,
  typedSourceSettingValue,
  type BlockPropertySchemaContract,
  type ComponentSettingFailure,
} from "./application-composition/block-property-schema";
import type { SourceBlockPropertyValueContract } from "./application-composition/block-property-values";

/**
 * The settings of every module field type, declared once as typed settings, so Studio edits a
 * field's settings with the same typed controls it uses for block settings. Each declaration
 * mirrors the field contract in `module-source-fields.ts` exactly: a typed value converts to the
 * plain settings the contract stores, and the source schema judges the result.
 */

export type ModuleFieldType = (typeof fieldTypeKeys)[number];
type Declaration = BlockPropertySchemaContract;
type Typed = SourceBlockPropertyValueContract;
export type ModuleFieldTypedSettings = Readonly<Record<string, Typed>>;

/** A field type as a person reads it, for the type picker. */
export const moduleFieldTypeLabels: Readonly<Record<ModuleFieldType, string>> = {
  text: "Text", long_text: "Long text", formatted_text: "Formatted text", whole_number: "Whole number",
  decimal_number: "Decimal number", money: "Money", yes_no: "Yes or no", date: "Date", date_time: "Date and time",
  choice: "Choice", several_choices: "Several choices", reference_number: "Reference number",
  email_address: "Email address", phone_number: "Phone number", web_address: "Web address", table: "Table",
  link: "Link to a record", link_to_one_of_several: "Link to one of several record types",
  link_to_person: "Link to a person", calculation: "Calculation", total: "Total of related records",
  attachment: "Attachment",
};

/** What a field's settings can refer to: the other fields of its record type and of related ones. */
export type ModuleFieldSettingsContext = Readonly<{
  /** The other fields of the field's own record type, by local key. */
  fields: readonly Readonly<{ key: string; label: string; type: string }>[];
  /** The fields of the record type a total's relationship comes from, by local key. */
  relatedFields: readonly Readonly<{ key: string; label: string; type: string }>[];
}>;

const base = (key: string, label: string, required: boolean, help?: string) =>
  ({ key, label, required, ...(help === undefined ? {} : { help }) });
const text = (key: string, label: string, required: boolean, minLength: number, maxLength: number, help?: string): Declaration =>
  ({ ...base(key, label, required, help), kind: "text", minLength, maxLength });
const number = (key: string, label: string, required: boolean, options: Readonly<{ integer?: boolean; minimum?: number; maximum?: number; help?: string }> = {}): Declaration => ({
  ...base(key, label, required, options.help), kind: "number", integer: options.integer ?? true,
  ...(options.minimum === undefined ? {} : { minimum: options.minimum }),
  ...(options.maximum === undefined ? {} : { maximum: options.maximum }),
});
const boolean = (key: string, label: string, required: boolean, help?: string): Declaration =>
  ({ ...base(key, label, required, help), kind: "boolean" });
const choice = (key: string, label: string, required: boolean, options: readonly (readonly [string, string])[], help?: string): Declaration =>
  ({ ...base(key, label, required, help), kind: "choice", options: options.map(([optionKey, optionLabel]) => ({ key: optionKey, label: optionLabel })) });
const list = (key: string, label: string, required: boolean, minimumItems: number, maximumItems: number, item: Declaration, help?: string): Declaration =>
  ({ ...base(key, label, required, help), kind: "list", minimumItems, maximumItems, item });
const group = (key: string, label: string, properties: Declaration[], required = true): Declaration =>
  ({ ...base(key, label, required), kind: "group", properties });

const decimalText = (key: string, label: string) =>
  text(key, label, false, 1, 60, "An exact number, for example 0 or 99.95.");
const isoDate = (key: string, label: string) => text(key, label, false, 10, 10, "A date written as YYYY-MM-DD.");
const fieldChoices = (fields: ModuleFieldSettingsContext["fields"], types?: readonly string[]) =>
  fields.filter((field) => types === undefined || types.includes(field.type)).map((field) => [field.key, field.label] as const);
const deleteRules = [["refuse", "Refuse to delete the linked record"], ["empty_optional", "Clear this link"],
  ["soft_delete_dependent", "Delete this record too"]] as const;
const resultTypes = [["text", "Text"], ["whole_number", "Whole number"], ["decimal_number", "Decimal number"],
  ["money", "Money"], ["yes_no", "Yes or no"], ["date", "Date"], ["date_time", "Date and time"]] as const;
const currencyModes = [["organization_default", "The organisation's currency"], ["fixed", "One fixed currency"]] as const;
const optionItem = (): Declaration => group("option", "Option", [
  text("value", "Stored value", true, 1, 120, "What is stored. It cannot change once records hold it."),
  text("label", "Label", true, 1, 60),
  text("required_permission", "Permission needed to choose it", false, 1, 200, "Leave empty so everyone who can edit the field may choose it."),
]);
const tableColumnTypes = [["text", "Text"], ["whole_number", "Whole number"], ["decimal_number", "Decimal number"],
  ["money", "Money"], ["yes_no", "Yes or no"], ["date", "Date"], ["date_time", "Date and time"], ["choice", "Choice"]] as const;
const timeZones = [["person", "The person's time zone"], ["organization", "The organisation's time zone"], ["utc", "UTC"]] as const;
const textFormats = [["email_address", "Email address"], ["web_address", "Secure web address"], ["uuid", "Identifier (UUID)"]] as const;
const numericOperations = [["add", "Add"], ["subtract", "Subtract"], ["multiply", "Multiply"], ["divide", "Divide"]] as const;

/** One table column, with every column type's settings: the column's type picks the ones it keeps. */
const tableColumnItem = (): Declaration => group("column", "Column", [
  text("key", "Key", true, 1, 40, "Lowercase words separated by underscores."),
  boolean("required", "A value is required", false),
  choice("type", "Type", true, tableColumnTypes),
  number("max_length", "Longest value allowed (text)", false, { minimum: 1, maximum: 100_000 }),
  choice("format", "Format (text)", false, textFormats),
  number("minimum", "Smallest value (whole number)", false),
  number("maximum", "Largest value (whole number)", false),
  number("step", "Step (whole number)", false, { minimum: 1 }),
  number("digits_before_decimal", "Digits before the decimal point (decimal number)", false, { minimum: 1, maximum: 30 }),
  number("decimal_places", "Decimal places (decimal number)", false, { minimum: 0, maximum: 12 }),
  choice("currency_mode", "Currency (money)", false, currencyModes),
  text("currency", "Fixed currency (money)", false, 3, 3, "Three capital letters, for example NZD."),
  decimalText("minimum_amount", "Smallest value (decimal number or money)"),
  decimalText("maximum_amount", "Largest value (decimal number or money)"),
  isoDate("earliest", "Earliest date (date)"),
  isoDate("latest", "Latest date (date)"),
  choice("display_time_zone", "Time zone shown (date and time)", false, timeZones),
  list("options", "Options (choice)", false, 0, 200, optionItem()),
]);

/** A calculation's formula, with every operation's parts: its operation picks the ones it keeps. */
const expressionGroup = (context: ModuleFieldSettingsContext): Declaration => {
  const fields = fieldChoices(context.fields);
  const operandParts = (): Declaration[] => [
    choice("source", "Value comes from", true, [["field", "A field"], ["literal", "A fixed number"]]),
    choice("field", "Field", false, fieldChoices(context.fields, ["whole_number", "decimal_number", "money"])),
    decimalText("value", "Fixed number"),
  ];
  const operand = group("operand", "Value", operandParts());
  return group("expression", "Formula", [
    choice("operation", "What it works out", true, [["join_text", "Joins text of fields"], ["numeric", "Works out a number"],
      ["date_offset", "Moves a date"], ["deadline_passed", "Whether a deadline has passed"]]),
    list("fields", "Fields joined (joins text)", false, 0, 20, choice("field", "Field", true, fields)),
    text("separator", "Between the joined values (joins text)", false, 0, 20),
    choice("numeric_operation", "Operation (works out a number)", false, numericOperations),
    list("operands", "Values (works out a number)", false, 0, 20, operand),
    choice("date_field", "Date field (moves a date)", false, fieldChoices(context.fields, ["date", "date_time"])),
    group("amount", "By how much (moves a date)", operandParts(), false),
    choice("unit", "Unit (moves a date)", false, [["days", "Days"], ["weeks", "Weeks"], ["months", "Months"], ["years", "Years"]]),
    choice("due_field", "Due field (deadline)", false, fieldChoices(context.fields, ["date", "date_time"])),
    choice("status_field", "Status field (deadline)", false, fieldChoices(context.fields, ["choice"])),
    list("terminal_status_values", "Statuses that end the deadline (deadline)", false, 0, 20, text("status", "Status", true, 1, 120)),
  ]);
};

/** The operations a calculation's formula is edited for here; another formula is kept as it is. */
const editableExpression = (expression: unknown): boolean => {
  const value = expression as { operation?: unknown; operands?: { source?: unknown }[] } | undefined;
  if (value === undefined) return true;
  if (value.operation === "numeric") return (value.operands ?? []).every((operand) => operand.source !== "numeric");
  return ["join_text", "date_offset", "deadline_passed"].includes(String(value.operation));
};

/**
 * The typed settings one field type declares. `settings` is the field's current plain settings,
 * used only to keep a formula Studio does not edit (a condition or nested numbers) as it is.
 */
export const moduleFieldSettingDeclarations = (
  type: ModuleFieldType, context: ModuleFieldSettingsContext, settings: Readonly<Record<string, unknown>> = {},
): readonly Declaration[] => {
  switch (type) {
    case "text":
      return [number("max_length", "Longest value allowed", true, { minimum: 1, maximum: 100_000, help: "The number of characters a person may enter." }),
        choice("format", "Format", false, textFormats, "Leave empty for any text.")];
    case "long_text":
      return [number("max_length", "Longest value allowed", true, { minimum: 1, maximum: 1_000_000, help: "The number of characters a person may enter." })];
    case "formatted_text":
      return [list("allowed_blocks", "What the text may contain", true, 1, 6, choice("block", "Part", true, [["paragraph", "Paragraphs"],
        ["heading", "Headings"], ["list", "Lists"], ["table", "Tables"], ["link", "Links"], ["attachment", "Attachments"]])),
        number("max_length", "Longest visible text allowed", false, { minimum: 1 })];
    case "whole_number":
      return [number("minimum", "Smallest value", false), number("maximum", "Largest value", false),
        number("step", "Step", false, { minimum: 1, help: "Values go up in this step from the smallest value." })];
    case "decimal_number":
      return [number("digits_before_decimal", "Digits before the decimal point", true, { minimum: 1, maximum: 30 }),
        number("decimal_places", "Decimal places (precision)", true, { minimum: 0, maximum: 12 }),
        decimalText("minimum", "Smallest value"), decimalText("maximum", "Largest value")];
    case "money":
      return [choice("currency_mode", "Currency", true, currencyModes),
        text("currency", "Fixed currency", false, 3, 3, "Three capital letters, for example NZD. Only for one fixed currency."),
        decimalText("minimum", "Smallest amount"), decimalText("maximum", "Largest amount")];
    case "date":
      return [isoDate("earliest", "Earliest date"), isoDate("latest", "Latest date")];
    case "date_time":
      return [choice("display_time_zone", "Time zone shown", false, timeZones, "Leave empty for the person's own time zone.")];
    case "choice":
      return [list("options", "Options", true, 1, 200, optionItem(), "Add, rename and reorder the options people choose from.")];
    case "several_choices":
      return [list("options", "Options", true, 1, 200, optionItem(), "Add, rename and reorder the options people choose from."),
        number("maximum_selections", "Most options a person may choose", false, { minimum: 1, maximum: 200 })];
    case "reference_number":
      return [text("prefix", "Text before the number", false, 0, 20), text("suffix", "Text after the number", false, 0, 20),
        number("digits", "Digits", true, { minimum: 1, maximum: 20 }),
        number("starting_number", "First number", false, { minimum: 1 })];
    case "phone_number":
      return [text("default_country", "Default country", false, 2, 2, "Two capital letters, for example NZ.")];
    case "web_address":
      return [list("allowed_schemes", "Allowed kinds of address", false, 1, 1, choice("scheme", "Kind", true, [["https", "Secure (https)"]]))];
    case "table":
      return [number("minimum_rows", "Fewest rows", true, { minimum: 0 }), number("maximum_rows", "Most rows", true, { minimum: 1, maximum: 1_000 }),
        list("columns", "Columns", true, 1, 40, tableColumnItem())];
    case "link":
      return [{ ...base("target", "Linked record type", true), kind: "record_type_reference" },
        text("reverse_key", "Name of the link back", true, 1, 40, "Lowercase words separated by underscores, for example contacts."),
        choice("on_parent_delete", "When the linked record is deleted", true, deleteRules),
        boolean("application_root_required", "Only records of this application", false),
        choice("legacy_person_field", "Person field it mirrors", false, fieldChoices(context.fields, ["link_to_person"]))];
    case "link_to_one_of_several":
      return [list("targets", "Record types it may link to", true, 2, 20, { ...base("target", "Record type", true), kind: "record_type_reference" }),
        choice("on_parent_delete", "When the linked record is deleted", true, deleteRules)];
    case "link_to_person":
      return [choice("audience", "Who can be chosen", true, [["organization_accounts", "People in the organisation"],
        ["application_accounts", "People using this application"],
        ["organization_identities_and_external_requesters", "People in the organisation and outside requesters"]]),
        boolean("application_root_required", "Only people of this application", false),
        choice("on_person_deactivation", "When the person is deactivated", true, [["retain_reference", "Keep the link"],
          ["empty_optional", "Clear the link"], ["refuse_deactivation", "Refuse the deactivation"]])];
    case "calculation":
      return [choice("result_type", "Result", true, resultTypes),
        choice("evaluation", "When it is worked out", false, [["read_time", "Each time it is read"], ["stored", "When the record is saved"]]),
        number("decimal_places", "Decimal places of the result", false, { minimum: 0, maximum: 12, help: "Only for decimal and money results." }),
        ...(editableExpression(settings.expression) ? [expressionGroup(context)] : [])];
    case "total":
      return [{ ...base("relationship", "Related records", true), kind: "relationship_reference" },
        choice("operation", "Total", true, [["count", "Count"], ["sum", "Sum"], ["minimum", "Smallest"], ["maximum", "Largest"], ["average", "Average"]]),
        choice("result_type", "Result", true, resultTypes),
        choice("field", "Field of the related records", false, fieldChoices(context.relatedFields), "Every total except a count needs one."),
        text("currency", "Currency", false, 3, 3, "Only for a sum of money."),
        number("decimal_places", "Decimal places", false, { minimum: 0, maximum: 12, help: "Only for an average." })];
    case "attachment":
      return [list("allowed_kinds", "Kinds of file allowed", true, 1, 9, choice("kind", "Kind", true, [["image", "Images"], ["document", "Documents"],
        ["spreadsheet", "Spreadsheets"], ["presentation", "Presentations"], ["audio", "Audio"], ["video", "Video"],
        ["archive", "Archives"], ["text", "Text files"], ["other", "Other files"]])),
        list("allowed_extensions", "File endings allowed", false, 0, 50, text("extension", "Ending", true, 2, 20, "For example .pdf.")),
        number("max_file_size_mb", "Largest file (MB)", true, { integer: false, minimum: 0.001, maximum: 5_000 }),
        boolean("multiple", "Several files", false), number("max_files", "Most files", false, { minimum: 2, maximum: 100, help: "Only for several files." })];
    case "yes_no":
    case "email_address":
      return [];
  }
};

/** Why a setting the field holds is kept as it is rather than edited here, one line per setting. */
export const moduleFieldKeptSettings = (type: ModuleFieldType, settings: Readonly<Record<string, unknown>>): readonly string[] => [
  ...(type === "calculation" && !editableExpression(settings.expression)
    ? ["Its formula uses a condition or nested numbers. It is kept as it is; change it in the application source."] : []),
  ...(type === "total" && settings.filter !== undefined
    ? ["Its filter of the related records is kept as it is; change it in the application source."] : []),
];

const columnSettingKeys: Readonly<Record<string, readonly string[]>> = {
  text: ["max_length", "format"], whole_number: ["minimum", "maximum", "step"],
  decimal_number: ["digits_before_decimal", "decimal_places", "minimum_amount", "maximum_amount"],
  money: ["currency_mode", "currency", "minimum_amount", "maximum_amount"], yes_no: [], date: ["earliest", "latest"],
  date_time: ["display_time_zone"], choice: ["options"],
};
const amountKeys = (type: string) => type === "decimal_number" || type === "money";
/** A stored column as the one flat entry the column control edits. */
const flatColumn = (column: Record<string, unknown>): Record<string, unknown> => {
  const settings = (column.settings ?? {}) as Record<string, unknown>;
  const flat: Record<string, unknown> = { key: column.key, required: column.required, type: column.type };
  for (const [key, value] of Object.entries(settings))
    flat[amountKeys(String(column.type)) && (key === "minimum" || key === "maximum") ? `${key}_amount` : key] = value;
  return flat;
};
/** The flat column entry back as the column the contract stores: only its type's settings are kept. */
const storedColumn = (flat: Record<string, unknown>): Record<string, unknown> => {
  const type = String(flat.type);
  const settings: Record<string, unknown> = {};
  for (const key of columnSettingKeys[type] ?? [])
    if (flat[key] !== undefined) settings[key.endsWith("_amount") ? key.slice(0, -"_amount".length) : key] = flat[key];
  return { key: flat.key, required: flat.required === true, type, settings };
};
const expressionKeys: Readonly<Record<string, readonly string[]>> = {
  join_text: ["fields", "separator"], numeric: ["numeric_operation", "operands"],
  date_offset: ["date_field", "amount", "unit"], deadline_passed: ["due_field", "status_field", "terminal_status_values"],
};
const storedOperand = (operand: Record<string, unknown>): Record<string, unknown> =>
  operand.source === "literal" ? { source: "literal", value: operand.value } : { source: "field", field: operand.field };
const storedExpression = (flat: Record<string, unknown>): Record<string, unknown> => {
  const operation = String(flat.operation);
  const expression: Record<string, unknown> = { operation };
  for (const key of expressionKeys[operation] ?? []) if (flat[key] !== undefined) expression[key] = flat[key];
  if (operation === "join_text") expression.separator ??= "";
  if (operation === "deadline_passed") expression.terminal_status_values ??= [];
  if (operation === "numeric") expression.operands = ((expression.operands ?? []) as Record<string, unknown>[]).map(storedOperand);
  if (operation === "date_offset" && expression.amount !== undefined)
    expression.amount = storedOperand(expression.amount as Record<string, unknown>);
  return expression;
};

/** Where a field's current settings could not be read as typed settings, as located failures. */
export type ModuleFieldSettingsReading = Readonly<{ values: ModuleFieldTypedSettings; failures: readonly ComponentSettingFailure[] }>;

/** The field's plain settings as the typed values its declarations edit; a kept setting is left out. */
export const readModuleFieldSettings = (
  type: ModuleFieldType, settings: Readonly<Record<string, unknown>>, declarations: readonly Declaration[],
): ModuleFieldSettingsReading => {
  const failures: ComponentSettingFailure[] = [];
  const values: Record<string, Typed> = {};
  for (const declaration of declarations) {
    let plain = settings[declaration.key];
    if (plain === undefined) continue;
    if (type === "table" && declaration.key === "columns" && Array.isArray(plain))
      plain = plain.map((column) => flatColumn(column as Record<string, unknown>));
    const typed = typedSourceSettingValue(plain, declaration, [declaration.key], failures);
    if (typed !== undefined) values[declaration.key] = typed;
  }
  return { values, failures };
};

/**
 * The typed values as the plain settings the field contract stores. A setting the declarations do
 * not edit (a kept formula or filter) is carried over from `current` unchanged.
 */
export const writeModuleFieldSettings = (
  type: ModuleFieldType, values: ModuleFieldTypedSettings, declarations: readonly Declaration[],
  current: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const declared = new Set(declarations.map((declaration) => declaration.key));
  const settings: Record<string, unknown> = Object.fromEntries(Object.entries(current).filter(([key]) => !declared.has(key)));
  for (const [key, value] of Object.entries(values)) {
    if (!declared.has(key)) continue;
    let plain = plainSourceSettingValue(value);
    if (type === "table" && key === "columns") plain = (plain as Record<string, unknown>[]).map(storedColumn);
    if (type === "calculation" && key === "expression") plain = storedExpression(plain as Record<string, unknown>);
    settings[key] = plain;
  }
  return settings;
};

/** The settings a field of a type starts with when it is added or its type changes. */
export const starterModuleFieldSettings = (
  type: ModuleFieldType,
  start: Readonly<{ fieldKey: string; recordKey: string; recordTypes: readonly string[]; titleField: string;
    relationships: readonly string[] }>,
): Record<string, unknown> => {
  switch (type) {
    case "text": return { max_length: 255 };
    case "long_text": return { max_length: 10_000 };
    case "formatted_text": return { allowed_blocks: ["paragraph", "heading", "list", "link"] };
    case "decimal_number": return { digits_before_decimal: 12, decimal_places: 2 };
    case "money": return { currency_mode: "organization_default" };
    case "choice": return { options: [{ value: "option_1", label: "Option 1" }] };
    case "several_choices": return { options: [{ value: "option_1", label: "Option 1" }] };
    case "reference_number": return { digits: 6 };
    case "table": return { minimum_rows: 0, maximum_rows: 50, columns: [{ key: "item", required: true, type: "text", settings: { max_length: 255 } }] };
    case "link": return { ...(start.recordTypes[0] === undefined ? {} : { target: start.recordTypes[0] }),
      reverse_key: `${start.recordKey}_${start.fieldKey}`.slice(0, 40).replace(/_+$/u, ""), on_parent_delete: "empty_optional" };
    case "link_to_one_of_several": return { targets: start.recordTypes.slice(0, 2), on_parent_delete: "empty_optional" };
    case "link_to_person": return { audience: "organization_accounts", application_root_required: false, on_person_deactivation: "retain_reference" };
    case "calculation": return { result_type: "text", expression: { operation: "join_text", fields: [start.titleField], separator: " " } };
    case "total": return { ...(start.relationships[0] === undefined ? {} : { relationship: start.relationships[0] }),
      operation: "count", result_type: "whole_number" };
    case "attachment": return { allowed_kinds: ["document", "image"], max_file_size_mb: 10, multiple: false };
    default: return {};
  }
};

/** Field types whose value is produced by the platform or held elsewhere, so they take no default. */
const noDefault: ReadonlySet<string> = new Set(["reference_number", "calculation", "total", "attachment", "table",
  "formatted_text", "link_to_person"]);

/** The one typed declaration of a field's default value, or why a default is not set here. */
export const moduleFieldDefaultDeclaration = (
  type: ModuleFieldType, settings: Readonly<Record<string, unknown>>,
): Readonly<{ kind: "declared"; declaration: Declaration }> | Readonly<{ kind: "none"; reason: string }> => {
  const label = "Default value";
  const help = "Filled in for a new record. Leave empty for no default.";
  if (noDefault.has(type))
    return { kind: "none", reason: type === "reference_number" || type === "calculation" || type === "total"
      ? "The platform works out this field's value, so it has no default."
      : "A default for this type is not set in Studio; one already in the source is kept." };
  const options = ((settings.options ?? []) as { value: string; label: string }[]).map((option) => [option.value, option.label] as const);
  switch (type) {
    case "text": case "long_text": case "email_address": case "phone_number": case "decimal_number": case "money":
    case "date_time":
      return { kind: "declared", declaration: text("default", label, false, 1, Math.max(1, Number(settings.max_length ?? 1_000_000)), help) };
    case "date": return { kind: "declared", declaration: isoDate("default", label) };
    case "web_address": return { kind: "declared", declaration: { ...base("default", label, false, help), kind: "url" } };
    case "whole_number": return { kind: "declared", declaration: number("default", label, false, { help }) };
    case "yes_no": return { kind: "declared", declaration: choice("default", label, false, [["yes", "Yes"], ["no", "No"]], help) };
    case "choice": return { kind: "declared", declaration: choice("default", label, false, options, help) };
    case "several_choices":
      return { kind: "declared", declaration: list("default", label, false, 0, 200, choice("choice", "Choice", true, options), help) };
    case "link":
      return settings.target === undefined ? { kind: "none", reason: "Choose the linked record type first." }
        : { kind: "declared", declaration: { ...base("default", label, false, help), kind: "record_reference" } };
    default: return { kind: "none", reason: "A default for this type is not set in Studio." };
  }
};

/** A stored default as the typed value its declaration edits. */
export const readModuleFieldDefault = (type: ModuleFieldType, value: unknown, declaration: Declaration): Typed | undefined => {
  if (value === undefined) return undefined;
  if (type === "yes_no") return { kind: "choice", value: value === true ? "yes" : "no" };
  return typedSourceSettingValue(value, declaration, ["default"], []);
};

/** A typed default as the value the field contract stores. */
export const writeModuleFieldDefault = (type: ModuleFieldType, value: Typed | undefined): unknown => {
  if (value === undefined) return undefined;
  if (type === "yes_no") return value.kind === "choice" && value.value === "yes";
  return plainSourceSettingValue(value);
};
