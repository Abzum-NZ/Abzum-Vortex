import { z } from "zod";
import { workflowValueTypeSchema } from "./catalogues";
import { jsonValueSchema, labelSchema } from "./common";
import {
  sourceAliasSchema,
  sourceQualifiedConditionSchema,
  sourceQualifiedRecordTypeSchema,
  sourceQualifiedRelationshipSchema,
} from "./definition-source-common";
import { conditionNodeSchema } from "./module-contracts";
import {
  actorIdSchema,
  applicationRootIdSchema,
  builderKeySchema,
  containedComponentIdSchema,
  eventIdSchema,
  fieldIdSchema,
  fingerprintSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  permissionIdSchema,
  platformIdSchema,
  queryIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  ruleIdSchema,
  stableDefinitionReleaseVersionSchema,
  timestampSchema,
  workflowIdSchema,
  workflowNodeIdSchema,
} from "./identifiers";
import { versionRequirementSchema } from "./definitions";

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
  z
    .object({
      kind: z.literal("response"),
      formId: containedComponentIdSchema,
      recordTypeId: recordTypeIdSchema.optional(),
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
    if (value.value.context.kind === "response") {
      context.addIssue({
        code: "custom",
        path: ["value", "context", "kind"],
        message: "A response context does not produce a record reference",
      });
      return;
    }
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

/** Immutable evidence attached to every Definition-owned flow target. */
export const resolvedFlowTargetEvidenceSchema = z
  .object({
    releaseVersion: stableDefinitionReleaseVersionSchema,
    contentFingerprint: fingerprintSchema,
    resolutionFingerprint: fingerprintSchema,
  })
  .strict();

export const frontendFlowReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("application_owned"),
      applicationRootId: applicationRootIdSchema,
      flowId: ruleIdSchema,
      ...resolvedFlowTargetEvidenceSchema.shape,
    })
    .strict(),
  z
    .object({
      kind: z.literal("platform_managed"),
      flowId: ruleIdSchema,
      releaseVersion: stableDefinitionReleaseVersionSchema,
      contentFingerprint: fingerprintSchema,
      catalogueFingerprint: fingerprintSchema,
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
    bindingId: containedComponentIdSchema,
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

/**
 * Exact manifest entries for targets contained by an Application release. These are deliberately
 * separate from Module/connection dependencies: a target is pinned by its permanent owner and
 * contained identity, not by a caller-supplied key or label.
 */
const flowTargetDependencyCommon = {
  releaseVersion: stableDefinitionReleaseVersionSchema,
  contentFingerprint: fingerprintSchema,
  resolutionFingerprint: fingerprintSchema,
};

export const flowTargetDependencySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("application_flow"),
      applicationRootId: applicationRootIdSchema,
      flowId: ruleIdSchema,
      ...flowTargetDependencyCommon,
    })
    .strict(),
  z
    .object({
      kind: z.literal("application_flow_node"),
      applicationRootId: applicationRootIdSchema,
      flowId: ruleIdSchema,
      nodeId: workflowNodeIdSchema,
      ...flowTargetDependencyCommon,
    })
    .strict(),
  z
    .object({
      kind: z.literal("application_query"),
      applicationRootId: applicationRootIdSchema,
      queryId: queryIdSchema,
      ...flowTargetDependencyCommon,
    })
    .strict(),
  z
    .object({
      kind: z.literal("module_query"),
      moduleRootId: moduleRootIdSchema,
      queryId: queryIdSchema,
      declaredRequirement: versionRequirementSchema,
      ...flowTargetDependencyCommon,
    })
    .strict(),
  z
    .object({
      kind: z.literal("protected_operation"),
      operation: protectedOperationReferenceSchema,
      ...flowTargetDependencyCommon,
      catalogueFingerprint: fingerprintSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("application_form"),
      applicationRootId: applicationRootIdSchema,
      formId: containedComponentIdSchema,
      ...flowTargetDependencyCommon,
    })
    .strict(),
  z
    .object({
      kind: z.literal("application_workflow"),
      applicationRootId: applicationRootIdSchema,
      workflowId: workflowIdSchema,
      ...flowTargetDependencyCommon,
    })
    .strict(),
  z
    .object({
      kind: z.literal("application_action"),
      applicationRootId: applicationRootIdSchema,
      actionId: containedComponentIdSchema,
      ...flowTargetDependencyCommon,
    })
    .strict(),
  z
    .object({
      kind: z.literal("module_record_type"),
      moduleRootId: moduleRootIdSchema,
      recordTypeId: recordTypeIdSchema,
      ...flowTargetDependencyCommon,
    })
    .strict(),
  z
    .object({
      kind: z.literal("module_action"),
      moduleRootId: moduleRootIdSchema,
      actionId: containedComponentIdSchema,
      ...flowTargetDependencyCommon,
    })
    .strict(),
]);

/** Exact immutable authority for a platform-managed flow catalogue release. */
export const platformManagedFlowDependencySchema = z
  .object({
    kind: z.literal("platform_flow"),
    flowId: ruleIdSchema,
    releaseVersion: stableDefinitionReleaseVersionSchema,
    contentFingerprint: fingerprintSchema,
    catalogueFingerprint: fingerprintSchema,
  })
  .strict();

export const platformServiceOperationReleaseSchema = z
  .object({
    serviceId: platformIdSchema,
    operationId: platformIdSchema,
    releaseVersion: stableDefinitionReleaseVersionSchema,
    contentFingerprint: fingerprintSchema,
    catalogueFingerprint: fingerprintSchema,
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
  "validation",
  "partial",
  "uncertain",
  "background_pending",
  "failed",
]);

const fixedResultDescriptorSchema = <
  Outcome extends SafeFlowResultKind,
  Commit extends string,
  Outputs extends string,
  Recovery extends string,
>(
  outcome: Outcome,
  commit: Commit,
  outputs: Outputs,
  recovery: Recovery,
) =>
  z
    .object({
      outcome: z.literal(outcome),
      commit: z.literal(commit),
      outputs: z.literal(outputs),
      recovery: z.literal(recovery),
    })
    .strict();

/**
 * Shared presentation semantics for every safe flow result. Each outcome fixes its own commit
 * state, output availability and recovery path, so a partial, uncertain or background-pending
 * result can never be rendered as success or as one another. Safe error detail belongs to the
 * runtime result, not this descriptor.
 */
export const safeFlowResultDescriptorSchema = z.discriminatedUnion("outcome", [
  fixedResultDescriptorSchema("completed", "none", "available", "none"),
  fixedResultDescriptorSchema("committed", "confirmed", "available", "none"),
  fixedResultDescriptorSchema("refused", "none", "unavailable", "change_request"),
  fixedResultDescriptorSchema("conflict", "none", "unavailable", "refresh_and_review"),
  fixedResultDescriptorSchema("validation", "none", "unavailable", "correct_inputs"),
  // Earlier commits are preserved, unexecuted changes stay unapplied and nothing is rolled back.
  fixedResultDescriptorSchema("partial", "partial", "unavailable", "review_committed_effects"),
  // The same invocation must be reconciled through its receipt before any retry or continuation.
  fixedResultDescriptorSchema("uncertain", "unknown", "unavailable", "reconcile_before_retry"),
  // Intent is durably accepted; completion is reported by the background work, not this result.
  fixedResultDescriptorSchema(
    "background_pending",
    "accepted",
    "unavailable",
    "await_background_result",
  ),
  fixedResultDescriptorSchema("failed", "none", "unavailable", "new_invocation"),
]);

/** The one shared result map: every safe flow result kind to its fixed descriptor. */
export const safeFlowResultDescriptors: Readonly<{
  [Outcome in SafeFlowResultKind]: Extract<SafeFlowResultDescriptor, { outcome: Outcome }>;
}> = Object.freeze({
  completed: { outcome: "completed", commit: "none", outputs: "available", recovery: "none" },
  committed: { outcome: "committed", commit: "confirmed", outputs: "available", recovery: "none" },
  refused: {
    outcome: "refused",
    commit: "none",
    outputs: "unavailable",
    recovery: "change_request",
  },
  conflict: {
    outcome: "conflict",
    commit: "none",
    outputs: "unavailable",
    recovery: "refresh_and_review",
  },
  validation: {
    outcome: "validation",
    commit: "none",
    outputs: "unavailable",
    recovery: "correct_inputs",
  },
  partial: {
    outcome: "partial",
    commit: "partial",
    outputs: "unavailable",
    recovery: "review_committed_effects",
  },
  uncertain: {
    outcome: "uncertain",
    commit: "unknown",
    outputs: "unavailable",
    recovery: "reconcile_before_retry",
  },
  background_pending: {
    outcome: "background_pending",
    commit: "accepted",
    outputs: "unavailable",
    recovery: "await_background_result",
  },
  failed: { outcome: "failed", commit: "none", outputs: "unavailable", recovery: "new_invocation" },
});

/** Declared results must be unique and are rendered in declaration order. */
const safeFlowResultDescriptorListSchema = z
  .array(safeFlowResultDescriptorSchema)
  .min(1)
  .max(safeFlowResultKindSchema.options.length)
  .superRefine((value, context) => {
    if (new Set(value.map((result) => result.outcome)).size !== value.length)
      context.addIssue({
        code: "custom",
        message: "Declared flow results must be unique",
      });
  });

/** Results an operation may report for its declared effect; the first is its confirmed result. */
const protectedOperationResultsByEffect: Readonly<
  Record<ProtectedOperationEffectKind, readonly [SafeFlowResultKind, ...SafeFlowResultKind[]]>
