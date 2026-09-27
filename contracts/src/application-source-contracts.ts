import { z } from "zod";
import {
  applicationExperienceStateSchema,
  workflowValueTypeSchema,
} from "./catalogues";
import { applicationSourceContractVersion } from "./application-contract-versions";
import { builderKeySchema, namespacedKeySchema, semanticVersionSchema } from "./identifiers";
import { jsonValueSchema, labelSchema } from "./common";
import { versionRequirementSchema } from "./definitions";
import {
  refineActionTaskIds,
  sourceActionTaskSchema,
  sourceAliasSchema,
  sourceConditionSchema,
  sourceQualifiedFieldSchema,
  sourceQualifiedQueryReferenceSchema,
  sourceQualifiedRecordTypeSchema,
  sourceProvenanceTarget,
  sourceProvenanceUnchanged,
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
import { sourceComponentFlowBindingSchema } from "./application-flow-bindings";
import { flowAliasSchema, sourceFlowCollectionSchema } from "./flow-source-contracts";

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
    if (Array.isArray(entry.value) && entry.value.length > maximumSourceContainerItems) {
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
/**
 * The fixed set of application experience pages an application may declare: the page shown
 * when an addressed page is refused or missing, when the application or its installation is
 * temporarily unavailable, and when resolving it fails unexpectedly. A refused page and a
 * missing page resolve to the same experience, so their surfaces stay indistinguishable.
 */
const sourceApplicationExperienceSchema = z
  .object({
    state: sourceProvenanceUnchanged(applicationExperienceStateSchema),
    page: sourceProvenanceTarget(builderKeySchema, ["pageId"]),
  })
  .strict();
/** Placement bindings that gate, condition or load data; none may appear on an experience page. */
const sourceExperienceGatedPlacementKeys = [
  "view_permission",
  "use_permission",
  "visibility_condition",
  "query",
  "read_model",
] as const;
const declaresGatedSourcePlacement = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(declaresGatedSourcePlacement);
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    "block" in record &&
    sourceExperienceGatedPlacementKeys.some((key) => record[key] !== undefined)
  )
    return true;
  return Object.values(record).some(declaresGatedSourcePlacement);
};
type SourceNavigation =
  | { id: string; type: "heading"; label: string; children: SourceNavigation[] }
  | { id: string; type: "page"; label: string; page: string; permission: string }
  | { id: string; type: "external"; label: string; address: string; permission: string };
const sourceNavigationSchema: z.ZodType<SourceNavigation> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z
      .object({
        id: sourceProvenanceTarget(sourceAliasSchema, ["id"]),
        type: sourceProvenanceUnchanged(z.literal("heading")),
        label: sourceProvenanceUnchanged(labelSchema),
        children: sourceProvenanceUnchanged(z.array(sourceNavigationSchema).min(1).max(100)),
      })
      .strict(),
    z
      .object({
        id: sourceProvenanceTarget(sourceAliasSchema, ["id"]),
        type: sourceProvenanceUnchanged(z.literal("page")),
        label: sourceProvenanceUnchanged(labelSchema),
        page: sourceProvenanceTarget(builderKeySchema, ["pageId"]),
        permission: sourceProvenanceTarget(namespacedKeySchema, ["permissionKey"]),
      })
      .strict(),
    z
      .object({
        id: sourceProvenanceUnchanged(sourceAliasSchema),
        type: sourceProvenanceUnchanged(z.literal("external")),
        label: sourceProvenanceUnchanged(labelSchema),
        address: sourceProvenanceUnchanged(z.string().url().startsWith("https://")),
        permission: sourceProvenanceTarget(namespacedKeySchema, ["permissionKey"]),
      })
      .strict(),
  ]),
);
// Retired page settings (#1011): accepted as opaque, unused JSON so stored authored
// sources keep their fingerprints and older sources still parse; never compiled.
const retiredSourcePageSettingV2Schema = jsonValueSchema.optional();

