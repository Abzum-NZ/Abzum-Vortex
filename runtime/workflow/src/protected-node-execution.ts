import "server-only";

import {
  builderKeySchema,
  findPlatformServiceOperation,
  flowValueSchema,
  flowTaskRegistry,
  jsonValueSchema,
  PLATFORM_SERVICE_OPERATIONS,
  platformOperationKey,
  protectedOperationRequestSchema,
  stableDefinitionReleaseVersionSchema,
  workflowExecutionReferenceSchema,
  workflowNodeIdSchema,
  workflowRunIdSchema,
  type FlowReference,
  type FlowValue,
  type JsonValue,
  type WorkflowExecutionReference,
} from "@vortex/contracts";
import { evaluateFlowFormula, type FlowRuntimeValue } from "@vortex/rule";
import { z } from "zod";
import {
  resolveDurableActorContext,
  retainedRunAuthoritySchema,
  type VerifiedDurableActorContext,
} from "./durable-actor-context";

const maximumCallbackAttempts = 5;
const callbackRetryDelayMs = 1_000;

const protectedOperationIdentitySchema = z
  .object({
    serviceId: z.guid(),
    operationId: z.guid(),
    releaseVersion: stableDefinitionReleaseVersionSchema,
  })
  .strict();
const unavailableAdapterOwnerSchema = z.enum([
  "#1398",
  "#81",
  "#100",
  "#101",
  "#113",
  "#666",
]);