> = {
  read: ["completed", "refused", "validation", "failed"],
  change: ["committed", "refused", "conflict", "validation", "partial", "uncertain", "failed"],
  background_start: [
    "background_pending",
    "refused",
    "conflict",
    "validation",
    "uncertain",
    "failed",
  ],
};

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
    safeResults: z
      .array(safeFlowResultKindSchema)
      .min(1)
      .max(safeFlowResultKindSchema.options.length),
  })
  .strict()
  .superRefine((value, context) => {
    const declared = new Set(value.safeResults);
    if (declared.size !== value.safeResults.length)
      context.addIssue({
        code: "custom",
        path: ["safeResults"],
        message: "Safe operation results must be unique",
      });
    const permitted = protectedOperationResultsByEffect[value.effect];
    if (value.safeResults.some((result) => !permitted.includes(result)))
      context.addIssue({
        code: "custom",
        path: ["safeResults"],
        message: "An operation can only report results possible for its declared effect",
      });
    if (!declared.has(permitted[0]) || !declared.has("refused"))
      context.addIssue({
        code: "custom",
        path: ["safeResults"],
        message: "An operation must declare its confirmed result and its permission refusal",
      });
    if (declared.has("conflict") !== (value.expectedRevision === "required"))
      context.addIssue({
        code: "custom",
        path: ["safeResults"],
        message: "A conflict result is declared exactly when an expected revision is required",
      });
    if (declared.has("uncertain") && value.duplicateProtection !== "required")
      context.addIssue({
        code: "custom",
        path: ["safeResults"],
        message: "An uncertain result requires duplicate protection for receipt reconciliation",
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

/**
 * An execution binding is an Access-owned grant, separate from the editable run-as reference a
 * definition carries. It names one exact organisation, application release, flow node, protected
 * operation and effective actor, plus who may invoke it, on which surfaces, with which declared
 * inputs and until when. Editing, installing, copying or delegating a role never creates one.
 */
export const flowExecutionBindingSurfaceSchema = z.enum([
  "web",
  "mcp",
  "programmatic_interface",
  "durable_workflow",
  "system",
]);

export const flowExecutionInvokerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("system") }).strict(),
  z
    .object({
      kind: z.literal("organization_account"),
      organizationAccountId: organizationAccountIdSchema,
    })
    .strict(),
]);

export const flowExecutionBindingActorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("specified_user"),
      organizationAccountId: organizationAccountIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("system"), systemActorId: actorIdSchema }).strict(),
]);

export const flowExecutionBindingStateSchema = z.enum(["active", "revoked"]);

export const flowExecutionBindingEffectiveStateSchema = z.enum(["active", "revoked", "expired"]);

const uniqueBy = <Value>(
  values: readonly Value[],
  identify: (value: Value) => string,
): boolean => new Set(values.map(identify)).size === values.length;

export const flowExecutionPermittedInvokersSchema = z
  .array(flowExecutionInvokerSchema)
  .min(1)
  .max(20)
  .superRefine((value, context) => {
    if (
      !uniqueBy(value, (invoker) =>
        invoker.kind === "system"
          ? "system"
          : `account:${invoker.organizationAccountId.toLowerCase()}`,
      )
    )
      context.addIssue({ code: "custom", message: "Permitted invokers must be unique" });
  });

export const flowExecutionPermittedSurfacesSchema = z
  .array(flowExecutionBindingSurfaceSchema)
  .min(1)
  .max(flowExecutionBindingSurfaceSchema.options.length)
  .superRefine((value, context) => {
    if (!uniqueBy(value, (surface) => surface))
      context.addIssue({ code: "custom", message: "Permitted surfaces must be unique" });
  });

export const flowExecutionPermittedInputsSchema = z
  .array(builderKeySchema)
  .max(20)
  .superRefine((value, context) => {
    if (!uniqueBy(value, (input) => input))
      context.addIssue({ code: "custom", message: "Permitted inputs must be unique" });
  });

/** A system actor runs only under the system origin; a specified person never does. */
export const refineFlowExecutionActorInvokers = (
  value: {
    actor: z.infer<typeof flowExecutionBindingActorSchema>;
    permittedInvokers: z.infer<typeof flowExecutionInvokerSchema>[];
  },
  context: z.RefinementCtx,
): void => {
  const permitsSystemOrigin = value.permittedInvokers.some((invoker) => invoker.kind === "system");
  if (value.actor.kind === "system" && !permitsSystemOrigin)
    context.addIssue({
      code: "custom",
      path: ["permittedInvokers"],
      message: "A system execution binding must permit the system origin",
    });
  if (value.actor.kind === "specified_user" && permitsSystemOrigin)
    context.addIssue({
      code: "custom",
      path: ["permittedInvokers"],
      message: "A specified-user execution binding cannot permit the system origin",
    });
};

export const flowExecutionBindingSchema = z
  .object({
    executionBindingId: containedComponentIdSchema,
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    releaseVersion: stableDefinitionReleaseVersionSchema,
    flowId: ruleIdSchema,
    nodeId: workflowNodeIdSchema,
    operation: protectedOperationReferenceSchema,
    actor: flowExecutionBindingActorSchema,
    permittedInvokers: flowExecutionPermittedInvokersSchema,
    permittedSurfaces: flowExecutionPermittedSurfacesSchema,
    permittedInputs: flowExecutionPermittedInputsSchema,
    expiresAt: timestampSchema.optional(),
    state: flowExecutionBindingStateSchema,
    revision: revisionSchema,
    recordedAt: timestampSchema,
    revokedAt: timestampSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    refineFlowExecutionActorInvokers(value, context);
    if ((value.state === "revoked") !== (value.revokedAt !== undefined))
      context.addIssue({
        code: "custom",
        path: ["revokedAt"],
        message: "Exactly a revoked execution binding records its revocation time",
      });
  });

export const frontendFlowNodeTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("protected_operation"),
      operation: protectedOperationReferenceSchema,
      ...resolvedFlowTargetEvidenceSchema.shape,
      catalogueFingerprint: fingerprintSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("query"),
      moduleRootId: moduleRootIdSchema,
      moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
      queryId: queryIdSchema,
      declaredRequirement: versionRequirementSchema,
      contentFingerprint: fingerprintSchema,
      resolutionFingerprint: fingerprintSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("form_continuation"),
      applicationRootId: applicationRootIdSchema,
      formId: containedComponentIdSchema,
      continuationEventId: eventIdSchema,
      ...resolvedFlowTargetEvidenceSchema.shape,
    })
    .strict(),
  z
    .object({
      kind: z.literal("durable_workflow_start"),
      applicationRootId: applicationRootIdSchema,
      workflowId: workflowIdSchema,
      ...resolvedFlowTargetEvidenceSchema.shape,
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

export const flowNodeInputBindingSchema = z
  .object({
    type: workflowValueTypeSchema,
    value: flowNodeInputValueSchema,
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
  });

const currentUserFlowRunAsSchema = z
  .object({ kind: z.literal("current_user") })
  .strict();

export const flowVariableDeclarationSchema = z
  .object({
    key: builderKeySchema,
    name: labelSchema.optional(),
    type: workflowValueTypeSchema,
    recordTypeIds: z.array(recordTypeIdSchema).min(1).max(20).optional(),
    defaultValue: jsonValueSchema.optional(),
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

export const currentUserFlowQueryTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("query"),
      moduleRootId: moduleRootIdSchema,
      moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
      queryId: queryIdSchema,
      declaredRequirement: versionRequirementSchema,
      contentFingerprint: fingerprintSchema,
      resolutionFingerprint: fingerprintSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("application_query"),
      queryId: queryIdSchema,
      applicationRootId: applicationRootIdSchema,
      releaseVersion: stableDefinitionReleaseVersionSchema,
      contentFingerprint: fingerprintSchema,
      resolutionFingerprint: fingerprintSchema,
    })
    .strict(),
]);

export const currentUserFlowActionTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("protected_operation"),
      operation: protectedOperationReferenceSchema,
      ...resolvedFlowTargetEvidenceSchema.shape,
      catalogueFingerprint: fingerprintSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("form_continuation"),
      applicationRootId: applicationRootIdSchema,
      formId: containedComponentIdSchema,
      continuationEventId: eventIdSchema,
      ...resolvedFlowTargetEvidenceSchema.shape,
    })
    .strict(),
  z
    .object({
      kind: z.literal("durable_workflow_start"),
      applicationRootId: applicationRootIdSchema,
      workflowId: workflowIdSchema,
      ...resolvedFlowTargetEvidenceSchema.shape,
    })
    .strict(),
  z
    .object({
      kind: z.literal("application_action"),
      actionKey: namespacedKeySchema,
      applicationRootId: applicationRootIdSchema,
      actionId: containedComponentIdSchema,
      ...resolvedFlowTargetEvidenceSchema.shape,
    })
    .strict(),
  z
    .object({
      kind: z.literal("record_save"),
      applicationRootId: applicationRootIdSchema,
      moduleRootId: moduleRootIdSchema,
      recordTypeId: recordTypeIdSchema,
      mode: z.enum(["create", "update"]),
      ...resolvedFlowTargetEvidenceSchema.shape,
    })
    .strict(),
  z
    .object({
      kind: z.literal("named_action"),
      actionKey: namespacedKeySchema,
      owner: z.discriminatedUnion("kind", [
        z
          .object({ kind: z.literal("application"), applicationRootId: applicationRootIdSchema })
          .strict(),
        z.object({ kind: z.literal("module"), moduleRootId: moduleRootIdSchema }).strict(),
      ]),
      actionId: containedComponentIdSchema,
      ...resolvedFlowTargetEvidenceSchema.shape,
    })
    .strict(),
]);

/**
 * Results each current-user action target reports, in presentation order. A protected operation
 * reports exactly the results its resolved operation descriptor declares.
 */
export const currentUserFlowActionResults = {
  form_continuation: ["completed", "validation", "refused"],
  durable_workflow_start: ["background_pending", "validation", "refused", "uncertain"],
  application_action: ["committed", "validation", "refused", "conflict", "uncertain"],
  record_save: ["committed", "validation", "refused", "conflict", "uncertain"],
  named_action: ["committed", "validation", "refused", "conflict", "uncertain"],
} as const satisfies Readonly<
  Record<
    Exclude<CurrentUserFlowActionTarget["kind"], "protected_operation">,
    readonly SafeFlowResultKind[]
  >
>;

