import { z } from "zod";
import { workflowValueTypeSchema } from "./catalogues";
import { jsonValueSchema, labelSchema } from "./common";
import {
  sourceAliasSchema,
  sourceQualifiedConditionSchema,
  sourceQualifiedRecordTypeSchema,
} from "./definition-source-common";
import { conditionNodeSchema } from "./module-contracts";
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
  versionRequirementSchema,
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
    bindingId: containedComponentIdSchema.optional(),
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

export const flowVariableDeclarationSchema = z
  .object({
    variableId: containedComponentIdSchema.optional(),
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
      moduleReleaseVersion: semanticVersionSchema,
      queryId: queryIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("application_query"),
      queryId: queryIdSchema,
    })
    .strict(),
]);

export const currentUserFlowActionTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("protected_operation"),
      operation: protectedOperationReferenceSchema,
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
  z
    .object({
      kind: z.literal("application_action"),
      actionKey: namespacedKeySchema,
    })
    .strict(),
]);

export const currentUserFlowStartNodeSchema = z
  .object({
    nodeId: containedComponentIdSchema,
    key: builderKeySchema,
    kind: z.literal("start"),
    label: labelSchema.optional(),
    runAs: flowNodeRunAsSchema.default({ kind: "current_user" }),
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
    runAs: flowNodeRunAsSchema.default({ kind: "current_user" }),
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
    runAs: flowNodeRunAsSchema.default({ kind: "current_user" }),
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
  const edgeSignatures = value.edges.map((e) => `${e.fromNodeId}:${e.toNodeId}:${e.outcome ?? ""}`);
  if (new Set(edgeSignatures).size !== edgeSignatures.length) {
    context.addIssue({ code: "custom", path: ["edges"], message: "Flow edges must be unique" });
  }

  const startNodes = value.nodes.filter((n) => n.kind === "start");
  if (startNodes.length !== 1) {
    context.addIssue({ code: "custom", path: ["nodes"], message: "A flow must have exactly one start node" });
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

  const topoIndex = new Map(topologicalOrder.map((id, idx) => [id, idx]));
  const nodeById = new Map(value.nodes.map((n) => [String(n.nodeId), n]));
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
            const currentIdx = topoIndex.get(String(node.nodeId)) ?? -1;
            const refIdx = topoIndex.get(refNodeId) ?? -1;
            if (refIdx >= currentIdx) {
              context.addIssue({ code: "custom", path: ["nodes"], message: `Input '${inputKey}' references node output from subsequent or concurrent node` });
            }
            if (refNode.kind !== "return") {
              const declaredOutput = (refNode as any).outputs?.[inputBinding.value.output];
              if (!declaredOutput) {
                context.addIssue({ code: "custom", path: ["nodes"], message: `Node '${refNode.key}' does not declare output '${inputBinding.value.output}'` });
              } else if (declaredOutput.type !== inputBinding.type) {
                context.addIssue({ code: "custom", path: ["nodes"], message: `Input '${inputKey}' type '${inputBinding.type}' is incompatible with output type '${declaredOutput.type}'` });
              }
            }
          }
        }
      }
    } else if (node.kind === "return") {
      for (const [resultKey, resultValue] of Object.entries(node.results)) {
        if (resultValue.source === "flow_input") {
          if (!value.inputs[resultValue.input]) {
            context.addIssue({ code: "custom", path: ["nodes"], message: `Return result '${resultKey}' references unknown flow input '${resultValue.input}'` });
          }
        } else if (resultValue.source === "flow_variable") {
          if (!value.variables[resultValue.variable]) {
            context.addIssue({ code: "custom", path: ["nodes"], message: `Return result '${resultKey}' references unknown flow variable '${resultValue.variable}'` });
          }
        } else if (resultValue.source === "node_output") {
          const refNodeId = String(resultValue.nodeId);
          const refNode = nodeById.get(refNodeId);
          if (!refNode) {
            context.addIssue({ code: "custom", path: ["nodes"], message: `Return result '${resultKey}' references unknown node '${refNodeId}'` });
          }
        }
      }
    }
  }
}

export const currentUserFlowSchema = z
  .object({
    flowId: ruleIdSchema,
    key: builderKeySchema,
    name: labelSchema,
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
      relationship: sourceAliasSchema,
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
      release_version: semanticVersionSchema,
    })
    .strict(),
]);

