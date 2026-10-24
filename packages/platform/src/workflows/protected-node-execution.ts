import "server-only";

import {
  builderKeySchema,
  describeFailure,
  findPlatformServiceOperation,
  flowValueSchema,
  flowTaskChildLists,
  flowTaskRegistry,
  jsonValueSchema,
  PLATFORM_SERVICE_OPERATIONS,
  platformOperationKey,
  protectedOperationRequestSchema,
  protectedOperationReferenceSetSchema,
  stableDefinitionReleaseVersionSchema,
  workflowExecutionReferenceSchema,
  workflowNodeIdSchema,
  workflowRunIdSchema,
  type FlowReference,
  type FlowTask,
  type FlowValue,
  type JsonValue,
  type WorkflowExecutionReference,
} from "../schema";
import { evaluateFlowFormula, type FlowRuntimeValue } from "../rules/index";
import type { RequestDatabaseTransaction } from "../db/index";
import { z } from "zod";
import {
  resolveDurableActorContext,
  retainedRunAuthoritySchema,
} from "./durable-actor-context";
import { protectedRunRegisteredReleaseSchema } from "./flow-registration";
import { deriveKestraNodeId } from "./kestra-compiler";
import type { ProtectedOperationExecutor } from "../definition/protected-operation-executor";
import { durableRecordUpdateSchema, type DurableRecordUpdate } from "../definition/durable-record-update";

const maximumCallbackAttempts = 5;
const callbackRetryDelayMs = 1_000;

const protectedOperationIdentitySchema = z
  .object({
    serviceId: z.guid(),
    operationId: z.guid(),
    releaseVersion: stableDefinitionReleaseVersionSchema,
  })
  .strict();
const retainedNodeBindingSchema = z
  .object({
    nodeId: workflowNodeIdSchema,
    taskType: z.string().min(1).max(100),
    operationKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    operation: protectedOperationIdentitySchema.optional(),
    operations: protectedOperationReferenceSetSchema.optional(),
    grantable: z.boolean().optional(),
  })
  .strict()
  .superRefine((binding, context) => {
    if (binding.taskType === "operation.call" && binding.operation === undefined)
      context.addIssue({ code: "custom", path: ["operation"], message: "A protected operation binding is required" });
    const carriesOperationReferences =
      binding.taskType === "record.query" || binding.taskType.startsWith("record.");
    if (
      carriesOperationReferences !== (binding.operations !== undefined) ||
      carriesOperationReferences !== (binding.grantable !== undefined)
    )
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: "Record and Query nodes retain their published operation reference set",
      });
    if (
      binding.operations !== undefined &&
      binding.grantable !== (binding.operations.length > 0)
    )
      context.addIssue({
        code: "custom",
        path: ["grantable"],
        message: "Only a node with a static protected operation reference is grantable",
      });
    if (binding.taskType === "record.query" && binding.operations?.length !== 1)
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: "A Query node retains exactly one query operation reference",
      });
    if (binding.operations?.some((operation) => operation.owner.kind === "platform_service"))
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: "Record and Query references are owned by an Application or Module",
      });
  });

const kestraExecutionBindingSchema = z
  .object({
    tenant: z.string().min(1).max(100),
    namespace: z.string().min(1).max(150),
    flowId: z.string().min(1).max(100),
    executionId: z.string().min(1).max(100),
  })
  .strict();