export const currentUserFlowStartNodeSchema = z
  .object({
    nodeId: containedComponentIdSchema,
    key: builderKeySchema,
    kind: z.literal("start"),
    label: labelSchema.optional(),
    runAs: currentUserFlowRunAsSchema.default({ kind: "current_user" }),
    entryCondition: conditionNodeSchema.optional(),
    outputs: z.record(builderKeySchema, flowValueDeclarationSchema).default({}),
  })
  .strict();

export const currentUserFlowQueryNodeSchema = z
  .object({
    nodeId: containedComponentIdSchema,
    key: builderKeySchema,
    kind: z.literal("query"),
    label: labelSchema.optional(),
    target: currentUserFlowQueryTargetSchema,
    runAs: currentUserFlowRunAsSchema.default({ kind: "current_user" }),
    inputs: z.record(builderKeySchema, flowNodeInputBindingSchema).default({}),
    outputs: z.record(builderKeySchema, flowValueDeclarationSchema).default({}),
    results: z.record(builderKeySchema, typedFlowResultMappingSchema).default({}),
  })
  .strict();

export const currentUserFlowActionNodeSchema = z
  .object({
    nodeId: containedComponentIdSchema,
    key: builderKeySchema,
    kind: z.literal("action"),
    label: labelSchema.optional(),
    target: currentUserFlowActionTargetSchema,
    runAs: currentUserFlowRunAsSchema.default({ kind: "current_user" }),
    inputs: z.record(builderKeySchema, flowNodeInputBindingSchema).default({}),
    outputs: z.record(builderKeySchema, flowValueDeclarationSchema).default({}),
    results: z.record(builderKeySchema, typedFlowResultMappingSchema).default({}),
  })
  .strict();

export const currentUserFlowTransformNodeSchema = z
  .object({
    nodeId: containedComponentIdSchema,
    key: builderKeySchema,
    kind: z.literal("transform"),
    label: labelSchema.optional(),
    inputs: z.record(builderKeySchema, flowNodeInputBindingSchema).default({}),
    outputs: z.record(builderKeySchema, flowValueDeclarationSchema).default({}),
    results: z.record(builderKeySchema, typedFlowResultMappingSchema).default({}),
  })
  .strict();

export const currentUserFlowReturnNodeSchema = z
  .object({
    nodeId: containedComponentIdSchema,
    key: builderKeySchema,
    kind: z.literal("return"),
    label: labelSchema.optional(),
    results: z.record(builderKeySchema, flowNodeInputValueSchema).default({}),
    outcome: safeFlowResultKindSchema.optional().default("completed"),
  })
  .strict();

export const currentUserFlowNodeSchema = z.discriminatedUnion("kind", [
  currentUserFlowStartNodeSchema,
  currentUserFlowQueryNodeSchema,
  currentUserFlowActionNodeSchema,
  currentUserFlowTransformNodeSchema,
  currentUserFlowReturnNodeSchema,
]);

export const currentUserFlowEdgeSchema = z
  .object({
    edgeId: containedComponentIdSchema,
    fromNodeId: containedComponentIdSchema,
    toNodeId: containedComponentIdSchema,
    outcome: builderKeySchema.optional(),
  })
  .strict();

type FlowTypeDeclaration = Readonly<{
  type: string;
  recordTypeIds?: readonly unknown[];
  record_types?: readonly unknown[];
}>;

function flowDeclarationsCompatible(
  actual: FlowTypeDeclaration,
  expected: FlowTypeDeclaration,
): boolean {
  if (actual.type !== expected.type) return false;
  const actualRecordTypes = actual.recordTypeIds ?? actual.record_types;
  const expectedRecordTypes = expected.recordTypeIds ?? expected.record_types;
  if (actualRecordTypes === undefined || expectedRecordTypes === undefined)
    return actualRecordTypes === expectedRecordTypes;
  const allowed = new Set(expectedRecordTypes.map(String));
  return actualRecordTypes.every((recordType) => allowed.has(String(recordType)));
}

/**
 * A protected operation's exact results are resolved from its descriptor after publication, but
 * every operation declares its permission refusal and the confirmed result of its effect.
 */
const protectedOperationConfirmedResults: readonly string[] = Object.values(
  protectedOperationResultsByEffect,
).map((results) => results[0]);

const fixedActionTargetResults: Readonly<Partial<Record<string, readonly string[]>>> =
  currentUserFlowActionResults;

export type FlowRoutingNode = Readonly<{
  id: string;
  kind: string;
  actionTarget?: CurrentUserFlowActionTarget["kind"];
  returnOutcome?: string;
}>;

export type FlowRoutingEdge = Readonly<{ from: string; to: string; outcome?: string | undefined }>;

export type FlowRoutingIssue = Readonly<{
  path: readonly (string | number)[];
  message: string;
}>;

/**
 * Checks that flow results are routed completely and unambiguously: only action nodes route by
 * outcome, never together with an unconditional edge, every result the target reports has its own
 * route, and a return node reports exactly the outcome that reaches it, so no result (a failed,
 * refused or uncertain action above all) is ever reported as success or as another result. Issues
 * are located by node or edge index. Structural problems (unknown endpoints, cycles, unknown
 * targets) are reported by the graph and reference validators.
 */
export function analyzeFlowResultRouting(
  nodes: readonly FlowRoutingNode[],
  edges: readonly FlowRoutingEdge[],
): FlowRoutingIssue[] {
  const issues: FlowRoutingIssue[] = [];
  const kindById = new Map(nodes.map((node) => [node.id, node.kind]));
  const targetById = new Map(nodes.map((node) => [node.id, node.actionTarget]));
  const routesByNode = new Map<string, FlowRoutingEdge[]>();
  for (const [index, edge] of edges.entries()) {
    routesByNode.set(edge.from, [...(routesByNode.get(edge.from) ?? []), edge]);
    const fromKind = kindById.get(edge.from);
    if (fromKind === undefined || edge.outcome === undefined) continue;
    const target = targetById.get(edge.from);
    const reportable: readonly string[] | undefined =
      target === "protected_operation"
        ? safeFlowResultKindSchema.options
        : target === undefined
          ? undefined
          : fixedActionTargetResults[target];
    if (fromKind !== "action")
      issues.push({
        path: ["edges", index, "outcome"],
        message: "Only an action node can route by outcome",
      });
    else if (reportable !== undefined && !reportable.includes(edge.outcome))
      issues.push({
        path: ["edges", index, "outcome"],
        message: "An action edge can only route a result its target reports",
      });
  }

  for (const [nodeIndex, node] of nodes.entries()) {
    if (node.kind !== "action" || node.actionTarget === undefined) continue;
    const routes = routesByNode.get(node.id) ?? [];
    const routed = new Set(
      routes.flatMap((edge) => (edge.outcome === undefined ? [] : [edge.outcome])),
    );
    if (routes.some((edge) => edge.outcome === undefined))
      issues.push({
        path: ["nodes", nodeIndex],
        message:
          routed.size > 0
            ? "An action node cannot mix an unconditional edge with outcome edges"
            : "An action node must route each result it reports by outcome, not by an unconditional edge",
      });
    const fixedResults = fixedActionTargetResults[node.actionTarget];
    const missing: string[] =
      node.actionTarget === "protected_operation"
        ? [
            ...(routed.has("refused") ? [] : ["refused"]),
            ...(protectedOperationConfirmedResults.some((result) => routed.has(result))
              ? []
              : ["its confirmed result"]),
          ]
        : (fixedResults ?? []).filter((result) => !routed.has(result));
    if (missing.length > 0)
      issues.push({
        path: ["nodes", nodeIndex],
        message: `An action node must route every result its target reports; missing: ${missing.join(", ")}`,
      });
  }

  // The outcomes that can arrive at each node: the start reports completion, an action edge
  // carries its own outcome and every other node passes its incoming outcomes through.
  const reaching = new Map<string, Set<string>>(nodes.map((node) => [node.id, new Set<string>()]));
  for (const node of nodes) if (node.kind === "start") reaching.get(node.id)?.add("completed");
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      const source = reaching.get(edge.from);
      const target = reaching.get(edge.to);
      if (source === undefined || target === undefined) continue;
      const carried =
        kindById.get(edge.from) === "action"
          ? edge.outcome === undefined
            ? []
            : [edge.outcome]
          : [...source];
      for (const outcome of carried)
        if (!target.has(outcome)) {
          target.add(outcome);
          changed = true;
        }
    }
  }
  // Each result has its own commit state and recovery, so a return node reports exactly the one
  // outcome that reaches it: a failed, refused or uncertain result can never be reported as
  // success, and no result can be reported as another.
  for (const [nodeIndex, node] of nodes.entries()) {
    if (node.kind !== "return") continue;
    const outcome = node.returnOutcome ?? "completed";
    const others = [...(reaching.get(node.id) ?? [])].filter((arrived) => arrived !== outcome);
    if (others.length > 0)
      issues.push({
        path: ["nodes", nodeIndex, "outcome"],
        message: `A return node reporting ${outcome} is reached by ${others.sort().join(", ")}; each result needs a return node that reports it`,
      });
  }
  return issues;
}

