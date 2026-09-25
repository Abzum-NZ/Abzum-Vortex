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
  "link_to_person",
  "calculation",
  "total",
  "attachment",
] as const;

/**
 * Flow-only value types: the references, bounded lists, file, run and JSON values that a field
 * does not itself have. Together with `fieldTypeKeys` these form the one Vortex value-type
 * catalogue (#982).
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
 * function. `number` and `boolean` are the action-input and sharing-parameter spellings of a
 * number and a yes/no value.
 */
export const valueTypeKeys = [
  ...fieldTypeKeys,
  ...flowOnlyValueTypeKeys,
  "number",
  "boolean",
] as const;
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

/** Action-input value types: the view of the catalogue shared by the V1 and V2 module contracts. */
export const actionInputValueTypes = {
  text: "text",
  formatted_text: "formatted_text",
  number: "number",
  decimal_number: "decimal_number",
  money: "money",
  boolean: "boolean",
  date: "date",
  date_time: "date_time",
  record_reference: "record_reference",
  organization_account_reference: "organization_account_reference",
} as const satisfies Record<string, ValueType>;
export type ActionInputValueType =
  (typeof actionInputValueTypes)[keyof typeof actionInputValueTypes];
export const actionInputValueTypeKeys = Object.values(actionInputValueTypes) as readonly [
  ActionInputValueType,
  ...ActionInputValueType[],
];
export const actionInputValueTypeSchema = z.enum(actionInputValueTypeKeys);

/**
 * Sharing-parameter value types: the view of the catalogue used by V1 saved sharing conditions.
 * The V1 typed-condition evaluator refuses any other parameter type, so this view stays exact.
 */
export const sharingParameterValueTypeKeys = [
  "text",
  "number",
  "boolean",
  "date",
  "date_time",
  "organization_account_reference",
] as const satisfies readonly ValueType[];
export const sharingParameterValueTypeSchema = z.enum(sharingParameterValueTypeKeys);

/** V2 sharing-parameter value types: the V1 view plus the exact decimal_number and money types. */
export const sharingParameterValueTypeV2Keys = [
  ...sharingParameterValueTypeKeys,
  "decimal_number",
  "money",
] as const satisfies readonly ValueType[];
export const sharingParameterValueTypeV2Schema = z.enum(sharingParameterValueTypeV2Keys);

export const pageTypeKeys = [
  "list",
  "detail",
  "dashboard",
  "form",
  "guided_form",
  "public",
] as const;
export const blockPaletteGroupKeys = [
  "data",
  "figures",
  "record",
  "input",
  "actions",
  "layout",
  "content",
] as const;
export const blockSettingControlKeys = [
  "text",
  "long_text",
  "formatted_text",
  "number",
  "switch",
  "choice",
  "theme_colour",
  "platform_icon",
  "stored_image",
  "data_reading",
  "record_type_picker",
  "record_picker",
  "field_picker",
  "relationship_picker",
  "action_picker",
  "page_picker",
  "process_pipeline_picker",
] as const;

export const workflowNodeTypeKeys = [
  "start",
  "condition",
  "decision_table",
  "bounded_loop",
  "delay",
  "wait_until",
  "start_workflow",
  "stop",
  "create_record",
  "change_record",
  "run_action",
  "soft_delete_record",
  "duplicate_record",
  "add_relationship",
  "copy_relationships",
  "request_form",
  "query_records",
  "set_values",
  "format_value",
  "generate_export",
  "attach_file",
  "move_file",
  "call_connection",
  "acknowledge_message",
] as const;

export const fieldTypeSchema = z.enum(fieldTypeKeys);
export const pageTypeSchema = z.enum(pageTypeKeys);
export const blockPaletteGroupSchema = z.enum(blockPaletteGroupKeys);
export const blockSettingControlSchema = z.enum(blockSettingControlKeys);
export const workflowNodeTypeSchema = z.enum(workflowNodeTypeKeys);