/** Private Vortex storage for one accepted run and its exact operation bindings. */
export const protectedNodeRunRecordSchema = z
  .object({
    authority: retainedRunAuthoritySchema,
    executionReference: workflowExecutionReferenceSchema,
    nodes: z.array(retainedNodeBindingSchema).max(100),
    kestra: kestraExecutionBindingSchema,
  })
  .strict()
  .superRefine((record, context) => {
    const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
    if (!same(record.authority.runId, record.executionReference.runId))
      context.addIssue({ code: "custom", path: ["executionReference", "runId"], message: "Run identity mismatch" });
    if (
      !same(record.authority.organizationId, record.executionReference.organizationId) ||
      !same(record.authority.applicationRootId, record.executionReference.applicationRootId) ||
      !same(record.authority.workflowId, record.executionReference.workflowId) ||
      record.authority.workflowRevision !== record.executionReference.workflowRevision
    )
      context.addIssue({ code: "custom", path: ["executionReference"], message: "Run authority binding mismatch" });
    const nodeIds = record.nodes.map((node) => node.nodeId.toLowerCase());
    if (new Set(nodeIds).size !== nodeIds.length)
      context.addIssue({ code: "custom", path: ["nodes"], message: "Node identities must be unique" });
    const authorityNodeIds = new Set(record.authority.nodes.map((node) => node.nodeId.toLowerCase()));
    if (
      record.nodes.length !== authorityNodeIds.size ||
      record.nodes.some((node) => !authorityNodeIds.has(node.nodeId.toLowerCase()))
    )
      context.addIssue({ code: "custom", path: ["nodes"], message: "Node bindings must match retained authority" });
    for (const node of record.nodes) {
      const authorityNode = record.authority.nodes.find((candidate) => same(candidate.nodeId, node.nodeId));
      if (authorityNode === undefined || authorityNode.operationKey !== node.operationKey)
        context.addIssue({ code: "custom", path: ["nodes"], message: "Node operation bindings must match retained authority" });
    }
  });

export type ProtectedNodeRunRecord = z.infer<typeof protectedNodeRunRecordSchema>;

/** Private run reads must carry the exact registration/release proof before effects. */
export const protectedNodeRegisteredRunSchema = z
  .object({
    runRecord: protectedNodeRunRecordSchema,
    registeredRelease: protectedRunRegisteredReleaseSchema,
  })
  .strict()
  .superRefine(({ runRecord, registeredRelease }, context) => {
    const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
    const authority = runRecord.authority;
    if (
      !same(authority.organizationId, registeredRelease.organizationId) ||
      !same(authority.applicationRootId, registeredRelease.applicationRootId) ||
      !same(authority.workflowId, registeredRelease.permanentFlowId) ||
      authority.applicationReleaseVersion !== registeredRelease.applicationVersion ||
      runRecord.executionReference.applicationVersion !== registeredRelease.applicationVersion ||
      authority.workflowRevision !== registeredRelease.compilerWorkflowRevision ||
      runRecord.kestra.namespace !== registeredRelease.namespace ||
      runRecord.kestra.flowId !== registeredRelease.providerFlowId
    )
      context.addIssue({ code: "custom", message: "Retained run registration identity mismatch" });
  });

export type ProtectedNodeRegisteredRun = z.infer<typeof protectedNodeRegisteredRunSchema>;

/** The narrow run-store API. Kestra identifiers remain private to this server-side adapter. */
export type ProtectedNodeRunStore = Readonly<{
  read: (runId: string) => Promise<ProtectedNodeRegisteredRun | undefined>;
  /** The #666 flow-start owner calls this seam after accepting the private Kestra mapping. */
  write: (record: unknown) => Promise<boolean>;
  refreshLastKnownState?: (
    runId: string,
    state: WorkflowExecutionReference["lastKnownState"],
    refreshedAt: string,
  ) => Promise<void>;
}>;

export class ProtectedNodeRunStoreError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "ProtectedNodeRunStoreError";
  }
}

export type ProtectedNodeEffectKey = Readonly<{
  runId: string;
  organizationId: string;
  identityId: string;
  taskPath: string;
  iteration: string;
}>;

