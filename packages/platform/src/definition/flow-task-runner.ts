import { z } from "zod";
import { runQueryTask } from "./flow-query-task";
import { namedActionInputs, planNamedActionSubjects } from "./flow-named-action-set";
import type { JsonValue } from "../catalogue/common";
import { groupIdSchema, recordIdSchema, recordTypeIdSchema } from "../catalogue/identifiers";
import { PLATFORM_SERVICE_OPERATIONS } from "../catalogue/platform-service-operation-catalogue";
import { tracedTaskRunner } from "./flow-task-runner-trace";
import { describeFailure, isRecord, sameId } from "../catalogue/runtime-primitives";
import {
  executeNamedActionCommandSchema,
  type ExecuteNamedActionCommand,
} from "../records/named-actions";
import {
  viewerSafeRecordPinAcquisitionResultSchema,
  viewerSafeRecordPinSelectorSchema,
} from "../records/record-links";
import { saveRecordCommandSchema, type SaveRecordCommand } from "../records/records";
import { platformOperationKey } from "../catalogue/platform-service-operation-catalogue";
import {
  flowRefusalFeedbackSchema,
  flowRefusalGuidanceByCodeSchema,
  unlocatedCorrectionsRefusal,
  type FlowRefusalFeedback,
} from "../workflows/flow-refusal-feedback";
import { storedFlowWarningSchema, storeFlowWarning } from "../workflows/flow-warning-replay";
import {
  rerenderBeforeSaveWarning,
  type BeforeSaveRuleWarning,
} from "../rules/before-save-flow-run";
import type {
  FlowProtectedTaskCall,
  FlowRunResume,
  FlowRunState,
  FlowRuntimeValues,
  FlowTaskOutcome,
} from "../rules/flow-interpreter";
import {
  beginFlowEffect,
  completeFlowEffect,
  type FlowEffectPrincipal,
} from "./flow-continuation-store";
import { reportUnexpectedFailure } from "./definition-error";
import { runGuidedDraftTask } from "./flow-guided-draft-task";
import {
  aliasSelectedRecordValues,
  carriesSensitive,
  dedupeFieldCorrections,
  effectCommandId,
  redactSensitiveOutputs,
  refusalOutcome,
  requestOutcome,
  ruleRefusalResult,
  selectedRecordProjectionForTask,
  sensitiveValues,
} from "./flow-orchestrator-support";
import type {
  FlowNamedAction,
  FlowOrchestratorDependencies,
  NamedActionRunner,
  Run,
} from "./flow-orchestrator-types";
import type { RecordChangeIntent } from "../records/apply-record-changes";
import { planBackendTask, runBackendTask, type BackendTaskPlan } from "./flow-backend-task";
import { nameRecordValues, setsActionOwnedOption, withoutEmptyValues } from "./flow-record-values";
import { planRecordLink } from "./flow-relationship-changes";
import { planRelationshipCopies } from "./flow-relationship-copies";

/**
 * Runs the protected tasks of one flow run: plans each task, claims its effect in the ledger and
 * runs the record, operation or named-action path it names. `runNamedAction` is the orchestrator's
 * one named-action path.
 */