const sourcePageV2Common = {
  id: sourceProvenanceTarget(sourceAliasSchema, ["pageId"]),
  key: sourceProvenanceUnchanged(builderKeySchema),
  name: sourceProvenanceUnchanged(labelSchema),
  states: sourceProvenanceUnchanged(retiredSourcePageSettingV2Schema),
  standard_page_replacement: sourceProvenanceUnchanged(retiredSourcePageSettingV2Schema),
};

const sourcePageV2Base = {
  ...sourcePageV2Common,
  composition: sourceProvenanceUnchanged(sourcePageCompositionV2Schema),
};

const sourceListPageV2Schema = z
  .object({
    ...sourcePageV2Base,
    type: sourceProvenanceUnchanged(z.literal("list")),
    record_type: sourceProvenanceTarget(sourceQualifiedRecordTypeSchema, ["recordType/**"]),
    permission: sourceProvenanceTarget(namespacedKeySchema, ["accessPermissionKey"]),
    query: sourceProvenanceTarget(sourceQualifiedQueryReferenceSchema, ["queryId"]),
    arrangements: sourceProvenanceUnchanged(retiredSourcePageSettingV2Schema),
    calendar_mapping: sourceProvenanceUnchanged(retiredSourcePageSettingV2Schema),
  })
  .strict();

const sourceGuidedFormStepV2Schema = z
  .object({
    id: sourceProvenanceTarget(sourceAliasSchema, ["id"]),
    name: sourceProvenanceUnchanged(z.string().min(1).max(60)),
    summary: sourceProvenanceUnchanged(z.boolean()),
  })
  .strict();