export type ProtectedNodeEffectClaim =
  | Readonly<{ kind: "claimed" }>
  | Readonly<{
      kind: "completed";
      outcome: string;
      outputs: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{ kind: "in_progress" }>
  | Readonly<{ kind: "unavailable" }>;

type ProtectedNodeEffectReplay =
  | Extract<ProtectedNodeEffectClaim, { kind: "completed" | "in_progress" | "unavailable" }>
  | Readonly<{ kind: "missing" }>;

/** The existing private flow-effect ledger; the application action remains the owning transaction. */
export type ProtectedNodeEffectLedger = Readonly<{
  replay: (key: ProtectedNodeEffectKey, operationKey: string) => Promise<ProtectedNodeEffectReplay>;
  begin: (transaction: RequestDatabaseTransaction, key: ProtectedNodeEffectKey, operationKey: string) => Promise<ProtectedNodeEffectClaim>;
  complete: (
    transaction: RequestDatabaseTransaction,
    key: ProtectedNodeEffectKey,
    outcome: string,
    outputs: Readonly<Record<string, unknown>>,
  ) => Promise<boolean>;
}>;

export type ProtectedNodeOperationIdentity = z.infer<typeof protectedOperationIdentitySchema>;

export type ProtectedNodeOperationExecutor = Pick<ProtectedOperationExecutor, "executeDurableActor">;

/** Safe callback response. `outputs` contains only the descriptor's declared values. */
export type ProtectedNodeCallbackResponse = Readonly<{
  outcome:
    | "completed"
    | "already_completed"
    | "waiting"
    | "retryable_failure"
    | "permanent_refusal";
  safeCode: string;
  nextPollAt?: string | undefined;
  outputs?: Readonly<Record<string, JsonValue>> | undefined;
}>;

export type ProtectedNodeRunStatus =
  | Readonly<{ availability: "current"; reference: WorkflowExecutionReference }>
  | Readonly<{
      availability: "unavailable";
      reference?: WorkflowExecutionReference;
      safeCode: "kestra_status_unavailable";
    }>;

export type ProtectedNodeExecutionDependencies = Readonly<{
  callbackKey: () => Uint8Array | undefined;
  correlationId: () => string;
  clock?: () => Date;
  runs: ProtectedNodeRunStore;
  effects: ProtectedNodeEffectLedger;
  operations: ProtectedNodeOperationExecutor;
  readKestraState: (binding: ProtectedNodeRunRecord["kestra"]) => Promise<unknown>;
}>;

const responseSchema = z
  .object({
    outcome: z.enum([
      "completed",
      "already_completed",
      "waiting",
      "retryable_failure",
      "permanent_refusal",
    ]),
    safeCode: builderKeySchema,
    nextPollAt: z.iso.datetime({ offset: true }).optional(),
    outputs: z.record(builderKeySchema, jsonValueSchema).optional(),
  })
  .strict();

const objectRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const sameIdentity = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const parseRegisteredRun = (
  candidate: unknown,
  expectedRunId: string,
): ProtectedNodeRegisteredRun => {
  const parsed = protectedNodeRegisteredRunSchema.safeParse(candidate);
  if (!parsed.success)
    throw new ProtectedNodeRunStoreError("PROTECTED_WORKFLOW_RUN_MALFORMED", {
      cause: parsed.error,
    });
  if (!sameIdentity(parsed.data.runRecord.authority.runId, expectedRunId))
    throw new ProtectedNodeRunStoreError(
      "PROTECTED_WORKFLOW_RUN_IDENTITY_MISMATCH",
      { cause: new Error("PROTECTED_WORKFLOW_RUN_IDENTITY_MISMATCH") },
    );
  return parsed.data;
};

/**
 * Task types no protected callback can run; they refuse with `task_unavailable`. Of the record
 * tasks, only `record.set_fields` runs durably, as the initiating person.
 */
const unavailableTaskTypes: ReadonlySet<string> = new Set([
  "connection.call",
  "message.acknowledge",
  "file.export",
  "event.announce",
  "flow.run_background",
  "interface.show_form",
  "interface.confirm",
  "workflow.human_task",
]);

const isUnavailableTaskType = (taskType: string): boolean =>
  (taskType.startsWith("record.") && taskType !== "record.set_fields") ||
  unavailableTaskTypes.has(taskType);

/** Task properties use the closed FlowValue literal wrapper for fixed values. */
const literalValue = (candidate: unknown): unknown => {
  if (typeof candidate === "string") return candidate;
  const wrapped = objectRecord(candidate);
  if (wrapped?.kind !== "literal") return undefined;
  const literal = objectRecord(wrapped.literal);
  return literal && Object.hasOwn(literal, "value") ? literal.value : undefined;
};

const registeredOperationForBinding = (
  candidate: unknown,
  binding: ProtectedNodeRunRecord["nodes"][number],
): ProtectedNodeOperationIdentity | undefined => {
  const properties = objectRecord(candidate);
  const requestedKey = literalValue(properties?.operation);
  if (typeof requestedKey !== "string" || binding.operation === undefined) return undefined;

  const registeredByKey = Object.values(PLATFORM_SERVICE_OPERATIONS).find(
    (entry) => platformOperationKey(entry.key) === requestedKey,
  );
  if (
    registeredByKey === undefined ||
    !sameIdentity(registeredByKey.release.serviceId, binding.operation.serviceId) ||
    !sameIdentity(registeredByKey.release.operationId, binding.operation.operationId) ||
    registeredByKey.release.releaseVersion !== binding.operation.releaseVersion
  )
    return undefined;

  const registered = findPlatformServiceOperation(
    binding.operation.serviceId,
    binding.operation.operationId,
    binding.operation.releaseVersion,
  );
  return registered === undefined ? undefined : binding.operation;
};

const operationInputs = (candidate: unknown): Readonly<Record<string, unknown>> | undefined => {
  const properties = objectRecord(candidate);
  if (properties === undefined) return undefined;
  const resolved = objectRecord(properties.inputs);
  return resolved === undefined ? undefined : Object.freeze({ ...resolved });
};

const runtimeValueSchema = z
  .object({ type: z.string().min(1).max(80), value: jsonValueSchema })
  .strict();
const runtimeScopeSchema = z
  .object({
    inputs: z.record(builderKeySchema, runtimeValueSchema).default({}),
    variables: z.record(builderKeySchema, runtimeValueSchema).default({}),
    outputs: z
      .record(builderKeySchema, z.record(builderKeySchema, runtimeValueSchema))
      .default({}),
  })
  .strict();

const evaluateValue = (
  candidate: unknown,
  scopeCandidate: unknown,
  now: string,
): JsonValue | undefined => {
  const value = flowValueSchema.safeParse(candidate);
  const scope = runtimeScopeSchema.safeParse(scopeCandidate ?? {});
  if (!value.success || !scope.success) return undefined;
  const resolveReference = (reference: FlowReference): FlowRuntimeValue | undefined => {
    switch (reference.source) {
      case "input":
        return scope.data.inputs[reference.name];
      case "variable":
        return scope.data.variables[reference.name];
      case "task_output":
        return scope.data.outputs[reference.task]?.[reference.key];
      case "execution_now":
        return { type: "date_time", value: now };
      case "trigger_record":
      case "trigger_previous":
      case "execution_actor":
        return undefined;
    }
  };
  const resolveValue = (source: FlowValue): FlowRuntimeValue | undefined => {
    if (source.kind === "literal") return { type: source.literal.type, value: source.literal.value };
    if (source.kind === "reference") return resolveReference(source.reference);
    if (source.kind === "formula")
      return evaluateFlowFormula(source.formula, {
        now,
        reference: resolveReference,
      });
    if (source.kind === "map") {
      const entries: Record<string, JsonValue> = {};
      for (const [name, entry] of Object.entries(source.entries)) {
        const resolved = resolveValue(entry);
        if (resolved === undefined) return undefined;
        entries[name] = resolved.value;
      }
      return { type: "json", value: entries };
    }
    if (source.kind === "array") {
      const items: JsonValue[] = [];
      for (const item of source.items) {
        const resolved = resolveValue(item);
        if (resolved === undefined) return undefined;
        items.push(resolved.value);
      }
      return { type: "json", value: items };
    }
    return undefined;
  };
  return resolveValue(value.data)?.value;
};

/** Selects the exact published task; a signed callback cannot substitute its own properties. */
const recordUpdateForBinding = (
  registered: ProtectedNodeRegisteredRun,
  binding: ProtectedNodeRunRecord["nodes"][number],
  runtimeScope: unknown,
  now: string,
): DurableRecordUpdate | undefined => {
  if (!binding.grantable || binding.operations?.length !== 1) return undefined;
  const operation = binding.operations[0]!;
  if (operation.owner.kind !== "module") return undefined;
  const release = registered.registeredRelease;
  if (release.definition.runAs.kind !== "initiator") return undefined;
  const find = (tasks: readonly FlowTask[]): FlowTask | undefined => {
    for (const task of tasks) {
      const nodeId = deriveKestraNodeId(
        { ...release, workflowRevision: release.compilerWorkflowRevision },
        release.definition.id, task.id,
      );
      if (sameIdentity(nodeId, binding.nodeId)) return task;
      for (const children of flowTaskChildLists(task)) {
        const found = find(children.tasks);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  const task = find(release.definition.tasks) ?? find(release.definition.errors) ?? find(release.definition.finally);
  if (task?.type !== "record.set_fields" || !("properties" in task) ||
      binding.operationKey !== flowTaskRegistry["record.set_fields"].protectedOperationKey)
    return undefined;
  const properties = task.properties;
  const recordReference = flowValueSchema.safeParse(properties.record);
  const declaration = recordReference.success && recordReference.data.kind === "reference" &&
    recordReference.data.reference.source === "input"
    ? release.definition.inputs[recordReference.data.reference.name] : undefined;
  const recordTypeId = properties.record_type === undefined
    ? declaration?.recordTypeIds?.length === 1 ? declaration.recordTypeIds[0] : undefined
    : properties.record_type.kind === "literal" ? properties.record_type.literal.value : undefined;
  if (typeof recordTypeId !== "string" || !sameIdentity(recordTypeId, operation.operationId))
    return undefined;
  const result = durableRecordUpdateSchema.safeParse({
    recordTypeId, moduleRootId: operation.owner.moduleRootId,
    installationRevision: release.installationRevision,
    recordId: evaluateValue(properties.record, runtimeScope, now),
    values: evaluateValue(properties.values, runtimeScope, now),
  });
  return result.success ? result.data : undefined;
};

const kestraStateMap: Readonly<Record<string, WorkflowExecutionReference["lastKnownState"]>> = {
  CREATED: "queued",
  QUEUED: "queued",
  RUNNING: "running",
  PAUSED: "waiting",
  SUCCESS: "completed",
  KILLED: "cancelled",
  CANCELLED: "cancelled",
  FAILED: "failed",
  WARNING: "failed",
};

const statusState = (candidate: unknown): WorkflowExecutionReference["lastKnownState"] | undefined => {
  const execution = objectRecord(candidate);
  const state = objectRecord(execution?.state);
  const current = state?.current;
  return typeof current === "string" ? kestraStateMap[current] : undefined;
};

const safeResponse = (candidate: ProtectedNodeCallbackResponse): ProtectedNodeCallbackResponse => {
  const parsed = responseSchema.safeParse(candidate);
  return parsed.success ? parsed.data : { outcome: "retryable_failure", safeCode: "invalid_result" };
};

const ledgerOutcome = (response: ProtectedNodeCallbackResponse): string => {
  switch (response.outcome) {
    case "completed":
    case "already_completed":
      return "committed";
    case "waiting":
      return "uncertain";
    case "retryable_failure":
      return "failed";
    case "permanent_refusal":
      return response.safeCode === "invalid_input" ? "validation" : "refused";
  }
};

const storedResponse = (candidate: Readonly<Record<string, unknown>>): ProtectedNodeCallbackResponse | undefined => {
  const parsed = responseSchema.safeParse(candidate.response);
  return parsed.success ? parsed.data : undefined;
};

const nextPollAt = (now: Date): string => new Date(now.valueOf() + callbackRetryDelayMs).toISOString();

/**
 * Signed, short-lived callbacks for registered protected operations and safe Vortex run status.
 * The callback key, retained run and Kestra mapping are supplied only by trusted server wiring.
 */
export const createProtectedNodeExecution = (dependencies: ProtectedNodeExecutionDependencies) => {
  const clock = dependencies.clock ?? (() => new Date());

  return Object.freeze({
    async execute(candidate: unknown): Promise<ProtectedNodeCallbackResponse> {
      const envelope = protectedOperationRequestSchema.safeParse(candidate);
      if (!envelope.success) return { outcome: "permanent_refusal", safeCode: "callback_refused" };

      let registeredRun: ProtectedNodeRegisteredRun | undefined;
      try {
        const storedCandidate = await dependencies.runs.read(envelope.data.runId);
        registeredRun = storedCandidate === undefined
          ? undefined
          : parseRegisteredRun(storedCandidate, envelope.data.runId);
      } catch (error) {
        console.error(`[workflow] protected callback run read failed: ${describeFailure(error)}`);
        return { outcome: "retryable_failure", safeCode: "run_store_unavailable", nextPollAt: nextPollAt(clock()) };
      }
      if (registeredRun === undefined)
        return { outcome: "permanent_refusal", safeCode: "callback_refused" };
      const run = { data: registeredRun.runRecord };

      const contextResolution = resolveDurableActorContext(envelope.data, run.data.authority, {
        callbackKey: dependencies.callbackKey,
        correlationId: dependencies.correlationId,
        clock,
        permitTerminalForReplay: true,
      });
      if (contextResolution.outcome !== "verified")
        return { outcome: "permanent_refusal", safeCode: "callback_refused" };

      const context = contextResolution.context;
      const binding = run.data.nodes.find((node) => sameIdentity(node.nodeId, context.purpose.nodeId));
      if (binding === undefined || binding.operationKey !== context.purpose.operationKey)
        return { outcome: "permanent_refusal", safeCode: "callback_refused" };

      if (isUnavailableTaskType(binding.taskType)) {
        console.warn(
          `[workflow] protected callback refused: no callback runner for task type ${binding.taskType}`,
        );
        return { outcome: "permanent_refusal", safeCode: "task_unavailable" };
      }

      if (binding.taskType === "workflow.evaluate") {
        if (run.data.authority.state !== "running")
          return { outcome: "permanent_refusal", safeCode: "callback_refused" };
        if (context.purpose.attempt > maximumCallbackAttempts)
          return { outcome: "permanent_refusal", safeCode: "attempt_limit" };
        const properties = objectRecord(envelope.data.inputs.properties);
        const value = evaluateValue(
          properties?.expression,
          envelope.data.inputs.runtime_scope,
          context.issuedAt,
        );
        return value === undefined
          ? { outcome: "permanent_refusal", safeCode: "invalid_input" }
          : { outcome: "completed", safeCode: "completed", outputs: { value } };
      }

      const task = Object.hasOwn(flowTaskRegistry, binding.taskType)
        ? flowTaskRegistry[binding.taskType as keyof typeof flowTaskRegistry]
        : undefined;
      if (task === undefined || !task.runLocations.includes("durable"))
        return { outcome: "permanent_refusal", safeCode: "task_unavailable" };
      if (binding.taskType !== "operation.call" && binding.taskType !== "record.set_fields")
        return { outcome: "permanent_refusal", safeCode: "task_unavailable" };

      const recordUpdate = binding.taskType === "record.set_fields"
        ? recordUpdateForBinding(registeredRun, binding, envelope.data.inputs.runtime_scope, context.issuedAt)
        : undefined;
      if (binding.taskType === "record.set_fields" && recordUpdate === undefined)
        return { outcome: "permanent_refusal", safeCode: "invalid_input" };
      const properties = envelope.data.inputs.properties;
      const operation = recordUpdate === undefined ? registeredOperationForBinding(properties, binding) : undefined;
      const inputs = recordUpdate === undefined ? operationInputs(properties) : {};
      if (recordUpdate === undefined && operation === undefined)
        return { outcome: "permanent_refusal", safeCode: "operation_unavailable" };
      if (inputs === undefined)
        return { outcome: "permanent_refusal", safeCode: "invalid_input" };
      if (context.policy.kind !== "initiating_person")
        return { outcome: "permanent_refusal", safeCode: "actor_unavailable" };
      const registeredOperation = operation === undefined ? undefined : findPlatformServiceOperation(
        operation.serviceId, operation.operationId, operation.releaseVersion,
      );
      if (recordUpdate === undefined && registeredOperation === undefined)
        return { outcome: "permanent_refusal", safeCode: "operation_unavailable" };
      const target = recordUpdate === undefined ? { operation: operation! } : { recordUpdate };

      const effectKey: ProtectedNodeEffectKey = {
        runId: context.purpose.runId,
        organizationId: context.purpose.organizationId,
        identityId: context.policy.initiator.identityId,
        taskPath: context.purpose.nodeId,
        // The signed duplicate key is stable across bounded callback retries.
        iteration: context.purpose.duplicateProtectionKey,
      };
      let prior: ProtectedNodeEffectReplay;
      try {
        prior = await dependencies.effects.replay(effectKey, context.purpose.operationKey);
      } catch (error) {
        console.error("[flows] protected node effect replay failed EFFECT_STORE_REPLAY_FAILED", {
          cause: error,
        });
        return { outcome: "retryable_failure", safeCode: "effect_store_unavailable", nextPollAt: nextPollAt(clock()) };
      }
      if (prior.kind === "unavailable")
        return { outcome: "retryable_failure", safeCode: "effect_store_unavailable", nextPollAt: nextPollAt(clock()) };
      if (prior.kind === "in_progress")
        return { outcome: "waiting", safeCode: "effect_in_progress", nextPollAt: nextPollAt(clock()) };
      if (prior.kind === "completed" && recordUpdate === undefined) {
        const replay = storedResponse(prior.outputs);
        return replay === undefined
          ? { outcome: "retryable_failure", safeCode: "effect_result_unavailable", nextPollAt: nextPollAt(clock()) }
          : { ...replay, outcome: replay.outcome === "completed" ? "already_completed" : replay.outcome };
      }
      if (run.data.authority.state !== "running" && prior.kind !== "completed")
        return { outcome: "permanent_refusal", safeCode: "callback_refused" };
      // A completed record update is replayed after the access recheck, whatever the attempt.
      if (prior.kind !== "completed" && context.purpose.attempt > maximumCallbackAttempts)
        return { outcome: "permanent_refusal", safeCode: "attempt_limit" };
      const execution = await dependencies.operations.executeDurableActor({
        ...target,
        actorContext: context,
        inputs,
        effect: async (transaction, executeOperation): Promise<ProtectedNodeCallbackResponse> => {
          const claim = await dependencies.effects.begin(transaction, effectKey, context.purpose.operationKey);
          if (claim.kind === "unavailable")
            throw new Error("PROTECTED_EFFECT_UNAVAILABLE");
          if (claim.kind === "in_progress")
            return { outcome: "waiting", safeCode: "effect_in_progress", nextPollAt: nextPollAt(clock()) };
          if (claim.kind === "completed") {
            const replay = storedResponse(claim.outputs);
            if (replay === undefined) throw new Error("PROTECTED_EFFECT_RESULT_UNAVAILABLE");
            const outputs = replay.outputs;
            if (recordUpdate !== undefined && replay.outcome === "completed" &&
                (outputs === undefined || typeof outputs.record !== "string" ||
                 !sameIdentity(outputs.record, recordUpdate.recordId) || Object.keys(outputs).length !== 1))
              return { outcome: "permanent_refusal", safeCode: "callback_refused" };
            return { ...replay, outcome: replay.outcome === "completed" ? "already_completed" : replay.outcome };
          }

          const result = await executeOperation();
          if (result.outcome === "failed") throw new Error("PROTECTED_OPERATION_FAILED");
          const sensitiveOutputs = new Set(registeredOperation?.descriptor.sensitiveOutputs ?? []);
          let response: ProtectedNodeCallbackResponse;
          switch (result.outcome) {
            case "committed":
              response = {
                outcome: "completed",
                safeCode: "completed",
                outputs: recordUpdate !== undefined ? result.outputs : {
                  result: Object.fromEntries(
                    Object.entries(result.outputs).filter(([key]) => !sensitiveOutputs.has(key)),
                  ),
                },
              };
              break;
            case "validation":
              response = { outcome: "permanent_refusal", safeCode: "invalid_input" };
              break;
            case "conflict":
              response = { outcome: "permanent_refusal", safeCode: "conflict" };
              break;
            case "refused":
              response = { outcome: "permanent_refusal", safeCode: "not_authorized" };
              break;
          }
          response = safeResponse(response);
          const stored = await dependencies.effects.complete(transaction, effectKey, ledgerOutcome(response), { response });
          if (!stored) throw new Error("PROTECTED_EFFECT_RESULT_UNAVAILABLE");
          return response;
        },
      });
      if (execution.kind !== "available")
        return execution.kind === "refused"
          ? { outcome: "permanent_refusal", safeCode: "not_authorized" }
          : { outcome: "retryable_failure", safeCode: "effect_store_unavailable", nextPollAt: nextPollAt(clock()) };
      return execution.value;
    },

    async readRunStatus(runId: string): Promise<ProtectedNodeRunStatus> {
      const parsedRunId = workflowRunIdSchema.safeParse(runId);
      if (!parsedRunId.success)
        return {
          availability: "unavailable",
          safeCode: "kestra_status_unavailable",
        };
      let registeredRun: ProtectedNodeRegisteredRun | undefined;
      try {
        const storedCandidate = await dependencies.runs.read(parsedRunId.data);
        registeredRun = storedCandidate === undefined
          ? undefined
          : parseRegisteredRun(storedCandidate, parsedRunId.data);
      } catch (error) {
        console.error(`[workflow] protected run status read failed: ${describeFailure(error)}`);
        return {
          availability: "unavailable",
          safeCode: "kestra_status_unavailable",
        };
      }
      if (registeredRun === undefined) {
        return {
          availability: "unavailable",
          safeCode: "kestra_status_unavailable",
        };
      }

      const run = { data: registeredRun.runRecord };

      const reference = workflowExecutionReferenceSchema.parse(run.data.executionReference);
      if (!sameIdentity(reference.runId, parsedRunId.data))
        return { availability: "unavailable", safeCode: "kestra_status_unavailable" };
      try {
        const state = statusState(await dependencies.readKestraState(run.data.kestra));
        if (state === undefined)
          return { availability: "unavailable", reference, safeCode: "kestra_status_unavailable" };
        const refreshedAt = clock().toISOString();
        const fresh = workflowExecutionReferenceSchema.parse({
          ...reference,
          lastKnownState: state,
          lastRefreshedAt: refreshedAt,
        });
        try {
          await dependencies.runs.refreshLastKnownState?.(reference.runId, state, refreshedAt);
        } catch (error) {
          // A failed cache write does not make Kestra's successful live answer stale.
          console.error(`[workflow] protected run status refresh failed: ${describeFailure(error)}`);
        }
        return { availability: "current", reference: fresh };
      } catch (error) {
        console.error(`[workflow] protected run status update failed: ${describeFailure(error)}`);
        return { availability: "unavailable", reference, safeCode: "kestra_status_unavailable" };
      }
    },
  });
};
