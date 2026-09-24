import { z } from "zod";
import {
  workflowNodeTypeKeys,
  workflowValueTypeSchema,
} from "./catalogues";
import { applicationSourceContractVersion } from "./application-contract-versions";
import { builderKeySchema, namespacedKeySchema, semanticVersionSchema } from "./identifiers";
import { jsonValueSchema, labelSchema } from "./common";
import { versionRequirementSchema } from "./definitions";
import {
  sourceActionEffectSchema,
  sourceAliasSchema,
  sourceConditionSchema,
  sourceQualifiedFieldSchema,
  sourceQualifiedRelationshipSchema,
  sourceQualifiedConditionSchema,
  sourceQualifiedRecordTypeSchema,
} from "./definition-source-common";
import {
  actionInputSchema,
  moduleSourcePermissionRecordScopeSchema,
  sourcePermissionFieldPolicySchema,
} from "./module-source-contracts";
import { applicationRolePermissionKeysSchema } from "./permissions";
import {
  sourceGuidedFormPageCompositionV2Schema,
  sourceApplicationShellV2Schema,
  sourceApplicationThemeV2Schema,
  sourcePageCompositionV2Schema,
  sourcePlacementEntriesV2,
  sourcePlatformBlockDependenciesV2Schema,
} from "./application-composition-v2";
import {
  sourceComponentFlowBindingSchema,
  sourceCurrentUserFlowSchema,
} from "./application-flow-bindings";

const maximumSourceDocumentNodes = 50_000;
const maximumSourceNestingDepth = 32;
const maximumSourceContainerItems = 1_000;
const maximumSourceStringLength = 1_000_000;

const inspectSourceBounds = (value: unknown, context: z.RefinementCtx) => {
  const pending: {
    value: unknown;
    path: (string | number)[];
    depth: number;
    exit?: object;
  }[] = [{ value, path: [], depth: 0 }];
  const ancestors = new Set<object>();
  let visited = 0;
  while (pending.length > 0) {
    const entry = pending.pop()!;
    if (entry.exit !== undefined) {
      ancestors.delete(entry.exit);
      continue;
    }
    visited += 1;
    if (visited > maximumSourceDocumentNodes) {
      context.addIssue({
        code: "custom",
        path: entry.path,
        message: "Source document is too large",
      });
      return z.NEVER;
    }
    if (entry.depth > maximumSourceNestingDepth) {
      context.addIssue({
        code: "custom",
        path: entry.path,
        message: "Source nesting is too deep",
      });
      return z.NEVER;
    }
    if (typeof entry.value === "string" && entry.value.length > maximumSourceStringLength) {
      context.addIssue({
        code: "custom",
        path: entry.path,
        message: "Source text is too long",
      });
      return z.NEVER;
    }
    if (typeof entry.value !== "object" || entry.value === null) continue;
    if (ancestors.has(entry.value)) {
      context.addIssue({
        code: "custom",
        path: entry.path,
        message: "Source values must be acyclic",
      });
      return z.NEVER;
    }
    if (
      Array.isArray(entry.value) &&
      entry.value.length > maximumSourceContainerItems
    ) {
      context.addIssue({
        code: "custom",
        path: entry.path,
        message: "Source container has too many items",
      });
      return z.NEVER;
    }
    const keys: string[] | undefined = Array.isArray(entry.value) ? undefined : [];
    if (keys !== undefined) {
      for (const key in entry.value) {
        if (!Object.prototype.hasOwnProperty.call(entry.value, key)) continue;
        keys.push(key);
        if (keys.length > maximumSourceContainerItems) break;
      }
    }
    if (keys !== undefined && keys.length > maximumSourceContainerItems) {
      context.addIssue({
        code: "custom",
        path: entry.path,
        message: "Source container has too many items",
      });
      return z.NEVER;
    }
    ancestors.add(entry.value);
    pending.push({ value: undefined, path: [], depth: 0, exit: entry.value });
    const count = keys?.length ?? (entry.value as unknown[]).length;
    for (let index = count - 1; index >= 0; index -= 1) {
      const key = keys?.[index] ?? index;
      const child = (entry.value as Record<string | number, unknown>)[key];
      pending.push({ value: child, path: [...entry.path, key], depth: entry.depth + 1 });
    }
  }
  return value;
};

