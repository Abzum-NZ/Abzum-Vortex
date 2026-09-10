import { z } from "zod";
import { workflowValueTypeSchema } from "./catalogues";
import { jsonValueSchema } from "./common";
import {
  applicationRootIdSchema,
  builderKeySchema,
  containedComponentIdSchema,
  eventIdSchema,
  fieldIdSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  permissionIdSchema,
  platformIdSchema,
  queryIdSchema,
  recordTypeIdSchema,
  ruleIdSchema,
  semanticVersionSchema,
  workflowIdSchema,
  workflowNodeIdSchema,
} from "./identifiers";

export const applicationFlowBindingContractVersion = "1.0.0" as const;

/**
 * These descriptors are structural configuration only. Definition compilation must still resolve
 * every referenced flow, query, operation, form and execution binding before publication.
 */
export const flowValueDeclarationSchema = z
  .object({
    type: workflowValueTypeSchema,
    required: z.boolean(),
    recordTypeIds: z.array(recordTypeIdSchema).min(1).max(20).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const isRecordReference =
      value.type === "record_reference" || value.type === "record_reference_list";
    if (isRecordReference !== (value.recordTypeIds !== undefined))
      context.addIssue({
        code: "custom",
        path: ["recordTypeIds"],
        message: "Record-reference values require their allowed record types",
      });
  });

export const componentBindingContextSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page_subject"), recordTypeId: recordTypeIdSchema }).strict(),
  z
    .object({
      kind: z.literal("related_record"),
      relationshipId: containedComponentIdSchema,
      recordTypeId: recordTypeIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("row"),
      controlId: containedComponentIdSchema,
      recordTypeId: recordTypeIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("selection"),
      controlId: containedComponentIdSchema,
      recordTypeId: recordTypeIdSchema,
      cardinality: z.enum(["one", "many"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("form"),
      formId: containedComponentIdSchema,
      recordTypeId: recordTypeIdSchema,
    })
    .strict(),
]);

export const componentFlowInputValueSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("literal"), value: jsonValueSchema }).strict(),
  z
    .object({
      source: z.literal("context_record"),
      context: componentBindingContextSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal("context_field"),
      context: componentBindingContextSchema,
      fieldId: fieldIdSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal("form_input"),
      formId: containedComponentIdSchema,
      input: builderKeySchema,
    })
    .strict(),
  z.object({ source: z.literal("event_input"), input: builderKeySchema }).strict(),
  z.object({ source: z.literal("current_organization_account_id") }).strict(),
]);

export const typedFlowInputBindingSchema = z
  .object({
    type: workflowValueTypeSchema,
    value: componentFlowInputValueSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.value.source === "current_organization_account_id" &&
      value.type !== "organization_account_reference"
    )
      context.addIssue({
        code: "custom",
        path: ["type"],
        message: "The current organisation account has a fixed reference type",
      });
    if (value.value.source !== "context_record") return;
    const expectedType =
      value.value.context.kind === "selection" && value.value.context.cardinality === "many"
        ? "record_reference_list"
        : "record_reference";
    if (value.type !== expectedType)
      context.addIssue({
        code: "custom",
        path: ["type"],
        message: "A record context has a fixed reference type",
      });
  });

export const typedFlowResultMappingSchema = z
  .object({
    output: builderKeySchema,
    type: workflowValueTypeSchema,
  })
  .strict();

export const frontendFlowReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("application_owned"),
      applicationRootId: applicationRootIdSchema,
      flowId: ruleIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("platform_managed"),
      flowId: ruleIdSchema,
      releaseVersion: semanticVersionSchema,
    })
    .strict(),
]);

export const componentSemanticEventKindSchema = z.enum([
  "action",
  "row_action",
  "load",
  "refresh",
  "filter_changed",
  "sort_changed",
  "page_changed",
  "selection_changed",
  "field_changed",
  "form_ready",
  "form_reset",
  "form_submit",
  "tab_changed",
  "guided_step_changed",
]);

export const flowEffectKindSchema = z.enum([
  "pure",
  "read",
  "change",
  "form_interaction",
  "background_start",
]);
export const protectedOperationEffectKindSchema = flowEffectKindSchema.extract([
  "read",
  "change",
  "background_start",
]);

export const componentFlowBindingSchema = z
  .object({
    contractVersion: z.literal(applicationFlowBindingContractVersion),
    controlId: containedComponentIdSchema,
    eventId: eventIdSchema,
    event: componentSemanticEventKindSchema,
    flow: frontendFlowReferenceSchema,
    inputs: z.record(builderKeySchema, typedFlowInputBindingSchema),
    results: z.record(builderKeySchema, typedFlowResultMappingSchema),
    declaredEffects: z.array(flowEffectKindSchema).min(1).max(5),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.declaredEffects).size !== value.declaredEffects.length)
      context.addIssue({
        code: "custom",
        path: ["declaredEffects"],
        message: "Declared flow effects must be unique",
      });
  });

export const protectedOperationOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("application"), applicationRootId: applicationRootIdSchema }).strict(),
  z.object({ kind: z.literal("module"), moduleRootId: moduleRootIdSchema }).strict(),
  z.object({ kind: z.literal("platform_service"), serviceId: platformIdSchema }).strict(),
]);