export const sourcePageDefinitionV2Schema = z.discriminatedUnion("type", [
  sourceListPageV2Schema,
  z
    .object({
      ...sourcePageV2Base,
      type: sourceProvenanceUnchanged(z.literal("detail")),
      record_type: sourceProvenanceTarget(sourceQualifiedRecordTypeSchema, ["recordType/**"]),
      permission: sourceProvenanceTarget(namespacedKeySchema, ["accessPermissionKey"]),
    })
    .strict(),
  z
    .object({
      ...sourcePageV2Base,
      type: sourceProvenanceUnchanged(z.literal("dashboard")),
      permission: sourceProvenanceTarget(namespacedKeySchema, ["accessPermissionKey"]),
    })
    .strict(),
  z
    .object({
      ...sourcePageV2Base,
      type: sourceProvenanceUnchanged(z.literal("form")),
      record_type: sourceProvenanceTarget(sourceQualifiedRecordTypeSchema, ["recordType/**"]),
      permission: sourceProvenanceTarget(namespacedKeySchema, ["accessPermissionKey"]),
    })
    .strict(),
  z
    .object({
      ...sourcePageV2Common,
      type: sourceProvenanceUnchanged(z.literal("guided_form")),
      record_type: sourceProvenanceTarget(sourceQualifiedRecordTypeSchema, ["recordType/**"]),
      permission: sourceProvenanceTarget(namespacedKeySchema, ["accessPermissionKey"]),
      steps: sourceProvenanceUnchanged(z.array(sourceGuidedFormStepV2Schema).min(2).max(20)),
      composition: sourceProvenanceUnchanged(sourceGuidedFormPageCompositionV2Schema),
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
      type: sourceProvenanceUnchanged(z.literal("public")),
      permission: sourceProvenanceTarget(namespacedKeySchema, ["accessPermissionKey"]),
      record_type: sourceProvenanceTarget(sourceQualifiedRecordTypeSchema.optional(), [
        "recordType/**",
      ]),
      public_fields: sourceProvenanceUnchanged(
        z.array(sourceProvenanceTarget(builderKeySchema, ["publicFieldIds/#"])),
      ),
      public_action: sourceProvenanceTarget(namespacedKeySchema.optional(), ["publicActionKey"]),
      rate_limit_per_minute: sourceProvenanceUnchanged(z.number().int().min(1).max(10_000)),
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
    type: sourceProvenanceUnchanged(
      z.union([sourceInterfaceValueTypeSchema, z.literal("formatted_text")]),
    ),
    required: sourceProvenanceUnchanged(z.boolean()),
    target_binding: sourceProvenanceTarget(
      z.discriminatedUnion("kind", [
        z.object({ kind: sourceProvenanceUnchanged(z.literal("action_subject")) }).strict(),
        z
          .object({
            kind: sourceProvenanceUnchanged(z.literal("action_input")),
            key: sourceProvenanceUnchanged(builderKeySchema),
          })
          .strict(),
      ]),
      ["targetBinding/**"],
      true,
    ),
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
    type: sourceProvenanceUnchanged(sourceInterfaceValueTypeSchema),
    required: sourceProvenanceUnchanged(z.boolean()),
    target_binding: sourceProvenanceTarget(
      z.discriminatedUnion("kind", [
        z
          .object({
            kind: sourceProvenanceUnchanged(z.literal("query_field")),
            field: sourceProvenanceUnchanged(sourceQualifiedFieldSchema),
          })
          .strict(),
        z
          .object({
            kind: sourceProvenanceUnchanged(z.literal("query_page_information")),
            value: sourceProvenanceUnchanged(
              z.enum(["continuation_token", "has_more", "result_count"]),
            ),
          })
          .strict(),
        z.object({ kind: sourceProvenanceUnchanged(z.literal("workflow_run_id")) }).strict(),
      ]),
      ["targetBinding/**"],
      true,
    ),
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
/**
 * What an interface operation calls: an application-owned flow entry point for a change or a
 * background start, never a lower-level action or workflow, or a declared query for a read.
 */
const sourceInterfaceTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("flow")),
      flow: sourceProvenanceTarget(flowAliasSchema, ["flowId"]),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("query")),
      key: sourceProvenanceTarget(builderKeySchema, ["queryId"]),
    })
    .strict(),
]);
const sourceInterfaceOperationSchema = z
  .object({
    key: sourceProvenanceUnchanged(builderKeySchema),
    id: sourceProvenanceTarget(sourceAliasSchema, ["operationId"]),
    description: sourceProvenanceUnchanged(z.string().min(1).max(1_000)),
    method: sourceProvenanceUnchanged(z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"])),
    path: sourceProvenanceUnchanged(z.string().startsWith("/").max(500)),
    input_shape: sourceProvenanceUnchanged(
      z.record(builderKeySchema, sourceInterfaceInputFieldSchema),
    ),
    output_shape: sourceProvenanceUnchanged(
      z.record(builderKeySchema, sourceInterfaceOutputFieldSchema),
    ),
    authentication: sourceProvenanceTarget(
      z.enum(["organisation_token", "partner_token", "public"]),
      ["authentication"],
    ),
    permission: sourceProvenanceTarget(namespacedKeySchema, ["permissionKey"]),
    visibility: sourceProvenanceTarget(z.enum(["organisation_private", "partner", "public"]), [
      "visibility",
    ]),
    rate_limit_per_minute: sourceProvenanceUnchanged(z.number().int().min(1).max(100_000)),
    maximum_request_bytes: sourceProvenanceUnchanged(z.number().int().min(1).max(100_000_000)),
    duplicate_protection: sourceProvenanceUnchanged(z.enum(["not_required", "required"])),
    target: sourceProvenanceUnchanged(sourceInterfaceTargetSchema),
    error_codes: sourceProvenanceUnchanged(z.array(builderKeySchema)),
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
      flow: new Set(["action_subject", "action_input"]),
      query: new Set(),
    };
    const allowedOutputKinds: Record<typeof value.target.kind, ReadonlySet<string>> = {
      flow: new Set(["workflow_run_id"]),
      query: new Set(["query_field", "query_page_information"]),
    };
    for (const kind of inputKinds)
      if (!allowedInputKinds[value.target.kind].has(kind))
        context.addIssue({
          code: "custom",
          path: ["input_shape"],
          message: `A ${value.target.kind} interface accepts only ${value.target.kind} input bindings`,
        });
    for (const kind of outputKinds)
      if (!allowedOutputKinds[value.target.kind].has(kind))
        context.addIssue({
          code: "custom",
          path: ["output_shape"],
          message: `A ${value.target.kind} interface accepts only ${value.target.kind} output bindings`,
        });
  });