const sourceFilterSchema = z.union([z.null(), sourceConditionSchema]);
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
        label: labelSchema,
        children: z.array(sourceNavigationSchema).min(1).max(100),
      })
      .strict(),
    z
      .object({
        id: sourceAliasSchema,
        type: z.literal("page"),
        label: labelSchema,
        page: builderKeySchema,
        permission: namespacedKeySchema,
      })
      .strict(),
    z
      .object({
        id: sourceAliasSchema,
        type: z.literal("external"),
        label: labelSchema,
        address: z.string().url().startsWith("https://"),
        permission: namespacedKeySchema,
      })
      .strict(),
  ]),
);
const sourcePageV2Common = {
  id: sourceAliasSchema,
  key: builderKeySchema,
  name: labelSchema,
};

const sourcePageV2Base = {
  ...sourcePageV2Common,
  composition: sourcePageCompositionV2Schema,
};

const sourceListPageV2Schema = z
  .object({
    ...sourcePageV2Base,
    type: z.literal("list"),
    record_type: sourceQualifiedRecordTypeSchema,
    permission: namespacedKeySchema,
    query: builderKeySchema,
  })
  .strict();

const sourceGuidedFormStepV2Schema = z
  .object({ id: sourceAliasSchema, name: z.string().min(1).max(60), summary: z.boolean() })
  .strict();