export const createFlowTaskRunner = (
  dependencies: FlowOrchestratorDependencies,
  runNamedAction: NamedActionRunner,
) => {
  type PlatformOperation =
    (typeof PLATFORM_SERVICE_OPERATIONS)[keyof typeof PLATFORM_SERVICE_OPERATIONS];

  /** What one protected task will run, decided before its effect is claimed. */
  type TaskPlan =
    | Readonly<{
        kind: "changes";
        commandId: string;
        intents: readonly RecordChangeIntent[];
        outputs?: Readonly<Record<string, JsonValue>>;
        warningTarget?: Readonly<{ recordTypeId: string; recordId: string }>;
      }>
    | Readonly<{ kind: "operation"; entry: PlatformOperation; inputs: Record<string, unknown> }>
    | Readonly<{
        kind: "save";
        command: SaveRecordCommand;
        /** The submitted form field key of each record field, by lower-case field id. */
        submittedNames: ReadonlyMap<string, string>;
        /** The key of every field of the record type, by lower-case field id. */
        fieldKeys: ReadonlyMap<string, string>;
      }>
    | BackendTaskPlan
    | Readonly<{
        kind: "action";
        command: ExecuteNamedActionCommand;
        /** The action stands in for a Save record task, so it reports the saved record like one. */
        asSave?: true;
        /** The same action over several records as one command; `command` is the first of them. */
        commands?: readonly ExecuteNamedActionCommand[];
      }>;

  type TaskResult = {
    outcome: FlowTaskOutcome;
    outputs?: Record<string, JsonValue>;
    diagnostic?: FlowRefusalFeedback;
  };

  const flowTaskOutcomes = new Set<FlowTaskOutcome>([
    "completed",
    "committed",
    "background_pending",
    "refused",
    "conflict",
    "validation",
    "uncertain",
    "failed",
  ]);

  /** A saved record effect stores only the record identity, never readable or submitted values. */
  const isSavedRecordEffectOutput = (value: unknown): value is Readonly<{ record: string }> =>
    isRecord(value) &&
    Object.keys(value).every((key) => key === "record" || key === "warnings") &&
    Object.hasOwn(value, "record") &&
    recordIdSchema.safeParse(value.record).success;

  const isEmptyEffectOutput = (value: unknown): boolean =>
    isRecord(value) && Object.keys(value).length === 0;

  /** A stored refusal carries its stable code, never rendered correction text. */
  const storedCorrectionDiagnostic = (value: unknown): FlowRefusalFeedback | undefined => {
    if (!isRecord(value) || Object.keys(value).length !== 1) return undefined;
    const parsed = flowRefusalFeedbackSchema.safeParse(value.diagnostic);
    return parsed.success ? parsed.data : undefined;
  };

  const storedWarningsSchema = z.array(storedFlowWarningSchema);
  const replayWarnings = async (
    run: Run,
    plan: TaskPlan,
    outputs: Readonly<Record<string, unknown>>,
  ): Promise<readonly BeforeSaveRuleWarning[] | undefined> => {
    if (outputs.warnings === undefined) return [];
    const warnings = storedWarningsSchema.parse(outputs.warnings);
    const records = new Map<string, FlowRuntimeValues>();
    const rendered: BeforeSaveRuleWarning[] = [];
    for (const warning of warnings) {
      let record: FlowRuntimeValues | undefined;
      if (warning.kind === "dynamic") {
        if (
          run.authority.kind !== "person" ||
          dependencies.currentRecords === undefined ||
          plan.kind === "operation" ||
          plan.kind === "backend"
        )
          return undefined;
        const result = isRecord(outputs.result) ? outputs.result : undefined;
        const changedTarget =
          plan.kind === "changes" ? (plan.warningTarget ?? plan.intents[0]) : undefined;
        const recordId = recordIdSchema.safeParse(
          warning.record?.recordId ??
            (plan.kind === "changes"
              ? (outputs.record ??
                (changedTarget !== undefined && "recordId" in changedTarget
                  ? changedTarget.recordId
                  : undefined))
              : plan.kind === "save" || plan.asSave
                ? outputs.record
                : result?.recordId),
        );
        const recordTypeId =
          warning.record?.recordTypeId ??
          (plan.kind === "changes" ? changedTarget?.recordTypeId : plan.command.recordTypeId);
        if (!recordId.success || recordTypeId === undefined) return undefined;
        const key = targetKey(recordTypeId, recordId.data);
        record = records.get(key);
        if (record === undefined) {
          const current = await dependencies.currentRecords.read(
            run.authority.session,
            run.authority.selection,
            { recordTypeId, recordId: recordId.data },
          );
          if (current.outcome !== "read") return undefined;
          record = current.values;
          records.set(key, record);
        }
      }
      const flow = run.release.flows.get(warning.flowId);
      if (warning.kind === "dynamic" && (flow === undefined || record === undefined))
        throw new Error("FLOW_WARNING_SOURCE_UNAVAILABLE");
      rendered.push({
        code: warning.code,
        flowId: warning.flowId,
        taskPath: warning.taskPath,
        messageIsLiteral: warning.kind === "literal",
        ...(warning.record === undefined ? {} : { record: warning.record }),
        message:
          warning.kind === "literal"
            ? warning.message
            : rerenderBeforeSaveWarning(
                flow!,
                warning.taskPath,
                warning.code,
                record!,
                (dependencies.now ?? (() => new Date()))().toISOString(),
              ),
      });
    }
    return rendered;
  };

  /** A writer refusal ends the task with its own outcome and authored words. */
  const refusedTask = (
    failure:
      | (Readonly<{ outcome: string }> & { error?: Parameters<typeof ruleRefusalResult>[0] })
      | undefined,
  ) => {
    const error = failure?.outcome === "refused" ? failure.error : undefined;
    return {
      result: {
        outcome: error === undefined ? ("refused" as const) : refusalOutcome(error.code),
        ...(error === undefined ? {} : ruleRefusalResult(error)),
      },
      stored: {},
    };
  };

  /** Carries only committed saves' authored messages; logs locate the rule without record values. */
  const appendWarnings = (
    run: Run,
    call: FlowProtectedTaskCall,
    warnings: readonly BeforeSaveRuleWarning[] | undefined,
  ): void => {
    for (const warning of warnings ?? []) {
      run.warnings.push({ taskId: call.taskId, message: warning.message });
      console.warn(
        `[flows] flow ${run.flowId} task ${call.taskId} committed with warning ${warning.code}`,
      );
    }
  };

  /**
   * Records a task the platform cannot run here: it fails as not available, never as refused.
   * The person sees the message; the server log keeps the cause.
   */
  const notAvailable = (
    run: Run,
    call: FlowProtectedTaskCall,
    message: string,
    cause: string,
  ): TaskResult => {
    console.warn(
      `[flows] flow ${run.flowId} task ${call.taskId} (${call.taskType}) not available: ${cause}`,
    );
    run.unavailable.push({
      taskId: call.taskId,
      taskType: call.taskType,
      code: "capability_unavailable",
      message,
    });
    return { outcome: "failed" };
  };

  /** A Call protected operation task's inputs: its own input map, or the flow's inputs by name. */
  const operationInputs = (call: FlowProtectedTaskCall): Record<string, unknown> | undefined => {
    const suppliedInputs = call.properties.inputs?.value;
    if (suppliedInputs !== undefined && !isRecord(suppliedInputs)) return undefined;
    return isRecord(suppliedInputs)
      ? suppliedInputs
      : Object.fromEntries(
          Object.entries(call.flowInputs).map(([name, value]) => [name, value.value]),
        );
  };

  // Revisions produced inside this admitted segment supersede its original page evidence.
  // Other records are resolved by a current protected read; no caller-supplied revision is trusted.
  const changedRevisions = new Map<string, number>();
  const targetKey = (recordTypeId: string, recordId: string) =>
    `${recordTypeId.toLowerCase()}:${recordId.toLowerCase()}`;
  /** The revisions a set-based For each read in one statement, while its calls are planned. */
  let setRevisions: ReadonlyMap<string, number> | undefined;
  const resolveRecordTarget = async (
    run: Run,
    state: FlowRunState,
    call: FlowProtectedTaskCall,
    recordTypeId: string,
    candidate: unknown,
    operation?: "restore",
    currentRevision?: number,
  ): Promise<Readonly<{ recordId: string; revision: number }> | TaskResult> => {
    const recordId = recordIdSchema.safeParse(candidate);
    if (!recordId.success) return { outcome: "validation" };
    if (dependencies.subjects === undefined)
      return notAvailable(
        run,
        call,
        "This workflow can't read the record here.",
        "a protected record revision read",
      );
    if (operation === "restore") {
      const current = await dependencies.recordChanges?.restoreRevision(
        recordTypeId,
        recordId.data,
      );
      return current === undefined
        ? { outcome: "refused" }
        : { recordId: recordId.data, revision: current };
    }
    const known = currentRevision ?? setRevisions?.get(targetKey(recordTypeId, recordId.data));
    const read =
      known === undefined
        ? await dependencies.subjects.read(run.authority.session, run.authority.selection, {
            recordTypeId,
            recordId: recordId.data,
          })
        : { kind: "read" as const, revision: known };
    if (read.kind !== "read") return { outcome: read.kind === "refused" ? "refused" : "failed" };
    return {
      recordId: recordId.data,
      revision:
        changedRevisions.get(targetKey(recordTypeId, recordId.data)) ??
        (state.subject !== undefined && sameId(state.subject.recordId, recordId.data)
          ? state.subject.revision
          : read.revision),
    };
  };

  const planNamedAction = async (
    run: Run,
    state: FlowRunState,
    call: FlowProtectedTaskCall,
    commandId: string,
    named: FlowNamedAction,
    inputs: Record<string, unknown>,
    asSave?: true,
  ): Promise<Readonly<{ plan: TaskPlan }> | TaskResult> => {
    if (dependencies.actionRecords === undefined)
      return notAvailable(
        run,
        call,
        "This workflow can't run app actions here.",
        "a registered protected operation",
      );
    const record = Object.hasOwn(call.properties, "record")
      ? call.properties.record?.value
      : state.subject?.recordId;
    if (record === undefined)
      return notAvailable(
        run,
        call,
        "This step needs the record you're working on.",
        "the record the action runs on",
      );
    const target = await resolveRecordTarget(run, state, call, named.subjectRecordTypeId, record);
    if ("outcome" in target) return target;
    const command = executeNamedActionCommandSchema.safeParse({
      contractVersion: "2.0.0",
      commandId,
      action: named.action,
      recordTypeId: named.subjectRecordTypeId,
      recordId: target.recordId,
      expectedConcurrencyNumber: target.revision,
      inputs: namedActionInputs(named, inputs),
    });
    if (!command.success) {
      console.error(
        `[flows] named action command invalid at task ${call.taskId}: ${command.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}`,
      );
      return { outcome: "validation" };
    }
    return { plan: { kind: "action", command: command.data, ...(asSave ? { asSave } : {}) } };
  };

  /**
   * Resolves one protected task against its exact release and current readable target.
   * Preparation reads may run here; no change runs before the task is claimed.
   */
  const planTask = async (
    run: Run,
    state: FlowRunState,
    call: FlowProtectedTaskCall,
  ): Promise<Readonly<{ plan: TaskPlan }> | TaskResult> => {
    const commandId = effectCommandId(state.runId, call.taskPath, call.iteration);

    if (call.taskType === "record.changes") {
      if (dependencies.recordChanges === undefined || run.release.recordTypes === undefined)
        return notAvailable(
          run,
          call,
          "This workflow can't copy relationships here.",
          "the admitted record change port",
        );
      const copies = await planRelationshipCopies(
        run.release.recordTypes,
        call.properties,
        dependencies.recordChanges.readTargets,
      );
      if (copies.outcome !== "planned")
        return {
          outcome: copies.outcome,
          ...(copies.reason === undefined ? {} : { diagnostic: { code: copies.reason } }),
        };
      for (const record of copies.targets) {
        const target = await resolveRecordTarget(
          run,
          state,
          call,
          record.recordTypeId,
          record.recordId,
          undefined,
          record.revision,
        );
        if ("outcome" in target) return target;
        if (target.revision !== record.revision) return { outcome: "conflict" };
      }
      return {
        plan: {
          kind: "changes",
          commandId,
          intents: copies.intents,
          outputs: copies.outputs,
          warningTarget: copies.targets[0]!,
        },
      };
    }

    if (call.taskType === "record.link") {
      if (dependencies.recordChanges === undefined || run.release.recordTypes === undefined)
        return notAvailable(
          run,
          call,
          "This workflow can't link records here.",
          "the admitted record change port",
        );
      const linked = await planRecordLink(
        run.release.recordTypes,
        call.properties,
        dependencies.recordChanges.readTargets,
      );
      if (linked.outcome !== "planned")
        return {
          outcome: linked.outcome,
          ...(linked.reason === undefined ? {} : { diagnostic: { code: linked.reason } }),
        };
      const target = await resolveRecordTarget(
        run,
        state,
        call,
        linked.subject.recordTypeId,
        linked.subject.recordId,
        undefined,
        linked.subject.revision,
      );
      if ("outcome" in target) return target;
      if (target.revision !== linked.subject.revision) return { outcome: "conflict" };
      return {
        plan: {
          kind: "changes",
          commandId,
          intents: linked.intents,
          outputs: linked.outputs,
          warningTarget: {
            recordTypeId: linked.subject.recordTypeId,
            recordId: linked.subject.recordId,
          },
        },
      };
    }

    if (call.taskType === "record.delete" || call.taskType === "record.restore") {
      if (dependencies.recordChanges === undefined)
        return notAvailable(
          run,
          call,
          "This workflow can't change records here.",
          "the admitted record change port",
        );
      const recordTypeId = recordTypeIdSchema.safeParse(call.properties.record_type?.value);
      if (!recordTypeId.success || !run.release.recordTypes?.has(recordTypeId.data.toLowerCase()))
        return { outcome: "validation" };
      const operation = call.taskType === "record.delete" ? "delete" : "restore";
      const target = await resolveRecordTarget(
        run,
        state,
        call,
        recordTypeId.data,
        call.properties.record?.value,
        operation === "restore" ? "restore" : undefined,
      );
      if ("outcome" in target) return target;
      return {
        plan: {
          kind: "changes",
          commandId,
          intents: [
            {
              operation,
              recordTypeId: recordTypeId.data,
              recordId: target.recordId,
              expectedConcurrencyNumber: target.revision,
            },
          ],
        },
      };
    }

    if (
      call.taskType === "record.save" ||
      call.taskType === "record.create" ||
      call.taskType === "record.set_fields"
    ) {
      if (dependencies.records === undefined)
        return notAvailable(
          run,
          call,
          "This workflow can't save records here.",
          "the interactive record task port",
        );
      const activeFlow = run.library(state.activations.at(-1)?.flowId ?? run.flowId);
      const subjectTypes =
        activeFlow?.recordInput === undefined
          ? undefined
          : activeFlow.inputs[activeFlow.recordInput]?.recordTypeIds;
      const recordTypeId = recordTypeIdSchema.safeParse(
        call.properties.record_type?.value ??
          (call.taskType === "record.set_fields" && subjectTypes?.length === 1
            ? subjectTypes[0]
            : undefined),
      );
      const recordType = recordTypeId.success
        ? run.release.recordTypes?.get(recordTypeId.data.toLowerCase())
        : undefined;
      if (!recordTypeId.success || recordType === undefined)
        return notAvailable(
          run,
          call,
          "This step names a record type this app doesn't have.",
          "a record type of this release",
        );
      // The values are named by the release's field keys or field identities; any other name is
      // refused as invalid, never dropped.
      const values = call.properties.values?.value;
      if (!isRecord(values) || carriesSensitive(values, run.sensitive))
        return { outcome: "validation" };
      const named = nameRecordValues(recordType, values);
      if (named === undefined) return { outcome: "validation" };
      const { submittedNames, fieldKeys } = named;
      let submittedValues = named.submittedValues;
      // A task that names a record changes it; one that names none creates a record.
      if (
        call.taskType === "record.create" ||
        (call.taskType === "record.save" && !Object.hasOwn(call.properties, "record"))
      ) {
        submittedValues = withoutEmptyValues(submittedValues);
        // A choice option that a named action sets is reached only by running that action on
        // the record, so a new record cannot be created already in it.
        if (setsActionOwnedOption(recordType, submittedValues)) return { outcome: "validation" };
        const selectedOwnerGroupId = call.properties.selected_owner_group_id?.value;
        const selectedGroup =
          selectedOwnerGroupId === undefined
            ? undefined
            : groupIdSchema.safeParse(selectedOwnerGroupId);
        if (selectedGroup !== undefined && !selectedGroup.success) return { outcome: "validation" };
        const command = saveRecordCommandSchema.safeParse({
          contractVersion: "2.0.0",
          commandId,
          operation: "create",
          recordTypeId: recordTypeId.data,
          submittedValues,
          ...(selectedGroup === undefined ? {} : { selectedOwnerGroupId: selectedGroup.data }),
        });
        return command.success
          ? { plan: { kind: "save", command: command.data, submittedNames, fieldKeys } }
          : { outcome: "validation" };
      }
      const recordId = recordIdSchema.safeParse(
        Object.hasOwn(call.properties, "record")
          ? call.properties.record?.value
          : state.subject?.recordId,
      );
      if (Object.hasOwn(call.properties, "selected_owner_group_id"))
        return { outcome: "validation" };
      if (!recordId.success) return { outcome: "validation" };
      // A choice option that a named action sets is changed only by that action, run for this
      // record with the action's own inputs, permission, rules and refusals.
      const linkedActions = Object.entries(submittedValues).flatMap(([fieldId, value]) => {
        const action =
          typeof value === "string"
            ? recordType.optionActions.get(fieldId.toLowerCase())?.get(value)
            : undefined;
        return action === undefined ? [] : [action];
      });
      if (linkedActions.length > 0) {
        if (linkedActions.length > 1 || Object.keys(submittedValues).length > 1)
          return { outcome: "validation" };
        // The action's inputs come from the task's own map; a release published before the map
        // existed has none and reads as no inputs.
        const actionInputs = call.properties.action_inputs?.value ?? {};
        if (!isRecord(actionInputs) || carriesSensitive(actionInputs, run.sensitive))
          return { outcome: "validation" };
        return planNamedAction(run, state, call, commandId, linkedActions[0]!, actionInputs, true);
      }
      // Inputs for an action only make sense when the value names an option an action owns.
      if (Object.hasOwn(call.properties, "action_inputs")) return { outcome: "validation" };
      // The revision the person saw, when the step names it; the write refuses a record past it.
      const expected = call.properties.expected_revision?.value;
      if (
        expected !== undefined &&
        (typeof expected !== "number" || !Number.isSafeInteger(expected))
      )
        return { outcome: "validation" };
      const subject = await resolveRecordTarget(
        run,
        state,
        call,
        recordTypeId.data,
        recordId.data,
        undefined,
        expected,
      );
      if ("outcome" in subject) return subject;
      const command = saveRecordCommandSchema.safeParse({
        contractVersion: "2.0.0",
        commandId,
        operation: "update",
        recordTypeId: recordTypeId.data,
        recordId: recordId.data,
        expectedConcurrencyNumber: subject.revision,
        submittedValues,
      });
      return command.success
        ? { plan: { kind: "save", command: command.data, submittedNames, fieldKeys } }
        : { outcome: "validation" };
    }

    if (call.taskType === "backend.run") {
      if (dependencies.backend === undefined)
        return notAvailable(
          run,
          call,
          "This workflow can't run on the back end here.",
          "the back-end adapter",
        );
      const plan = planBackendTask(call, run, commandId);
      return plan === undefined ? { outcome: "validation" } : { plan };
    }

    if (call.taskType !== "operation.call")
      return notAvailable(
        run,
        call,
        "This action can't be completed in a workflow.",
        "no server runner for this task type",
      );

    const operationKey = call.properties.operation?.value;
    const inputs = operationInputs(call);
    // A sensitive value is shown to the person once; it is never passed on to another effect.
    if (inputs === undefined || carriesSensitive(inputs, run.sensitive))
      return { outcome: "validation" };
    const entry = Object.values(PLATFORM_SERVICE_OPERATIONS).find(
      (candidate) => platformOperationKey(candidate.key) === operationKey,
    );
    if (entry !== undefined) {
      // A record target belongs to a named action, never to a platform-service operation.
      if (Object.hasOwn(call.properties, "record")) return { outcome: "validation" };
      // A platform operation acts on the organisation's live data or an outside service; a
      // preview changes only its own copy of the records, so it never runs one.
      if (
        run.authority.kind === "person" &&
        run.authority.selection.previewInstallationId !== undefined
      )
        return { outcome: "refused" };
      return { plan: { kind: "operation", entry, inputs } };
    }

    // Otherwise the key may name one named action of the exact release, run for the surface's
    // subject record through the same named-action path (`runNamedAction`).
    const named =
      typeof operationKey === "string" ? run.release.namedActions?.get(operationKey) : undefined;
    if (named === undefined)
      return notAvailable(
        run,
        call,
        "This workflow step names an action this app doesn't have.",
        "a registered protected operation",
      );
    if (Object.hasOwn(call.properties, "subjects")) {
      if (Object.hasOwn(call.properties, "record")) return { outcome: "validation" };
      if (dependencies.actionRecords === undefined)
        return notAvailable(
          run,
          call,
          "This workflow can't run app actions here.",
          "a registered protected operation",
        );
      const set = await planNamedActionSubjects(
        dependencies.recordChanges,
        named,
        commandId,
        call.properties.subjects?.value,
        inputs,
      );
      return "commands" in set
        ? { plan: { kind: "action", command: set.commands[0]!, commands: set.commands } }
        : set;
    }
    return planNamedAction(run, state, call, commandId, named, inputs);
  };

  /** Reads the active task's selected fields without using the replayable effect ledger. */
  const runSelectedRecordRead = async (
    run: Run,
    state: FlowRunState,
    call: FlowProtectedTaskCall,
  ): Promise<TaskResult> => {
    const authority = run.authority;
    if (authority.kind !== "person")
      return notAvailable(
        run,
        call,
        "Only a signed-in person can read this record's fields.",
        "the current initiator's selected-record read port",
      );
    if (dependencies.selectedRecordReads === undefined)
      return notAvailable(
        run,
        call,
        "This workflow can't read record fields here.",
        "a trusted selected-record read port",
      );
    const projection = selectedRecordProjectionForTask(run.release, run.library, state, call);
    if (projection === undefined)
      return notAvailable(
        run,
        call,
        "This step reads fields this app doesn't have.",
        "the exact release's selected-record projection",
      );

    const record = call.properties.record;
    const recordId =
      record?.type === "record_reference" ? recordIdSchema.safeParse(record.value) : undefined;
    if (recordId === undefined || !recordId.success) return { outcome: "refused" };

    try {
      const result = await dependencies.selectedRecordReads.readFields(
        authority.session,
        authority.selection,
        {
          recordTypeId: projection.recordTypeId,
          recordId: recordId.data,
          fieldIds: projection.fields.map((field) => field.fieldId),
        },
      );
      if (result.kind !== "available") return { outcome: requestOutcome(result.kind) };
      const read = result.value;
      if (
        !isRecord(read) ||
        read.outcome !== "read" ||
        Object.keys(read).length !== 2 ||
        !isRecord(read.values)
      )
        return { outcome: "refused" };
      const values = aliasSelectedRecordValues(projection, read.values);
      if (values === undefined) return { outcome: "refused" };

      // The interpreter will place these values in FlowRunState on resume. That state may finish
      // in this segment, but it must never be written to a continuation.
      run.selectedRecordReadSeen = true;
      return { outcome: "completed", outputs: { values } };
    } catch (error) {
      reportUnexpectedFailure("selected record read task", error);
      return { outcome: "refused" };
    }
  };

  /** Runs a planned task's effect, holding the claim. Every failure is a safe outcome. */
  const runPlan = async (
    run: Run,
    state: FlowRunState,
    call: FlowProtectedTaskCall,
    plan: TaskPlan,
  ): Promise<{
    result: TaskResult;
    stored: Record<string, JsonValue>;
    warnings?: readonly BeforeSaveRuleWarning[] | undefined;
  }> => {
    const { session, selection } = run.authority;
    if (plan.kind === "changes") {
      if (plan.intents.length === 0) {
        const outputs = { ...plan.outputs };
        return { result: { outcome: "completed", outputs }, stored: outputs };
      }
      const changed = await dependencies.recordChanges!.apply(plan.commandId, plan.intents);
      if (changed.kind === "restart") return { result: { outcome: "conflict" }, stored: {} };
      if (changed.kind === "refused") return refusedTask(changed.result);
      for (const [index, result] of changed.results.entries())
        changedRevisions.set(
          targetKey(plan.intents[index]!.recordTypeId, result.recordId),
          result.concurrencyNumber,
        );
      const outputs: Record<string, JsonValue> =
        plan.outputs !== undefined
          ? { ...plan.outputs }
          : call.taskType === "record.delete"
            ? {}
            : { record: changed.results[0]!.recordId };
      return {
        result: { outcome: "committed", outputs },
        stored: outputs,
        warnings: changed.warnings,
      };
    }
    if (plan.kind === "save") {
      const saved = await dependencies.records!.save(session, selection, plan.command);
      if (saved.kind !== "available")
        return { result: { outcome: requestOutcome(saved.kind) }, stored: {} };
      const value = saved.value;
      if (value.outcome === "saved") {
        changedRevisions.set(
          targetKey(plan.command.recordTypeId, value.recordId),
          value.concurrencyNumber,
        );
        const recordId = recordIdSchema.safeParse(value.recordId);
        if (!recordId.success) return { result: { outcome: "refused" }, stored: {} };
        const outputs = { record: recordId.data };
        return {
          result: { outcome: "committed", outputs },
          stored: outputs,
          warnings: saved.warnings,
        };
      }
      if (value.outcome === "correction_required") {
        // Only the form field key, the correction code and a rule's authored message leave the save: never a value.
        const unlocated: typeof value.corrections = [];
        const located = dedupeFieldCorrections(
          value.corrections.flatMap((correction) => {
            // A rule may refuse for another field than the one submitted; its authored message
            // still names that field by key, so the caller can show the real reason.
            const fieldId = correction.fieldId.toLowerCase();
            const field =
              plan.submittedNames.get(fieldId) ??
              (correction.message === undefined ? undefined : plan.fieldKeys.get(fieldId));
            if (field === undefined) {
              unlocated.push(correction);
              return [];
            }
            return [
              {
                field,
                code: correction.code,
                ...(correction.message === undefined ? {} : { message: correction.message }),
              },
            ];
          }),
        );
        // Corrections on no field of this save still carry the rule's sentence (for example the
        // pipeline's), which the person reads as one refusal beside the located fields.
        const ruleRefusal = unlocatedCorrectionsRefusal(unlocated);
        const diagnostic = flowRefusalFeedbackSchema.safeParse({
          code: "invalid_command",
          ...(located.length === 0 ? {} : { corrections: located }),
          ...(ruleRefusal === undefined ? {} : { ruleRefusal }),
        });
        // The caller sees the located fields; the run-ended line carries the stable reason.
        console.error(
          `[flows] save of task ${call.taskId} needs ${value.corrections.length} field correction(s) (${value.corrections.map((correction) => `${correction.fieldId}:${correction.code}`).join(", ")}); ${located.length} located in the form${diagnostic.success ? "" : `: ${describeFailure(diagnostic.error)}`}`,
        );
        return {
          result: {
            outcome: "validation",
            ...(diagnostic.success ? { diagnostic: diagnostic.data } : {}),
          },
          stored: diagnostic.success ? { diagnostic: { code: diagnostic.data.code } } : {},
        };
      }
      return {
        result: {
          outcome: refusalOutcome(value.error.code),
          ...ruleRefusalResult(value.error),
        },
        stored: {},
      };
    }

    if (plan.kind === "backend") return runBackendTask(dependencies, run, plan, call.taskId);

    if (plan.kind === "action" && plan.commands !== undefined) {
      const executed = await runNamedAction(session, selection, plan.commands);
      if (executed.kind === "completed") {
        for (const value of executed.results)
          if (value.outcome === "completed")
            changedRevisions.set(
              targetKey(plan.command.recordTypeId, value.recordId),
              value.concurrencyNumber,
            );
        const outputs = { count: executed.results.length };
        return {
          result: { outcome: "committed", outputs },
          stored: outputs,
          warnings: executed.warnings,
        };
      }
      if (executed.kind !== "refused") return { result: { outcome: "failed" }, stored: {} };
      run.refusalLoggedTaskIds.push(call.taskId);
      return refusedTask(executed.result);
    }
    if (plan.kind === "action") {
      const executed = await runNamedAction(session, selection, plan.command);
      if (executed.kind !== "available")
        return { result: { outcome: requestOutcome(executed.kind) }, stored: {} };
      const value = executed.value;
      if (value.outcome === "completed") {
        changedRevisions.set(
          targetKey(plan.command.recordTypeId, value.recordId),
          value.concurrencyNumber,
        );
        // Only the record's identity and revision are kept: its readable values stay with the port.
        const outputs = plan.asSave
          ? { record: value.recordId }
          : { result: { recordId: value.recordId, concurrencyNumber: value.concurrencyNumber } };
        return {
          result: { outcome: "committed", outputs },
          stored: outputs,
          warnings: executed.warnings,
        };
      }
      // The action port logged this refusal with its reason; the run-ended line must not repeat it.
      run.refusalLoggedTaskIds.push(call.taskId);
      return {
        result: {
          outcome: refusalOutcome(value.error.code),
          ...ruleRefusalResult(value.error),
        },
        stored: {},
      };
    }

    const executed = await dependencies.executor.execute({
      operation: {
        serviceId: plan.entry.release.serviceId,
        operationId: plan.entry.release.operationId,
        releaseVersion: plan.entry.release.releaseVersion,
      },
      session,
      selection,
      inputs: plan.inputs,
      effectKey: { runId: state.runId, taskPath: call.taskPath, iteration: call.iteration },
    });
    const outcome: FlowTaskOutcome = executed.outcome;
    // Read results keep their outputs for later tasks but do not count as committed changes.
    const operationSucceeded = executed.outcome === "completed" || executed.outcome === "committed";
    const outputs: Record<string, JsonValue> = operationSucceeded
      ? { result: { ...executed.outputs } }
      : {};
    const sensitive = plan.entry.descriptor.sensitiveOutputs ?? [];
    if (operationSucceeded) run.sensitive.push(...sensitiveValues(executed.outputs, sensitive));
    const stored: Record<string, JsonValue> = operationSucceeded
      ? { result: redactSensitiveOutputs(executed.outputs, sensitive) }
      : {};
    let diagnostic = "diagnostic" in executed ? executed.diagnostic : undefined;
    if (diagnostic !== undefined && call.properties.refusal_feedback !== undefined) {
      const guidance = flowRefusalGuidanceByCodeSchema.parse(
        call.properties.refusal_feedback.value,
      )[diagnostic.code];
      if (guidance !== undefined)
        diagnostic = flowRefusalFeedbackSchema.parse({
          ...diagnostic,
          presentation: { ...guidance, code: diagnostic.code },
        });
    }
    if (diagnostic !== undefined) stored.diagnostic = { code: diagnostic.code };
    return {
      result: {
        outcome,
        outputs,
        ...(diagnostic === undefined ? {} : { diagnostic }),
      },
      stored,
    };
  };

  /**
   * Runs one protected task of the interpreter. The effect ledger claims the duplicate key first,
   * the task's protected path runs only when this call holds the claim, and the safe outcome is
   * recorded so any repeat replays it.
   */
  const runProtectedTask = async (
    run: Run,
    state: FlowRunState,
    call: FlowProtectedTaskCall,
  ): Promise<TaskResult> => {
    // Selected-record values are intentionally fresh and transient: never claim or complete a
    // replayable effect-ledger entry for this task.
    if (run.selectedRecordReadSeen && call.taskType !== "record.save")
      return { outcome: "refused" };
    if (call.taskType === "record.read_fields") return runSelectedRecordRead(run, state, call);

    if (call.taskType === "record.query") {
      if (dependencies.queryRecords === undefined)
        return notAvailable(
          run,
          call,
          "This workflow can't read records here.",
          "the current initiator's protected query reader",
        );
      return runQueryTask(dependencies.queryRecords, run, call.properties);
    }

    // Identity acquisition is a fresh protected read, never an effect-ledger replay. The tuple
    // selects a later read; it contains no title/address and does not confer target authority.
    if (call.taskType === "record.pin_identity") {
      if (run.authority.kind !== "person" || dependencies.recordPins === undefined)
        return notAvailable(
          run,
          call,
          "Only a signed-in person can choose a record here.",
          "a trusted human record-pin acquisition port",
        );
      if (
        call.taskVersion !== "1.0.0" ||
        Object.keys(call.properties).length !== 3 ||
        call.properties.application_key?.type !== "text" ||
        call.properties.record_type_key?.type !== "text" ||
        call.properties.record_id?.type !== "text"
      )
        return { outcome: "validation" };
      const selector = viewerSafeRecordPinSelectorSchema.safeParse({
        applicationKey: call.properties.application_key.value,
        recordTypeKey: call.properties.record_type_key.value,
        recordId: call.properties.record_id.value,
      });
      if (!selector.success || carriesSensitive(selector.data, run.sensitive))
        return { outcome: "validation" };
      try {
        const result = viewerSafeRecordPinAcquisitionResultSchema.safeParse(
          await dependencies.recordPins.acquireIdentity(
            run.authority.session,
            run.authority.selection,
            selector.data,
          ),
        );
        if (!result.success || result.data.outcome !== "available") return { outcome: "refused" };
        const identity = result.data.identity;
        if (
          !sameId(identity.organizationId, run.authority.selection.organizationId) ||
          (dependencies.recordPins.storedTargetResume !== true &&
            !sameId(identity.recordId, selector.data.recordId))
        )
          return { outcome: "refused" };
        run.recordPinReadSeen = true;
        return {
          outcome: "completed",
          outputs: {
            organization_id: identity.organizationId,
            application_root_id: identity.applicationRootId,
            module_root_id: identity.moduleRootId,
            module_release_revision: identity.moduleReleaseRevision,
            record_type_id: identity.recordTypeId,
            storage_contract_id: identity.storageContractId,
            record_id: identity.recordId,
          },
        };
      } catch (error) {
        reportUnexpectedFailure("record pin read task", error);
        return { outcome: "refused" };
      }
    }

    // The guided-form draft is the person's own private scratch state, never a record or a
    // replayable effect: the port checks ownership and revision, and a repeat answers a conflict.
    if (call.taskType === "form.save_draft" || call.taskType === "form.discard_draft") {
      if (run.authority.kind !== "person" || dependencies.guidedDrafts === undefined)
        return notAvailable(
          run,
          call,
          "Only a signed-in person can save this form's draft here.",
          "a trusted guided-form draft port",
        );
      return runGuidedDraftTask(
        dependencies.guidedDrafts,
        run.authority.session,
        run.authority.selection,
        call,
        run.sensitive,
      );
    }

    const principal: FlowEffectPrincipal =
      run.authority.kind === "person"
        ? { kind: "person", id: run.authority.session.identityId }
        : { kind: "system", id: run.authority.actorId };
    const organizationId = run.authority.selection.organizationId;
    const planned = await planTask(run, state, call);
    if (!("plan" in planned)) return planned;
    // A test run claims nothing in the ledger: its effects are rolled back and a repeat is a new run.
    if (dependencies.trace !== undefined) {
      const tested = await runPlan(run, state, call, planned.plan);
      appendWarnings(run, call, tested.warnings);
      return tested.result;
    }

    const key = {
      runId: state.runId,
      organizationId,
      principal,
      origin: run.origin,
      originId: run.originId,
      taskPath: call.taskPath,
      iteration: call.iteration,
    } as const;
    let claim: Awaited<ReturnType<typeof beginFlowEffect>>;
    try {
      claim = await beginFlowEffect(key);
    } catch (error) {
      reportUnexpectedFailure("effect ledger claim", error);
      // Nothing was claimed, so nothing ran.
      return { outcome: "failed" };
    }
    if (claim.kind === "completed") {
      if (run.selectedRecordReadSeen || run.recordPinReadSeen === true) {
        // Never trust or expose an effect-ledger replay for a read-derived save. Validate its
        // minimal stored shape, then ask the Record service to resolve the command receipt under
        // the current initiator and permissions. The receipt also rejects changed command fields.
        if (planned.plan.kind !== "save" || !flowTaskOutcomes.has(claim.outcome as FlowTaskOutcome))
          return { outcome: "refused" };
        if (claim.outcome === "committed") {
          const ledgerOutputs = claim.outputs;
          if (!isSavedRecordEffectOutput(ledgerOutputs)) return { outcome: "refused" };
          try {
            const replayed = await runPlan(run, state, call, planned.plan);
            if (replayed.result.outcome === "committed") {
              const replayedOutputs = replayed.result.outputs;
              if (
                !isSavedRecordEffectOutput(replayedOutputs) ||
                replayedOutputs.record.toLowerCase() !== ledgerOutputs.record.toLowerCase()
              )
                return { outcome: "refused" };
              const warnings = await replayWarnings(run, planned.plan, ledgerOutputs);
              if (warnings === undefined) return { outcome: "refused" };
              appendWarnings(run, call, warnings);
            }
            return replayed.result;
          } catch (error) {
            reportUnexpectedFailure("effect replay", error);
            return { outcome: "uncertain" };
          }
        }
        const replayedDiagnostic =
          claim.outcome === "validation" || claim.outcome === "refused"
            ? storedCorrectionDiagnostic(claim.outputs)
            : undefined;
        if (replayedDiagnostic !== undefined)
          return {
            outcome: claim.outcome as "validation" | "refused",
            diagnostic: replayedDiagnostic,
          };
        return isEmptyEffectOutput(claim.outputs)
          ? { outcome: claim.outcome as FlowTaskOutcome }
          : { outcome: "refused" };
      }
      const replayedDiagnostic =
        claim.outcome === "validation" || claim.outcome === "refused"
          ? storedCorrectionDiagnostic(claim.outputs)
          : undefined;
      if (replayedDiagnostic !== undefined)
        return {
          outcome: claim.outcome as "validation" | "refused",
          diagnostic: replayedDiagnostic,
        };
      const outputs = { ...claim.outputs };
      if (claim.outcome === "committed" && planned.plan.kind !== "operation") {
        const warnings = await replayWarnings(run, planned.plan, outputs);
        if (warnings === undefined) return { outcome: "refused" };
        appendWarnings(run, call, warnings);
        delete outputs.warnings;
      }
      return {
        outcome: claim.outcome as FlowTaskOutcome,
        outputs: outputs as Record<string, JsonValue>,
      };
    }
    if (claim.kind === "in_progress") return { outcome: "uncertain" };
    if (claim.kind !== "claimed") return { outcome: "refused" };

    let ran: Awaited<ReturnType<typeof runPlan>>;
    try {
      ran = await runPlan(run, state, call, planned.plan);
    } catch (error) {
      reportUnexpectedFailure("effect run", error);
      // Whether the effect committed is unknown; the open claim reports any repeat as uncertain.
      return { outcome: "uncertain" };
    }
    appendWarnings(run, call, ran.warnings);
    const stored = {
      ...ran.stored,
      ...(ran.warnings === undefined || ran.warnings.length === 0
        ? {}
        : {
            warnings: ran.warnings.map(storeFlowWarning),
          }),
    };
    try {
      await completeFlowEffect(key, ran.result.outcome, stored);
    } catch (error) {
      reportUnexpectedFailure("effect ledger completion", error);
      // The effect ran. Leaving the claim open makes any repeat report it uncertain, never re-run it.
    }
    return ran.result;
  };

  /** Runs one task inside its admitted segment; its caller owns the transaction and receipt. */
  const runSegmentTask = async (
    run: Run,
    state: FlowRunState,
    call: FlowProtectedTaskCall,
  ): Promise<
    Readonly<{
      result: TaskResult;
      replay: Extract<FlowRunResume, { kind: "task_result" }> | null | undefined;
      warnings: readonly BeforeSaveRuleWarning[];
    }>
  > => {
    if (
      call.taskType === "record.read_fields" ||
      call.taskType === "record.pin_identity" ||
      call.taskType === "record.query"
    )
      return { result: await runProtectedTask(run, state, call), replay: undefined, warnings: [] };
    // A guided-form draft write is a change that is never a record write: no plan, ledger claim or
    // record warnings, only the segment's receipt of its safe outcome.
    if (call.taskType === "form.save_draft" || call.taskType === "form.discard_draft") {
      const result = await runProtectedTask(run, state, call);
      return {
        result,
        replay: {
          kind: "task_result",
          outcome: result.outcome,
          ...(result.outputs === undefined ? {} : { outputs: result.outputs }),
        },
        warnings: [],
      };
    }
    if (run.selectedRecordReadSeen && call.taskType !== "record.save")
      return {
        result: { outcome: "refused" },
        replay: { kind: "task_result", outcome: "refused" },
        warnings: [],
      };
    const planned = await planTask(run, state, call);
    if (!("plan" in planned))
      return {
        result: planned,
        replay:
          call.effect === "read"
            ? undefined
            : {
                kind: "task_result",
                outcome: planned.outcome,
                ...(planned.diagnostic === undefined ? {} : { diagnostic: planned.diagnostic }),
              },
        warnings: [],
      };
    const ran = await runPlan(run, state, call, planned.plan);
    appendWarnings(run, call, ran.warnings);
    const isRead =
      planned.plan.kind === "operation" && planned.plan.entry.descriptor.effect === "read";
    if (isRead) return { result: ran.result, replay: undefined, warnings: ran.warnings ?? [] };
    const sensitive =
      planned.plan.kind === "operation" &&
      (planned.plan.entry.descriptor.sensitiveOutputs ?? []).some(
        (name) =>
          isRecord(ran.result.outputs?.result) && Object.hasOwn(ran.result.outputs.result, name),
      );
    if (sensitive) return { result: ran.result, replay: null, warnings: ran.warnings ?? [] };
    const outputs = Object.fromEntries(
      Object.entries(ran.stored).filter(([name]) => name !== "diagnostic" && name !== "warnings"),
    );
    const diagnostic = flowRefusalFeedbackSchema.safeParse(ran.stored.diagnostic);
    return {
      result: ran.result,
      replay: {
        kind: "task_result",
        outcome: ran.result.outcome,
        outputs,
        ...(diagnostic.success ? { diagnostic: diagnostic.data } : {}),
      },
      warnings: ran.warnings ?? [],
    };
  };

  /** Rebuilds warning text from current readable data before returning a stored effect outcome. */
  const replaySegmentTask = async (
    run: Run,
    state: FlowRunState,
    call: FlowProtectedTaskCall,
    replay: Extract<FlowRunResume, { kind: "task_result" }>,
    warnings: readonly z.infer<typeof storedFlowWarningSchema>[],
  ): Promise<FlowRunResume | undefined> => {
    if (run.authority.kind !== "person") return undefined;
    // The completed receipt is scoped to the verified actor and binding. Its subject may have
    // been deleted by this very command; replay exposes only its stored safe outcome.
    if (warnings.length === 0) return replay;
    const planned = await planTask(run, state, call);
    if (!("plan" in planned)) return undefined;
    const rendered = await replayWarnings(run, planned.plan, {
      ...replay.outputs,
      warnings,
    });
    if (rendered === undefined) return undefined;
    appendWarnings(run, call, rendered);
    return replay;
  };

  type SetStep = Readonly<{
    taskPath: string;
    iteration: string;
    calls: readonly FlowProtectedTaskCall[];
  }>;
  type SetRun = Readonly<{
    result: TaskResult;
    replay: Extract<FlowRunResume, { kind: "task_result" }>;
    warnings: readonly BeforeSaveRuleWarning[];
  }>;

  /**
   * A set-based For each: every item's record calls are planned against one batched target read,
   * then applied as ONE change (one command, receipt and storage write); each call gets its own
   * outputs, and a refusal names the call whose intent the writer refused.
   */
  const runSegmentSet = async (run: Run, state: FlowRunState, step: SetStep): Promise<SetRun> => {
    const stop = (taskId: string, failure: TaskResult): SetRun => {
      const result = { ...failure, outputs: { task: taskId } };
      return { result, replay: { kind: "task_result", ...result }, warnings: [] };
    };
    const first = step.calls[0]!;
    if (run.selectedRecordReadSeen) return stop(first.taskId, { outcome: "refused" });
    if (dependencies.recordChanges === undefined)
      return stop(
        first.taskId,
        notAvailable(
          run,
          first,
          "This workflow can't change records here.",
          "the admitted record change port",
        ),
      );
    const targets = step.calls.flatMap((call) => {
      const recordTypeId = recordTypeIdSchema.safeParse(call.properties.record_type?.value);
      const recordId = recordIdSchema.safeParse(call.properties.record?.value);
      return recordTypeId.success && recordId.success
        ? [{ recordTypeId: recordTypeId.data, recordId: recordId.data }]
        : [];
    });
    setRevisions =
      targets.length === 0 ? new Map() : await dependencies.recordChanges.readRevisions(targets);
    const intents: RecordChangeIntent[] = [];
    const slices: {
      call: FlowProtectedTaskCall;
      start: number;
      outputs?: Record<string, JsonValue>;
    }[] = [];
    try {
      for (const call of step.calls) {
        const planned = await planTask(run, state, call);
        if (!("plan" in planned)) return stop(call.taskId, planned);
        const plan = planned.plan;
        if (plan.kind !== "changes" && plan.kind !== "save")
          return stop(call.taskId, { outcome: "validation" });
        slices.push({
          call,
          start: intents.length,
          ...(plan.kind === "changes" && plan.outputs !== undefined
            ? { outputs: { ...plan.outputs } }
            : {}),
        });
        if (plan.kind === "changes") intents.push(...plan.intents);
        else {
          const command = plan.command;
          intents.push(
            command.operation === "create"
              ? {
                  operation: "create",
                  recordTypeId: command.recordTypeId,
                  values: command.submittedValues,
                  ...(command.selectedOwnerGroupId === undefined
                    ? {}
                    : { selectedOwnerGroupId: command.selectedOwnerGroupId }),
                }
              : {
                  operation: "update",
                  recordTypeId: command.recordTypeId,
                  recordId: command.recordId,
                  expectedConcurrencyNumber: command.expectedConcurrencyNumber,
                  values: command.submittedValues,
                },
          );
        }
      }
    } finally {
      setRevisions = undefined;
    }
    if (intents.length > 200) return stop(first.taskId, { outcome: "refused" });
    const changed =
      intents.length === 0
        ? undefined
        : await dependencies.recordChanges.apply(
            effectCommandId(state.runId, step.taskPath, step.iteration),
            intents,
          );
    if (changed?.kind === "restart") return stop(first.taskId, { outcome: "conflict" });
    if (changed?.kind === "refused") {
      const failed =
        [...slices].reverse().find((slice) => slice.start <= changed.index) ?? slices[0]!;
      const failure = changed.result;
      // A BeforeSave rule refusal ends the task with the writer's authored correction sentence,
      // exactly as a Save record task shows it; never discard it as a bare refusal.
      const correctionRule =
        failure?.outcome === "correction_required"
          ? unlocatedCorrectionsRefusal(failure.corrections)
          : undefined;
      return stop(failed.call.taskId, {
        outcome:
          failure?.outcome === "refused"
            ? refusalOutcome(failure.error.code)
            : failure?.outcome === "correction_required"
              ? "validation"
              : "refused",
        ...(failure?.outcome === "refused"
          ? ruleRefusalResult(failure.error)
          : correctionRule === undefined
            ? {}
            : ruleRefusalResult({ code: "operation_refused", reason: correctionRule })),
      });
    }
    for (const [index, result] of (changed?.results ?? []).entries())
      changedRevisions.set(
        targetKey(intents[index]!.recordTypeId, result.recordId),
        result.concurrencyNumber,
      );
    const setOutputs = slices.map((slice): Record<string, JsonValue> => {
      if (slice.outputs !== undefined) return slice.outputs;
      if (slice.call.taskType === "record.delete" || slice.call.taskType === "record.restore")
        return {};
      const result = changed!.results[slice.start]!;
      return slice.call.taskType === "record.set_fields"
        ? {
            record: result.recordId,
            revision: result.concurrencyNumber,
            previous: (changed!.previous[slice.start] ?? {}) as JsonValue,
          }
        : { record: result.recordId };
    });
    const warnings = changed?.warnings ?? [];
    appendWarnings(run, first, warnings);
    const outcome = changed === undefined ? "completed" : "committed";
    return {
      result: { outcome, outputs: { set: setOutputs } },
      replay: { kind: "task_result", outcome, outputs: { set: setOutputs } },
      warnings,
    };
  };

  /** Rebuilds a stored set's warning text from current readable data; warnings name their record. */
  const replaySegmentSet = async (
    run: Run,
    state: FlowRunState,
    step: SetStep,
    replay: Extract<FlowRunResume, { kind: "task_result" }>,
    warnings: readonly z.infer<typeof storedFlowWarningSchema>[],
  ): Promise<FlowRunResume | undefined> => {
    if (run.authority.kind !== "person") return undefined;
    if (warnings.length === 0) return replay;
    const rendered = await replayWarnings(
      run,
      {
        kind: "changes",
        commandId: effectCommandId(state.runId, step.taskPath, step.iteration),
        intents: [],
      },
      { warnings },
    );
    if (rendered === undefined) return undefined;
    appendWarnings(run, step.calls[0]!, rendered);
    return replay;
  };

  const runner = Object.freeze({
    run: runProtectedTask,
    runSegmentTask,
    replaySegmentTask,
    runSegmentSet,
    replaySegmentSet,
  });
  return dependencies.trace === undefined ? runner : tracedTaskRunner(dependencies.trace, runner);
};
