import { z } from "zod";
import {
  blockPaletteGroupSchema,
  blockSettingControlSchema,
  listArrangementKeys,
  pageStateSchema,
  workflowNodeTypeKeys,
  workflowValueTypeSchema,
} from "./catalogues";
import { builderKeySchema, namespacedKeySchema, semanticVersionSchema } from "./identifiers";
import { jsonValueSchema } from "./common";
import { versionRequirementSchema } from "./definitions";
import {
  authoredSourceBase,
  sourceActionEffectSchema,
  sourceAliasSchema,
  sourceConditionSchema,
  sourceQualifiedFieldSchema,
  sourceQualifiedRelationshipSchema,
  sourceQualifiedConditionSchema,
  sourceQualifiedRecordTypeSchema,
  sourceRuleEffectSchema,
} from "./definition-source-common";
import { actionInputSchema } from "./module-source-contracts";
import { applicationRolePermissionKeysSchema } from "./permissions";

const sourceFilterSchema = z.union([z.null(), sourceConditionSchema]);
export const sourceBlockSettingValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: jsonValueSchema }).strict(),
  z.object({ kind: z.literal("field_reference"), field: sourceQualifiedFieldSchema }).strict(),
  z
    .object({
      kind: z.literal("relationship_reference"),
      relationship: sourceQualifiedRelationshipSchema,
    })
    .strict(),
  z.object({ kind: z.literal("action_reference"), action: namespacedKeySchema }).strict(),
  z.object({ kind: z.literal("page_reference"), page: builderKeySchema }).strict(),
  z.object({ kind: z.literal("query_reference"), query: builderKeySchema }).strict(),
  z.object({ kind: z.literal("pipeline_reference"), pipeline: builderKeySchema }).strict(),
  z
    .object({
      kind: z.literal("record_type_reference"),
      record_type: sourceQualifiedRecordTypeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("record_reference"),
      record_type: sourceQualifiedRecordTypeSchema,
      record_id: z.uuid(),
    })
    .strict(),
]);
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
const sourceResponsiveLayoutSchema = z
  .object({
    desktop: z
      .object({ columns: z.literal(12), component_order: z.array(sourceAliasSchema) })
      .strict(),
    phone: z.object({ component_order: z.array(sourceAliasSchema) }).strict(),
  })
  .strict();
const sourceBlockPlacementSchema = z
  .object({
    id: sourceAliasSchema,
    block: sourceAliasSchema,
    block_release_version: semanticVersionSchema,
    settings: z.record(builderKeySchema, sourceBlockSettingValueSchema),
    desktop: z
      .object({
        start_column: z.number().int().min(1).max(12),
        span: z.number().int().min(1).max(12),
        height: z.number().int().positive(),
      })
      .strict(),
    phone: z
      .object({
        order: z.number().int().min(0),
        behaviour: z.enum(["stack", "hide", "full_width"]),
      })
      .strict(),
    visibility_condition: sourceQualifiedConditionSchema.optional(),
    view_permission: namespacedKeySchema,
    use_permission: namespacedKeySchema.optional(),
    query: builderKeySchema.optional(),
  })
  .strict();
const sourceStandardPageReplacementSchema = z
  .object({
    standard_page: z.enum(["list", "detail", "create_form"]),
    record_type: sourceQualifiedRecordTypeSchema,
  })
  .strict();
type SourceNavigation =
  | { id: string; type: "heading"; label: string; children: SourceNavigation[] }
  | { id: string; type: "page"; label: string; page: string; permission: string }
  | { id: string; type: "external"; label: string; address: string; permission: string };