export function validateCurrentUserFlowGraph(
  value: {
    inputs: Record<string, FlowValueDeclaration>;
    outputs: Record<string, FlowValueDeclaration>;
    variables: Record<string, FlowVariableDeclaration>;
    nodes: CurrentUserFlowNode[];
    edges: CurrentUserFlowEdge[];
  },
  context: z.RefinementCtx,
): void {
  for (const [variableKey, variable] of Object.entries(value.variables)) {
    if (variable.key !== variableKey)
      context.addIssue({
        code: "custom",
        path: ["variables", variableKey, "key"],
        message: "A flow variable key must match its containing map key",
      });
  }
  const nodeIds = value.nodes.map((n) => String(n.nodeId));
  const nodeKeys = value.nodes.map((n) => n.key);
  if (new Set(nodeIds).size !== nodeIds.length) {
    context.addIssue({ code: "custom", path: ["nodes"], message: "Flow node identities must be unique" });
  }
  if (new Set(nodeKeys).size !== nodeKeys.length) {
    context.addIssue({ code: "custom", path: ["nodes"], message: "Flow node keys must be unique" });
  }
  const edgeIds = value.edges.map((e) => String(e.edgeId));
  if (new Set(edgeIds).size !== edgeIds.length) {
    context.addIssue({ code: "custom", path: ["edges"], message: "Flow edge identities must be unique" });
  }
  const edgeSignatures = value.edges.map((edge) =>
    `${String(edge.fromNodeId)}:${edge.outcome ?? ""}`,
  );
  if (new Set(edgeSignatures).size !== edgeSignatures.length) {
    context.addIssue({ code: "custom", path: ["edges"], message: "Flow outcome routes must be unique" });
  }

  const startNodes = value.nodes.filter((n) => n.kind === "start");
  if (startNodes.length !== 1) {
    context.addIssue({ code: "custom", path: ["nodes"], message: "A flow must have exactly one start node" });
  } else {
    const startOutputs = startNodes[0]!.outputs;
    if (
      Object.keys(startOutputs).length !== Object.keys(value.inputs).length ||
      Object.entries(value.inputs).some(
        ([key, declaration]) =>
          startOutputs[key] === undefined ||
          !flowDeclarationsCompatible(declaration, startOutputs[key]) ||
          !flowDeclarationsCompatible(startOutputs[key], declaration),
      )
    )
      context.addIssue({
        code: "custom",
        path: ["nodes"],
        message: "The start node outputs must exactly expose the declared flow inputs",
      });
  }
  const returnNodes = value.nodes.filter((n) => n.kind === "return");
  if (returnNodes.length < 1) {
    context.addIssue({ code: "custom", path: ["nodes"], message: "A flow must have at least one return node" });
  }

  const nodeIdSet = new Set(nodeIds);
  for (const [index, edge] of value.edges.entries()) {
    if (!nodeIdSet.has(String(edge.fromNodeId))) {
      context.addIssue({ code: "custom", path: ["edges", index, "fromNodeId"], message: "Edge source must resolve to a node in this flow" });
    }
    if (!nodeIdSet.has(String(edge.toNodeId))) {
      context.addIssue({ code: "custom", path: ["edges", index, "toNodeId"], message: "Edge target must resolve to a node in this flow" });
    }
    if (edge.fromNodeId === edge.toNodeId) {
      context.addIssue({ code: "custom", path: ["edges", index], message: "Self-referencing edges are not allowed" });
    }
  }

  if (startNodes.length === 1) {
    const startId = String(startNodes[0]!.nodeId);
    if (value.edges.some((e) => String(e.toNodeId) === startId)) {
      context.addIssue({ code: "custom", path: ["nodes"], message: "Start node cannot have incoming edges" });
    }
    if (value.edges.filter((e) => String(e.fromNodeId) === startId).length === 0 && value.nodes.length > 1) {
      context.addIssue({ code: "custom", path: ["nodes"], message: "Start node must have at least one outgoing edge" });
    }
  }

  for (const returnNode of returnNodes) {
    const returnId = String(returnNode.nodeId);
    if (value.edges.some((e) => String(e.fromNodeId) === returnId)) {
      context.addIssue({ code: "custom", path: ["nodes"], message: "Return node cannot have outgoing edges" });
    }
    if (value.edges.filter((e) => String(e.toNodeId) === returnId).length === 0) {
      context.addIssue({ code: "custom", path: ["nodes"], message: "Return node must have at least one incoming edge" });
    }
  }

  for (const node of value.nodes) {
    const nId = String(node.nodeId);
    if (node.kind !== "start" && !value.edges.some((e) => String(e.toNodeId) === nId)) {
      context.addIssue({ code: "custom", path: ["nodes"], message: `Node '${node.key}' must have at least one incoming edge` });
    }
    if (node.kind !== "return" && !value.edges.some((e) => String(e.fromNodeId) === nId)) {
      context.addIssue({ code: "custom", path: ["nodes"], message: `Node '${node.key}' must have at least one outgoing edge` });
    }
  }

  if (startNodes.length === 1) {
    const visited = new Set<string>();
    const queue = [String(startNodes[0]!.nodeId)];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      if (visited.has(curr)) continue;
      visited.add(curr);
      for (const edge of value.edges) {
        if (String(edge.fromNodeId) === curr && !visited.has(String(edge.toNodeId))) {
          queue.push(String(edge.toNodeId));
        }
      }
    }
    if (visited.size !== value.nodes.length) {
      context.addIssue({ code: "custom", path: ["nodes"], message: "All nodes in the flow must be reachable from the start node" });
    }
  }

  if (returnNodes.length >= 1) {
    const canReachReturn = new Set<string>();
    const reverseQueue = returnNodes.map((n) => String(n.nodeId));
    while (reverseQueue.length > 0) {
      const curr = reverseQueue.shift()!;
      if (canReachReturn.has(curr)) continue;
      canReachReturn.add(curr);
      for (const edge of value.edges) {
        if (String(edge.toNodeId) === curr && !canReachReturn.has(String(edge.fromNodeId))) {
          reverseQueue.push(String(edge.fromNodeId));
        }
      }
    }
    if (canReachReturn.size !== value.nodes.length) {
      context.addIssue({ code: "custom", path: ["nodes"], message: "All paths in the flow must terminate at a return node" });
    }
  }

  const inDegree = new Map<string, number>();
  for (const id of nodeIds) inDegree.set(id, 0);
  for (const edge of value.edges) {
    const to = String(edge.toNodeId);
    if (inDegree.has(to)) inDegree.set(to, inDegree.get(to)! + 1);
  }
  const zeroInDegree = nodeIds.filter((id) => inDegree.get(id) === 0);
  let processedCount = 0;
  const topologicalOrder: string[] = [];
  const topoQueue = [...zeroInDegree];
  while (topoQueue.length > 0) {
    const curr = topoQueue.shift()!;
    topologicalOrder.push(curr);
    processedCount++;
    for (const edge of value.edges) {
      if (String(edge.fromNodeId) === curr) {
        const to = String(edge.toNodeId);
        const remaining = (inDegree.get(to) ?? 1) - 1;
        inDegree.set(to, remaining);
        if (remaining === 0) topoQueue.push(to);
      }
    }
  }
  if (processedCount !== value.nodes.length) {
    context.addIssue({ code: "custom", path: ["edges"], message: "Flow graph must be acyclic (no cycles allowed)" });
  }

  const nodeById = new Map(value.nodes.map((n) => [String(n.nodeId), n]));
  const dominators = new Map<string, Set<string>>();
  for (const nodeId of topologicalOrder) {
    const parents = value.edges
      .filter((edge) => String(edge.toNodeId) === nodeId)
      .map((edge) => String(edge.fromNodeId));
    const dominated =
      parents.length === 0
        ? new Set<string>()
        : new Set(
            [...(dominators.get(parents[0]!) ?? [])].filter((candidate) =>
              parents.slice(1).every((parent) => dominators.get(parent)?.has(candidate)),
            ),
          );
    dominated.add(nodeId);
    dominators.set(nodeId, dominated);
  }
  for (const node of value.nodes) {
    if (node.kind === "query" || node.kind === "action" || node.kind === "transform") {
      for (const [inputKey, inputBinding] of Object.entries(node.inputs)) {
        if (inputBinding.value.source === "flow_input") {
          const flowInput = value.inputs[inputBinding.value.input];
          if (!flowInput) {
            context.addIssue({ code: "custom", path: ["nodes"], message: `Input '${inputKey}' references unknown flow input '${inputBinding.value.input}'` });
          } else if (flowInput.type !== inputBinding.type) {
            context.addIssue({ code: "custom", path: ["nodes"], message: `Input '${inputKey}' type '${inputBinding.type}' is incompatible with flow input type '${flowInput.type}'` });
          }
        } else if (inputBinding.value.source === "flow_variable") {
          const flowVar = value.variables[inputBinding.value.variable];
          if (!flowVar) {
            context.addIssue({ code: "custom", path: ["nodes"], message: `Input '${inputKey}' references unknown flow variable '${inputBinding.value.variable}'` });
          } else if (flowVar.type !== inputBinding.type) {
            context.addIssue({ code: "custom", path: ["nodes"], message: `Input '${inputKey}' type '${inputBinding.type}' is incompatible with flow variable type '${flowVar.type}'` });
          }
        } else if (inputBinding.value.source === "node_output") {
          const refNodeId = String(inputBinding.value.nodeId);
          const refNode = nodeById.get(refNodeId);
          if (!refNode) {
            context.addIssue({ code: "custom", path: ["nodes"], message: `Input '${inputKey}' references unknown node '${refNodeId}'` });
          } else {
            if (
              refNodeId === String(node.nodeId) ||
              !dominators.get(String(node.nodeId))?.has(refNodeId)
            ) {
              context.addIssue({ code: "custom", path: ["nodes"], message: `Input '${inputKey}' references node output from subsequent or concurrent node` });
            }
            const declaredOutput = refNode.kind === "return"
              ? undefined
              : refNode.outputs[inputBinding.value.output];
            if (!declaredOutput) {
              context.addIssue({ code: "custom", path: ["nodes"], message: `Node '${refNode.key}' does not declare output '${inputBinding.value.output}'` });
            } else if (declaredOutput.type !== inputBinding.type) {
              context.addIssue({ code: "custom", path: ["nodes"], message: `Input '${inputKey}' type '${inputBinding.type}' is incompatible with output type '${declaredOutput.type}'` });
            }
          }
        }
      }
      const mappedOutputs = new Set<string>();
      for (const [resultKey, mapping] of Object.entries(node.results)) {
        const declaredOutput = node.outputs[mapping.output];
        if (!declaredOutput || mapping.type !== declaredOutput.type) {
          context.addIssue({ code: "custom", path: ["nodes"], message: `Result '${resultKey}' must map to a compatible declared node output` });
        }
        if (mappedOutputs.has(mapping.output)) {
          context.addIssue({ code: "custom", path: ["nodes"], message: `Node output '${mapping.output}' cannot be mapped more than once` });
        }
        mappedOutputs.add(mapping.output);
      }
      for (const [outputKey, output] of Object.entries(node.outputs)) {
        if (output.required && !mappedOutputs.has(outputKey)) {
          context.addIssue({ code: "custom", path: ["nodes"], message: `Required node output '${outputKey}' needs an explicit result mapping` });
        }
      }
    } else if (node.kind === "return") {
      for (const [resultKey, resultValue] of Object.entries(node.results)) {
        const expectedOutput = value.outputs[resultKey];
        if (!expectedOutput) {
          context.addIssue({ code: "custom", path: ["nodes"], message: `Return result '${resultKey}' is not declared by the flow` });
          continue;
        }
        if (resultValue.source === "flow_input") {
          const input = value.inputs[resultValue.input];
          if (!input || !flowDeclarationsCompatible(input, expectedOutput)) {
            context.addIssue({ code: "custom", path: ["nodes"], message: `Return result '${resultKey}' references unknown flow input '${resultValue.input}'` });
          }
        } else if (resultValue.source === "flow_variable") {
          const variable = value.variables[resultValue.variable];
          if (!variable || !flowDeclarationsCompatible(variable, expectedOutput)) {
            context.addIssue({ code: "custom", path: ["nodes"], message: `Return result '${resultKey}' references unknown flow variable '${resultValue.variable}'` });
          }
        } else if (resultValue.source === "node_output") {
          const refNodeId = String(resultValue.nodeId);
          const refNode = nodeById.get(refNodeId);
          const declaredOutput = refNode?.kind === "return"
            ? undefined
            : refNode?.outputs[resultValue.output];
          if (
            !refNode ||
            refNodeId === String(node.nodeId) ||
            !dominators.get(String(node.nodeId))?.has(refNodeId) ||
            !declaredOutput ||
            !flowDeclarationsCompatible(declaredOutput, expectedOutput)
          ) {
            context.addIssue({ code: "custom", path: ["nodes"], message: `Return result '${resultKey}' references unknown node '${refNodeId}'` });
          }
        }
      }
      for (const [outputKey, output] of Object.entries(value.outputs)) {
        if (output.required && !(outputKey in node.results)) {
          context.addIssue({ code: "custom", path: ["nodes"], message: `Return node must map required flow output '${outputKey}'` });
        }
      }
    }
  }
  for (const issue of analyzeFlowResultRouting(
    value.nodes.map((node) => ({
      id: String(node.nodeId),
      kind: node.kind,
      ...(node.kind === "action" ? { actionTarget: node.target.kind } : {}),
      ...(node.kind === "return" ? { returnOutcome: node.outcome } : {}),
    })),
    value.edges.map((edge) => ({
      from: String(edge.fromNodeId),
      to: String(edge.toNodeId),
      outcome: edge.outcome,
    })),
  ))
    context.addIssue({ code: "custom", path: [...issue.path], message: issue.message });
}

