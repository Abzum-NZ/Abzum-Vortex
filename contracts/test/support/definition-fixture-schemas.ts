import { z } from "zod";
import {
  fieldTypeKeys,
  listArrangementKeys,
  pageStateSchema,
  personalDataClassSchema,
  publicDisplaySchema,
  searchPrioritySchema,
  workflowNodeTypeKeys,
} from "../../src/catalogues";
import {
  builderKeySchema,
  namespacedKeySchema,
  revisionSchema,
  semanticVersionSchema,
} from "../../src/identifiers";
import { jsonValueSchema } from "../../src/common";

/** Portable aliases exist only in authored definitions. #15 resolves them to platform identifiers. */
export const sourceAliasSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z][a-z0-9_]*$/);
const fixtureAliasSchema = sourceAliasSchema;
export const sourceQualifiedRecordTypeSchema = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[a-z][a-z0-9_.]*:[a-z][a-z0-9_]*$/);
const fixtureQualifiedRecordTypeSchema = sourceQualifiedRecordTypeSchema;
export const sourceQualifiedFieldSchema = z
  .string()
  .min(5)
  .max(250)
  .regex(/^[a-z][a-z0-9_.]*:[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
const sourceFingerprintSchema = z.string().min(8).max(250).regex(/^\S+$/);
const sourceOptionSchema = z
  .object({ value: z.string().min(1).max(120), label: z.string().min(1).max(60) })
  .strict();
const sourceFieldBase = {
  id: fixtureAliasSchema,
  key: builderKeySchema,
  label: z.string().min(1).max(60),
  required: z.boolean(),
  unique: z.boolean(),
  filterable: z.boolean(),
  sortable: z.boolean(),
  search_priority: searchPrioritySchema.optional(),
  personal_data: personalDataClassSchema,
  public_display: publicDisplaySchema,
};
const sourceField = <K extends string, S extends z.ZodType>(type: K, settings: S) =>
  z.object({ ...sourceFieldBase, type: z.literal(type), settings }).strict();
const numberRange = {
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional(),
  default: z.number().finite().optional(),
};
const empty = z.object({}).strict();
const sourceAttachmentSettingsSchema = z
  .object({
    allowed_kinds: z
      .array(
        z.enum([
          "image",
          "document",
          "spreadsheet",
          "presentation",
          "audio",
          "video",
          "archive",
          "text",
          "other",
        ]),
      )
      .min(1),
    allowed_extensions: z
      .array(z.string().regex(/^\.[a-z0-9]+$/))
      .min(1)
      .optional(),
    max_file_size_mb: z.number().positive().max(5_000),
    multiple: z.boolean(),
    max_files: z.number().int().min(2).max(100).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.multiple !== (value.max_files !== undefined))
      context.addIssue({
        code: "custom",
        path: ["max_files"],
        message: "max_files is required only for multiple attachments",
      });
  });
const sourceCalculationExpressionSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("subtract_percentage"),
      amount_field: builderKeySchema,
      percentage_field: builderKeySchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("join_text"),
      fields: z.array(builderKeySchema).min(1),
      separator: z.string().max(20),
    })
    .strict(),
  z
    .object({
      operation: z.literal("after_due_date"),
      status_field: builderKeySchema,
      due_field: builderKeySchema,
    })
    .strict(),
]);
const sourceFieldMembers = [
  sourceField("text", z.object({ max_length: z.number().int().positive() }).strict()),
  sourceField("long_text", z.object({ max_length: z.number().int().positive() }).strict()),
  sourceField(
    "formatted_text",
    z.object({ allowed_blocks: z.array(builderKeySchema).min(1) }).strict(),
  ),
  sourceField("whole_number", z.object(numberRange).strict()),
  sourceField(
    "decimal_number",
    z.object({ ...numberRange, decimal_places: z.number().int().min(0).max(12) }).strict(),
  ),
  sourceField(
    "money",
    z
      .object({
        currency_mode: z.literal("organisation_default"),
        minimum: z.number().finite().optional(),
        maximum: z.number().finite().optional(),
      })
      .strict(),
  ),
  sourceField("yes_no", z.object({ default: z.boolean().optional() }).strict()),
  sourceField("date", empty),
  sourceField("date_time", z.object({ default: z.literal("now").optional() }).strict()),
  sourceField(
    "choice",
    z
      .object({ options: z.array(sourceOptionSchema).min(1), default: builderKeySchema.optional() })
      .strict(),
  ),
  sourceField(
    "several_choices",
    z
      .object({
        options: z.array(sourceOptionSchema).min(1),
        maximum_selections: z.number().int().positive().optional(),
      })
      .strict(),
  ),
  sourceField(
    "reference_number",
    z
      .object({
        prefix: z.string().max(20).optional(),
        suffix: z.string().max(20).optional(),
        digits: z.number().int().positive(),
        starting_number: z.number().int().positive().optional(),
      })
      .strict(),
  ),
  sourceField("email_address", empty),
  sourceField(
    "phone_number",
    z.object({ default_country: z.string().length(2).optional() }).strict(),
  ),
  sourceField(
    "web_address",
    z.object({ allowed_schemes: z.array(z.literal("https")).min(1) }).strict(),
  ),
  sourceField(
    "table",
    z
      .object({
        minimum_rows: z.number().int().min(0),
        maximum_rows: z.number().int().positive(),
        columns: z
          .array(
            z
              .object({
                key: builderKeySchema,
                type: z.enum([
                  "text",
                  "whole_number",
                  "decimal_number",
                  "money",
                  "yes_no",
                  "date",
                  "date_time",
                  "choice",
                ]),
                required: z.boolean(),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
  ),
  sourceField(
    "link",
    z
      .object({
        target: fixtureQualifiedRecordTypeSchema,
        reverse_key: builderKeySchema,
        on_parent_delete: z.enum(["refuse", "empty_optional", "soft_delete_dependent"]),
      })
      .strict(),
  ),
  sourceField(
    "link_to_one_of_several",
    z
      .object({
        targets: z.array(fixtureQualifiedRecordTypeSchema).min(1),
        on_parent_delete: z.enum(["refuse", "empty_optional", "soft_delete_dependent"]),
      })
      .strict(),
  ),
  sourceField(
    "link_to_person",
    z
      .object({
        audience: z.enum([
          "organisation_accounts",
          "application_accounts",
          "organisation_identities_and_external_requesters",
        ]),
        on_person_deactivation: z.enum(["retain_reference", "clear_reference"]),
      })
      .strict(),
  ),
  sourceField(
    "calculation",
    z
      .object({
        result_type: z.enum([
          "text",
          "whole_number",
          "decimal_number",
          "money",
          "yes_no",
          "date",
          "date_time",
        ]),
        expression: sourceCalculationExpressionSchema,
      })
      .strict(),
  ),
  sourceField(
    "total",
    z
      .object({
        relationship: builderKeySchema,
        operation: z.enum(["count", "sum", "minimum", "maximum", "average"]),
        field: builderKeySchema.optional(),
      })
      .strict(),
  ),
  sourceField("attachment", sourceAttachmentSettingsSchema),
] as const;
export const moduleSourceFieldSchema = z.discriminatedUnion("type", sourceFieldMembers);
const moduleFixtureFieldSchema = moduleSourceFieldSchema;

const moduleFixtureRecordTypeSchema = z
  .object({
    id: fixtureAliasSchema,
    key: builderKeySchema,
    name: z.string().min(1).max(60),
    plural_name: z.string().min(1).max(60),
    description: z.string().min(1).max(1_000),
    title_field: builderKeySchema,
    storage_contract_id: fixtureAliasSchema,
    storage_scope: z.enum(["organisation_shared", "application_contained"]),
    ownership_mode: z.enum(["none", "individual", "team", "inherited"]),
    ownership_relationship: builderKeySchema.optional(),
    standard_actions: z
      .array(z.enum(["create", "read", "update", "soft_delete", "restore", "export"]))
      .min(1),
    fields: z.array(moduleFixtureFieldSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.ownership_mode === "inherited") !== (value.ownership_relationship !== undefined))
      context.addIssue({
        code: "custom",
        path: ["ownership_relationship"],
        message: "Inherited ownership requires exactly one source relationship",
      });
    if (
      value.ownership_relationship !== undefined &&
      !value.fields.some(
        (field) =>
          field.key === value.ownership_relationship &&
          (field.type === "link" || field.type === "link_to_one_of_several"),
      )
    )
      context.addIssue({
        code: "custom",
        path: ["ownership_relationship"],
        message: "The ownership relationship must resolve to a link field on this record type",
      });
  });
const actionScalarInputTypes = fieldTypeKeys.filter(
  (type) => type !== "link" && type !== "link_to_one_of_several",
) as Exclude<(typeof fieldTypeKeys)[number], "link" | "link_to_one_of_several">[];
const actionInputSchema = z.discriminatedUnion("type", [
  z
    .object({
      key: builderKeySchema,
      type: z.enum(
        actionScalarInputTypes as [
          (typeof actionScalarInputTypes)[number],
          ...typeof actionScalarInputTypes,
        ],
      ),
      required: z.boolean(),
    })
    .strict(),
  z
    .object({
      key: builderKeySchema,
      type: z.literal("link"),
      required: z.boolean(),
      settings: z.object({ target: fixtureQualifiedRecordTypeSchema }).strict(),
    })
    .strict(),
  z
    .object({
      key: builderKeySchema,
      type: z.literal("link_to_one_of_several"),
      required: z.boolean(),
      settings: z.object({ targets: z.array(fixtureQualifiedRecordTypeSchema).min(1) }).strict(),
    })
    .strict(),
]);
const sourceComparisonSchema = z.union([
  z.object({ field: builderKeySchema, operator: z.enum(["is_empty", "is_not_empty"]) }).strict(),
  z
    .object({
      field: builderKeySchema,
      operator: z.enum([
        "equals",
        "not_equals",
        "contains",
        "not_contains",
        "in",
        "not_in",
        "greater_than",
        "greater_than_or_equal",
        "less_than",
        "less_than_or_equal",
      ]),
      value: jsonValueSchema,
    })
    .strict(),
]);
type SourceCondition =
  | z.infer<typeof sourceComparisonSchema>
  | { all: SourceCondition[] }
  | { any: SourceCondition[] }
  | { not: SourceCondition };
const sourceConditionSchema: z.ZodType<SourceCondition> = z.lazy(() =>
  z.union([
    sourceComparisonSchema,
    z.object({ all: z.array(sourceConditionSchema).min(1).max(50) }).strict(),
    z.object({ any: z.array(sourceConditionSchema).min(1).max(50) }).strict(),
    z.object({ not: sourceConditionSchema }).strict(),
  ]),
);
const sourceActionValueSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("literal"), value: jsonValueSchema }).strict(),
  z.object({ source: z.literal("input"), input: builderKeySchema }).strict(),
  z.object({ source: z.literal("subject_field"), field: builderKeySchema }).strict(),
  z.object({ source: z.literal("subject_record") }).strict(),
  z.object({ source: z.literal("current_actor") }).strict(),
  z.object({ source: z.literal("current_time") }).strict(),
]);
const sourceActionEffectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("set_field"),
      field: builderKeySchema,
      value: sourceActionValueSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("create_record"),
      record_type: fixtureQualifiedRecordTypeSchema,
      values: z.record(builderKeySchema, sourceActionValueSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("copy_relationships"),
      relationships: z.array(builderKeySchema).min(1),
      target_input: builderKeySchema,
    })
    .strict(),
  z.object({ kind: z.literal("soft_delete_subject") }).strict(),
  z.object({ kind: z.literal("announce_event"), event: namespacedKeySchema }).strict(),
]);
const sourceRuleEffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("refuse"), reason_code: builderKeySchema }).strict(),
  z
    .object({ kind: z.literal("set_value"), field: builderKeySchema, value: jsonValueSchema })
    .strict(),
  z.object({ kind: z.literal("require"), field: builderKeySchema }).strict(),
  z
    .object({
      kind: z.literal("show_or_hide"),
      component: fixtureAliasSchema,
      visibility: z.enum(["show", "hide"]),
    })
    .strict(),
  z.object({ kind: z.literal("warn"), message: builderKeySchema }).strict(),
  z.object({ kind: z.literal("start_background_work"), workflow: builderKeySchema }).strict(),
]);
const moduleFixtureBodySchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(1_000),
    category: z.string().min(1).max(120),
    dependencies: z.array(
      z.object({ module: namespacedKeySchema, version: semanticVersionSchema }).strict(),
    ),
    record_types: z.array(moduleFixtureRecordTypeSchema).min(1),
    permissions: z.array(
      z
        .object({
          key: namespacedKeySchema,
          label: z.string().min(1).max(120),
          record_type: builderKeySchema,
        })
        .strict(),
    ),
    actions: z.array(
      z
        .object({
          id: fixtureAliasSchema,
          key: namespacedKeySchema,
          label: z.string().min(1).max(120),
          record_type: builderKeySchema,
          permission: namespacedKeySchema,
          shareable: z.boolean(),
          inputs: z.array(actionInputSchema),
          precondition: sourceConditionSchema.optional(),
          effects: z.array(sourceActionEffectSchema).min(1).max(10),
        })
        .strict(),
    ),
    events: z.array(
      z
        .object({
          id: fixtureAliasSchema,
          key: namespacedKeySchema,
          record_type: builderKeySchema,
          carries: z.array(builderKeySchema),
        })
        .strict(),
    ),
    rules: z.array(
      z
        .object({
          id: fixtureAliasSchema,
          key: builderKeySchema,
          record_type: builderKeySchema,
          trigger: z.enum(["create", "change", "delete", "form_change", "action"]),
          priority: z.number().int().min(0).max(10_000),
          condition: sourceConditionSchema,
          effect: sourceRuleEffectSchema,
        })
        .strict(),
    ),
    extension_points: z.array(
      z
        .object({
          id: fixtureAliasSchema,
          key: builderKeySchema,
          record_type: builderKeySchema,
          accepts: z.array(z.enum(["field", "action", "choice_option", "link_target"])).min(1),
        })
        .strict(),
    ),
  })
  .strict();

