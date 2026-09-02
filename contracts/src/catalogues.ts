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

export const pageTypeKeys = [
  "list",
  "detail",
  "dashboard",
  "form",
  "guided_form",
  "public",
] as const;
export const listArrangementKeys = ["table", "board", "calendar", "summary"] as const;
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
export const listArrangementSchema = z.enum(listArrangementKeys);
export const blockPaletteGroupSchema = z.enum(blockPaletteGroupKeys);
export const blockSettingControlSchema = z.enum(blockSettingControlKeys);
export const workflowNodeTypeSchema = z.enum(workflowNodeTypeKeys);

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
  request_form: ["response"],
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
export const pageStateSchema = z.enum([
  "normal",
  "loading",
  "empty",
  "not_found",
  "validation",
  "refused",
  "access_ended",
  "conflict",
  "failure",
  "recovery",
]);
export const personalDataClassSchema = z.enum(["none", "personal", "sensitive"]);
export const publicDisplaySchema = z.enum(["refused", "allowed"]);
export const searchPrioritySchema = z.enum(["first", "normal", "last"]);

export type FieldType = z.infer<typeof fieldTypeSchema>;
export type PageType = z.infer<typeof pageTypeSchema>;
export type ListArrangement = z.infer<typeof listArrangementSchema>;
export type BlockPaletteGroup = z.infer<typeof blockPaletteGroupSchema>;
export type BlockSettingControl = z.infer<typeof blockSettingControlSchema>;
export type WorkflowNodeType = z.infer<typeof workflowNodeTypeSchema>;
export type LifecycleState = z.infer<typeof lifecycleStateSchema>;
export type PageState = z.infer<typeof pageStateSchema>;
export type PersonalDataClass = z.infer<typeof personalDataClassSchema>;
export type PublicDisplay = z.infer<typeof publicDisplaySchema>;
export type SearchPriority = z.infer<typeof searchPrioritySchema>;