export const currentUserFlowSchema = z
  .object({
    flowId: ruleIdSchema,
    key: builderKeySchema,
    name: labelSchema,
    releaseVersion: stableDefinitionReleaseVersionSchema,
    contentFingerprint: fingerprintSchema,
    resolutionFingerprint: fingerprintSchema,
    description: z.string().max(1000).optional(),
    runAs: z.literal("current_user").default("current_user"),
    inputs: z.record(builderKeySchema, flowValueDeclarationSchema).default({}),
    outputs: z.record(builderKeySchema, flowValueDeclarationSchema).default({}),
    variables: z.record(builderKeySchema, flowVariableDeclarationSchema).default({}),
    nodes: z.array(currentUserFlowNodeSchema).min(2).max(100),
    edges: z.array(currentUserFlowEdgeSchema).min(1).max(200),
  })
  .strict()
  .superRefine(validateCurrentUserFlowGraph);

/** A trusted value the server takes from the verified request context; callers never supply it. */
export const serverResolvedFlowInputSchema = z
  .object({
    source: z.literal("current_organization_account_id"),
    type: z.literal("organization_account_reference"),
  })
  .strict();

const flowContinuationInputs = {
  /** The verified original initiator; never a caller-supplied account or actor. */
  initiator: z.literal("server_resolved_current_account"),
  /** Typed values the server binds from the published flow and its verified run state. */
  flowInputs: z.record(builderKeySchema, workflowValueTypeSchema),
  serverResolvedInputs: z.record(builderKeySchema, serverResolvedFlowInputSchema),
};

const refineDisjointContinuationInputs = (
  value: { flowInputs: Record<string, unknown>; serverResolvedInputs: Record<string, unknown> },
  context: z.RefinementCtx,
): void => {
  if (Object.keys(value.serverResolvedInputs).some((key) => key in value.flowInputs))
    context.addIssue({
      code: "custom",
      path: ["serverResolvedInputs"],
      message: "A server-resolved input cannot also be a flow-supplied input",
    });
};

/**
 * Resumes a flow from one private form draft. The draft belongs to the current account,
 * organisation, application and form and creates no record before a protected operation commits.
 */
export const privateFormContinuationDescriptorSchema = z
  .object({
    kind: z.literal("private_form"),
    draftScope: z.literal("current_account"),
    ...flowContinuationInputs,
    /** Answers the caller submits; the server validates them before the flow continues. */
    answers: z.record(builderKeySchema, flowValueDeclarationSchema),
  })
  .strict()
  .superRefine(refineDisjointContinuationInputs);

/** Starts durable background work without fabricating or requiring a subject record. */
export const recordFreeDurableStartContinuationDescriptorSchema = z
  .object({
    kind: z.literal("record_free_durable_start"),
    subject: z.literal("none"),
    ...flowContinuationInputs,
  })
  .strict()
  .superRefine(refineDisjointContinuationInputs);

export const flowContinuationDescriptorSchema = z.discriminatedUnion("kind", [
  privateFormContinuationDescriptorSchema,
  recordFreeDurableStartContinuationDescriptorSchema,
]);

const continuationKindByTarget = {
  form_continuation: "private_form",
  durable_workflow_start: "record_free_durable_start",
} as const;

/**
 * The one typed descriptor a web or non-web consumer renders for a current-user flow action node.
 * It names the exact server-resolved target, every result the node can report and its
 * continuation, but never a successor node, actor, permission grant or executable endpoint:
 * routing follows the published edges and authority is resolved again by the owning service.
 */
export const currentUserFlowActionDescriptorSchema = z
  .object({
    contractVersion: z.literal(applicationFlowBindingContractVersion),
    flowId: ruleIdSchema,
    nodeId: containedComponentIdSchema,
    target: currentUserFlowActionTargetSchema,
    runAs: z.literal("current_user"),
    results: safeFlowResultDescriptorListSchema,
    operation: protectedOperationDescriptorSchema.optional(),
    continuation: flowContinuationDescriptorSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const target = value.target;
    const operation = value.operation;
    if (target.kind === "protected_operation") {
      if (
        operation === undefined ||
        operationReferenceKey(operation.operation) !== operationReferenceKey(target.operation)
      )
        context.addIssue({
          code: "custom",
          path: ["operation"],
          message: "A protected operation action carries its own resolved operation descriptor",
        });
    } else if (operation !== undefined)
      context.addIssue({
        code: "custom",
        path: ["operation"],
        message: "Only a protected operation action carries an operation descriptor",
      });
    const expectedResults: readonly SafeFlowResultKind[] =
      target.kind === "protected_operation"
        ? (operation?.safeResults ?? [])
        : currentUserFlowActionResults[target.kind];
    if (
      value.results.length !== expectedResults.length ||
      value.results.some((result, index) => result.outcome !== expectedResults[index])
    )
      context.addIssue({
        code: "custom",
        path: ["results"],
        message: "Action results must be exactly those its target reports",
      });
    const expectedContinuation =
      target.kind === "form_continuation" || target.kind === "durable_workflow_start"
        ? continuationKindByTarget[target.kind]
        : undefined;
    if (value.continuation?.kind !== expectedContinuation)
      context.addIssue({
        code: "custom",
        path: ["continuation"],
        message: "Form and durable-start actions carry exactly their own continuation",
      });
  });

function operationReferenceKey(reference: ProtectedOperationReference): string {
  const owner = reference.owner;
  const ownerId =
    owner.kind === "application"
      ? owner.applicationRootId
      : owner.kind === "module"
        ? owner.moduleRootId
        : owner.serviceId;
  return `${owner.kind}:${String(ownerId)}:${String(reference.operationId)}`;
}

/**
 * Builds the descriptor for one action node of a published current-user flow. A protected
 * operation node requires the operation descriptor the server resolved for its exact target;
 * trusted current-account inputs are always marked server-resolved rather than caller-supplied.
 */
export function describeCurrentUserFlowAction(
  flow: CurrentUserFlow,
  nodeId: string,
  operation?: ProtectedOperationDescriptor,
): CurrentUserFlowActionDescriptor {
  const node = flow.nodes.find((candidate) => String(candidate.nodeId) === nodeId);
  if (node?.kind !== "action")
    throw new Error("A current-user flow action descriptor requires an action node of that flow");
  const target = node.target;
  const flowInputs: Record<string, z.infer<typeof workflowValueTypeSchema>> = {};
  const serverResolvedInputs: Record<string, ServerResolvedFlowInput> = {};
  for (const [key, binding] of Object.entries(node.inputs)) {
    if (binding.value.source === "current_organization_account_id")
      serverResolvedInputs[key] = {
        source: "current_organization_account_id",
        type: "organization_account_reference",
      };
    else flowInputs[key] = binding.type;
  }
  const continuationInputs = {
    initiator: "server_resolved_current_account",
    flowInputs,
    serverResolvedInputs,
  } as const;
  const results: readonly SafeFlowResultKind[] =
    target.kind === "protected_operation"
      ? (operation?.safeResults ?? [])
      : currentUserFlowActionResults[target.kind];
  return currentUserFlowActionDescriptorSchema.parse({
    contractVersion: applicationFlowBindingContractVersion,
    flowId: flow.flowId,
    nodeId: node.nodeId,
    target,
    runAs: "current_user",
    results: results.map((result) => safeFlowResultDescriptors[result]),
    ...(operation === undefined ? {} : { operation }),
    ...(target.kind === "form_continuation"
      ? {
          continuation: {
            kind: "private_form",
            draftScope: "current_account",
            ...continuationInputs,
            answers: node.outputs,
          },
        }
      : target.kind === "durable_workflow_start"
        ? {
            continuation: {
              kind: "record_free_durable_start",
              subject: "none",
              ...continuationInputs,
            },
          }
        : {}),
  });
}

