import "server-only";

import { randomUUID } from "node:crypto";
import {
  flowDurableOnlyTaskTypeKeys,
  flowMaximumServerSeconds,
  flowSchema,
  flowTaskChildLists,
  flowTestRunRequestSchema,
  formContinuationIntentSchema,
  groupIdSchema,
  identitySessionSchema,
  jsonValueSchema,
  moduleDefinitionConsumerReadResultV3Schema,
  organizationAccountIdSchema,
  organizationSelectionCandidateSchema,
  previewInstallationAddressSchema,
  previewRecordReadCommandV1Schema,
  recordTypeIdSchema,
  saveRecordCommandV2Schema,
  type FlowDefinition,
  type FlowTask,
  type FlowTestRunFailure,
  type FlowTestRunRequest,
  type FlowTestRunResponse,
  type FlowTestRunTaskOutcome,
  type FlowTestRunTaskTraceEntry,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
  type PreviewInstallation,
  type PreviewInstallationAddress,
  type PreviewRecordReadResultV1,
  type SaveRecordCommandV2,
  type SaveRecordResultV2,
} from "@vortex/contracts";
import type { HumanOrganizationRequestResult } from "@vortex/access";
import {
  resumeFlowRun,
  startFlowRun,
  type FlowLibrary,
  type FlowProtectedTaskCall,
  type FlowRunResult,
  type FlowRunStep,
  type FlowFailure,
  type FlowTaskTraceObservation,
  type FlowTaskTraceObserver,
} from "@vortex/rule";

const maximumPayloadCharacters = 65_536;
const serverMilliseconds = flowMaximumServerSeconds * 1_000;

type PreviewRecordTaskPort = Readonly<{
  read(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    command: unknown,
  ): Promise<HumanOrganizationRequestResult<PreviewRecordReadResultV1>>;
  save(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    command: SaveRecordCommandV2,
  ): Promise<HumanOrganizationRequestResult<SaveRecordResultV2>>;
}>;

type PreviewInstallationReader = Readonly<{
  read(
    session: IdentitySession,
    address: PreviewInstallationAddress,
  ): Promise<PreviewInstallation>;
}>;

export type FlowTestRunDependencies = Readonly<{
  previews: PreviewInstallationReader;
  records: PreviewRecordTaskPort;
  /** Reads the exact published Module release pinned by the preview, not the current release. */
  readPinnedModuleRelease(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    moduleRootId: string,
    releaseRevision: number,
  ): Promise<unknown | undefined>;
  /** Returns the account from the active, validated request context, never from caller input. */
  resolvePreviewerOrganizationAccountId(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
  ): Promise<string | undefined>;
  authorizeInvocation?(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    flow: FlowDefinition,
  ): Promise<boolean>;
  now?: () => Date;
  clock?: () => number;
  newRunId?: () => string;
}>;

type TaskExecution = Readonly<{
  outcome: "completed" | "committed" | "refused" | "conflict" | "validation" | "uncertain" | "failed";
  outputs?: Readonly<Record<string, string>>;
  failure?: FlowTestRunFailure;
}>;

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const withinPayload = (candidate: unknown): boolean => {
  try {
    return (JSON.stringify(candidate) ?? "").length <= maximumPayloadCharacters;
  } catch {
    return false;
  }
};

const taskKey = (flowId: string, taskId: string): string => `${flowId}:${taskId}`;

const asIntent = (intent: NonNullable<FlowTaskTraceObservation["intent"]>) => {
  const parsed = formContinuationIntentSchema.safeParse({
    kind: intent.kind,
    taskId: intent.taskId,
    properties: Object.fromEntries(
      Object.entries(intent.properties).map(([name, value]) => [name, value.value]),
    ),
  });
  return parsed.success ? parsed.data : undefined;
};

const taskFailure = (
  code: string,
  outcome: FlowTestRunFailure["outcome"],
  taskId: string,
): FlowTestRunFailure => ({ outcome, code, taskId });

const failureFromInterpreter = (failure: FlowFailure): FlowTestRunFailure => ({
  outcome: failure.outcome,
  code: failure.code,
  ...(failure.taskId === undefined ? {} : { taskId: failure.taskId }),
});

