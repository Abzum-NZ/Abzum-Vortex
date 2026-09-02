import { z } from "zod";
import {
  fieldTypeKeys,
  listArrangementKeys,
  pageStateSchema,
  personalDataClassSchema,
  publicDisplaySchema,
  searchPrioritySchema,
  workflowNodeTypeKeys,
} from "./catalogues";
import {
  builderKeySchema,
  namespacedKeySchema,
  revisionSchema,
  semanticVersionSchema,
} from "./identifiers";
import { jsonValueSchema } from "./common";

/** Portable aliases exist only in authored examples. #15 resolves them to platform identifiers. */
export const fixtureAliasSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z][a-z0-9_]*$/);
export const fixtureQualifiedRecordTypeSchema = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[a-z][a-z0-9_.]*:[a-z][a-z0-9_]*$/);
const fixtureFingerprintSchema = z.string().min(8).max(250).startsWith("fixture:");
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
export const moduleFixtureFieldSchema = z.discriminatedUnion("type", sourceFieldMembers);

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
          record_type: builderKeySchema,
          permission: namespacedKeySchema,
          shareable: z.boolean(),
          inputs: z.array(actionInputSchema),
          effects: z
            .array(
              z.enum([
                "change_stage",
                "change_status",
                "create_comment",
                "create_company_if_needed",
                "create_contact",
                "create_customer_visible_comment",
                "create_record",
                "emit_event",
                "move_relationships",
                "record_approval",
                "set_completed",
                "set_inactive",
                "set_owner",
                "set_resolved",
                "soft_delete_source",
              ]),
            )
            .min(1),
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
          moment: z.literal("saving"),
          condition: sourceConditionSchema,
          effect: z.enum(["refuse", "require_permission"]),
          permission: namespacedKeySchema.optional(),
          message: z.string().min(1).max(500),
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
  content_fingerprint: fixtureFingerprintSchema,
};
export const moduleFixtureDocumentSchema = z
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
const sourceWorkflowConfigByType = {
  start: z.object({}).strict(),
  condition: sourceComparisonSchema,
  decision_table: z.object({ table: builderKeySchema }).strict(),
  bounded_loop: z.object({ maximum: z.number().int().min(1).max(1_000) }).strict(),
  delay: z.object({ minutes: z.number().int().min(1).max(129_600) }).strict(),
  wait_until: z.object({ field: builderKeySchema }).strict(),
  start_workflow: z.object({ workflow: builderKeySchema }).strict(),
  stop: z.object({}).strict(),
  create_record: z.object({ record_type: fixtureQualifiedRecordTypeSchema }).strict(),
  change_record: z.object({ record_type: fixtureQualifiedRecordTypeSchema }).strict(),
  run_action: z.object({ action: namespacedKeySchema }).strict(),
  soft_delete_record: z
    .object({ record_type: fixtureQualifiedRecordTypeSchema, scope: builderKeySchema.optional() })
    .strict(),
  duplicate_record: z.object({ record_type: fixtureQualifiedRecordTypeSchema }).strict(),
  convert_record: z
    .object({ from: fixtureQualifiedRecordTypeSchema, to: fixtureQualifiedRecordTypeSchema })
    .strict(),
  add_relationship: z.object({ target: fixtureQualifiedRecordTypeSchema }).strict(),
  copy_relationships: z.object({}).strict(),
  add_comment: z
    .object({ visibility: z.enum(["internal", "public"]), text: z.string().min(1).max(10_000) })
    .strict(),
  change_tags: z.object({ action: namespacedKeySchema }).strict(),
  request_form: z.object({ page: builderKeySchema }).strict(),
  request_approval: z.object({ reason: builderKeySchema }).strict(),
  create_task: z.object({ title: z.string().min(1).max(200) }).strict(),
  create_calendar_event: z
    .object({ connection: fixtureAliasSchema, operation: builderKeySchema })
    .strict(),
  notification: z.object({ audience: builderKeySchema }).strict(),
  send_email: z.object({ connection: fixtureAliasSchema, operation: builderKeySchema }).strict(),
  query_records: z.object({ query: builderKeySchema }).strict(),
  set_values: z.object({ values: z.record(builderKeySchema, jsonValueSchema) }).strict(),
  format_value: z.object({ format: builderKeySchema }).strict(),
  generate_export: z.object({ query: builderKeySchema }).strict(),
  attach_file: z.object({ record_type: fixtureQualifiedRecordTypeSchema }).strict(),
  move_file: z.object({ destination: builderKeySchema }).strict(),
  generate_document: z.object({ template: builderKeySchema }).strict(),
  call_connection: z
    .object({ connection: fixtureAliasSchema, operation: builderKeySchema })
    .strict(),
  acknowledge_message: z.object({}).strict(),
} satisfies Record<(typeof workflowNodeTypeKeys)[number], z.ZodType>;
const sourceWorkflowNodeMembers = workflowNodeTypeKeys.map((type) =>
  z
    .object({
      id: fixtureAliasSchema,
      type: z.literal(type),
      config: sourceWorkflowConfigByType[type],
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
    motion: z
      .object({
        library: z.literal("motion/react"),
        simple_feedback: z.literal("css"),
        feature_loading: z.literal("lazy"),
        tokens: z.literal("platform_default"),
        semantic_tokens: z.tuple([
          z.literal("feedback"),
          z.literal("enter_exit"),
          z.literal("refresh"),
          z.literal("panel"),
          z.literal("page"),
          z.literal("layout_spring"),
        ]),
        current_state_wins: z.literal(true),
        reduced_motion: z.literal("required"),
        experimental_view_transitions: z.literal(false),
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
          nodes: z.array(sourceWorkflowNodeSchema).min(1),
          edges: z.array(z.tuple([fixtureAliasSchema, fixtureAliasSchema])),
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
          stages: z.array(builderKeySchema).min(1),
          transitions: z
            .array(
              z
                .object({
                  from: builderKeySchema,
                  to: builderKeySchema,
                  permission: namespacedKeySchema.optional(),
                  action: namespacedKeySchema.optional(),
                })
                .strict(),
            )
            .min(1),
          time_targets: z
            .array(z.object({ stage: builderKeySchema, field: builderKeySchema }).strict())
            .optional(),
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
export const applicationFixtureDocumentSchema = z
  .object({
    ...publishedSourceBase,
    kind: z.literal("application"),
    body: sourceApplicationBodySchema,
  })
  .strict();

export const connectionTypeFixtureDocumentSchema = z
  .object({
    ...publishedSourceBase,
    kind: z.literal("connection_type"),
    body: z
      .object({
        name: z.string().min(1).max(120),
        authentication: z
          .object({
            kind: z.enum(["oauth2", "signed_secret"]),
            secret_fields: z.array(builderKeySchema).min(1),
          })
          .strict(),
        allowed_hosts: z
          .array(
            z
              .string()
              .min(1)
              .max(253)
              .regex(/^[a-z0-9.-]+$/),
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
              })
              .strict(),
          )
          .min(1),
        incoming_messages: z.array(
          z
            .object({
              key: builderKeySchema,
              signature: z.literal("hmac_sha256"),
              replay_window_seconds: z.number().int().min(1).max(86_400),
              input: builderKeySchema,
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

const unversionedSourceBase = {
  schema_version: semanticVersionSchema,
  root_id: fixtureAliasSchema,
  key: namespacedKeySchema,
  version: semanticVersionSchema,
};
const sameRecordCaseSchema = z
  .object({
    record_type: fixtureQualifiedRecordTypeSchema,
    record_id: fixtureAliasSchema,
    created_in: namespacedKeySchema,
    read_in: z.array(namespacedKeySchema).min(2),
    expected_physical_records: z.literal(1),
    grant_required: z.boolean(),
  })
  .strict();
const fixtureGrantSchema = z
  .object({
    id: fixtureAliasSchema,
    source_application: namespacedKeySchema,
    recipient_application: namespacedKeySchema,
    recipient_roles: z.array(builderKeySchema).min(1),
    module: namespacedKeySchema,
    record_type: builderKeySchema,
    scope: z.object({ kind: z.literal("record"), record_id: fixtureAliasSchema }).strict(),
    readable_fields: z.array(builderKeySchema).min(1),
    changeable_fields: z.array(builderKeySchema),
    allowed_actions: z.array(namespacedKeySchema),
    export_allowed: z.boolean(),
    state: z.literal("active"),
    expected_physical_records: z.literal(1),
  })
  .strict()
  .refine(
    (value) => value.changeable_fields.every((field) => value.readable_fields.includes(field)),
    { path: ["changeable_fields"], message: "Changeable fields must also be readable" },
  );
const scenarioAssertionSchema = z
  .object({
    id: fixtureAliasSchema,
    when: z.string().min(1).max(500),
    expect: z.string().min(1).max(500).optional(),
    expect_fields: z.array(builderKeySchema).min(1).optional(),
    refuse_fields: z.array(builderKeySchema).min(1).optional(),
  })
  .strict()
  .refine((value) => value.expect !== undefined || value.expect_fields !== undefined, {
    message: "An assertion requires an expected result",
  });
export const acceptanceScenarioFixtureDocumentSchema = z
  .object({
    ...unversionedSourceBase,
    kind: z.literal("acceptance_scenario"),
    body: z
      .object({
        organisation: fixtureAliasSchema,
        applications: z.array(namespacedKeySchema).min(2),
        same_record_cases: z.array(sameRecordCaseSchema).min(1),
        inter_application_grant: fixtureGrantSchema,
        assertions: z.array(scenarioAssertionSchema).min(1),
      })
      .strict(),
  })
  .strict();

const storageTableSchema = z
  .object({
    record_type: fixtureQualifiedRecordTypeSchema,
    storage_contract_id: fixtureAliasSchema,
    table: z.string().regex(/^record_data\.rt_[a-z0-9_]+$/),
    storage_scope: z.enum(["organisation_shared", "application_contained"]),
  })
  .strict();
const applicationRootFixtureSchema = z
  .object({
    organisation_id: fixtureAliasSchema,
    application_definition: namespacedKeySchema,
    application_root_id: fixtureAliasSchema,
    display_name: z.string().min(1).max(120),
  })
  .strict();
const rowExampleSchema = z
  .object({
    record_type: fixtureQualifiedRecordTypeSchema,
    record_id: fixtureAliasSchema,
    organisation_id: fixtureAliasSchema,
    application_root_id: fixtureAliasSchema.nullable(),
    physical_table: z.string().regex(/^record_data\.rt_[a-z0-9_]+$/),
  })
  .strict();
export const storageLayoutFixtureDocumentSchema = z
  .object({
    ...unversionedSourceBase,
    kind: z.literal("storage_layout"),
    body: z
      .object({
        owning_service: z.literal("record"),
        physical_schema: z.literal("record_data"),
        allocation_unit: z.literal("storage_contract_id"),
        table_name_rule: z.literal("rt_<immutable_storage_token>"),
        field_name_rule: z.literal("f_<immutable_field_token>"),
        uses_display_names: z.literal(false),
        system_columns: z.array(builderKeySchema).min(1),
        scope_keys: z
          .object({
            organisation_shared: z.tuple([z.literal("organisation_id")]),
            application_contained: z.tuple([
              z.literal("organisation_id"),
              z.literal("application_root_id"),
            ]),
          })
          .strict(),
        tables: z.array(storageTableSchema).min(1),
        application_roots: z.array(applicationRootFixtureSchema).min(1),
        row_examples: z.array(rowExampleSchema).min(1),
        fork_example: z
          .object({
            display_application_name: z.string().min(1),
            display_module_name: z.string().min(1),
            display_record_type_name: z.string().min(1),
            source_storage_contract_id: fixtureAliasSchema,
            forked_storage_contract_id: fixtureAliasSchema,
            source_table: z.string().regex(/^record_data\.rt_[a-z0-9_]+$/),
            forked_table: z.string().regex(/^record_data\.rt_[a-z0-9_]+$/),
          })
          .strict(),
        assertions: z
          .array(
            z
              .string()
              .min(1)
              .max(160)
              .regex(/^[a-z][a-z0-9_]*$/),
          )
          .min(1),
      })
      .strict(),
  })
  .strict();
export const fixtureDocumentSchema = z.discriminatedUnion("kind", [
  moduleFixtureDocumentSchema,
  applicationFixtureDocumentSchema,
  connectionTypeFixtureDocumentSchema,
  acceptanceScenarioFixtureDocumentSchema,
  storageLayoutFixtureDocumentSchema,
]);

export type ModuleFixtureDocument = z.infer<typeof moduleFixtureDocumentSchema>;
export type ApplicationFixtureDocument = z.infer<typeof applicationFixtureDocumentSchema>;
export type ConnectionTypeFixtureDocument = z.infer<typeof connectionTypeFixtureDocumentSchema>;
export type AcceptanceScenarioFixtureDocument = z.infer<
  typeof acceptanceScenarioFixtureDocumentSchema
>;
export type StorageLayoutFixtureDocument = z.infer<typeof storageLayoutFixtureDocumentSchema>;
export type FixtureDocument = z.infer<typeof fixtureDocumentSchema>;
