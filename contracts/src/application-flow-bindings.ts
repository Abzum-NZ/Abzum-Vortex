import { z } from "zod";
import { workflowValueTypeSchema } from "./catalogues";
import { sourceAliasSchema } from "./definition-source-common";
import { flowBindingInputSchema, flowBindingSchema } from "./flow-contracts";
import { flowAliasSchema } from "./flow-source-contracts";
import {
  actorIdSchema,
  applicationRootIdSchema,
  builderKeySchema,
  containedComponentIdSchema,
  eventIdSchema,
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
import { protectedOperationChannelSchema } from "./operation-contracts";

/**
 * The vocabulary Application flows share with the protected-operation, execution-binding and
 * dependency-manifest contracts. The current-user node-and-edge flow and its per-surface component
 * binding were removed with #986: an Application owns ordinary flows (`flow-contracts.ts`), and a
 * component binding holds only the flow id plus a typed input map (`flowBindingSchema`). #988
 * removed the remaining unused authored type aliases; every schema that stays below is consumed,
 * directly or through a schema that composes it, by the compiler, publication, access or runtime
 * contracts.
 */
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

export const typedFlowResultMappingSchema = z
  .object({
    output: builderKeySchema,
    type: workflowValueTypeSchema,
  })
  .strict();

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

/**
 * A component placement's binding of one semantic event to one flow: the flow's permanent
 * identity plus a typed input map, and nothing else (architecture decision 1). The flow's own
 * declaration says what it needs, what it returns and what it may do, so a binding carries no
 * routing, result mapping or declared effect of its own. A value the surface itself supplies, such
 * as a form's answers or a selection, is a `caller` input named for the flow input it fills.
 */
export const componentFlowBindingSchema = z
  .object({
    bindingId: containedComponentIdSchema,
    controlId: containedComponentIdSchema,
    eventId: eventIdSchema,
    event: componentSemanticEventKindSchema,
    flow: flowBindingSchema,
  })
  .strict();


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
]);

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
    /**
     * The declared outputs whose raw value must never be persisted or replayed: the runtime returns
     * them once in the live result and records only that they were issued when it stores the effect.
     * Each name must be one of the operation's own declared outputs; nothing is named here for a
     * business reason, so a generic engine never special-cases an operation.
     */
    sensitiveOutputs: z.array(builderKeySchema).max(20).optional(),
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
    const sensitiveOutputs = value.sensitiveOutputs ?? [];
    if (new Set(sensitiveOutputs).size !== sensitiveOutputs.length)
      context.addIssue({
        code: "custom",
        path: ["sensitiveOutputs"],
        message: "Sensitive outputs must be unique",
      });
    for (const name of sensitiveOutputs)
      if (!Object.hasOwn(value.outputs, name))
        context.addIssue({
          code: "custom",
          path: ["sensitiveOutputs"],
          message: "A sensitive output must be one of the operation's declared outputs",
        });
      else if (Object.hasOwn(value.outputs, `${name}_issued`))
        context.addIssue({
          code: "custom",
          path: ["sensitiveOutputs"],
          message: "A sensitive output's issued marker must not be a declared output",
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
 *
 * The surface is the same one channel vocabulary as the Activity source, so a binding's permitted
 * surface and the recorded source of the operation it invokes never diverge.
 */
export const flowExecutionBindingSurfaceSchema = protectedOperationChannelSchema;

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

// --- Source equivalent for a component's flow binding ---

/**
 * The authored binding. `flow` names an application-owned flow by its owner alias or its key, and
 * each input is the closed value the canonical binding holds: a literal, a typed reference, a
 * formula or a value the invoking surface supplies by name.
 */
export const sourceComponentFlowBindingSchema = z
  .object({
    id: sourceAliasSchema,
    control: sourceAliasSchema,
    event_id: sourceAliasSchema,
    event: componentSemanticEventKindSchema,
    flow: flowAliasSchema,
    inputs: z
      .record(builderKeySchema, flowBindingInputSchema)
      .refine((inputs) => Object.keys(inputs).length <= 100, {
        message: "At most 100 entries are allowed",
      })
      .default({}),
  })
  .strict();


export type ComponentSemanticEventKind = z.infer<typeof componentSemanticEventKindSchema>;
export type FlowEffectKind = z.infer<typeof flowEffectKindSchema>;
export type ProtectedOperationEffectKind = z.infer<typeof protectedOperationEffectKindSchema>;
export type ComponentFlowBinding = z.infer<typeof componentFlowBindingSchema>;
export type ProtectedOperationReference = z.infer<typeof protectedOperationReferenceSchema>;
export type PlatformServiceOperationRelease = z.infer<
  typeof platformServiceOperationReleaseSchema
>;
export type SafeFlowResultKind = z.infer<typeof safeFlowResultKindSchema>;
export type SafeFlowResultDescriptor = z.infer<typeof safeFlowResultDescriptorSchema>;
export type ProtectedOperationDescriptor = z.infer<typeof protectedOperationDescriptorSchema>;
export type FlowExecutionBinding = z.infer<typeof flowExecutionBindingSchema>;