export const workflowValueTypeSchema = z.enum(workflowValueTypeKeys);
export const workflowNodeOutputsByType = Object.freeze({
  start: [],
  condition: [{ key: "matched", type: "yes_no", target: "none" }],
  decision_table: [{ key: "decision", type: "text", target: "none" }],
  bounded_loop: [{ key: "record", type: "record_reference", target: "query" }],
  delay: [],
  wait_until: [],
  start_workflow: [{ key: "run", type: "workflow_run_reference", target: "none" }],
  stop: [],
  create_record: [{ key: "record", type: "record_reference", target: "configured_record" }],
  change_record: [{ key: "record", type: "record_reference", target: "configured_record" }],
  run_action: [{ key: "result", type: "json", target: "none" }],
  soft_delete_record: [],
  duplicate_record: [{ key: "record", type: "record_reference", target: "configured_record" }],
  add_relationship: [{ key: "relationship", type: "relationship_reference", target: "none" }],
  copy_relationships: [
    { key: "relationships", type: "relationship_reference_list", target: "none" },
  ],
  request_form: [],
  query_records: [{ key: "records", type: "record_reference_list", target: "query" }],
  set_values: [{ key: "record", type: "record_reference", target: "input_record" }],
  format_value: [{ key: "value", type: "json", target: "none" }],
  generate_export: [{ key: "file", type: "file_reference", target: "none" }],
  attach_file: [{ key: "attachment", type: "file_reference", target: "none" }],
  move_file: [{ key: "file", type: "file_reference", target: "none" }],
  call_connection: [{ key: "response", type: "json", target: "none" }],
  acknowledge_message: [],
} as const satisfies Record<
  (typeof workflowNodeTypeKeys)[number],
  readonly {
    key: string;
    type: z.infer<typeof workflowValueTypeSchema>;
    target: "none" | "query" | "configured_record" | "input_record";
  }[]
>);
export const workflowNodeOutputKeysByType = Object.freeze({
  start: [],
  condition: ["matched"],
  decision_table: ["decision"],
  bounded_loop: ["record"],
  delay: [],
  wait_until: [],
  start_workflow: ["run"],
  stop: [],
  create_record: ["record"],
  change_record: ["record"],
  run_action: ["result"],
  soft_delete_record: [],
  duplicate_record: ["record"],
  add_relationship: ["relationship"],
  copy_relationships: ["relationships"],
  request_form: [],
  query_records: ["records"],
  set_values: ["record"],
  format_value: ["value"],
  generate_export: ["file"],
  attach_file: ["attachment"],
  move_file: ["file"],
  call_connection: ["response"],
  acknowledge_message: [],
} as const satisfies Record<(typeof workflowNodeTypeKeys)[number], readonly string[]>);
export const lifecycleStateSchema = z.enum(["active", "soft_deleted", "removal_pending"]);
export const personalDataClassSchema = z.enum(["none", "personal", "sensitive"]);
export const publicDisplaySchema = z.enum(["refused", "allowed"]);
export const searchPrioritySchema = z.enum(["first", "normal", "last"]);

export type FieldType = z.infer<typeof fieldTypeSchema>;
export type PageType = z.infer<typeof pageTypeSchema>;
export type BlockPaletteGroup = z.infer<typeof blockPaletteGroupSchema>;
export type BlockSettingControl = z.infer<typeof blockSettingControlSchema>;
export type WorkflowNodeType = z.infer<typeof workflowNodeTypeSchema>;
export type LifecycleState = z.infer<typeof lifecycleStateSchema>;
export type PersonalDataClass = z.infer<typeof personalDataClassSchema>;
export type PublicDisplay = z.infer<typeof publicDisplaySchema>;
export type SearchPriority = z.infer<typeof searchPrioritySchema>;

/** The semantic spelling of a flow value type, shared by every flow compatibility check (#982). */
export function canonicalWorkflowValueType(type: string): string {
  return ["whole_number", "decimal_number", "money"].includes(type)
    ? "number"
    : type === "yes_no"
      ? "boolean"
      : ["choice", "formatted_text"].includes(type)
        ? "text"
        : type === "several_choices"
          ? "json"
          : type;
}

export type ValueTypeCompatibilityContext =
  | "value"
  | "flow"
  | "exact"
  | "condition"
  | "mapping"
  | "cross_format";

const numericValueTypes: ReadonlySet<string> = new Set([
  "number",
  "whole_number",
  "decimal_number",
]);
const crossFormatValueTypes: ReadonlySet<string> = new Set([
  "text",
  "number",
  "boolean",
  "date",
  "date_time",
]);

/**
 * The one value-type compatibility function (#982). The context selects the exact rule set the
 * caller needs; every rule is a view of the one value-type catalogue above.
 */
export function valueTypesCompatible(
  actual: string | undefined,
  expected: string | undefined,
  context: ValueTypeCompatibilityContext = "value",
): boolean {
  if (actual === undefined || expected === undefined) return false;
  switch (context) {
    case "condition":
      return actual === expected || (numericValueTypes.has(actual) && numericValueTypes.has(expected));
    case "mapping":
      if (
        actual === "decimal_number" ||
        actual === "money" ||
        expected === "decimal_number" ||
        expected === "money"
      )
        return actual === expected;
      if (
        (actual === "number" || actual === "whole_number") &&
        (expected === "number" || expected === "whole_number")
      )
        return true;
      return valueTypesCompatible(actual, expected, "exact");
    case "exact":
      return (
        actual === expected || (expected === "text" && (actual === "date" || actual === "date_time"))
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