// FlowTask's registered-task member is open-ended, so narrow control tasks by shape as well as tag.
const isIfTask = (task: FlowTask): task is Extract<FlowTask, { type: "if" }> =>
  task.type === "if" && "condition" in task && "then" in task && Array.isArray(task.then);

const isSwitchTask = (task: FlowTask): task is Extract<FlowTask, { type: "switch" }> =>
  task.type === "switch" && "value" in task && "cases" in task && Array.isArray(task.cases);

const isForEachTask = (task: FlowTask): task is Extract<FlowTask, { type: "for_each" }> =>
  task.type === "for_each" && "items" in task && "tasks" in task && Array.isArray(task.tasks);

const isSequentialTask = (task: FlowTask): task is Extract<FlowTask, { type: "sequential" }> =>
  task.type === "sequential" && "tasks" in task && Array.isArray(task.tasks);

const isRunFlowTask = (task: FlowTask): task is Extract<FlowTask, { type: "run_flow" }> =>
  task.type === "run_flow" && "flowId" in task && "inputs" in task;

const mapTasksForTest = (
  flowId: FlowDefinition["id"],
  tasks: readonly FlowTask[],
  simulatedTasks: Set<string>,
  simulatedTaskTypes: Map<string, string>,
): FlowTask[] =>
  tasks.map((task): FlowTask => {
    const common = {
      id: task.id,
      ...(task.description === undefined ? {} : { description: task.description }),
      ...(task.retry === undefined ? {} : { retry: task.retry }),
      ...(task.timeout === undefined ? {} : { timeout: task.timeout }),
    };
    if ((flowDurableOnlyTaskTypeKeys as readonly string[]).includes(task.type)) {
      const key = taskKey(flowId, task.id);
      simulatedTasks.add(key);
      simulatedTaskTypes.set(key, task.type);
      return { ...common, type: "sequential", tasks: [] };
    }
    if (isIfTask(task))
      return {
        ...task,
        then: mapTasksForTest(flowId, task.then, simulatedTasks, simulatedTaskTypes),
        ...(task.else === undefined
          ? {}
          : { else: mapTasksForTest(flowId, task.else, simulatedTasks, simulatedTaskTypes) }),
      };
    if (isSwitchTask(task))
      return {
        ...task,
        cases: task.cases.map((entry) => ({
          ...entry,
          tasks: mapTasksForTest(flowId, entry.tasks, simulatedTasks, simulatedTaskTypes),
        })),
        ...(task.default === undefined
          ? {}
          : { default: mapTasksForTest(flowId, task.default, simulatedTasks, simulatedTaskTypes) }),
      };
    if (isForEachTask(task) || isSequentialTask(task))
      return {
        ...task,
        tasks: mapTasksForTest(flowId, task.tasks, simulatedTasks, simulatedTaskTypes),
      };
    return task;
  });

const testFlow = (
  flow: FlowDefinition,
  simulatedTasks: Set<string>,
  simulatedTaskTypes: Map<string, string>,
): FlowDefinition => ({
  ...flow,
  execution: "interactive",
  runAs: { kind: "initiator" },
  triggers: [],
  tasks: mapTasksForTest(flow.id, flow.tasks, simulatedTasks, simulatedTaskTypes),
  errors: mapTasksForTest(flow.id, flow.errors, simulatedTasks, simulatedTaskTypes),
  finally: mapTasksForTest(flow.id, flow.finally, simulatedTasks, simulatedTaskTypes),
});

const runFlowTargets = (flow: FlowDefinition): FlowDefinition["id"][] => {
  const targets: FlowDefinition["id"][] = [];
  const visit = (tasks: readonly FlowTask[]) => {
    for (const task of tasks) {
      if (isRunFlowTask(task)) targets.push(task.flowId);
      for (const child of flowTaskChildLists(task)) visit(child.tasks);
    }
  };
  visit(flow.tasks);
  visit(flow.errors);
  visit(flow.finally);
  return targets;
};

const emptyObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const resultOutcome = (code: string): FlowTestRunFailure["outcome"] =>
  code === "conflict"
    ? "conflict"
    : code === "invalid_request"
      ? "validation"
      : "refused";

const previewFieldIds = async (
  dependencies: FlowTestRunDependencies,
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  previewInstallation: PreviewInstallation,
  recordTypeId: string,
  cache: Map<string, ReadonlyMap<string, string>>,
): Promise<ReadonlyMap<string, string> | undefined> => {
  const key = recordTypeId.toLowerCase();
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const identities = previewInstallation.storageIdentities.filter((identity) =>
    sameId(identity.recordTypeId, recordTypeId),
  );
  if (identities.length !== 1) return undefined;
  const identity = identities[0]!;
  const pins = previewInstallation.resolvedModules.filter((module) =>
    sameId(module.moduleRootId, identity.moduleRootId) &&
    module.moduleReleaseRevision === identity.moduleReleaseRevision,
  );
  if (pins.length !== 1) return undefined;

  try {
    const candidate = await dependencies.readPinnedModuleRelease(
      session,
      selection,
      identity.moduleRootId,
      identity.moduleReleaseRevision,
    );
    const parsed = moduleDefinitionConsumerReadResultV3Schema.safeParse(candidate);
    if (
      !parsed.success ||
      !sameId(parsed.data.organizationId, previewInstallation.organizationId) ||
      !sameId(parsed.data.rootId, identity.moduleRootId) ||
      parsed.data.releaseRevision !== identity.moduleReleaseRevision ||
      parsed.data.releaseVersion !== pins[0]!.releaseVersion
    ) return undefined;
    const recordTypes = parsed.data.content.recordTypes.filter((recordType) =>
      sameId(recordType.recordTypeId, recordTypeId),
    );
    if (recordTypes.length !== 1) return undefined;
    const fieldIds = new Map<string, string>();
    for (const field of recordTypes[0]!.fields) {
      for (const name of [field.key, field.fieldId]) {
        const alias = name.toLowerCase();
        if (fieldIds.has(alias) && !sameId(fieldIds.get(alias)!, field.fieldId))
          return undefined;
        fieldIds.set(alias, field.fieldId);
      }
    }
    cache.set(key, fieldIds);
    return fieldIds;
  } catch {
    return undefined;
  }
};