const sourceNavigationSchema: z.ZodType<SourceNavigation> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z
      .object({
        id: sourceAliasSchema,
        type: z.literal("heading"),
        label: z.string().min(1).max(120),
        children: z.array(sourceNavigationSchema).min(1),
      })
      .strict(),
    z
      .object({
        id: sourceAliasSchema,
        type: z.literal("page"),
        label: z.string().min(1).max(120),
        page: builderKeySchema,
        permission: namespacedKeySchema,
      })
      .strict(),
    z
      .object({
        id: sourceAliasSchema,
        type: z.literal("external"),
        label: z.string().min(1).max(120),
        address: z.string().url().startsWith("https://"),
        permission: namespacedKeySchema,
      })
      .strict(),
  ]),
);
const sourcePageBase = {
  id: sourceAliasSchema,
  key: builderKeySchema,
  name: z.string().min(1).max(120),
  states: z.array(pageStateSchema).min(1),
  layout: sourceResponsiveLayoutSchema,
  standard_page_replacement: sourceStandardPageReplacementSchema.optional(),
};
const sourcePageSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...sourcePageBase,
      type: z.literal("list"),
      record_type: sourceQualifiedRecordTypeSchema,
      permission: namespacedKeySchema,
      query: builderKeySchema,
      arrangements: z.array(z.enum(listArrangementKeys)).min(1),
      calendar_mapping: sourceCalendarMappingSchema.optional(),
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
      record_type: sourceQualifiedRecordTypeSchema,
      permission: namespacedKeySchema,
      blocks: z.array(sourceBlockPlacementSchema).min(1),
    })
    .strict(),
  z
    .object({
      ...sourcePageBase,
      type: z.literal("dashboard"),
      permission: namespacedKeySchema,
      blocks: z.array(sourceBlockPlacementSchema).min(1),
    })
    .strict(),
  z
    .object({
      ...sourcePageBase,
      type: z.literal("form"),
      record_type: sourceQualifiedRecordTypeSchema,
      permission: namespacedKeySchema,
      commit_action: namespacedKeySchema,
      blocks: z.array(sourceBlockPlacementSchema).min(1),
    })
    .strict(),
  z
    .object({
      ...sourcePageBase,
      type: z.literal("guided_form"),
      record_type: sourceQualifiedRecordTypeSchema,
      permission: namespacedKeySchema,
      commit_action: namespacedKeySchema,
      steps: z
        .array(
          z
            .object({
              id: sourceAliasSchema,
              name: z.string().min(1).max(60),
              summary: z.boolean(),
              blocks: z.array(sourceBlockPlacementSchema).min(1),
            })
            .strict(),
        )
        .min(2)
        .max(20),
    })
    .strict(),
  z
    .object({
      ...sourcePageBase,
      type: z.literal("public"),
      permission: namespacedKeySchema,
      record_type: sourceQualifiedRecordTypeSchema.optional(),
      public_fields: z.array(builderKeySchema),
      public_action: namespacedKeySchema.optional(),
      blocks: z.array(sourceBlockPlacementSchema).min(1),
      rate_limit_per_minute: z.number().int().min(1).max(10_000),
    })
    .strict(),
]);
const sourceWorkflowValueSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("literal"), value: jsonValueSchema }).strict(),
  z.object({ source: z.literal("trigger_field"), field: sourceQualifiedFieldSchema }).strict(),
  z.object({ source: z.literal("trigger_input"), input: builderKeySchema }).strict(),
  z
    .object({
      source: z.literal("node_output"),
      node: sourceAliasSchema,
      output: builderKeySchema,
    })
    .strict(),
  z.object({ source: z.literal("current_record") }).strict(),
  z.object({ source: z.literal("current_actor") }).strict(),
  z.object({ source: z.literal("current_time") }).strict(),
]);
const sourceWorkflowDeclaredOutputSchema = z
  .object({
    key: builderKeySchema,
    type: workflowValueTypeSchema,
    record_types: z.array(sourceQualifiedRecordTypeSchema).min(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.type === "record_reference") !== (value.record_types !== undefined))
      context.addIssue({
        code: "custom",
        path: ["record_types"],
        message: "Record-reference outputs require their allowed record types",
      });
  });