export const sourceApplicationBodyV2Schema = z
  .object({
    name: sourceProvenanceUnchanged(z.string().min(1).max(120)),
    description: sourceProvenanceUnchanged(z.string().min(1).max(1_000)),
    icon: sourceProvenanceUnchanged(
      z
        .string()
        .min(1)
        .max(120)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    ),
    home_page: sourceProvenanceTarget(builderKeySchema, ["homePageId"]),
    module_bindings: sourceProvenanceUnchanged(
      z
        .array(
          z
            .object({
              module: sourceProvenanceTarget(namespacedKeySchema, [
                "moduleRootId",
                "resolvedVersion",
              ]),
              version: sourceProvenanceUnchanged(versionRequirementSchema, true),
              purpose: sourceProvenanceUnchanged(builderKeySchema),
            })
            .strict(),
        )
        .min(1)
        .max(100),
    ),
    permissions: sourceProvenanceUnchanged(
      z
        .array(
          z
            .object({
              id: sourceProvenanceTarget(sourceAliasSchema, ["permissionId"]),
              key: sourceProvenanceUnchanged(namespacedKeySchema),
              label: sourceProvenanceUnchanged(labelSchema),
              description: sourceProvenanceUnchanged(z.string().min(1).max(1_000)),
              record_type: sourceProvenanceTarget(sourceQualifiedRecordTypeSchema.optional(), [
                "recordType/**",
              ]),
              action_kind: sourceProvenanceUnchanged(
                z.enum([
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
              ),
              named_action: sourceProvenanceUnchanged(builderKeySchema.optional()),
              administrative: sourceProvenanceUnchanged(z.boolean()),
              record_scope: sourceProvenanceUnchanged(
                moduleSourcePermissionRecordScopeSchema.optional(),
              ),
              field_policy: sourceProvenanceUnchanged(sourcePermissionFieldPolicySchema.optional()),
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
        )
        .max(100),
    ),
    roles: sourceProvenanceUnchanged(
      z
        .array(
          z
            .object({
              id: sourceProvenanceTarget(sourceAliasSchema, ["roleId"]),
              key: sourceProvenanceUnchanged(builderKeySchema),
              name: sourceProvenanceUnchanged(labelSchema),
              home_page: sourceProvenanceTarget(builderKeySchema, ["homePageId"]),
              permissions: sourceProvenanceTarget(
                applicationRolePermissionKeysSchema,
                ["permissionKeys/#", "permissionSelection/kind"],
                true,
              ),
            })
            .strict(),
        )
        .min(1)
        .max(100),
    ),
    navigation: sourceProvenanceUnchanged(z.array(sourceNavigationSchema).max(100)),
    queries: sourceProvenanceUnchanged(
      z
        .array(
          z
            .object({
              id: sourceProvenanceTarget(sourceAliasSchema, ["queryId"]),
              key: sourceProvenanceUnchanged(builderKeySchema),
              record_type: sourceProvenanceTarget(sourceQualifiedRecordTypeSchema, [
                "recordType/**",
              ]),
              select: sourceProvenanceUnchanged(
                z
                  .array(sourceProvenanceTarget(builderKeySchema, ["selectedFieldIds/#"]))
                  .min(1)
                  .max(200),
              ),
              filter: sourceProvenanceUnchanged(sourceFilterSchema),
              group_by: sourceProvenanceUnchanged(
                z.array(sourceProvenanceTarget(builderKeySchema, ["groupByFieldIds/#"])).max(10),
              ),
              aggregates: sourceProvenanceUnchanged(
                z
                  .array(
                    z
                      .object({
                        operation: sourceProvenanceUnchanged(
                          z.enum(["count", "sum", "minimum", "maximum", "average"]),
                        ),
                        field: sourceProvenanceTarget(builderKeySchema.optional(), ["fieldId"]),
                        alias: sourceProvenanceUnchanged(builderKeySchema),
                      })
                      .strict(),
                  )
                  .max(20),
              ),
              sort: sourceProvenanceUnchanged(
                z
                  .array(
                    z
                      .object({
                        field: sourceProvenanceTarget(builderKeySchema, ["fieldId"]),
                        direction: sourceProvenanceUnchanged(z.enum(["ascending", "descending"])),
                      })
                      .strict(),
                  )
                  .min(1)
                  .max(20),
              ),
              page_size: sourceProvenanceUnchanged(z.number().int().min(1).max(200)),
              relationship_hops: sourceProvenanceUnchanged(z.number().int().min(0).max(2)),
            })
            .strict(),
        )
        .max(100),
    ),
    pipelines: sourceProvenanceUnchanged(
      z
        .array(
          z
            .object({
              id: sourceProvenanceTarget(sourceAliasSchema, ["pipelineId"]),
              key: sourceProvenanceUnchanged(builderKeySchema),
              name: sourceProvenanceUnchanged(labelSchema),
              record_type: sourceProvenanceTarget(sourceQualifiedRecordTypeSchema, [
                "recordType/**",
              ]),
              stage_field: sourceProvenanceTarget(builderKeySchema, ["stageFieldId"]),
              stages: sourceProvenanceUnchanged(
                z
                  .array(
                    z
                      .object({
                        key: sourceProvenanceUnchanged(builderKeySchema),
                        label: sourceProvenanceUnchanged(labelSchema),
                        entry_actions: sourceProvenanceUnchanged(
                          z
                            .array(
                              sourceProvenanceTarget(namespacedKeySchema, ["entryActionKeys/#"]),
                            )
                            .max(10),
                        ),
                        exit_actions: sourceProvenanceUnchanged(
                          z
                            .array(
                              sourceProvenanceTarget(namespacedKeySchema, ["exitActionKeys/#"]),
                            )
                            .max(10),
                        ),
                      })
                      .strict(),
                  )
                  .min(1)
                  .max(100),
              ),
              transitions: sourceProvenanceUnchanged(
                z
                  .array(
                    z
                      .object({
                        from: sourceProvenanceUnchanged(builderKeySchema),
                        to: sourceProvenanceUnchanged(builderKeySchema),
                        permission: sourceProvenanceTarget(namespacedKeySchema.optional(), [
                          "permissionKey",
                        ]),
                        action: sourceProvenanceTarget(namespacedKeySchema.optional(), [
                          "actionKey",
                        ]),
                        gate: sourceProvenanceUnchanged(sourceConditionSchema.optional()),
                      })
                      .strict(),
                  )
                  .min(1)
                  .max(200),
              ),
              time_targets: sourceProvenanceUnchanged(
                z
                  .array(
                    z
                      .object({
                        stage: sourceProvenanceTarget(builderKeySchema, ["stageKey"]),
                        field: sourceProvenanceTarget(builderKeySchema, ["dateTimeFieldId"]),
                        escalation_event: sourceProvenanceTarget(namespacedKeySchema, [
                          "escalationEventKey",
                        ]),
                      })
                      .strict(),
                  )
                  .max(100),
              ),
            })
            .strict(),
        )
        .max(100),
    ),
    connection_bindings: sourceProvenanceUnchanged(
      z
        .array(
          z
            .object({
              id: sourceProvenanceTarget(sourceAliasSchema, ["bindingId"]),
              key: sourceProvenanceUnchanged(builderKeySchema),
              connection_type: sourceProvenanceTarget(namespacedKeySchema, [
                "connectionTypeId",
                "resolvedVersion",
              ]),
              version: sourceProvenanceUnchanged(versionRequirementSchema, true),
              required_operations: sourceProvenanceUnchanged(
                z
                  .array(sourceProvenanceTarget(builderKeySchema, ["requiredOperationKeys/#"]))
                  .min(1),
              ),
            })
            .strict(),
        )
        .max(100),
    ),
    interfaces: sourceProvenanceUnchanged(
      z
        .array(
          z
            .object({
              id: sourceProvenanceTarget(sourceAliasSchema, ["interfaceId"]),
              key: sourceProvenanceUnchanged(namespacedKeySchema),
              version: sourceProvenanceUnchanged(semanticVersionSchema),
              state: sourceProvenanceUnchanged(
                z.enum(["supported", "deprecated", "removal_scheduled", "removed"]),
              ),
              operations: sourceProvenanceUnchanged(
                z.array(sourceInterfaceOperationSchema).min(1).max(100),
              ),
            })
            .strict(),
        )
        .max(100),
    ),
    actions: sourceProvenanceUnchanged(
      z
        .array(
          z
            .object({
              id: sourceProvenanceTarget(sourceAliasSchema, ["actionId"]),
              key: sourceProvenanceUnchanged(namespacedKeySchema),
              label: sourceProvenanceUnchanged(labelSchema),
              record_type: sourceProvenanceTarget(sourceQualifiedRecordTypeSchema, [
                "subjectRecordTypeId",
              ]),
              permission: sourceProvenanceTarget(namespacedKeySchema.optional(), ["permissionKey"]),
              permission_alternatives: sourceProvenanceUnchanged(
                z.array(namespacedKeySchema).min(2).optional(),
              ),
              sharing: sourceProvenanceTarget(z.enum(["refused", "allowed"]), ["sharing"]),
              inputs: sourceProvenanceUnchanged(z.array(actionInputSchema).max(50)),
              precondition: sourceProvenanceUnchanged(sourceConditionSchema.optional()),
              tasks: sourceProvenanceUnchanged(
                z.array(sourceActionTaskSchema).min(1).max(10).superRefine(refineActionTaskIds),
              ),
            })
            .strict()
            .superRefine((value, context) => {
              if (
                (value.permission === undefined) ===
                (value.permission_alternatives === undefined)
              )
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
        )
        .max(100),
    ),
    events: sourceProvenanceUnchanged(
      z
        .array(
          z
            .object({
              id: sourceProvenanceTarget(sourceAliasSchema, ["eventId"]),
              key: sourceProvenanceUnchanged(namespacedKeySchema),
              record_type: sourceProvenanceTarget(sourceQualifiedRecordTypeSchema, [
                "recordTypeId",
              ]),
              carries: sourceProvenanceUnchanged(
                z.array(sourceProvenanceTarget(builderKeySchema, ["carriedFieldIds/#"])).max(30),
              ),
              personal_or_sensitive_values_allowed: sourceProvenanceUnchanged(z.literal(false)),
            })
            .strict(),
        )
        .max(100),
    ),
    public_addresses: sourceProvenanceUnchanged(
      z
        .array(
          z
            .object({
              id: sourceProvenanceTarget(sourceAliasSchema, ["addressId"]),
              page: sourceProvenanceTarget(builderKeySchema, ["pageId"]),
              path: sourceProvenanceUnchanged(z.string().startsWith("/").max(500)),
              state: sourceProvenanceUnchanged(z.enum(["draft", "active", "disabled"])),
              rate_limit_per_minute: sourceProvenanceUnchanged(z.number().int().min(1).max(10_000)),
            })
            .strict(),
        )
        .max(100),
    ),
    platform_block_dependencies: sourceProvenanceUnchanged(sourcePlatformBlockDependenciesV2Schema),
    shells: sourceProvenanceUnchanged(z.array(sourceApplicationShellV2Schema).max(100)),
    pages: sourceProvenanceUnchanged(z.array(sourcePageDefinitionV2Schema).min(1).max(100)),
    experiences: sourceProvenanceUnchanged(
      z.array(sourceApplicationExperienceSchema).max(3).optional(),
    ),
    theme: sourceProvenanceUnchanged(sourceApplicationThemeV2Schema),
    /** Every flow this Application owns (architecture decision 1); each has one owner. */
    flows: sourceProvenanceUnchanged(sourceFlowCollectionSchema, true),
    flow_bindings: sourceProvenanceUnchanged(
      z.array(sourceComponentFlowBindingSchema).max(100),
      true,
    ),
  })
  .strict()
  .superRefine((value, context) => {
    const experiences = value.experiences ?? [];
    if (new Set(experiences.map((experience) => experience.state)).size !== experiences.length)
      context.addIssue({
        code: "custom",
        path: ["experiences"],
        message: "Each application experience state may be declared only once",
      });
    for (const [experienceIndex, experience] of experiences.entries()) {
      const page = value.pages.find((candidate) => candidate.key === experience.page);
      if (page === undefined) {
        context.addIssue({
          code: "custom",
          path: ["experiences", experienceIndex, "page"],
          message: "An application experience page must resolve inside the same application",
        });
        continue;
      }
      // Shown before any placement authority or data is projected, so presentation-only.
      const composition = page.composition;
      const shellAlias = composition.shell_kind === "application" ? composition.shell : undefined;
      const shell =
        shellAlias === undefined
          ? undefined
          : value.shells.find((candidate) => candidate.id === shellAlias);
      if (
        declaresGatedSourcePlacement(composition) ||
        (shell !== undefined && declaresGatedSourcePlacement(shell.layout))
      )
        context.addIssue({
          code: "custom",
          path: ["experiences", experienceIndex, "page"],
          message:
            "An application experience page must be presentation-only: no permission-gated, conditional or data-bound placements",
        });
    }
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

    const manifest = new Set(
      value.platform_block_dependencies.map(
        (dependency) => `${dependency.block_id}@${dependency.release_version}`,
      ),
    );
    const used = new Set<string>();
    for (const [, placement] of placementEntries) {
      const identity = `${placement.block.block_id}@${placement.block.release_version}`;
      used.add(identity);
      if (!manifest.has(identity))
        context.addIssue({
          code: "custom",
          path: ["platform_block_dependencies"],
          message: "Every placement must match one exact platform-block dependency",
        });
    }
    if ([...manifest].some((identity) => !used.has(identity)))
      context.addIssue({
        code: "custom",
        path: ["platform_block_dependencies"],
        message: "The platform-block dependency list cannot contain unused releases",
      });

    // Flow aliases and keys are unique in the collection schema; a binding names its flow by either.
    const flowReferences = new Set(value.flows.flatMap((flow) => [flow.id, flow.key]));
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
      if (!flowReferences.has(binding.flow))
        context.addIssue({
          code: "custom",
          path: ["flow_bindings", bindingIndex, "flow"],
          message: "A flow binding must resolve inside the same application",
        });
      if (!placementAliasSet.has(binding.control))
        context.addIssue({
          code: "custom",
          path: ["flow_bindings", bindingIndex, "control"],
          message: "A flow binding control must resolve to a placement inside the application",
        });
    }
  });

export const applicationSourceDocumentV2Schema = z
  .object({
    source_contract_version: sourceProvenanceUnchanged(z.literal(applicationSourceContractVersion)),
    root_alias: sourceProvenanceTarget(sourceAliasSchema, ["rootId"]),
    key: sourceProvenanceUnchanged(namespacedKeySchema),
    kind: sourceProvenanceUnchanged(z.literal("application")),
    body: sourceProvenanceUnchanged(
      z.preprocess(inspectSourceBounds, sourceApplicationBodyV2Schema),
    ),
  })
  .strict();

export type ApplicationSourceDocumentV2 = z.infer<typeof applicationSourceDocumentV2Schema>;
export type SourceApplicationBodyV2 = z.infer<typeof sourceApplicationBodyV2Schema>;
export type SourcePageDefinitionV2 = z.infer<typeof sourcePageDefinitionV2Schema>;