// --- Source equivalents for current-user flows and bindings ---

export const sourceComponentBindingContextSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("page_subject"),
      record_type: sourceQualifiedRecordTypeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("related_record"),
      relationship: sourceQualifiedRelationshipSchema,
      record_type: sourceQualifiedRecordTypeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("row"),
      control: sourceAliasSchema,
      record_type: sourceQualifiedRecordTypeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("selection"),
      control: sourceAliasSchema,
      record_type: sourceQualifiedRecordTypeSchema,
      cardinality: z.enum(["one", "many"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("form"),
      form: sourceAliasSchema,
      record_type: sourceQualifiedRecordTypeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("response"),
      form: sourceAliasSchema,
      record_type: sourceQualifiedRecordTypeSchema.optional(),
    })
    .strict(),
]);

export const sourceComponentFlowInputValueSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("literal"), value: jsonValueSchema }).strict(),
  z
    .object({
      source: z.literal("context_record"),
      context: sourceComponentBindingContextSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal("context_field"),
      context: sourceComponentBindingContextSchema,
      field: builderKeySchema,
    })
    .strict(),
  z
    .object({
      source: z.literal("form_input"),
      form: sourceAliasSchema,
      input: builderKeySchema,
    })
    .strict(),
  z.object({ source: z.literal("event_input"), input: builderKeySchema }).strict(),
  z.object({ source: z.literal("current_organization_account_id") }).strict(),
]);

export const sourceTypedFlowInputBindingSchema = z
  .object({
    type: workflowValueTypeSchema,
    value: sourceComponentFlowInputValueSchema,
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
    if (value.value.context.kind === "response") {
      context.addIssue({
        code: "custom",
        path: ["value", "context", "kind"],
        message: "A response context does not produce a record reference",
      });
      return;
    }
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

export const sourceFrontendFlowReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("application_owned"),
      flow: sourceAliasSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("platform_managed"),
      flow_id: ruleIdSchema,
      release_version: stableDefinitionReleaseVersionSchema,
    })
    .strict(),
]);

export const sourceComponentFlowBindingSchema = z
  .object({
    id: sourceAliasSchema,
    control: sourceAliasSchema,
    event_id: sourceAliasSchema,
    event: componentSemanticEventKindSchema,
    flow: sourceFrontendFlowReferenceSchema,
    inputs: z.record(builderKeySchema, sourceTypedFlowInputBindingSchema).default({}),
    results: z.record(builderKeySchema, typedFlowResultMappingSchema).default({}),
    declared_effects: z.array(flowEffectKindSchema).min(1).max(5),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.declared_effects).size !== value.declared_effects.length)
      context.addIssue({
        code: "custom",
        path: ["declared_effects"],
        message: "Declared flow effects must be unique",
      });
  });

export const sourceFlowNodeInputValueSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("literal"), value: jsonValueSchema }).strict(),
  z.object({ source: z.literal("flow_input"), input: builderKeySchema }).strict(),
  z.object({ source: z.literal("flow_variable"), variable: builderKeySchema }).strict(),
  z
    .object({
      source: z.literal("node_output"),
      node: sourceAliasSchema,
      output: builderKeySchema,
    })
    .strict(),
  z.object({ source: z.literal("current_organization_account_id") }).strict(),
]);

export const sourceFlowNodeInputBindingSchema = z
  .object({
    type: workflowValueTypeSchema,
    value: sourceFlowNodeInputValueSchema,
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
  });

export const sourceFlowValueDeclarationSchema = z
  .object({
    type: workflowValueTypeSchema,
    required: z.boolean(),
    record_types: z.array(sourceQualifiedRecordTypeSchema).min(1).max(20).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const isRecordReference =
      value.type === "record_reference" || value.type === "record_reference_list";
    if (isRecordReference !== (value.record_types !== undefined))
      context.addIssue({
        code: "custom",
        path: ["record_types"],
        message: "Record-reference values require their allowed record types",
      });
  });

export const sourceFlowVariableDeclarationSchema = z
  .object({
    key: builderKeySchema,
    name: labelSchema.optional(),
    type: workflowValueTypeSchema,
    record_types: z.array(sourceQualifiedRecordTypeSchema).min(1).max(20).optional(),
    default_value: jsonValueSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const isRecordReference =
      value.type === "record_reference" || value.type === "record_reference_list";
    if (isRecordReference !== (value.record_types !== undefined))
      context.addIssue({
        code: "custom",
        path: ["record_types"],
        message: "Record-reference values require their allowed record types",
      });
  });

export const sourceCurrentUserFlowQueryTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("query"),
      module: namespacedKeySchema,
      version: versionRequirementSchema,
      query: builderKeySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("application_query"),
      query: builderKeySchema,
    })
    .strict(),
]);

export const sourceCurrentUserFlowActionTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("protected_operation"),
      operation: protectedOperationReferenceSchema,
      release_version: stableDefinitionReleaseVersionSchema.optional(),
    })
    .strict()
    .superRefine((value, context) => {
      const platformManaged = value.operation.owner.kind === "platform_service";
      if (platformManaged !== (value.release_version !== undefined))
        context.addIssue({
          code: "custom",
          path: ["release_version"],
          message:
            "A platform-service operation requires one exact release; Definition-owned operations inherit their selected Definition release",
        });
    }),
  z
    .object({
      kind: z.literal("form_continuation"),
      form: sourceAliasSchema,
      continuation_event: sourceAliasSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("durable_workflow_start"),
      workflow: builderKeySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("application_action"),
      action: namespacedKeySchema,
    })
    .strict(),
  // A generic record commit binds one module record type by its published permanent identity and
  // commits the bound form draft through the ordinary create/update Record operation. It carries
  // no application-specific action identity.
  z
    .object({
      kind: z.literal("record_save"),
      record_type: sourceQualifiedRecordTypeSchema,
      mode: z.enum(["create", "update"]),
    })
    .strict(),
  // A named action binds one module- or application-owned action by its published namespaced key;
  // the compiler resolves the key to the action's permanent contained identity.
  z
    .object({
      kind: z.literal("named_action"),
      action: namespacedKeySchema,
    })
    .strict(),
]);

export const sourceCurrentUserFlowStartNodeSchema = z
  .object({
    id: sourceAliasSchema,
    key: builderKeySchema,
    kind: z.literal("start"),
    label: labelSchema.optional(),
    run_as: currentUserFlowRunAsSchema.default({ kind: "current_user" }),
    entry_condition: sourceQualifiedConditionSchema.optional(),
    outputs: z.record(builderKeySchema, sourceFlowValueDeclarationSchema).default({}),
  })
  .strict();

export const sourceCurrentUserFlowQueryNodeSchema = z
  .object({
    id: sourceAliasSchema,
    key: builderKeySchema,
    kind: z.literal("query"),
    label: labelSchema.optional(),
    target: sourceCurrentUserFlowQueryTargetSchema,
    run_as: currentUserFlowRunAsSchema.default({ kind: "current_user" }),
    inputs: z.record(builderKeySchema, sourceFlowNodeInputBindingSchema).default({}),
    outputs: z.record(builderKeySchema, sourceFlowValueDeclarationSchema).default({}),
    results: z.record(builderKeySchema, typedFlowResultMappingSchema).default({}),
  })
  .strict();

export const sourceCurrentUserFlowActionNodeSchema = z
  .object({
    id: sourceAliasSchema,
    key: builderKeySchema,
    kind: z.literal("action"),
    label: labelSchema.optional(),
    target: sourceCurrentUserFlowActionTargetSchema,
    run_as: currentUserFlowRunAsSchema.default({ kind: "current_user" }),
    inputs: z.record(builderKeySchema, sourceFlowNodeInputBindingSchema).default({}),
    outputs: z.record(builderKeySchema, sourceFlowValueDeclarationSchema).default({}),
    results: z.record(builderKeySchema, typedFlowResultMappingSchema).default({}),
  })
  .strict();

export const sourceCurrentUserFlowTransformNodeSchema = z
  .object({
    id: sourceAliasSchema,
    key: builderKeySchema,
    kind: z.literal("transform"),
    label: labelSchema.optional(),
    inputs: z.record(builderKeySchema, sourceFlowNodeInputBindingSchema).default({}),
    outputs: z.record(builderKeySchema, sourceFlowValueDeclarationSchema).default({}),
    results: z.record(builderKeySchema, typedFlowResultMappingSchema).default({}),
  })
  .strict();

export const sourceCurrentUserFlowReturnNodeSchema = z
  .object({
    id: sourceAliasSchema,
    key: builderKeySchema,
    kind: z.literal("return"),
    label: labelSchema.optional(),
    results: z.record(builderKeySchema, sourceFlowNodeInputValueSchema).default({}),
    outcome: safeFlowResultKindSchema.optional().default("completed"),
  })
  .strict();

export const sourceCurrentUserFlowNodeSchema = z.discriminatedUnion("kind", [
  sourceCurrentUserFlowStartNodeSchema,
  sourceCurrentUserFlowQueryNodeSchema,
  sourceCurrentUserFlowActionNodeSchema,
  sourceCurrentUserFlowTransformNodeSchema,
  sourceCurrentUserFlowReturnNodeSchema,
]);

export const sourceCurrentUserFlowEdgeSchema = z
  .object({
    id: sourceAliasSchema,
    from_node: sourceAliasSchema,
    to_node: sourceAliasSchema,
    outcome: builderKeySchema.optional(),
  })
  .strict();