const runRecordTask = async (
  dependencies: FlowTestRunDependencies,
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  previewInstallation: PreviewInstallation,
  call: FlowProtectedTaskCall,
  fieldIdsCache: Map<string, ReadonlyMap<string, string>>,
): Promise<TaskExecution> => {
  const supported = new Set(["record.save", "record.create", "record.set_fields"]);
  if (!supported.has(call.taskType))
    return {
      outcome: "refused",
      failure: taskFailure(
        `${call.taskType.replace(".", "_")}_unavailable_in_preview_test_run`,
        "refused",
        call.taskId,
      ),
    };

  const recordTypeId = recordTypeIdSchema.safeParse(call.properties.record_type?.value);
  const values = call.properties.values?.value;
  if (
    !recordTypeId.success ||
    !emptyObject(values) ||
    !Object.values(values).every((value) => jsonValueSchema.safeParse(value).success)
  )
    return {
      outcome: "validation",
      failure: taskFailure("record_values_invalid", "validation", call.taskId),
    };
  const fieldIds = await previewFieldIds(
    dependencies,
    session,
    selection,
    previewInstallation,
    recordTypeId.data,
    fieldIdsCache,
  );
  if (fieldIds === undefined)
    return {
      outcome: "refused",
      failure: taskFailure("record_type_unavailable", "refused", call.taskId),
    };
  const submittedValues: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(values)) {
    const fieldId = fieldIds.get(name.toLowerCase());
    if (fieldId === undefined || Object.hasOwn(submittedValues, fieldId))
      return {
        outcome: "validation",
        failure: taskFailure("record_values_invalid", "validation", call.taskId),
      };
    submittedValues[fieldId] = value as JsonValue;
  }

  const recordValue = call.properties.record?.value;
  if (call.taskType === "record.set_fields" && typeof recordValue !== "string")
    return {
      outcome: "validation",
      failure: taskFailure("record_target_invalid", "validation", call.taskId),
    };
  const operation =
    call.taskType === "record.create" ||
    (call.taskType === "record.save" && recordValue === undefined)
      ? "create"
      : "update";
  const selectedOwnerGroupId = call.properties.selected_owner_group_id?.value;
  const selectedGroup = selectedOwnerGroupId === undefined
    ? undefined
    : groupIdSchema.safeParse(selectedOwnerGroupId);
  if (
    (selectedGroup !== undefined && !selectedGroup.success) ||
    (operation === "update" && Object.hasOwn(call.properties, "selected_owner_group_id"))
  )
    return {
      outcome: "validation",
      failure: taskFailure("record_owner_group_invalid", "validation", call.taskId),
    };
  const selectedOwnerGroup = selectedGroup?.success ? selectedGroup.data : undefined;
  if (operation === "update" && typeof recordValue !== "string")
    return {
      outcome: "validation",
      failure: taskFailure("record_target_invalid", "validation", call.taskId),
    };

  let expectedConcurrencyNumber: number | undefined;
  if (operation === "update") {
    const readCommand = previewRecordReadCommandV1Schema.safeParse({
      contractVersion: "1.0.0",
      previewInstallationId: previewInstallation.previewInstallationId,
      recordTypeId: recordTypeId.data,
      recordId: recordValue,
    });
    if (!readCommand.success)
      return {
        outcome: "validation",
        failure: taskFailure("record_target_invalid", "validation", call.taskId),
      };
    try {
      const read = await dependencies.records.read(session, selection, readCommand.data);
      if (read.kind !== "available")
        return {
          outcome: read.kind === "unavailable" ? "refused" : "failed",
          failure: taskFailure(
            "preview_record_unavailable",
            read.kind === "unavailable" ? "refused" : "failed",
            call.taskId,
          ),
        };
      if (read.value.outcome !== "allowed")
        return {
          outcome: "refused",
          failure: taskFailure("preview_record_refused", "refused", call.taskId),
        };
      expectedConcurrencyNumber = read.value.concurrencyNumber;
    } catch {
      return {
        outcome: "failed",
        failure: taskFailure("preview_record_read_failed", "failed", call.taskId),
      };
    }
  }

  const commandCandidate = {
    contractVersion: "2.0.0",
    commandId: randomUUID(),
    previewInstallationId: previewInstallation.previewInstallationId,
    operation,
    recordTypeId: recordTypeId.data,
    submittedValues,
    ...(operation === "update"
      ? { recordId: recordValue, expectedConcurrencyNumber }
      : selectedOwnerGroup === undefined ? {} : { selectedOwnerGroupId: selectedOwnerGroup }),
  };
  const command = saveRecordCommandV2Schema.safeParse(commandCandidate);
  if (!command.success)
    return {
      outcome: "validation",
      failure: taskFailure("record_command_invalid", "validation", call.taskId),
    };

  try {
    const saved = await dependencies.records.save(session, selection, command.data);
    if (saved.kind !== "available")
      return {
        outcome: saved.kind === "unavailable" ? "refused" : "failed",
        failure: taskFailure(
          "preview_record_unavailable",
          saved.kind === "unavailable" ? "refused" : "failed",
          call.taskId,
        ),
      };
    if (saved.value.outcome === "saved")
      return { outcome: "committed", outputs: { record: saved.value.recordId } };
    if (saved.value.outcome === "correction_required")
      return {
        outcome: "validation",
        failure: taskFailure("record_correction_required", "validation", call.taskId),
      };
    const outcome = resultOutcome(saved.value.error.code);
    return {
      outcome,
      failure: taskFailure(`record_${outcome}`, outcome, call.taskId),
    };
  } catch {
    return {
      outcome: "uncertain",
      failure: taskFailure("preview_record_save_uncertain", "uncertain", call.taskId),
    };
  }
};

const completedResult = (
  step: Extract<FlowRunStep, { kind: "finished" }>,
): FlowRunResult => step.result;