const publishedSourceBase = {
  schema_version: semanticVersionSchema,
  root_id: fixtureAliasSchema,
  key: namespacedKeySchema,
  version: semanticVersionSchema,
  revision: revisionSchema,
  state: z.literal("published"),
  content_fingerprint: sourceFingerprintSchema,
};
export const moduleSourceDocumentSchema = z
  .object({ ...publishedSourceBase, kind: z.literal("module"), body: moduleFixtureBodySchema })
  .strict();

const sourceFilterSchema = z.union([z.null(), sourceConditionSchema]);
const sourceCalendarMappingSchema = z.union([
  z.object({ start: builderKeySchema, end: builderKeySchema }).strict(),
  z
    .object({
      start: builderKeySchema,
      duration_field: builderKeySchema,
      duration_unit: z.enum(["minutes", "hours", "days"]),
    })
    .strict(),
]);
const sourceDashboardLayoutSchema = z
  .object({
    desktop: z
      .array(
        z
          .object({
            block: builderKeySchema,
            span: z.number().int().min(1).max(12),
            query: builderKeySchema,
          })
          .strict(),
      )
      .min(1)
      .max(200),
    phone: z.array(builderKeySchema).min(1).max(200),
  })
  .strict();
type SourceNavigation =
  | { id: string; type: "heading"; label: string; children: SourceNavigation[] }
  | { id: string; type: "page"; label: string; page: string; permission: string };