export function validateSourceCurrentUserFlowGraph(
  value: {
    inputs: Record<string, SourceFlowValueDeclaration>;
    outputs: Record<string, SourceFlowValueDeclaration>;
    variables: Record<string, SourceFlowVariableDeclaration>;
    nodes: SourceCurrentUserFlowNode[];
    edges: SourceCurrentUserFlowEdge[];
  },
  context: z.RefinementCtx,
): void {
  for (const [variableKey, variable] of Object.entries(value.variables)) {
    if (variable.key !== variableKey)
      context.addIssue({
        code: "custom",
        path: ["variables", variableKey, "key"],
        message: "A flow variable key must match its containing map key",
      });
  }
  const nodeAliases = value.nodes.map((n) => n.id);
  const nodeKeys = value.nodes.map((n) => n.key);
  if (new Set(nodeAliases).size !== nodeAliases.length) {
    context.addIssue({ code: "custom", path: ["nodes"], message: "Flow node aliases must be unique" });
  }
  if (new Set(nodeKeys).size !== nodeKeys.length) {
    context.addIssue({ code: "custom", path: ["nodes"], message: "Flow node keys must be unique" });
  }
  const edgeSignatures = value.edges.map((edge) =>
    `${edge.from_node}:${edge.outcome ?? ""}`,
  );
  const edgeAliases = value.edges.map((edge) => edge.id);
  if (new Set(edgeAliases).size !== edgeAliases.length) {
    context.addIssue({ code: "custom", path: ["edges"], message: "Flow edge aliases must be unique" });
  }
  if (new Set(edgeSignatures).size !== edgeSignatures.length) {
    context.addIssue({ code: "custom", path: ["edges"], message: "Flow outcome routes must be unique" });
  }

  const startNodes = value.nodes.filter((n) => n.kind === "start");
  if (startNodes.length !== 1) {
    context.addIssue({ code: "custom", path: ["nodes"], message: "A flow must have exactly one start node" });
  } else {
    const startOutputs = startNodes[0]!.outputs;
    if (
      Object.keys(startOutputs).length !== Object.keys(value.inputs).length ||
      Object.entries(value.inputs).some(
        ([key, declaration]) =>
          startOutputs[key] === undefined ||
          !flowDeclarationsCompatible(declaration, startOutputs[key]) ||
          !flowDeclarationsCompatible(startOutputs[key], declaration),
      )
    )
      context.addIssue({
        code: "custom",
        path: ["nodes"],
        message: "The start node outputs must exactly expose the declared flow inputs",
      });
  }
  const returnNodes = value.nodes.filter((n) => n.kind === "return");
  if (returnNodes.length < 1) {
    context.addIssue({ code: "custom", path: ["nodes"], message: "A flow must have at least one return node" });
  }

  const nodeAliasSet = new Set(nodeAliases);
  for (const [index, edge] of value.edges.entries()) {
    if (!nodeAliasSet.has(edge.from_node)) {
      context.addIssue({ code: "custom", path: ["edges", index, "from_node"], message: "Edge source must resolve to a node in this flow" });
    }
    if (!nodeAliasSet.has(edge.to_node)) {
      context.addIssue({ code: "custom", path: ["edges", index, "to_node"], message: "Edge target must resolve to a node in this flow" });
    }
    if (edge.from_node === edge.to_node) {
      context.addIssue({ code: "custom", path: ["edges", index], message: "Self-referencing edges are not allowed" });
    }
  }

  if (startNodes.length === 1) {
    const startId = startNodes[0]!.id;
    if (value.edges.some((e) => e.to_node === startId)) {
      context.addIssue({ code: "custom", path: ["nodes"], message: "Start node cannot have incoming edges" });
    }
    if (value.edges.filter((e) => e.from_node === startId).length === 0 && value.nodes.length > 1) {
      context.addIssue({ code: "custom", path: ["nodes"], message: "Start node must have at least one outgoing edge" });
    }
  }

  for (const returnNode of returnNodes) {
    const returnId = returnNode.id;
    if (value.edges.some((e) => e.from_node === returnId)) {
      context.addIssue({ code: "custom", path: ["nodes"], message: "Return node cannot have outgoing edges" });
    }
    if (value.edges.filter((e) => e.to_node === returnId).length === 0) {
      context.addIssue({ code: "custom", path: ["nodes"], message: "Return node must have at least one incoming edge" });
    }
  }

  for (const node of value.nodes) {
    const nId = node.id;
    if (node.kind !== "start" && !value.edges.some((e) => e.to_node === nId)) {
      context.addIssue({ code: "custom", path: ["nodes"], message: `Node '${node.key}' must have at least one incoming edge` });
    }
    if (node.kind !== "return" && !value.edges.some((e) => e.from_node === nId)) {
      context.addIssue({ code: "custom", path: ["nodes"], message: `Node '${node.key}' must have at least one outgoing edge` });
    }
  }

  if (startNodes.length === 1) {
    const visited = new Set<string>();
    const queue = [startNodes[0]!.id];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      if (visited.has(curr)) continue;
      visited.add(curr);
      for (const edge of value.edges) {
        if (edge.from_node === curr && !visited.has(edge.to_node)) {
          queue.push(edge.to_node);
        }
      }
    }
    if (visited.size !== value.nodes.length) {
      context.addIssue({ code: "custom", path: ["nodes"], message: "All nodes in the flow must be reachable from the start node" });
    }
  }

  if (returnNodes.length >= 1) {
    const canReachReturn = new Set<string>();
    const reverseQueue = returnNodes.map((n) => n.id);
    while (reverseQueue.length > 0) {
      const curr = reverseQueue.shift()!;
      if (canReachReturn.has(curr)) continue;
      canReachReturn.add(curr);
      for (const edge of value.edges) {
        if (edge.to_node === curr && !canReachReturn.has(edge.from_node)) {
          reverseQueue.push(edge.from_node);
        }
      }
    }
    if (canReachReturn.size !== value.nodes.length) {
      context.addIssue({ code: "custom", path: ["nodes"], message: "All paths in the flow must terminate at a return node" });
    }
  }

  const inDegree = new Map<string, number>();
  for (const id of nodeAliases) inDegree.set(id, 0);
  for (const edge of value.edges) {
    const to = edge.to_node;
    if (inDegree.has(to)) inDegree.set(to, inDegree.get(to)! + 1);
  }
  const zeroInDegree = nodeAliases.filter((id) => inDegree.get(id) === 0);
  let processedCount = 0;
  const topologicalOrder: string[] = [];
  const topoQueue = [...zeroInDegree];
  while (topoQueue.length > 0) {
    const curr = topoQueue.shift()!;
    topologicalOrder.push(curr);
    processedCount++;
    for (const edge of value.edges) {
      if (edge.from_node === curr) {
        const to = edge.to_node;
        const remaining = (inDegree.get(to) ?? 1) - 1;
        inDegree.set(to, remaining);
        if (remaining === 0) topoQueue.push(to);
      }
    }
  }
  if (processedCount !== value.nodes.length) {
    context.addIssue({ code: "custom", path: ["edges"], message: "Flow graph must be acyclic (no cycles allowed)" });
  }

  const nodeById = new Map(value.nodes.map((n) => [n.id, n]));
  const dominators = new Map<string, Set<string>>();
  for (const nodeId of topologicalOrder) {
    const parents = value.edges
      .filter((edge) => edge.to_node === nodeId)
      .map((edge) => edge.from_node);
    const dominated =
      parents.length === 0
        ? new Set<string>()
        : new Set(
            [...(dominators.get(parents[0]!) ?? [])].filter((candidate) =>
              parents.slice(1).every((parent) => dominators.get(parent)?.has(candidate)),
            ),
          );
    dominated.add(nodeId);
    dominators.set(nodeId, dominated);
  }
  for (const node of value.nodes) {
    if (node.kind === "query" || node.kind === "action" || node.kind === "transform") {
      for (const [inputKey, inputBinding] of Object.entries(node.inputs)) {
        if (inputBinding.value.source === "flow_input") {
          const flowInput = value.inputs[inputBinding.value.input];
          if (!flowInput) {
            context.addIssue({ code: "custom", path: ["nodes"], message: `Input '${inputKey}' references unknown flow input '${inputBinding.value.input}'` });
          } else if (flowInput.type !== inputBinding.type) {
            context.addIssue({ code: "custom", path: ["nodes"], message: `Input '${inputKey}' type '${inputBinding.type}' is incompatible with flow input type '${flowInput.type}'` });
          }
        } else if (inputBinding.value.source === "flow_variable") {
          const flowVar = value.variables[inputBinding.value.variable];
          if (!flowVar) {
            context.addIssue({ code: "custom", path: ["nodes"], message: `Input '${inputKey}' references unknown flow variable '${inputBinding.value.variable}'` });
          } else if (flowVar.type !== inputBinding.type) {
            context.addIssue({ code: "custom", path: ["nodes"], message: `Input '${inputKey}' type '${inputBinding.type}' is incompatible with flow variable type '${flowVar.type}'` });
          }
        } else if (inputBinding.value.source === "node_output") {
          const refNodeId = inputBinding.value.node;
          const refNode = nodeById.get(refNodeId);
          if (!refNode) {
            context.addIssue({ code: "custom", path: ["nodes"], message: `Input '${inputKey}' references unknown node '${refNodeId}'` });
          } else {
            if (refNodeId === node.id || !dominators.get(node.id)?.has(refNodeId)) {
              context.addIssue({ code: "custom", path: ["nodes"], message: `Input '${inputKey}' references node output from subsequent or concurrent node` });
            }
            const declaredOutput = refNode.kind === "return"
              ? undefined
              : refNode.outputs[inputBinding.value.output];
            if (!declaredOutput) {
              context.addIssue({ code: "custom", path: ["nodes"], message: `Node '${refNode.key}' does not declare output '${inputBinding.value.output}'` });
            } else if (declaredOutput.type !== inputBinding.type) {
              context.addIssue({ code: "custom", path: ["nodes"], message: `Input '${inputKey}' type '${inputBinding.type}' is incompatible with output type '${declaredOutput.type}'` });
            }
          }
        }
      }
      const mappedOutputs = new Set<string>();
      for (const [resultKey, mapping] of Object.entries(node.results)) {
        const declaredOutput = node.outputs[mapping.output];
        if (!declaredOutput || mapping.type !== declaredOutput.type) {
          context.addIssue({ code: "custom", path: ["nodes"], message: `Result '${resultKey}' must map to a compatible declared node output` });
        }
        if (mappedOutputs.has(mapping.output)) {
          context.addIssue({ code: "custom", path: ["nodes"], message: `Node output '${mapping.output}' cannot be mapped more than once` });
        }
        mappedOutputs.add(mapping.output);
      }
      for (const [outputKey, output] of Object.entries(node.outputs)) {
        if (output.required && !mappedOutputs.has(outputKey)) {
          context.addIssue({ code: "custom", path: ["nodes"], message: `Required node output '${outputKey}' needs an explicit result mapping` });
        }
      }
    } else if (node.kind === "return") {
      for (const [resultKey, resultValue] of Object.entries(node.results)) {
        const expectedOutput = value.outputs[resultKey];
        if (!expectedOutput) {
          context.addIssue({ code: "custom", path: ["nodes"], message: `Return result '${resultKey}' is not declared by the flow` });
          continue;
        }
        if (resultValue.source === "flow_input") {
          const input = value.inputs[resultValue.input];
          if (!input || !flowDeclarationsCompatible(input, expectedOutput)) {
            context.addIssue({ code: "custom", path: ["nodes"], message: `Return result '${resultKey}' references unknown flow input '${resultValue.input}'` });
          }
        } else if (resultValue.source === "flow_variable") {
          const variable = value.variables[resultValue.variable];
          if (!variable || !flowDeclarationsCompatible(variable, expectedOutput)) {
            context.addIssue({ code: "custom", path: ["nodes"], message: `Return result '${resultKey}' references unknown flow variable '${resultValue.variable}'` });
          }
        } else if (resultValue.source === "node_output") {
          const refNodeId = resultValue.node;
          const refNode = nodeById.get(refNodeId);
          const declaredOutput = refNode?.kind === "return"
            ? undefined
            : refNode?.outputs[resultValue.output];
          if (
            !refNode ||
            refNodeId === node.id ||
            !dominators.get(node.id)?.has(refNodeId) ||
            !declaredOutput ||
            !flowDeclarationsCompatible(declaredOutput, expectedOutput)
          ) {
            context.addIssue({ code: "custom", path: ["nodes"], message: `Return result '${resultKey}' references unknown node '${refNodeId}'` });
          }
        }
      }
      for (const [outputKey, output] of Object.entries(value.outputs)) {
        if (output.required && !(outputKey in node.results)) {
          context.addIssue({ code: "custom", path: ["nodes"], message: `Return node must map required flow output '${outputKey}'` });
        }
      }
    }
  }
  for (const issue of analyzeFlowResultRouting(
    value.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      ...(node.kind === "action" ? { actionTarget: node.target.kind } : {}),
      ...(node.kind === "return" ? { returnOutcome: node.outcome } : {}),
    })),
    value.edges.map((edge) => ({
      from: edge.from_node,
      to: edge.to_node,
      outcome: edge.outcome,
    })),
  ))
    context.addIssue({ code: "custom", path: [...issue.path], message: issue.message });
}