export const sourceComponentFlowBindingSchema = z
  .object({
    id: sourceAliasSchema.optional(),
    control: sourceAliasSchema,
    event_id: sourceAliasSchema.optional(),
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
    id: sourceAliasSchema.optional(),
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
      version: versionRequirementSchema.optional(),
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
    })
    .strict(),
  z
    .object({
      kind: z.literal("form_continuation"),
      form: sourceAliasSchema,
      continuation_event: sourceAliasSchema.optional(),
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
]);

export const sourceCurrentUserFlowStartNodeSchema = z
  .object({
    id: sourceAliasSchema,
    key: builderKeySchema,
    kind: z.literal("start"),
    label: labelSchema.optional(),
    run_as: flowNodeRunAsSchema.default({ kind: "current_user" }),
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
    run_as: flowNodeRunAsSchema.default({ kind: "current_user" }),
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
    run_as: flowNodeRunAsSchema.default({ kind: "current_user" }),
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
    id: sourceAliasSchema.optional(),
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
  const nodeAliases = value.nodes.map((n) => n.id);
  const nodeKeys = value.nodes.map((n) => n.key);
  if (new Set(nodeAliases).size !== nodeAliases.length) {
    context.addIssue({ code: "custom", path: ["nodes"], message: "Flow node aliases must be unique" });
  }
  if (new Set(nodeKeys).size !== nodeKeys.length) {
    context.addIssue({ code: "custom", path: ["nodes"], message: "Flow node keys must be unique" });
  }
  const edgeSignatures = value.edges.map((e) => `${e.from_node}:${e.to_node}:${e.outcome ?? ""}`);
  if (new Set(edgeSignatures).size !== edgeSignatures.length) {
    context.addIssue({ code: "custom", path: ["edges"], message: "Flow edges must be unique" });
  }

  const startNodes = value.nodes.filter((n) => n.kind === "start");
  if (startNodes.length !== 1) {
    context.addIssue({ code: "custom", path: ["nodes"], message: "A flow must have exactly one start node" });
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

  const topoIndex = new Map(topologicalOrder.map((id, idx) => [id, idx]));
  const nodeById = new Map(value.nodes.map((n) => [n.id, n]));
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
            const currentIdx = topoIndex.get(node.id) ?? -1;
            const refIdx = topoIndex.get(refNodeId) ?? -1;
            if (refIdx >= currentIdx) {
              context.addIssue({ code: "custom", path: ["nodes"], message: `Input '${inputKey}' references node output from subsequent or concurrent node` });
            }
            if (refNode.kind !== "return") {
              const declaredOutput = (refNode as any).outputs?.[inputBinding.value.output];
              if (!declaredOutput) {
                context.addIssue({ code: "custom", path: ["nodes"], message: `Node '${refNode.key}' does not declare output '${inputBinding.value.output}'` });
              } else if (declaredOutput.type !== inputBinding.type) {
                context.addIssue({ code: "custom", path: ["nodes"], message: `Input '${inputKey}' type '${inputBinding.type}' is incompatible with output type '${declaredOutput.type}'` });
              }
            }
          }
        }
      }
    } else if (node.kind === "return") {
      for (const [resultKey, resultValue] of Object.entries(node.results)) {
        if (resultValue.source === "flow_input") {
          if (!value.inputs[resultValue.input]) {
            context.addIssue({ code: "custom", path: ["nodes"], message: `Return result '${resultKey}' references unknown flow input '${resultValue.input}'` });
          }
        } else if (resultValue.source === "flow_variable") {
          if (!value.variables[resultValue.variable]) {
            context.addIssue({ code: "custom", path: ["nodes"], message: `Return result '${resultKey}' references unknown flow variable '${resultValue.variable}'` });
          }
        } else if (resultValue.source === "node_output") {
          const refNodeId = resultValue.node;
          const refNode = nodeById.get(refNodeId);
          if (!refNode) {
            context.addIssue({ code: "custom", path: ["nodes"], message: `Return result '${resultKey}' references unknown node '${refNodeId}'` });
          }
        }
      }
    }
  }
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
export type ProtectedOperationPermissionReference = z.infer<
  typeof protectedOperationPermissionReferenceSchema
>;
export type SafeFlowResultKind = z.infer<typeof safeFlowResultKindSchema>;
export type ProtectedOperationDescriptor = z.infer<typeof protectedOperationDescriptorSchema>;
export type FlowNodeRunAs = z.infer<typeof flowNodeRunAsSchema>;
export type FrontendFlowNodeTarget = z.infer<typeof frontendFlowNodeTargetSchema>;
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