const sourceNavigationSchema: z.ZodType<SourceNavigation> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z
      .object({
        id: fixtureAliasSchema,
        type: z.literal("heading"),
        label: z.string().min(1),
        children: z.array(sourceNavigationSchema).min(1),
      })
      .strict(),
    z
      .object({
        id: fixtureAliasSchema,
        type: z.literal("page"),
        label: z.string().min(1),
        page: builderKeySchema,
        permission: namespacedKeySchema,
      })
      .strict(),
  ]),
);
const sourcePageBase = {
  id: fixtureAliasSchema,
  key: builderKeySchema,
  name: z.string().min(1).max(120),
  states: z.array(pageStateSchema).min(1),
};
const sourcePageSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...sourcePageBase,
      type: z.literal("list"),
      record_type: fixtureQualifiedRecordTypeSchema,
      permission: namespacedKeySchema,
      query: builderKeySchema,
      arrangements: z.array(z.enum(listArrangementKeys)).min(1),
      calendar_mapping: sourceCalendarMappingSchema.optional(),
      capabilities_from: z
        .enum(["local_permissions", "active_grant", "active_inter_application_grant"])
        .optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.arrangements.includes("calendar") !== (value.calendar_mapping !== undefined))
        context.addIssue({
          code: "custom",
          path: ["calendar_mapping"],
          message: "Calendar mapping is required exactly for a calendar arrangement",
        });
    }),
  z
    .object({
      ...sourcePageBase,
      type: z.literal("detail"),
      record_type: fixtureQualifiedRecordTypeSchema,
      permission: namespacedKeySchema,
      sections: z.array(builderKeySchema).min(1),
    })
    .strict(),
  z
    .object({
      ...sourcePageBase,
      type: z.literal("dashboard"),
      permission: namespacedKeySchema,
      layout: sourceDashboardLayoutSchema,
    })
    .strict(),
  z
    .object({
      ...sourcePageBase,
      type: z.literal("form"),
      record_type: fixtureQualifiedRecordTypeSchema,
      permission: namespacedKeySchema,
      commit_action: namespacedKeySchema,
    })
    .strict(),
  z
    .object({
      ...sourcePageBase,
      type: z.literal("guided_form"),
      record_type: fixtureQualifiedRecordTypeSchema,
      permission: namespacedKeySchema,
      commit_action: namespacedKeySchema,
      steps: z.array(builderKeySchema).min(2).max(20),
      summary_step: builderKeySchema,
    })
    .strict(),
  z
    .object({
      ...sourcePageBase,
      type: z.literal("public"),
      record_type: fixtureQualifiedRecordTypeSchema,
      public_fields: z.array(builderKeySchema).min(1),
      filter: sourceFilterSchema,
    })
    .strict(),
]);
const sourceWorkflowValueSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("literal"), value: jsonValueSchema }).strict(),
  z.object({ source: z.literal("trigger_field"), field: sourceQualifiedFieldSchema }).strict(),
  z
    .object({
      source: z.literal("node_output"),
      node: fixtureAliasSchema,
      output: builderKeySchema,
    })
    .strict(),
  z.object({ source: z.literal("current_record") }).strict(),
  z.object({ source: z.literal("current_actor") }).strict(),
  z.object({ source: z.literal("current_time") }).strict(),
]);
const sourceWorkflowConfigByType = {
  start: z.object({}).strict(),
  condition: sourceComparisonSchema,
  decision_table: z
    .object({
      decisions: z
        .array(z.object({ when: sourceConditionSchema, output: builderKeySchema }).strict())
        .min(2),
    })
    .strict(),
  bounded_loop: z
    .object({ query: builderKeySchema, maximum_records: z.number().int().min(1).max(1_000) })
    .strict(),
  delay: z.object({ seconds: z.number().int().min(1).max(7_776_000) }).strict(),
  wait_until: z.object({ field: sourceQualifiedFieldSchema }).strict(),
  start_workflow: z.object({ workflow: builderKeySchema }).strict(),
  stop: z.object({ reason_code: builderKeySchema }).strict(),
  create_record: z
    .object({
      record_type: fixtureQualifiedRecordTypeSchema,
      values: z.record(builderKeySchema, sourceWorkflowValueSchema),
    })
    .strict(),
  change_record: z
    .object({
      record_type: fixtureQualifiedRecordTypeSchema,
      record: sourceWorkflowValueSchema,
      values: z.record(builderKeySchema, sourceWorkflowValueSchema),
    })
    .strict(),
  run_action: z
    .object({
      action: namespacedKeySchema,
      subject: sourceWorkflowValueSchema,
      inputs: z.record(builderKeySchema, sourceWorkflowValueSchema),
    })
    .strict(),
  soft_delete_record: z
    .object({ record_type: fixtureQualifiedRecordTypeSchema, record: sourceWorkflowValueSchema })
    .strict(),
  duplicate_record: z
    .object({ record_type: fixtureQualifiedRecordTypeSchema, record: sourceWorkflowValueSchema })
    .strict(),
  add_relationship: z
    .object({
      relationship: sourceQualifiedFieldSchema,
      subject: sourceWorkflowValueSchema,
      target: sourceWorkflowValueSchema,
    })
    .strict(),
  copy_relationships: z
    .object({
      relationships: z.array(sourceQualifiedFieldSchema).min(1),
      source_record: sourceWorkflowValueSchema,
      target_record: sourceWorkflowValueSchema,
    })
    .strict(),
  request_form: z
    .object({
      page: builderKeySchema,
      responder_permission: namespacedKeySchema,
      due_in_seconds: z.number().int().min(1).max(7_776_000),
      timeout_outcome: builderKeySchema,
      outputs: z.array(builderKeySchema).min(1),
    })
    .strict(),
  query_records: z.object({ query: builderKeySchema }).strict(),
  set_values: z
    .object({
      record: sourceWorkflowValueSchema,
      values: z.record(sourceQualifiedFieldSchema, sourceWorkflowValueSchema),
    })
    .strict(),
  format_value: z
    .object({ formatter: builderKeySchema, input: sourceWorkflowValueSchema })
    .strict(),
  generate_export: z
    .object({ query: builderKeySchema, maximum_rows: z.number().int().min(1).max(100_000) })
    .strict(),
  attach_file: z
    .object({
      record: sourceWorkflowValueSchema,
      field: sourceQualifiedFieldSchema,
      file: sourceWorkflowValueSchema,
    })
    .strict(),
  move_file: z
    .object({
      record: sourceWorkflowValueSchema,
      field: sourceQualifiedFieldSchema,
      file: sourceWorkflowValueSchema,
    })
    .strict(),
  call_connection: z
    .object({
      connection: fixtureAliasSchema,
      operation: builderKeySchema,
      inputs: z.record(builderKeySchema, sourceWorkflowValueSchema),
    })
    .strict(),
  acknowledge_message: z.object({ message: builderKeySchema }).strict(),
} satisfies Record<(typeof workflowNodeTypeKeys)[number], z.ZodType>;
const sourceWorkflowNodeMembers = workflowNodeTypeKeys.map((type) =>
  z
    .object({
      id: fixtureAliasSchema,
      type: z.literal(type),
      config: sourceWorkflowConfigByType[type],
      permission: namespacedKeySchema.optional(),
      timeout_seconds: z.number().int().min(1).max(7_776_000).default(300),
      retry: z
        .object({
          maximum_attempts: z.number().int().min(1).max(20),
          initial_delay_seconds: z.number().int().min(0).max(86_400),
          maximum_delay_seconds: z.number().int().min(0).max(86_400),
          backoff: z.enum(["fixed", "exponential"]),
        })
        .strict()
        .default({
          maximum_attempts: 3,
          initial_delay_seconds: 1,
          maximum_delay_seconds: 30,
          backoff: "exponential",
        }),
      duplicate_protection: z
        .enum(["not_applicable", "required"])
        .default(
          [
            "create_record",
            "change_record",
            "run_action",
            "soft_delete_record",
            "duplicate_record",
            "add_relationship",
            "copy_relationships",
            "request_form",
            "set_values",
            "start_workflow",
            "generate_export",
            "attach_file",
            "move_file",
            "call_connection",
            "acknowledge_message",
          ].includes(type)
            ? "required"
            : "not_applicable",
        ),
      activity: builderKeySchema.default(type),
      redaction: z.enum(["identifiers_only", "safe_fields", "no_payload"]).default("no_payload"),
    })
    .strict(),
);
const sourceWorkflowNodeSchema = z.discriminatedUnion(
  "type",
  sourceWorkflowNodeMembers as [
    (typeof sourceWorkflowNodeMembers)[number],
    (typeof sourceWorkflowNodeMembers)[number],
    ...(typeof sourceWorkflowNodeMembers)[number][],
  ],
);
const sourceApplicationBodySchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(1_000),
    icon: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    home_page: builderKeySchema,
    module_bindings: z
      .array(
        z
          .object({
            module: namespacedKeySchema,
            version: semanticVersionSchema,
            purpose: builderKeySchema,
          })
          .strict(),
      )
      .min(1),
    theme: z
      .object({
        mode: z.literal("application"),
        light_and_dark: z.boolean(),
        tokens: z
          .object({
            brand: builderKeySchema,
            density: z.enum(["compact", "comfortable"]),
            corners: z.enum(["square", "small", "medium", "large"]),
            focus: z.literal("high_contrast"),
          })
          .strict(),
      })
      .strict(),
    permissions: z.array(
      z.object({ key: namespacedKeySchema, label: z.string().min(1).max(120) }).strict(),
    ),
    roles: z
      .array(
        z
          .object({
            id: fixtureAliasSchema,
            key: builderKeySchema,
            name: z.string().min(1).max(120),
            home_page: builderKeySchema,
            permissions: z.array(z.string().min(3).max(200)).min(1),
          })
          .strict(),
      )
      .min(1),
    navigation: z.array(sourceNavigationSchema),
    queries: z.array(
      z
        .object({
          id: fixtureAliasSchema,
          key: builderKeySchema,
          record_type: fixtureQualifiedRecordTypeSchema,
          select: z.array(builderKeySchema).min(1),
          filter: sourceFilterSchema,
          sort: z
            .array(
              z
                .object({ field: builderKeySchema, direction: z.enum(["ascending", "descending"]) })
                .strict(),
            )
            .min(1),
          source: z.literal("active_inter_application_grant").optional(),
        })
        .strict(),
    ),
    pages: z.array(sourcePageSchema).min(1),
    workflows: z.array(
      z
        .object({
          id: fixtureAliasSchema,
          key: builderKeySchema,
          name: z.string().min(1).max(120),
          trigger: z.union([
            z.object({ event: namespacedKeySchema }).strict(),
            z.object({ schedule: z.string().min(1).max(120) }).strict(),
          ]),
          run_as: z.enum(["triggering_account", "system_with_source_authority"]),
          maximum_nesting_depth: z.number().int().min(1).max(5),
          nodes: z.array(sourceWorkflowNodeSchema).min(1),
          edges: z.array(
            z.tuple([fixtureAliasSchema, fixtureAliasSchema, builderKeySchema.optional()]),
          ),
        })
        .strict(),
    ),
    pipelines: z.array(
      z
        .object({
          id: fixtureAliasSchema,
          key: builderKeySchema,
          name: z.string().min(1).max(120),
          record_type: fixtureQualifiedRecordTypeSchema,
          stage_field: builderKeySchema,
          stages: z
            .array(
              z
                .object({
                  key: builderKeySchema,
                  label: z.string().min(1).max(120),
                  entry_actions: z.array(namespacedKeySchema).default([]),
                  exit_actions: z.array(namespacedKeySchema).default([]),
                  entry_workflows: z.array(builderKeySchema).default([]),
                  exit_workflows: z.array(builderKeySchema).default([]),
                })
                .strict(),
            )
            .min(1),
          transitions: z
            .array(
              z
                .object({
                  from: builderKeySchema,
                  to: builderKeySchema,
                  permission: namespacedKeySchema.optional(),
                  action: namespacedKeySchema.optional(),
                  gate: sourceConditionSchema.optional(),
                })
                .strict(),
            )
            .min(1),
          time_targets: z
            .array(
              z
                .object({
                  stage: builderKeySchema,
                  field: builderKeySchema,
                  escalation_event: namespacedKeySchema,
                })
                .strict(),
            )
            .default([]),
        })
        .strict(),
    ),
    connection_bindings: z.array(
      z
        .object({
          id: fixtureAliasSchema,
          connection_type: namespacedKeySchema,
          required_operations: z.array(builderKeySchema).min(1),
        })
        .strict(),
    ),
    interfaces: z.array(
      z
        .object({
          id: fixtureAliasSchema,
          key: namespacedKeySchema,
          version: semanticVersionSchema,
          operations: z
            .array(
              z
                .object({
                  key: builderKeySchema,
                  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
                  query: builderKeySchema.optional(),
                  action: namespacedKeySchema.optional(),
                  permission: namespacedKeySchema,
                })
                .strict(),
            )
            .min(1),
        })
        .strict(),
    ),
  })
  .strict();