const rawResult = (result: FlowRunResult) =>
  result.status === "failed"
    ? { status: "failed" as const, failure: failureFromInterpreter(result.failure) }
    : {
        status: "completed" as const,
        outputs: Object.fromEntries(
          Object.entries(result.outputs).map(([name, value]) => [name, value.value]),
        ),
        ...(result.stopped === undefined ? {} : { stopped: result.stopped }),
      };

const refusal = (
  reason: Extract<FlowTestRunResponse, { kind: "refused" }>['reason'],
  location: Extract<FlowTestRunResponse, { kind: "refused" }>['location'],
): FlowTestRunResponse => ({ kind: "refused", reason, location });

export const createFlowTestRunner = (dependencies: FlowTestRunDependencies) => {
  const now = dependencies.now ?? (() => new Date());
  const clock = dependencies.clock ?? (() => performance.now());
  const newRunId = dependencies.newRunId ?? (() => randomUUID());

  return Object.freeze({
    async run(
      sessionCandidate: IdentitySession,
      selectionCandidate: OrganizationSelectionCandidate,
      requestCandidate: FlowTestRunRequest,
    ): Promise<FlowTestRunResponse> {
      const session = identitySessionSchema.safeParse(sessionCandidate);
      const selection = organizationSelectionCandidateSchema.safeParse(selectionCandidate);
      const request = flowTestRunRequestSchema.safeParse(requestCandidate);
      if (
        !session.success ||
        !selection.success ||
        !request.success ||
        !withinPayload(requestCandidate)
      )
        return refusal("invalid_request", { kind: "preview" });
      if (selection.data.applicationRootId === undefined)
        return refusal("invalid_request", { kind: "preview" });
      if (Date.parse(session.data.accessTokenExpiresAt) <= now().valueOf())
        return refusal("preview_unavailable", { kind: "preview" });

      const address = previewInstallationAddressSchema.safeParse({
        organizationId: selection.data.organizationId,
        applicationRootId: selection.data.applicationRootId,
        previewInstallationId: request.data.previewInstallationId,
      });
      if (!address.success) return refusal("invalid_request", { kind: "preview" });

      let previewInstallation: PreviewInstallation;
      try {
        previewInstallation = await dependencies.previews.read(session.data, address.data);
      } catch {
        return refusal("preview_unavailable", { kind: "preview" });
      }
      if (
        !sameId(previewInstallation.previewInstallationId, request.data.previewInstallationId) ||
        !sameId(previewInstallation.organizationId, selection.data.organizationId) ||
        !sameId(previewInstallation.applicationRootId, selection.data.applicationRootId)
      )
        return refusal("preview_unavailable", { kind: "preview" });
      if (Date.parse(previewInstallation.expiresAt) <= now().valueOf())
        return refusal("preview_expired", { kind: "preview" });

      let accountId: string | undefined;
      try {
        accountId = await dependencies.resolvePreviewerOrganizationAccountId(
          session.data,
          selection.data,
        );
      } catch {
        return refusal("preview_unavailable", { kind: "preview" });
      }
      if (
        accountId === undefined ||
        !organizationAccountIdSchema.safeParse(accountId).success ||
        !sameId(previewInstallation.previewerIdentityId, session.data.identityId) ||
        !sameId(previewInstallation.previewerOrganizationAccountId, accountId)
      )
        return refusal("preview_unavailable", { kind: "preview" });

      const candidateFlows = new Map<string, FlowDefinition>();
      for (const flowCandidate of previewInstallation.candidate.compilation.canonical.content.flows) {
        const parsed = flowSchema.safeParse(flowCandidate);
        if (parsed.success && parsed.data.id === flowCandidate.id)
          candidateFlows.set(parsed.data.id, parsed.data);
      }
      const requestedFlow = candidateFlows.get(request.data.flowId);
      if (requestedFlow === undefined)
        return refusal("flow_unavailable", { kind: "flow", flowId: request.data.flowId });
      if (
        requestedFlow.runAs.kind !== "initiator" ||
        (requestedFlow.execution !== "interactive" && requestedFlow.execution !== "durable")
      )
        return refusal("flow_not_runnable", { kind: "flow", flowId: request.data.flowId });

      const permittedFlows = new Set<string>();
      const visited = new Set<string>();
      const pending = [requestedFlow.id];
      while (pending.length > 0) {
        const flowId = pending.shift()!;
        if (visited.has(flowId)) continue;
        visited.add(flowId);
        const flow = candidateFlows.get(flowId);
        if (
          flow === undefined ||
          flow.runAs.kind !== "initiator" ||
          (flow.execution !== "interactive" && flow.execution !== "durable")
        )
          continue;
        let permitted = flow.invocationPermissionId === undefined;
        if (!permitted && dependencies.authorizeInvocation !== undefined) {
          try {
            permitted = await dependencies.authorizeInvocation(session.data, selection.data, flow);
          } catch {
            permitted = false;
          }
        }
        if (!permitted) continue;
        permittedFlows.add(flowId);
        pending.push(...runFlowTargets(flow));
      }
      if (!permittedFlows.has(requestedFlow.id))
        return refusal("flow_not_authorized", { kind: "flow", flowId: requestedFlow.id });

      const simulatedTasks = new Set<string>();
      const simulatedTaskTypes = new Map<string, string>();
      const testFlows = new Map<string, FlowDefinition>();
      for (const flowId of permittedFlows) {
        const flow = candidateFlows.get(flowId)!;
        testFlows.set(flowId, testFlow(flow, simulatedTasks, simulatedTaskTypes));
      }
      const library: FlowLibrary = (flowId) => testFlows.get(flowId);
      const runId = newRunId();
      const trace: FlowTestRunTaskTraceEntry[] = [];
      const fieldIdsCache = new Map<string, ReadonlyMap<string, string>>();
      const intents: NonNullable<Extract<FlowTestRunResponse, { kind: "finished" }>['intents']> = [];
      const pendingRunFlows: Array<{
        flowId: string;
        taskId: string;
        iteration: string;
        traceIndex: number;
      }> = [];
      let traceFlowUnavailable = false;
      const observer: FlowTaskTraceObserver = (observation) => {
        const observedFlow = testFlows.get(observation.flowId);
        if (observedFlow === undefined) {
          traceFlowUnavailable = true;
          return;
        }
        const flowId = observedFlow.id;
        const key = taskKey(observation.flowId, observation.taskId);
        if (observation.outcome === "awaiting") return;
        if (observation.outcome === "entered") {
          pendingRunFlows.push({
            flowId: observation.flowId,
            taskId: observation.taskId,
            iteration: observation.iteration,
            traceIndex: trace.length,
          });
          trace.push({
            flowId,
            taskId: observation.taskId,
            taskType: observation.taskType,
            iteration: observation.iteration,
            outcome: "paused",
          });
          return;
        }
        if (observation.taskType === "run_flow") {
          let pendingIndex = -1;
          for (let index = pendingRunFlows.length - 1; index >= 0; index -= 1) {
            const pending = pendingRunFlows[index]!;
            if (
              pending.flowId === observation.flowId &&
              pending.taskId === observation.taskId &&
              pending.iteration === observation.iteration
            ) {
              pendingIndex = index;
              break;
            }
          }
          if (pendingIndex !== -1) {
            const [pending] = pendingRunFlows.splice(pendingIndex, 1);
            const entry = trace[pending!.traceIndex]!;
            trace[pending!.traceIndex] = observation.failure === undefined
              ? { ...entry, outcome: "completed" }
              : {
                  ...entry,
                  outcome: "failed",
                  failure: failureFromInterpreter(observation.failure),
                };
            return;
          }
        }
        const intent = observation.intent === undefined ? undefined : asIntent(observation.intent);
        if (intent !== undefined) intents.push(intent);
        const simulated = simulatedTasks.has(key) || observation.outcome === "interface";
        const failure = observation.failure === undefined
          ? undefined
          : failureFromInterpreter(observation.failure);
        trace.push({
          flowId,
          taskId: observation.taskId,
          taskType: simulatedTaskTypes.get(key) ?? observation.taskType,
          iteration: observation.iteration,
          outcome: failure === undefined ? (simulated ? "simulated" : "completed") : "failed",
          ...(failure === undefined ? {} : { failure }),
          ...(intent === undefined ? {} : { intent }),
        });
      };
      const failPendingRunFlows = (code: string, outcome: FlowTestRunFailure["outcome"]) => {
        for (const pending of pendingRunFlows) {
          const entry = trace[pending.traceIndex]!;
          trace[pending.traceIndex] = {
            ...entry,
            outcome,
            failure: taskFailure(code, outcome, pending.taskId),
          };
        }
      };
      const finishFailedRun = (failure: FlowTestRunFailure): FlowTestRunResponse => ({
        kind: "finished",
        runId,
        flowId: requestedFlow.id,
        result: { status: "failed", failure },
        trace,
        intents,
      });

      const startedAt = clock();
      let step = startFlowRun(
        {
          runId,
          flowId: requestedFlow.id,
          inputs: request.data.sampleInputs,
          now: now().toISOString(),
          actor: accountId,
          executionKinds: ["interactive"],
        },
        library,
        observer,
      );
      if (
        step.kind === "finished" &&
        step.result.status === "failed" &&
        step.result.failure.code === "inputs_invalid"
      )
        return refusal("invalid_request", { kind: "flow", flowId: requestedFlow.id });
      for (;;) {
        if (clock() - startedAt > serverMilliseconds) {
          failPendingRunFlows("server_time_limit", "failed");
          return finishFailedRun({ outcome: "failed", code: "server_time_limit" });
        }
        if (Date.parse(previewInstallation.expiresAt) <= now().valueOf()) {
          failPendingRunFlows("preview_expired", "refused");
          return finishFailedRun({ outcome: "refused", code: "preview_expired" });
        }
        if (traceFlowUnavailable) {
          failPendingRunFlows("flow_unavailable", "failed");
          return finishFailedRun({ outcome: "failed", code: "flow_unavailable" });
        }
        if (step.kind === "finished") {
          return {
            kind: "finished",
            runId,
            flowId: requestedFlow.id,
            result: rawResult(completedResult(step)),
            trace,
            intents,
          };
        }
        if (step.kind === "interface") {
          return {
            kind: "finished",
            runId,
            flowId: requestedFlow.id,
            result: {
              status: "paused",
              awaiting: step.awaiting,
              taskId: step.state.awaiting!.taskId,
              outputs: {},
            },
            trace,
            intents,
          };
        }

        const call = step.call;
        const activeFlowId = step.state.activations.at(-1)?.flowId;
        const activeFlow = activeFlowId === undefined ? undefined : testFlows.get(activeFlowId);
        if (activeFlow === undefined) {
          failPendingRunFlows("flow_unavailable", "failed");
          return finishFailedRun({ outcome: "failed", code: "flow_unavailable" });
        }
        let execution: TaskExecution;
        if (call.taskType.startsWith("record.")) {
          execution = await runRecordTask(
            dependencies,
            session.data,
            selection.data,
            previewInstallation,
            call,
            fieldIdsCache,
          );
        } else execution = { outcome: "completed" };
        const traceOutcome: FlowTestRunTaskOutcome = call.taskType.startsWith("record.")
          ? execution.outcome
          : "simulated";
        trace.push({
          flowId: activeFlow.id,
          taskId: call.taskId,
          taskType: call.taskType,
          iteration: call.iteration,
          outcome: traceOutcome,
          ...(execution.failure === undefined ? {} : { failure: execution.failure }),
        });
        const resumeOutcome = execution.outcome === "uncertain" ? "uncertain" : execution.outcome;
        step = resumeFlowRun(
          step.state,
          {
            kind: "task_result",
            outcome: resumeOutcome,
            ...(execution.outputs === undefined ? {} : { outputs: execution.outputs }),
          },
          library,
          observer,
        );
      }
    },
  });
};

export type FlowTestRunner = ReturnType<typeof createFlowTestRunner>;
