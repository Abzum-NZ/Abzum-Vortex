import { z } from "zod";

export const fieldTypeKeys = [
  "text",
  "long_text",
  "formatted_text",
  "whole_number",
  "decimal_number",
  "money",
  "yes_no",
  "date",
  "date_time",
  "choice",
  "several_choices",
  "reference_number",
  "email_address",
  "phone_number",
  "web_address",
  "table",
  "link",
  "link_to_one_of_several",
  "calculation",
  "total",
  "attachment",
] as const;

/**
 * Flow-only value types: the references, bounded lists, file, run and JSON values that a field
 * does not itself have. Together with `fieldTypeKeys` these form the one Vortex value-type
 * catalogue.
 */
export const flowOnlyValueTypeKeys = [
  "record_reference",
  "record_reference_list",
  "organization_account_reference",
  "workflow_run_reference",
  "relationship_reference",
  "relationship_reference_list",
  "file_reference",
  "json",
] as const;

/**
 * The one value-type catalogue. Every field, flow, action-input, sharing-parameter and rule-graph
 * type list is a view of this list, and `valueTypesCompatible` is the one type-compatibility
 * function.
 */
export const valueTypeKeys = [...fieldTypeKeys, ...flowOnlyValueTypeKeys] as const;
export const valueTypeSchema = z.enum(valueTypeKeys);
export type ValueType = z.infer<typeof valueTypeSchema>;

/** Flow value types: the view of the catalogue used by flow inputs, variables and task outputs. */
export const workflowValueTypeKeys = [
  "text",
  "formatted_text",
  "whole_number",
  "decimal_number",
  "money",
  "yes_no",
  "date",
  "date_time",
  "choice",
  "several_choices",
  "record_reference",
  "record_reference_list",
  "organization_account_reference",
  "workflow_run_reference",
  "relationship_reference",
  "relationship_reference_list",
  "file_reference",
  "json",
] as const satisfies readonly ValueType[];

/** Action-input value types: the view of the catalogue shared by application and module contracts. */
export const actionInputValueTypes = {
  text: "text",
  formatted_text: "formatted_text",
  whole_number: "whole_number",
  decimal_number: "decimal_number",
  money: "money",
  yes_no: "yes_no",
  date: "date",
  date_time: "date_time",
  record_reference: "record_reference",
  organization_account_reference: "organization_account_reference",
} as const satisfies Record<string, ValueType>;

/** Sharing-parameter value types accepted by the current condition contract. */
export const sharingParameterValueTypeKeys = [
  "record_reference",
  "text",
  "whole_number",
  "yes_no",
  "date",
  "date_time",
  "organization_account_reference",
  "decimal_number",
  "money",
] as const satisfies readonly ValueType[];
export const sharingParameterValueTypeSchema = z.enum(sharingParameterValueTypeKeys);

export const blockPaletteGroupKeys = [
  "data",
  "figures",
  "record",
  "input",
  "actions",
  "layout",
  "content",
] as const;

export const fieldTypeSchema = z.enum(fieldTypeKeys);
/**
 * The fixed application experience states. A page refused and a page missing share `not_found`,
 * so their surfaces stay indistinguishable and never reveal why an address is unavailable.
 */
export const applicationExperienceStateKeys = ["not_found", "unavailable", "error"] as const;
export const applicationExperienceStateSchema = z.enum(applicationExperienceStateKeys);
export const blockPaletteGroupSchema = z.enum(blockPaletteGroupKeys);

export const workflowValueTypeSchema = z.enum(workflowValueTypeKeys);
export const personalDataClassSchema = z.enum(["none", "personal", "sensitive"]);
export const publicDisplaySchema = z.enum(["refused", "allowed"]);
export const searchPrioritySchema = z.enum(["first", "normal", "last"]);

export type FieldType = z.infer<typeof fieldTypeSchema>;
export type BlockPaletteGroup = z.infer<typeof blockPaletteGroupSchema>;
export type PersonalDataClass = z.infer<typeof personalDataClassSchema>;
export type SearchPriority = z.infer<typeof searchPrioritySchema>;

export type ValueTypeCompatibilityContext =
  "value" | "flow" | "exact" | "condition" | "mapping" | "cross_format";

const numericValueTypes: ReadonlySet<string> = new Set(["whole_number", "decimal_number"]);
const crossFormatValueTypes: ReadonlySet<string> = new Set([
  "text",
  "whole_number",
  "yes_no",
  "date",
  "date_time",
]);

/**
 * The one value-type compatibility function. The context selects the exact rule set the
 * caller needs; every rule is a view of the one value-type catalogue above.
 */
export function valueTypesCompatible(
  actual: string | undefined,
  expected: string | undefined,
  context: ValueTypeCompatibilityContext = "value",
): boolean {
  if (!valueTypeSchema.safeParse(actual).success || !valueTypeSchema.safeParse(expected).success)
    return false;
  if (actual === undefined || expected === undefined) return false;
  switch (context) {
    case "condition":
      return (
        actual === expected || (numericValueTypes.has(actual) && numericValueTypes.has(expected))
      );
    case "mapping":
      if (
        actual === "decimal_number" ||
        actual === "money" ||
        expected === "decimal_number" ||
        expected === "money"
      )
        return actual === expected;
      return valueTypesCompatible(actual, expected, "exact");
    case "exact":
      return (
        actual === expected ||
        (expected === "text" && (actual === "date" || actual === "date_time"))
      );
    case "cross_format":
      return actual === expected && crossFormatValueTypes.has(actual);
    case "flow":
      return (
        actual === expected ||
        (expected === "record_reference" && actual === "organization_account_reference") ||
        expected === "json"
      );
    case "value":
      return (
        actual === expected ||
        (expected === "text" && (actual === "date" || actual === "date_time")) ||
        (expected === "record_reference" && actual === "organization_account_reference") ||
        expected === "json"
      );
  }
  return false;
}