export const applicationSourceDocumentSchema = z
  .object({
    ...publishedSourceBase,
    kind: z.literal("application"),
    body: sourceApplicationBodySchema,
  })
  .strict();

export const connectionTypeSourceDocumentSchema = z
  .object({
    ...publishedSourceBase,
    kind: z.literal("connection_type"),
    body: z
      .object({
        name: z.string().min(1).max(120),
        purpose: z.string().min(1).max(1_000),
        provider: z.string().min(1).max(120),
        authentication: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("oauth2"),
              secret_fields: z.array(builderKeySchema).min(1),
              scopes: z.array(z.string().min(1).max(200)),
            })
            .strict(),
          z
            .object({
              kind: z.literal("signed_secret"),
              secret_fields: z.array(builderKeySchema).min(1),
              algorithm: z.enum(["hmac_sha256", "ed25519"]),
            })
            .strict(),
          z
            .object({
              kind: z.literal("api_key"),
              secret_fields: z.array(builderKeySchema).min(1),
              placement: z.enum(["header", "query"]),
            })
            .strict(),
        ]),
        allowed_hosts: z
          .array(
            z
              .string()
              .min(1)
              .max(253)
              .regex(/^[a-z0-9.-]+$/),
          )
          .min(1),
        allow_redirects: z.boolean(),
        shapes: z
          .array(
            z
              .object({
                key: builderKeySchema,
                fields: z
                  .array(
                    z
                      .object({
                        key: builderKeySchema,
                        type: z.enum([
                          "text",
                          "number",
                          "boolean",
                          "date",
                          "date_time",
                          "record_reference",
                          "json",
                        ]),
                        required: z.boolean(),
                      })
                      .strict(),
                  )
                  .max(100),
              })
              .strict(),
          )
          .min(1),
        operations: z
          .array(
            z
              .object({
                key: builderKeySchema,
                method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
                path: z.string().startsWith("/"),
                input: builderKeySchema,
                output: builderKeySchema,
                timeout_seconds: z.number().int().min(1).max(120),
                max_attempts: z.number().int().min(1).max(10),
                maximum_response_bytes: z.number().int().min(1).max(100_000_000),
              })
              .strict(),
          )
          .min(1),
        incoming_messages: z.array(
          z
            .object({
              key: builderKeySchema,
              signature: z.enum(["hmac_sha256", "ed25519"]),
              replay_window_seconds: z.number().int().min(1).max(86_400),
              input: builderKeySchema,
              workflow_trigger: builderKeySchema,
            })
            .strict(),
        ),
        health_operation: builderKeySchema.optional(),
        revocation_operation: builderKeySchema.optional(),
      })
      .strict(),
  })
  .strict();

export const definitionSourceDocumentSchema = z.discriminatedUnion("kind", [
  moduleSourceDocumentSchema,
  applicationSourceDocumentSchema,
  connectionTypeSourceDocumentSchema,
]);

export type ModuleSourceDocument = z.infer<typeof moduleSourceDocumentSchema>;
export type ApplicationSourceDocument = z.infer<typeof applicationSourceDocumentSchema>;
export type ConnectionTypeSourceDocument = z.infer<typeof connectionTypeSourceDocumentSchema>;
export type DefinitionSourceDocument = z.infer<typeof definitionSourceDocumentSchema>;