const sourceWorkflowConfigByType = {
  start: z.object({}).strict(),
  condition: sourceQualifiedConditionSchema,
  decision_table: z
    .object({
      decisions: z
        .array(
          z.object({ when: sourceQualifiedConditionSchema, output: builderKeySchema }).strict(),
        )
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
      record_type: sourceQualifiedRecordTypeSchema,
      values: z.record(builderKeySchema, sourceWorkflowValueSchema),
    })
    .strict(),
  change_record: z
    .object({
      record_type: sourceQualifiedRecordTypeSchema,
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
    .object({ record_type: sourceQualifiedRecordTypeSchema, record: sourceWorkflowValueSchema })
    .strict(),
  duplicate_record: z
    .object({ record_type: sourceQualifiedRecordTypeSchema, record: sourceWorkflowValueSchema })
    .strict(),
  add_relationship: z
    .object({
      relationship: sourceQualifiedRelationshipSchema,
      subject: sourceWorkflowValueSchema,
      target: sourceWorkflowValueSchema,
    })
    .strict(),
  copy_relationships: z
    .object({
      relationships: z.array(sourceQualifiedRelationshipSchema).min(1),
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
      outputs: z.array(sourceWorkflowDeclaredOutputSchema).min(1),
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
      connection: sourceAliasSchema,
      operation: builderKeySchema,
      inputs: z.record(builderKeySchema, sourceWorkflowValueSchema),
    })
    .strict(),
  acknowledge_message: z.object({ message: builderKeySchema }).strict(),
} satisfies Record<(typeof workflowNodeTypeKeys)[number], z.ZodType>;
const sourceWorkflowNodeMembers = workflowNodeTypeKeys.map((type) =>
  z
    .object({
      id: sourceAliasSchema,
      type: z.literal(type),
      config: sourceWorkflowConfigByType[type],
      permission: namespacedKeySchema.optional(),
      timeout_seconds: z.number().int().min(1).max(7_776_000).optional(),
      retry: z
        .object({
          maximum_attempts: z.number().int().min(1).max(20),
          initial_delay_seconds: z.number().int().min(0).max(86_400),
          maximum_delay_seconds: z.number().int().min(0).max(86_400),
          backoff: z.enum(["fixed", "exponential"]),
        })
        .strict()
        .optional(),
      duplicate_protection: z.enum(["not_applicable", "required"]).optional(),
      activity: builderKeySchema.optional(),
      redaction: z.enum(["identifiers_only", "safe_fields", "no_payload"]).optional(),
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
const sourceWorkflowTriggerInputSchema = z
  .object({
    key: builderKeySchema,
    type: workflowValueTypeSchema,
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("record_field"), field: builderKeySchema }).strict(),
      z.object({ kind: z.literal("payload"), key: builderKeySchema }).strict(),
    ]),
    record_types: z.array(sourceQualifiedRecordTypeSchema).min(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.type === "record_reference") !== (value.record_types !== undefined))
      context.addIssue({
        code: "custom",
        path: ["record_types"],
        message: "Record-reference inputs require their allowed record types",
      });
  });
const sourceWorkflowTriggerCommon = {
  inputs: z.array(sourceWorkflowTriggerInputSchema).max(100),
  condition: sourceConditionSchema.nullable(),
  duplicate_protection: z.enum(["not_required", "required"]),
};
const sourceWorkflowScheduleSchema = z
  .object({
    cadence: z.enum(["hourly", "daily", "weekly", "monthly"]),
    interval: z.number().int().min(1).max(365),
    time_zone: z.string().min(1).max(100),
    minute: z.number().int().min(0).max(59),
    hour: z.number().int().min(0).max(23).optional(),
    week_day: z.number().int().min(1).max(7).optional(),
    month_day: z.number().int().min(1).max(31).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const valid =
      (value.cadence === "hourly" &&
        value.hour === undefined &&
        value.week_day === undefined &&
        value.month_day === undefined) ||
      (value.cadence === "daily" &&
        value.hour !== undefined &&
        value.week_day === undefined &&
        value.month_day === undefined) ||
      (value.cadence === "weekly" &&
        value.hour !== undefined &&
        value.week_day !== undefined &&
        value.month_day === undefined) ||
      (value.cadence === "monthly" &&
        value.hour !== undefined &&
        value.week_day === undefined &&
        value.month_day !== undefined);
    if (!valid)
      context.addIssue({
        code: "custom",
        path: ["cadence"],
        message: "Schedule fields must match cadence",
      });
  });