export const sourcePageDefinitionV2Schema = z.discriminatedUnion("type", [
  sourceListPageV2Schema,
  z
    .object({
      ...sourcePageV2Base,
      type: z.literal("detail"),
      record_type: sourceQualifiedRecordTypeSchema,
      permission: namespacedKeySchema,
    })
    .strict(),
  z
    .object({
      ...sourcePageV2Base,
      type: z.literal("dashboard"),
      permission: namespacedKeySchema,
    })
    .strict(),
  z
    .object({
      ...sourcePageV2Base,
      type: z.literal("form"),
      record_type: sourceQualifiedRecordTypeSchema,
      permission: namespacedKeySchema,
      commit_action: namespacedKeySchema,
    })
    .strict(),
  z
    .object({
      ...sourcePageV2Common,
      type: z.literal("guided_form"),
      record_type: sourceQualifiedRecordTypeSchema,
      permission: namespacedKeySchema,
      commit_action: namespacedKeySchema,
      steps: z.array(sourceGuidedFormStepV2Schema).min(2).max(20),
      composition: sourceGuidedFormPageCompositionV2Schema,
    })
    .strict()
    .superRefine((value, context) => {
      const stepIds = value.steps.map((step) => step.id);
      if (value.steps.filter((step) => step.summary).length !== 1)
        context.addIssue({
          code: "custom",
          path: ["steps"],
          message: "A guided form has exactly one summary step",
        });
      if (new Set(stepIds).size !== stepIds.length)
        context.addIssue({
          code: "custom",
          path: ["steps"],
          message: "Guided-form step aliases must be unique",
        });
      const contentIds = Object.keys(value.composition.step_content);
      if (
        contentIds.length !== stepIds.length ||
        contentIds.some((stepId) => !stepIds.includes(stepId))
      )
        context.addIssue({
          code: "custom",
          path: ["composition", "step_content"],
          message: "Guided-form step content must match every declared step exactly once",
        });
    }),
  z
    .object({
      ...sourcePageV2Base,
      type: z.literal("public"),
      permission: namespacedKeySchema,
      record_type: sourceQualifiedRecordTypeSchema.optional(),
      public_fields: z.array(builderKeySchema),
      public_action: namespacedKeySchema.optional(),
      rate_limit_per_minute: z.number().int().min(1).max(10_000),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.record_type === undefined &&
        (value.public_fields.length > 0 || value.public_action !== undefined)
      )
        context.addIssue({
          code: "custom",
          path: ["record_type"],
          message: "A public record field or action requires an explicit record type",
        });
    }),
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
const isSourceRecordReferenceType = (type: string) =>
  type === "record_reference" || type === "record_reference_list";
const sourceWorkflowDeclaredOutputSchema = z
  .object({
    key: builderKeySchema,
    type: workflowValueTypeSchema,
    record_types: z.array(sourceQualifiedRecordTypeSchema).min(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (isSourceRecordReferenceType(value.type) !== (value.record_types !== undefined))
      context.addIssue({
        code: "custom",
        path: ["record_types"],
        message: "Record-reference and record-list outputs require their allowed record types",
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
      relationships: z.array(sourceQualifiedRelationshipSchema).min(1).max(100),
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
      outputs: z.array(sourceWorkflowDeclaredOutputSchema).min(1).max(100),
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
    if (isSourceRecordReferenceType(value.type) !== (value.record_types !== undefined))
      context.addIssue({
        code: "custom",
        path: ["record_types"],
        message: "Record-reference and record-list inputs require their allowed record types",
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
    type: z.union([sourceInterfaceValueTypeSchema, z.literal("formatted_text")]),
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
export const sourceApplicationBodyV2Schema = z
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
      .min(1)
      .max(100),
    permissions: z.array(
      z
        .object({
          id: sourceAliasSchema,
          key: namespacedKeySchema,
          label: labelSchema,
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
          record_scope: moduleSourcePermissionRecordScopeSchema.optional(),
          field_policy: sourcePermissionFieldPolicySchema.optional(),
        })
        .strict()
        .superRefine((value, context) => {
          if (value.field_policy !== undefined && value.record_type === undefined)
            context.addIssue({
              code: "custom",
              path: ["field_policy"],
              message: "Only record permissions may declare a field policy",
            });
        }),
    ).max(100),
    roles: z
      .array(
        z
          .object({
            id: sourceAliasSchema,
            key: builderKeySchema,
            name: labelSchema,
            home_page: builderKeySchema,
            permissions: applicationRolePermissionKeysSchema,
          })
          .strict(),
      )
      .min(1)
      .max(100),
    navigation: z.array(sourceNavigationSchema).max(100),
    queries: z.array(
      z
        .object({
          id: sourceAliasSchema,
          key: builderKeySchema,
          record_type: sourceQualifiedRecordTypeSchema,
          select: z.array(builderKeySchema).min(1).max(200),
          filter: sourceFilterSchema,
          group_by: z.array(builderKeySchema).max(10),
          aggregates: z.array(
            z
              .object({
                operation: z.enum(["count", "sum", "minimum", "maximum", "average"]),
                field: builderKeySchema.optional(),
                alias: builderKeySchema,
              })
              .strict(),
          ).max(20),
          sort: z
            .array(
              z
                .object({ field: builderKeySchema, direction: z.enum(["ascending", "descending"]) })
                .strict(),
            )
            .min(1)
            .max(20),
          page_size: z.number().int().min(1).max(200),
          relationship_hops: z.number().int().min(0).max(2),
        })
        .strict(),
    ).max(100),
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
          nodes: z.array(sourceWorkflowNodeSchema).min(1).max(100),
          edges: z.array(
            z.tuple([sourceAliasSchema, sourceAliasSchema, builderKeySchema.optional()]),
          ).max(200),
        })
        .strict(),
    ).max(100),
    pipelines: z.array(
      z
        .object({
          id: sourceAliasSchema,
          key: builderKeySchema,
          name: labelSchema,
          record_type: sourceQualifiedRecordTypeSchema,
          stage_field: builderKeySchema,
          stages: z
            .array(
              z
                .object({
                  key: builderKeySchema,
                  label: labelSchema,
                  entry_actions: z.array(namespacedKeySchema).max(10),
                  exit_actions: z.array(namespacedKeySchema).max(10),
                  entry_workflows: z.array(builderKeySchema).max(10),
                  exit_workflows: z.array(builderKeySchema).max(10),
                })
                .strict(),
            )
            .min(1)
            .max(100),
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
            .min(1)
            .max(200),
          time_targets: z.array(
            z
              .object({
                stage: builderKeySchema,
                field: builderKeySchema,
                escalation_event: namespacedKeySchema,
              })
              .strict(),
          ).max(100),
        })
        .strict(),
    ).max(100),
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
    ).max(100),
    interfaces: z.array(
      z
        .object({
          id: sourceAliasSchema,
          key: namespacedKeySchema,
          version: semanticVersionSchema,
          state: z.enum(["supported", "deprecated", "removal_scheduled", "removed"]),
          operations: z.array(sourceInterfaceOperationSchema).min(1).max(100),
        })
        .strict(),
    ).max(100),
    actions: z.array(
      z
        .object({
          id: sourceAliasSchema,
          key: namespacedKeySchema,
          label: labelSchema,
          record_type: sourceQualifiedRecordTypeSchema,
          permission: namespacedKeySchema.optional(),
          permission_alternatives: z.array(namespacedKeySchema).min(2).optional(),
          sharing: z.enum(["refused", "allowed"]),
          inputs: z.array(actionInputSchema).max(50),
          precondition: sourceConditionSchema.optional(),
          effects: z.array(sourceActionEffectSchema).min(1).max(10),
        })
        .strict()
        .superRefine((value, context) => {
          if ((value.permission === undefined) === (value.permission_alternatives === undefined))
            context.addIssue({
              code: "custom",
              path: ["permission_alternatives"],
              message: "An action requires either one permission or canonical alternatives",
            });
          const alternatives = value.permission_alternatives;
          if (!alternatives) return;
          if (new Set(alternatives).size !== alternatives.length)
            context.addIssue({
              code: "custom",
              path: ["permission_alternatives"],
              message: "Action permission alternatives must be unique",
            });
          if (
            alternatives.some(
              (permission, index) => index > 0 && alternatives[index - 1]! >= permission,
            )
          )
            context.addIssue({
              code: "custom",
              path: ["permission_alternatives"],
              message: "Action permission alternatives must use canonical order",
            });
        }),
    ).max(100),
    events: z.array(
      z
        .object({
          id: sourceAliasSchema,
          key: namespacedKeySchema,
          record_type: sourceQualifiedRecordTypeSchema,
          carries: z.array(builderKeySchema).max(30),
          personal_or_sensitive_values_allowed: z.literal(false),
        })
        .strict(),
    ).max(100),
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
    ).max(100),
    platform_block_dependencies: sourcePlatformBlockDependenciesV2Schema,
    shells: z.array(sourceApplicationShellV2Schema).max(100),
    pages: z.array(sourcePageDefinitionV2Schema).min(1).max(100),
    theme: sourceApplicationThemeV2Schema,
    flows: z.array(sourceCurrentUserFlowSchema).max(100),
    flow_bindings: z.array(sourceComponentFlowBindingSchema).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const shellAliases = value.shells.map((shell) => shell.id);
    const shellKeys = value.shells.map((shell) => shell.key);
    if (new Set(shellAliases).size !== shellAliases.length)
      context.addIssue({
        code: "custom",
        path: ["shells"],
        message: "Shell aliases must be unique",
      });
    if (new Set(shellKeys).size !== shellKeys.length)
      context.addIssue({ code: "custom", path: ["shells"], message: "Shell keys must be unique" });
    const contentSlotAliases = value.shells.flatMap((shell) =>
      shell.content_slots.map((slot) => slot.id),
    );
    if (new Set(contentSlotAliases).size !== contentSlotAliases.length)
      context.addIssue({
        code: "custom",
        path: ["shells"],
        message: "Shell content-slot aliases must be unique across the application",
      });

    const placementEntries = value.shells.flatMap((shell) =>
      sourcePlacementEntriesV2(shell.layout),
    );
    const shellsByAlias = new Map(value.shells.map((shell) => [shell.id, shell]));
    const validateShellContent = (
      content: Record<string, { placements: Record<string, unknown> }>,
      shell: (typeof value.shells)[number],
      path: (string | number)[],
    ) => {
      const allowed = new Set(shell.content_slots.map((slot) => slot.id));
      const required = shell.content_slots.filter((slot) => slot.required).map((slot) => slot.id);
      const supplied = Object.keys(content);
      if (supplied.some((slotId) => !allowed.has(slotId)))
        context.addIssue({
          code: "custom",
          path,
          message: "Page content may bind only slots declared by its shell",
        });
      if (
        required.some((slotId) => {
          const slot = content[slotId];
          return slot === undefined || Object.keys(slot.placements).length === 0;
        })
      )
        context.addIssue({
          code: "custom",
          path,
          message: "Page content must bind non-empty content to every required shell slot",
        });
    };
    for (const [pageIndex, page] of value.pages.entries()) {
      const composition = page.composition;
      if ("step_content" in composition) {
        if (composition.shell_kind === "default") {
          for (const slot of Object.values(composition.step_content))
            placementEntries.push(...sourcePlacementEntriesV2(slot));
          continue;
        }
        const shell = shellsByAlias.get(composition.shell);
        if (shell === undefined)
          context.addIssue({
            code: "custom",
            path: ["pages", pageIndex, "composition", "shell"],
            message: "A page shell must resolve inside the same application",
          });
        for (const [stepId, content] of Object.entries(composition.step_content)) {
          if (shell !== undefined)
            validateShellContent(content, shell, [
              "pages",
              pageIndex,
              "composition",
              "step_content",
              stepId,
            ]);
          for (const slot of Object.values(content))
            placementEntries.push(...sourcePlacementEntriesV2(slot));
        }
        continue;
      }
      if (composition.shell_kind === "default")
        placementEntries.push(...sourcePlacementEntriesV2(composition.main));
      else {
        const shell = shellsByAlias.get(composition.shell);
        if (shell === undefined)
          context.addIssue({
            code: "custom",
            path: ["pages", pageIndex, "composition", "shell"],
            message: "A page shell must resolve inside the same application",
          });
        else
          validateShellContent(composition.content, shell, [
            "pages",
            pageIndex,
            "composition",
            "content",
          ]);
        for (const slot of Object.values(composition.content))
          placementEntries.push(...sourcePlacementEntriesV2(slot));
      }
    }

    const placementAliases = placementEntries.map(([placementId]) => placementId);
    if (new Set(placementAliases).size !== placementAliases.length)
      context.addIssue({
        code: "custom",
        path: ["pages"],
        message: "Placement aliases must be unique across the application",
      });

    const manifest = new Map(
      value.platform_block_dependencies.map((dependency) => [
        String(dependency.block_id),
        dependency.release_version,
      ]),
    );
    const used = new Set<string>();
    for (const [, placement] of placementEntries) {
      const blockId = String(placement.block.block_id);
      used.add(blockId);
      if (manifest.get(blockId) !== placement.block.release_version)
        context.addIssue({
          code: "custom",
          path: ["platform_block_dependencies"],
          message: "Every placement must match one exact platform-block dependency",
        });
    }
    if ([...manifest.keys()].some((blockId) => !used.has(blockId)))
      context.addIssue({
        code: "custom",
        path: ["platform_block_dependencies"],
        message: "The platform-block dependency list cannot contain unused releases",
      });

    const flowAliases = value.flows.map((flow) => flow.id);
    const flowKeys = value.flows.map((flow) => flow.key);
    if (new Set(flowAliases).size !== flowAliases.length)
      context.addIssue({ code: "custom", path: ["flows"], message: "Flow aliases must be unique" });
    if (new Set(flowKeys).size !== flowKeys.length)
      context.addIssue({ code: "custom", path: ["flows"], message: "Flow keys must be unique" });

    const flowsByAlias = new Map(value.flows.map((flow) => [flow.id, flow]));
    const placementAliasSet = new Set(placementEntries.map(([alias]) => alias));
    const flowBindingAliases = value.flow_bindings.map((binding) => binding.id);
    const flowBindingEvents = value.flow_bindings.map(
      (binding) => `${binding.control}:${binding.event_id}`,
    );
    if (new Set(flowBindingAliases).size !== flowBindingAliases.length)
      context.addIssue({
        code: "custom",
        path: ["flow_bindings"],
        message: "Flow binding aliases must be unique",
      });
    if (new Set(flowBindingEvents).size !== flowBindingEvents.length)
      context.addIssue({
        code: "custom",
        path: ["flow_bindings"],
        message: "A control event can have only one flow binding",
      });
    for (const [bindingIndex, binding] of value.flow_bindings.entries()) {
      if (binding.flow.kind === "application_owned") {
        const flow = flowsByAlias.get(binding.flow.flow);
        if (flow === undefined) {
          context.addIssue({
            code: "custom",
            path: ["flow_bindings", bindingIndex, "flow"],
            message: "A flow binding must resolve inside the same application",
          });
        }
      }
      if (!placementAliasSet.has(binding.control)) {
        context.addIssue({
          code: "custom",
          path: ["flow_bindings", bindingIndex, "control"],
          message: "A flow binding control must resolve to a placement inside the application",
        });
      }
    }
  });

export const applicationSourceDocumentV2Schema = z
  .object({
    source_contract_version: z.literal(applicationSourceContractVersion),
    root_alias: sourceAliasSchema,
    key: namespacedKeySchema,
    kind: z.literal("application"),
    body: z.preprocess(inspectSourceBounds, sourceApplicationBodyV2Schema),
  })
  .strict();

export type ApplicationSourceDocumentV2 = z.infer<typeof applicationSourceDocumentV2Schema>;
export type SourceApplicationBodyV2 = z.infer<typeof sourceApplicationBodyV2Schema>;
export type SourcePageDefinitionV2 = z.infer<typeof sourcePageDefinitionV2Schema>;