const retainedNodeBindingSchema = z
  .object({
    nodeId: workflowNodeIdSchema,
    taskType: z.string().min(1).max(100),
    operationKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    operation: protectedOperationIdentitySchema.optional(),
    unavailableOwner: unavailableAdapterOwnerSchema.optional(),
  })
  .strict()
  .superRefine((binding, context) => {
    if (binding.taskType === "operation.call" && binding.operation === undefined)
      context.addIssue({ code: "custom", path: ["operation"], message: "A protected operation binding is required" });
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

/** The narrow run-store API. Kestra identifiers remain private to this server-side adapter. */
export type ProtectedNodeRunStore = Readonly<{
  read: (runId: string) => Promise<unknown | undefined>;
  /** The #666 flow-start owner calls this seam after accepting the private Kestra mapping. */
  write: (record: unknown) => Promise<boolean>;
  refreshLastKnownState?: (
    runId: string,
    state: WorkflowExecutionReference["lastKnownState"],
    refreshedAt: string,
  ) => Promise<void>;
}>;

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

/** The existing private flow-effect ledger; the application action remains the owning transaction. */
export type ProtectedNodeEffectLedger = Readonly<{
  begin: (key: ProtectedNodeEffectKey) => Promise<ProtectedNodeEffectClaim>;
  complete: (
    key: ProtectedNodeEffectKey,
    outcome: string,
    outputs: Readonly<Record<string, unknown>>,
  ) => Promise<boolean>;
}>;

export type ProtectedNodeOperationIdentity = z.infer<typeof protectedOperationIdentitySchema>;

export type ProtectedNodeOperationResult =
  | Readonly<{ outcome: "committed"; outputs: Readonly<Record<string, JsonValue>> }>
  | Readonly<{ outcome: "refused" | "conflict" | "validation" | "failed" }>;

export type ProtectedNodeOperationExecutor = Readonly<{
  executeDurableActor: (request: Readonly<{
    operation: ProtectedNodeOperationIdentity;
    actorContext: VerifiedDurableActorContext;
    inputs: Readonly<Record<string, unknown>>;
  }>) => Promise<ProtectedNodeOperationResult>;
}>;

/** Safe callback response. `outputs` contains only the descriptor's declared values. */
export type ProtectedNodeCallbackResponse = Readonly<{
  outcome:
    | "completed"
    | "already_completed"
    | "waiting"
    | "retryable_failure"
    | "permanent_refusal";
  safeCode: string;
  nextPollAt?: string;
  outputs?: Readonly<Record<string, JsonValue>>;
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

const unavailableOwnerForTask = (taskType: string): string | undefined => {
  if (taskType.startsWith("record.")) return "#1398";
  if (taskType === "record.query") return "#1398";
  if (taskType === "interface.show_form" || taskType === "interface.confirm") return "#81";
  if (taskType === "workflow.human_task") return "#81";
  if (taskType === "connection.call") return "#100";
  if (taskType === "message.acknowledge") return "#101";
  if (taskType === "file.export") return "#113";
  if (taskType === "event.announce" || taskType === "flow.run_background") return "#666";
  return undefined;
};

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
    const entries: Record<string, JsonValue> = {};
    for (const [name, entry] of Object.entries(source.entries)) {
      const resolved = resolveValue(entry);
      if (resolved === undefined) return undefined;
      entries[name] = resolved.value;
    }
    return { type: "json", value: entries };
  };
  return resolveValue(value.data)?.value;
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

      let storedCandidate: unknown;
      try {
        storedCandidate = await dependencies.runs.read(envelope.data.runId);
      } catch {
        return { outcome: "retryable_failure", safeCode: "run_store_unavailable", nextPollAt: nextPollAt(clock()) };
      }
      const run = protectedNodeRunRecordSchema.safeParse(storedCandidate);
      if (!run.success) return { outcome: "permanent_refusal", safeCode: "callback_refused" };

      const contextResolution = resolveDurableActorContext(envelope.data, run.data.authority, {
        callbackKey: dependencies.callbackKey,
        correlationId: dependencies.correlationId,
        clock,
      });
      if (contextResolution.outcome !== "verified")
        return { outcome: "permanent_refusal", safeCode: "callback_refused" };

      const context = contextResolution.context;
      const binding = run.data.nodes.find((node) => sameIdentity(node.nodeId, context.purpose.nodeId));
      if (binding === undefined || binding.operationKey !== context.purpose.operationKey)
        return { outcome: "permanent_refusal", safeCode: "callback_refused" };

      const owner = binding.unavailableOwner ?? unavailableOwnerForTask(binding.taskType);
      if (owner !== undefined)
        return {
          outcome: "permanent_refusal",
          safeCode: `adapter_unavailable_${owner.replace(/^#/, "")}`,
        };

      if (context.purpose.attempt > maximumCallbackAttempts)
        return { outcome: "permanent_refusal", safeCode: "attempt_limit" };

      if (binding.taskType === "workflow.evaluate") {
        const properties = objectRecord(envelope.data.inputs.properties);
        const value = evaluateValue(
          properties?.expression,
          envelope.data.inputs.runtimeScope,
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
      if (binding.taskType !== "operation.call")
        return { outcome: "permanent_refusal", safeCode: "task_unavailable" };

      const properties = envelope.data.inputs.properties;
      const operation = registeredOperationForBinding(properties, binding);
      const inputs = operationInputs(properties);
      if (operation === undefined)
        return { outcome: "permanent_refusal", safeCode: "operation_unavailable" };
      if (inputs === undefined)
        return { outcome: "permanent_refusal", safeCode: "invalid_input" };
      if (context.policy.kind !== "initiating_person")
        return { outcome: "permanent_refusal", safeCode: "actor_unavailable" };
      const registeredOperation = findPlatformServiceOperation(
        operation.serviceId,
        operation.operationId,
        operation.releaseVersion,
      );
      if (registeredOperation === undefined)
        return { outcome: "permanent_refusal", safeCode: "operation_unavailable" };

      const effectKey: ProtectedNodeEffectKey = {
        runId: context.purpose.runId,
        organizationId: context.purpose.organizationId,
        identityId: context.policy.initiator.identityId,
        taskPath: context.purpose.nodeId,
        // The signed duplicate key is stable across bounded callback retries.
        iteration: context.purpose.duplicateProtectionKey,
      };
      let claim: ProtectedNodeEffectClaim;
      try {
        claim = await dependencies.effects.begin(effectKey);
      } catch {
        return { outcome: "retryable_failure", safeCode: "effect_store_unavailable", nextPollAt: nextPollAt(clock()) };
      }
      if (claim.kind === "unavailable")
        return { outcome: "retryable_failure", safeCode: "effect_store_unavailable", nextPollAt: nextPollAt(clock()) };
      if (claim.kind === "in_progress")
        return { outcome: "waiting", safeCode: "effect_in_progress", nextPollAt: nextPollAt(clock()) };
      if (claim.kind === "completed") {
        const replay = storedResponse(claim.outputs);
        return replay === undefined
          ? { outcome: "retryable_failure", safeCode: "effect_result_unavailable", nextPollAt: nextPollAt(clock()) }
          : { ...replay, outcome: replay.outcome === "completed" ? "already_completed" : replay.outcome };
      }

      let result: ProtectedNodeOperationResult;
      try {
        result = await dependencies.operations.executeDurableActor({
          operation,
          actorContext: context,
          inputs,
        });
      } catch {
        result = { outcome: "failed" };
      }

      const now = clock();
      const sensitiveOutputs = new Set(registeredOperation.descriptor.sensitiveOutputs ?? []);
      let response: ProtectedNodeCallbackResponse;
      switch (result.outcome) {
        case "committed":
          response = {
            outcome: "completed",
            safeCode: "completed",
            outputs: {
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
        case "failed":
          response = { outcome: "retryable_failure", safeCode: "temporarily_unavailable", nextPollAt: nextPollAt(now) };
          break;
      }
      response = safeResponse(response);

      try {
        const stored = await dependencies.effects.complete(effectKey, ledgerOutcome(response), {
          response,
        });
        if (!stored)
          return {
            outcome: "retryable_failure",
            safeCode: "effect_result_unavailable",
            nextPollAt: nextPollAt(clock()),
          };
      } catch {
        return {
          outcome: "retryable_failure",
          safeCode: "effect_result_unavailable",
          nextPollAt: nextPollAt(clock()),
        };
      }
      return response;
    },

    async readRunStatus(runId: string): Promise<ProtectedNodeRunStatus> {
      const parsedRunId = workflowRunIdSchema.safeParse(runId);
      if (!parsedRunId.success)
        return {
          availability: "unavailable",
          safeCode: "kestra_status_unavailable",
        };
      let storedCandidate: unknown;
      try {
        storedCandidate = await dependencies.runs.read(parsedRunId.data);
      } catch {
        return {
          availability: "unavailable",
          safeCode: "kestra_status_unavailable",
        };
      }
      const run = protectedNodeRunRecordSchema.safeParse(storedCandidate);
      if (!run.success) {
        return {
          availability: "unavailable",
          safeCode: "kestra_status_unavailable",
        };
      }

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
        } catch {
          // A failed cache write does not make Kestra's successful live answer stale.
        }
        return { availability: "current", reference: fresh };
      } catch {
        return { availability: "unavailable", reference, safeCode: "kestra_status_unavailable" };
      }
    },
  });
};