const sourceInterfaceValueTypeSchema = z.enum([
  "text",
  "number",
  "boolean",
  "date",
  "date_time",
  "record_reference",
]);
const sourceInterfaceInputFieldSchema = z
  .object({
    type: sourceInterfaceValueTypeSchema,
    required: z.boolean(),
    target_binding: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("action_subject") }).strict(),
      z.object({ kind: z.literal("action_input"), key: builderKeySchema }).strict(),
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.target_binding.kind === "action_subject" && value.type !== "record_reference")
      context.addIssue({
        code: "custom",
        path: ["type"],
        message: "An action subject input is a record reference",
      });
  });
const sourceInterfaceOutputFieldSchema = z
  .object({
    type: sourceInterfaceValueTypeSchema,
    required: z.boolean(),
    target_binding: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("query_field"), field: sourceQualifiedFieldSchema }).strict(),
      z
        .object({
          kind: z.literal("query_page_information"),
          value: z.enum(["continuation_token", "has_more", "result_count"]),
        })
        .strict(),
      z.object({ kind: z.literal("workflow_run_id") }).strict(),
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.target_binding.kind === "workflow_run_id" && value.type !== "text")
      context.addIssue({
        code: "custom",
        path: ["type"],
        message: "A workflow run identifier is text",
      });
    if (
      value.target_binding.kind === "query_page_information" &&
      ((value.target_binding.value === "continuation_token" && value.type !== "text") ||
        (value.target_binding.value === "has_more" && value.type !== "boolean") ||
        (value.target_binding.value === "result_count" && value.type !== "number"))
    )
      context.addIssue({
        code: "custom",
        path: ["type"],
        message: "Query page information has a fixed value type",
      });
  });
const sourceInterfaceTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("action"), key: namespacedKeySchema }).strict(),
  z.object({ kind: z.literal("query"), key: builderKeySchema }).strict(),
  z.object({ kind: z.literal("workflow"), key: builderKeySchema }).strict(),
]);
const sourceInterfaceOperationSchema = z
  .object({
    key: builderKeySchema,
    id: sourceAliasSchema,
    description: z.string().min(1).max(1_000),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().startsWith("/").max(500),
    input_shape: z.record(builderKeySchema, sourceInterfaceInputFieldSchema),
    output_shape: z.record(builderKeySchema, sourceInterfaceOutputFieldSchema),
    authentication: z.enum(["organisation_token", "partner_token", "public"]),
    permission: namespacedKeySchema,
    visibility: z.enum(["organisation_private", "partner", "public"]),
    rate_limit_per_minute: z.number().int().min(1).max(100_000),
    maximum_request_bytes: z.number().int().min(1).max(100_000_000),
    duplicate_protection: z.enum(["not_required", "required"]),
    target: sourceInterfaceTargetSchema,
    error_codes: z.array(builderKeySchema),
  })
  .strict()
  .superRefine((value, context) => {
    const inputKinds = new Set(
      Object.values(value.input_shape).map((field) => field.target_binding.kind),
    );
    const outputKinds = new Set(
      Object.values(value.output_shape).map((field) => field.target_binding.kind),
    );
    const allowedInputKinds: Record<typeof value.target.kind, ReadonlySet<string>> = {
      action: new Set(["action_subject", "action_input"]),
      query: new Set(),
      workflow: new Set(),
    };
    const allowedOutputKinds: Record<typeof value.target.kind, ReadonlySet<string>> = {
      action: new Set(),
      query: new Set(["query_field", "query_page_information"]),
      workflow: new Set(["workflow_run_id"]),
    };
    for (const kind of inputKinds)
      if (!allowedInputKinds[value.target.kind].has(kind))
        context.addIssue({
          code: "custom",
          path: ["input_shape"],
          message: `An ${value.target.kind} interface accepts only ${value.target.kind} input bindings`,
        });
    for (const kind of outputKinds)
      if (!allowedOutputKinds[value.target.kind].has(kind))
        context.addIssue({
          code: "custom",
          path: ["output_shape"],
          message: `An ${value.target.kind} interface accepts only ${value.target.kind} output bindings`,
        });
  });
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
            version: versionRequirementSchema,
            purpose: builderKeySchema,
          })
          .strict(),
      )
      .min(1),
    theme: z.discriminatedUnion("mode", [
      z
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
      z
        .object({
          mode: z.literal("platform"),
          catalogue_theme_id: z.uuid(),
          version: semanticVersionSchema,
        })
        .strict(),
    ]),
    permissions: z.array(
      z
        .object({
          id: sourceAliasSchema,
          key: namespacedKeySchema,
          label: z.string().min(1).max(120),
          description: z.string().min(1).max(1_000),
          record_type: sourceQualifiedRecordTypeSchema.optional(),
          action_kind: z.enum([
            "create",
            "read",
            "update",
            "delete",
            "restore",
            "export",
            "share",
            "manage",
            "named",
          ]),
          named_action: builderKeySchema.optional(),
          administrative: z.boolean(),
        })
        .strict(),
    ),
    roles: z
      .array(
        z
          .object({
            id: sourceAliasSchema,
            key: builderKeySchema,
            name: z.string().min(1).max(120),
            home_page: builderKeySchema,
            permissions: applicationRolePermissionKeysSchema,
          })
          .strict(),
      )
      .min(1),
    navigation: z.array(sourceNavigationSchema),
    queries: z.array(
      z
        .object({
          id: sourceAliasSchema,
          key: builderKeySchema,
          record_type: sourceQualifiedRecordTypeSchema,
          select: z.array(builderKeySchema).min(1),
          filter: sourceFilterSchema,
          group_by: z.array(builderKeySchema),
          aggregates: z.array(
            z
              .object({
                operation: z.enum(["count", "sum", "minimum", "maximum", "average"]),
                field: builderKeySchema.optional(),
                alias: builderKeySchema,
              })
              .strict(),
          ),
          sort: z
            .array(
              z
                .object({ field: builderKeySchema, direction: z.enum(["ascending", "descending"]) })
                .strict(),
            )
            .min(1),
          page_size: z.number().int().min(1).max(200),
          relationship_hops: z.number().int().min(0).max(2),
        })
        .strict(),
    ),
    block_registrations: z.array(
      z
        .object({
          id: sourceAliasSchema,
          release_version: semanticVersionSchema,
          name: z.string().min(1).max(60),
          icon: z
            .string()
            .min(1)
            .max(120)
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
          palette_group: blockPaletteGroupSchema,
          settings: z.array(
            z
              .object({
                key: builderKeySchema,
                control: blockSettingControlSchema,
                required: z.boolean(),
              })
              .strict(),
          ),
          allowed_child_blocks: z.array(sourceAliasSchema),
          phone_behaviour: z.enum(["stack", "hide", "full_width"]),
          resizable_height: z.boolean(),
          live_update: z.boolean(),
          public_page: z.boolean(),
        })
        .strict(),
    ),
    pages: z.array(sourcePageSchema).min(1),
    workflows: z.array(
      z
        .object({
          id: sourceAliasSchema,
          key: builderKeySchema,
          name: z.string().min(1).max(120),
          trigger: z.discriminatedUnion("kind", [
            z
              .object({
                kind: z.literal("event"),
                event: namespacedKeySchema,
                record_type: sourceQualifiedRecordTypeSchema,
                ...sourceWorkflowTriggerCommon,
              })
              .strict(),
            z
              .object({
                kind: z.literal("schedule"),
                schedule: sourceWorkflowScheduleSchema,
                ...sourceWorkflowTriggerCommon,
              })
              .strict(),
            z
              .object({
                kind: z.literal("incoming_message"),
                message: builderKeySchema,
                ...sourceWorkflowTriggerCommon,
              })
              .strict(),
            z
              .object({
                kind: z.literal("button"),
                action: namespacedKeySchema,
                ...sourceWorkflowTriggerCommon,
              })
              .strict(),
            z
              .object({
                kind: z.literal("interface"),
                operation: builderKeySchema,
                ...sourceWorkflowTriggerCommon,
              })
              .strict(),
            z
              .object({
                kind: z.literal("workflow"),
                workflow: builderKeySchema,
                ...sourceWorkflowTriggerCommon,
              })
              .strict(),
          ]),
          run_as: z.enum(["triggering_account", "system_with_source_authority"]),
          maximum_nesting_depth: z.number().int().min(1).max(5),
          nodes: z.array(sourceWorkflowNodeSchema).min(1),
          edges: z.array(
            z.tuple([sourceAliasSchema, sourceAliasSchema, builderKeySchema.optional()]),
          ),
        })
        .strict(),
    ),
    pipelines: z.array(
      z
        .object({
          id: sourceAliasSchema,
          key: builderKeySchema,
          name: z.string().min(1).max(120),
          record_type: sourceQualifiedRecordTypeSchema,
          stage_field: builderKeySchema,
          stages: z
            .array(
              z
                .object({
                  key: builderKeySchema,
                  label: z.string().min(1).max(120),
                  entry_actions: z.array(namespacedKeySchema),
                  exit_actions: z.array(namespacedKeySchema),
                  entry_workflows: z.array(builderKeySchema),
                  exit_workflows: z.array(builderKeySchema),
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
          time_targets: z.array(
            z
              .object({
                stage: builderKeySchema,
                field: builderKeySchema,
                escalation_event: namespacedKeySchema,
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    connection_bindings: z.array(
      z
        .object({
          id: sourceAliasSchema,
          key: builderKeySchema,
          connection_type: namespacedKeySchema,
          version: versionRequirementSchema,
          required_operations: z.array(builderKeySchema).min(1),
        })
        .strict(),
    ),
    interfaces: z.array(
      z
        .object({
          id: sourceAliasSchema,
          key: namespacedKeySchema,
          version: semanticVersionSchema,
          state: z.enum(["supported", "deprecated", "removal_scheduled", "removed"]),
          operations: z.array(sourceInterfaceOperationSchema).min(1),
        })
        .strict(),
    ),
    actions: z.array(
      z
        .object({
          id: sourceAliasSchema,
          key: namespacedKeySchema,
          label: z.string().min(1).max(60),
          record_type: sourceQualifiedRecordTypeSchema,
          permission: namespacedKeySchema,
          sharing: z.enum(["refused", "allowed"]),
          inputs: z.array(actionInputSchema),
          precondition: sourceConditionSchema.optional(),
          effects: z.array(sourceActionEffectSchema).min(1).max(10),
        })
        .strict(),
    ),
    rules: z.array(
      z
        .object({
          id: sourceAliasSchema,
          key: builderKeySchema,
          record_type: sourceQualifiedRecordTypeSchema,
          trigger: z.enum(["create", "change", "delete", "form_change", "action"]),
          priority: z.number().int().min(0).max(10_000),
          condition: sourceConditionSchema,
          effect: sourceRuleEffectSchema,
        })
        .strict(),
    ),
    events: z.array(
      z
        .object({
          id: sourceAliasSchema,
          key: namespacedKeySchema,
          record_type: sourceQualifiedRecordTypeSchema,
          carries: z.array(builderKeySchema),
          personal_or_sensitive_values_allowed: z.literal(false),
        })
        .strict(),
    ),
    public_addresses: z.array(
      z
        .object({
          id: sourceAliasSchema,
          page: builderKeySchema,
          path: z.string().startsWith("/").max(500),
          state: z.enum(["draft", "active", "disabled"]),
          rate_limit_per_minute: z.number().int().min(1).max(10_000),
        })
        .strict(),
    ),
  })
  .strict();
export const applicationSourceDocumentSchema = z
  .object({
    ...authoredSourceBase,
    kind: z.literal("application"),
    body: sourceApplicationBodySchema,
  })
  .strict();