export const protectedOperationReferenceSchema = z
  .object({
    owner: protectedOperationOwnerSchema,
    operationId: platformIdSchema,
  })
  .strict();

export const protectedOperationPermissionReferenceSchema = z
  .object({ permissionId: permissionIdSchema, key: namespacedKeySchema })
  .strict();

export const safeFlowResultKindSchema = z.enum([
  "completed",
  "committed",
  "refused",
  "conflict",
  "partial",
  "uncertain",
  "background_pending",
  "failed",
]);

export const protectedOperationDescriptorSchema = z
  .object({
    contractVersion: z.literal(applicationFlowBindingContractVersion),
    operation: protectedOperationReferenceSchema,
    inputs: z.record(builderKeySchema, flowValueDeclarationSchema),
    outputs: z.record(builderKeySchema, flowValueDeclarationSchema),
    permission: protectedOperationPermissionReferenceSchema,
    effect: protectedOperationEffectKindSchema,
    expectedRevision: z.enum(["not_required", "required"]),
    confirmation: z.enum(["not_required", "required"]),
    duplicateProtection: z.enum(["not_required", "required"]),
    safeResults: z.array(safeFlowResultKindSchema).min(1).max(8),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.safeResults).size !== value.safeResults.length)
      context.addIssue({
        code: "custom",
        path: ["safeResults"],
        message: "Safe operation results must be unique",
      });
  });

/** Current user always means the original verified initiator. Other modes name Access-owned bindings. */
export const flowNodeRunAsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current_user") }).strict(),
  z
    .object({
      kind: z.literal("specified_user"),
      executionBindingId: containedComponentIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("system"), executionBindingId: containedComponentIdSchema }).strict(),
]);

export const frontendFlowNodeTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("protected_operation"),
      operation: protectedOperationReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("query"),
      moduleRootId: moduleRootIdSchema,
      moduleReleaseVersion: semanticVersionSchema,
      queryId: queryIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("form_continuation"),
      applicationRootId: applicationRootIdSchema,
      formId: containedComponentIdSchema,
      continuationEventId: eventIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("durable_workflow_start"),
      applicationRootId: applicationRootIdSchema,
      workflowId: workflowIdSchema,
    })
    .strict(),
]);

export const flowNodeInputValueSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("literal"), value: jsonValueSchema }).strict(),
  z.object({ source: z.literal("flow_input"), input: builderKeySchema }).strict(),
  z.object({ source: z.literal("flow_variable"), variable: builderKeySchema }).strict(),
  z
    .object({
      source: z.literal("node_output"),
      nodeId: workflowNodeIdSchema,
      output: builderKeySchema,
    })
    .strict(),
  z.object({ source: z.literal("current_organization_account_id") }).strict(),
]);

export const frontendFlowNodeBindingSchema = z
  .object({
    contractVersion: z.literal(applicationFlowBindingContractVersion),
    nodeId: workflowNodeIdSchema,
    target: frontendFlowNodeTargetSchema,
    runAs: flowNodeRunAsSchema,
    inputs: z.record(
      builderKeySchema,
      z
        .object({ type: workflowValueTypeSchema, value: flowNodeInputValueSchema })
        .strict()
        .superRefine((value, context) => {
          if (
            value.value.source === "current_organization_account_id" &&
            value.type !== "organization_account_reference"
          )
            context.addIssue({
              code: "custom",
              path: ["type"],
              message: "The current organisation account has a fixed reference type",
            });
        }),
    ),
    results: z.record(builderKeySchema, typedFlowResultMappingSchema),
  })
  .strict();

export type FlowValueDeclaration = z.infer<typeof flowValueDeclarationSchema>;
export type ComponentBindingContext = z.infer<typeof componentBindingContextSchema>;
export type ComponentFlowInputValue = z.infer<typeof componentFlowInputValueSchema>;
export type TypedFlowInputBinding = z.infer<typeof typedFlowInputBindingSchema>;
export type TypedFlowResultMapping = z.infer<typeof typedFlowResultMappingSchema>;
export type FrontendFlowReference = z.infer<typeof frontendFlowReferenceSchema>;
export type ComponentSemanticEventKind = z.infer<typeof componentSemanticEventKindSchema>;
export type FlowEffectKind = z.infer<typeof flowEffectKindSchema>;
export type ProtectedOperationEffectKind = z.infer<typeof protectedOperationEffectKindSchema>;
export type ComponentFlowBinding = z.infer<typeof componentFlowBindingSchema>;
export type ProtectedOperationOwner = z.infer<typeof protectedOperationOwnerSchema>;
export type ProtectedOperationReference = z.infer<typeof protectedOperationReferenceSchema>;
export type ProtectedOperationPermissionReference = z.infer<
  typeof protectedOperationPermissionReferenceSchema
>;
export type SafeFlowResultKind = z.infer<typeof safeFlowResultKindSchema>;
export type ProtectedOperationDescriptor = z.infer<typeof protectedOperationDescriptorSchema>;
export type FlowNodeRunAs = z.infer<typeof flowNodeRunAsSchema>;
export type FrontendFlowNodeTarget = z.infer<typeof frontendFlowNodeTargetSchema>;
export type FlowNodeInputValue = z.infer<typeof flowNodeInputValueSchema>;
export type FrontendFlowNodeBinding = z.infer<typeof frontendFlowNodeBindingSchema>;