export const sourceCurrentUserFlowSchema = z
  .object({
    id: sourceAliasSchema,
    key: builderKeySchema,
    name: labelSchema,
    description: z.string().max(1000).optional(),
    run_as: z.literal("current_user").default("current_user"),
    inputs: z.record(builderKeySchema, sourceFlowValueDeclarationSchema).default({}),
    outputs: z.record(builderKeySchema, sourceFlowValueDeclarationSchema).default({}),
    variables: z.record(builderKeySchema, sourceFlowVariableDeclarationSchema).default({}),
    nodes: z.array(sourceCurrentUserFlowNodeSchema).min(2).max(100),
    edges: z.array(sourceCurrentUserFlowEdgeSchema).min(1).max(200),
  })
  .strict()
  .superRefine(validateSourceCurrentUserFlowGraph);

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
export type ResolvedFlowTargetEvidence = z.infer<typeof resolvedFlowTargetEvidenceSchema>;
export type FlowTargetDependency = z.infer<typeof flowTargetDependencySchema>;
export type PlatformManagedFlowDependency = z.infer<typeof platformManagedFlowDependencySchema>;
export type PlatformServiceOperationRelease = z.infer<
  typeof platformServiceOperationReleaseSchema
>;
export type ProtectedOperationPermissionReference = z.infer<
  typeof protectedOperationPermissionReferenceSchema
>;
export type SafeFlowResultKind = z.infer<typeof safeFlowResultKindSchema>;
export type SafeFlowResultDescriptor = z.infer<typeof safeFlowResultDescriptorSchema>;
export type ProtectedOperationDescriptor = z.infer<typeof protectedOperationDescriptorSchema>;
export type FlowNodeRunAs = z.infer<typeof flowNodeRunAsSchema>;
export type FrontendFlowNodeTarget = z.infer<typeof frontendFlowNodeTargetSchema>;
export type FlowExecutionBindingSurface = z.infer<typeof flowExecutionBindingSurfaceSchema>;
export type FlowExecutionInvoker = z.infer<typeof flowExecutionInvokerSchema>;
export type FlowExecutionBindingActor = z.infer<typeof flowExecutionBindingActorSchema>;
export type FlowExecutionBindingState = z.infer<typeof flowExecutionBindingStateSchema>;
export type FlowExecutionBindingEffectiveState = z.infer<
  typeof flowExecutionBindingEffectiveStateSchema
>;
export type FlowExecutionBinding = z.infer<typeof flowExecutionBindingSchema>;
export type FlowNodeInputValue = z.infer<typeof flowNodeInputValueSchema>;
export type FlowNodeInputBinding = z.infer<typeof flowNodeInputBindingSchema>;
export type FlowVariableDeclaration = z.infer<typeof flowVariableDeclarationSchema>;
export type FrontendFlowNodeBinding = z.infer<typeof frontendFlowNodeBindingSchema>;
export type CurrentUserFlowQueryTarget = z.infer<typeof currentUserFlowQueryTargetSchema>;
export type CurrentUserFlowActionTarget = z.infer<typeof currentUserFlowActionTargetSchema>;
export type CurrentUserFlowStartNode = z.infer<typeof currentUserFlowStartNodeSchema>;
export type CurrentUserFlowQueryNode = z.infer<typeof currentUserFlowQueryNodeSchema>;
export type CurrentUserFlowActionNode = z.infer<typeof currentUserFlowActionNodeSchema>;
export type CurrentUserFlowTransformNode = z.infer<typeof currentUserFlowTransformNodeSchema>;
export type CurrentUserFlowReturnNode = z.infer<typeof currentUserFlowReturnNodeSchema>;
export type CurrentUserFlowNode = z.infer<typeof currentUserFlowNodeSchema>;
export type CurrentUserFlowEdge = z.infer<typeof currentUserFlowEdgeSchema>;
export type CurrentUserFlow = z.infer<typeof currentUserFlowSchema>;
export type ServerResolvedFlowInput = z.infer<typeof serverResolvedFlowInputSchema>;
export type PrivateFormContinuationDescriptor = z.infer<
  typeof privateFormContinuationDescriptorSchema
>;
export type RecordFreeDurableStartContinuationDescriptor = z.infer<
  typeof recordFreeDurableStartContinuationDescriptorSchema
>;
export type FlowContinuationDescriptor = z.infer<typeof flowContinuationDescriptorSchema>;
export type CurrentUserFlowActionDescriptor = z.infer<
  typeof currentUserFlowActionDescriptorSchema
>;

export type SourceComponentBindingContext = z.infer<typeof sourceComponentBindingContextSchema>;
export type SourceComponentFlowInputValue = z.infer<typeof sourceComponentFlowInputValueSchema>;
export type SourceTypedFlowInputBinding = z.infer<typeof sourceTypedFlowInputBindingSchema>;
export type SourceFrontendFlowReference = z.infer<typeof sourceFrontendFlowReferenceSchema>;
export type SourceComponentFlowBinding = z.infer<typeof sourceComponentFlowBindingSchema>;
export type SourceFlowNodeInputValue = z.infer<typeof sourceFlowNodeInputValueSchema>;
export type SourceFlowNodeInputBinding = z.infer<typeof sourceFlowNodeInputBindingSchema>;
export type SourceFlowValueDeclaration = z.infer<typeof sourceFlowValueDeclarationSchema>;
export type SourceFlowVariableDeclaration = z.infer<typeof sourceFlowVariableDeclarationSchema>;
export type SourceCurrentUserFlowQueryTarget = z.infer<typeof sourceCurrentUserFlowQueryTargetSchema>;
export type SourceCurrentUserFlowActionTarget = z.infer<typeof sourceCurrentUserFlowActionTargetSchema>;
export type SourceCurrentUserFlowStartNode = z.infer<typeof sourceCurrentUserFlowStartNodeSchema>;
export type SourceCurrentUserFlowQueryNode = z.infer<typeof sourceCurrentUserFlowQueryNodeSchema>;
export type SourceCurrentUserFlowActionNode = z.infer<typeof sourceCurrentUserFlowActionNodeSchema>;
export type SourceCurrentUserFlowTransformNode = z.infer<typeof sourceCurrentUserFlowTransformNodeSchema>;
export type SourceCurrentUserFlowReturnNode = z.infer<typeof sourceCurrentUserFlowReturnNodeSchema>;
export type SourceCurrentUserFlowNode = z.infer<typeof sourceCurrentUserFlowNodeSchema>;
export type SourceCurrentUserFlowEdge = z.infer<typeof sourceCurrentUserFlowEdgeSchema>;
export type SourceCurrentUserFlow = z.infer<typeof sourceCurrentUserFlowSchema>;
