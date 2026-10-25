import { z } from "zod";
import type { IdentitySession, OrganizationSelectionCandidate } from "../access/identity-access";
import { jsonValueSchema, type JsonValue } from "../catalogue/common";
import { groupIdSchema, recordIdSchema, recordTypeIdSchema } from "../catalogue/identifiers";
import { PLATFORM_SERVICE_OPERATIONS } from "../catalogue/platform-service-operation-catalogue";
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
import { platformOperationKey } from "../workflows/default-flow-sources";
import {
  flowRefusalFeedbackSchema,
  flowRefusalPresentationSchema,
  unlocatedCorrectionsRefusal,
  type FlowRefusalFeedback,
} from "../workflows/flow-refusal-feedback";
import type { BeforeSaveRuleWarning } from "../rules/before-save-flow-run";
import type {
  FlowProtectedTaskCall,
  FlowRunState,
  FlowTaskOutcome,
} from "../rules/flow-interpreter";
import type { FlowEffectLedger, FlowEffectPrincipal } from "./flow-continuation-store";
import { reportUnexpectedFailure } from "./definition-error";
import {
  aliasSelectedRecordValues,
  carriesSensitive,
  dedupeFieldCorrections,
  effectCommandId,
  unavailableTaskMessages,
  redactSensitiveOutputs,
  refusalOutcome,
  requestOutcome,
  selectedRecordProjectionForTask,
  sensitiveValues,
} from "./flow-orchestrator-support";
import type {
  FlowNamedAction,
  FlowOrchestratorDependencies,
  NamedActionExecutionResult,
  Run,
} from "./flow-orchestrator-types";

/**
 * Runs the protected tasks of one flow run: plans each task, claims its effect in the ledger and
 * runs the record, operation or named-action path it names. `runNamedAction` is the orchestrator's
 * one named-action path.
 */
export const createFlowTaskRunner = (
  dependencies: FlowOrchestratorDependencies,
  runNamedAction: (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    command: ExecuteNamedActionCommand,
  ) => Promise<NamedActionExecutionResult>,
) => {
  type PlatformOperation =
    (typeof PLATFORM_SERVICE_OPERATIONS)[keyof typeof PLATFORM_SERVICE_OPERATIONS];

  /** What one protected task will run, decided before its effect is claimed. */
  type TaskPlan =
    | Readonly<{ kind: "operation"; entry: PlatformOperation; inputs: Record<string, unknown> }>
    | Readonly<{
        kind: "save";
        command: SaveRecordCommand;
        /** The submitted form field key of each record field, by lower-case field id. */
        submittedNames: ReadonlyMap<string, string>;
        /** The key of every field of the record type, by lower-case field id. */
        fieldKeys: ReadonlyMap<string, string>;
      }>
    | Readonly<{
        kind: "action";
        command: ExecuteNamedActionCommand;
        /** The action stands in for a Save record task, so it reports the saved record like one. */
        asSave?: true;
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

  /** A refused save stores only its located field keys and codes, so a replay reports them again. */
  const storedCorrectionDiagnostic = (value: unknown): FlowRefusalFeedback | undefined => {
    if (!isRecord(value) || Object.keys(value).length !== 1) return undefined;
    const parsed = flowRefusalFeedbackSchema.safeParse(value.diagnostic);
    return parsed.success ? parsed.data : undefined;
  };

  const storedWarningsSchema = z.array(
    z.object({ code: z.string(), message: z.string() }).strict(),
  );
  const replayWarnings = (
    outputs: Readonly<Record<string, unknown>>,
  ): readonly BeforeSaveRuleWarning[] =>
    outputs.warnings === undefined ? [] : storedWarningsSchema.parse(outputs.warnings);

  /** The rule's authored refusal of a protected record path, when its safe error carries one. */
  const ruleRefusalResult = (
    error: Readonly<{
      code: string;
      reason?: Readonly<{ code: string; message: string }> | undefined;
    }>,
  ): Pick<TaskResult, "diagnostic"> => {
    if (error.reason === undefined) return {};
    const diagnostic = flowRefusalFeedbackSchema.safeParse({
      code: "invalid_command",
      ruleRefusal: error.reason,
    });
    if (diagnostic.success) return { diagnostic: diagnostic.data };
    console.error(`[flows] rule refusal not carried: ${describeFailure(diagnostic.error)}`);
    return {};
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

  /**
   * Plans one named action of the exact release, run for the surface's subject record through the
   * same path as its binding (`executeAction`).
   */
  const planNamedAction = (
    run: Run,
    state: FlowRunState,
    call: FlowProtectedTaskCall,
    commandId: string,
    named: FlowNamedAction,
    inputs: Record<string, unknown>,
    asSave?: true,
  ): Readonly<{ plan: TaskPlan }> | TaskResult => {
    if (dependencies.actionRecords === undefined)
      return notAvailable(
        run,
        call,
        "This workflow can't run app actions here.",
        "a registered protected operation",
      );
    if (state.subject === undefined)
      return notAvailable(
        run,
        call,
        "This step needs the record you're working on.",
        "the record the action runs on",
      );
    if (dependencies.subjects === undefined)
      return notAvailable(
        run,
        call,
        "This workflow can't read the record here.",
        "a protected read of the page's record",
      );
    const command = executeNamedActionCommandSchema.safeParse({
      contractVersion: "2.0.0",
      commandId,
      action: named.action,
      recordTypeId: named.subjectRecordTypeId,
      recordId: state.subject.recordId,
      expectedConcurrencyNumber: state.subject.revision,
      inputs: Object.fromEntries(
        Object.entries(inputs).map(([name, value]) => [
          name,
          typeof value === "string" && Object.hasOwn(named.referenceInputTypes, name)
            ? { recordTypeId: named.referenceInputTypes[name], recordId: value }
            : value,
        ]),
      ),
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
   * Decides what one protected task runs, from the task, the exact release and the segment's
   * subject only. Nothing runs here, so a task that cannot run is settled before any claim.
   */
  const planTask = (
    run: Run,
    state: FlowRunState,
    call: FlowProtectedTaskCall,
  ): Readonly<{ plan: TaskPlan }> | TaskResult => {
    const commandId = effectCommandId(state.runId, call.taskPath, call.iteration);

    if (call.taskType === "record.save") {
      if (dependencies.records === undefined)
        return notAvailable(
          run,
          call,
          "This workflow can't save records here.",
          "the interactive record task port",
        );
      const recordTypeId = recordTypeIdSchema.safeParse(call.properties.record_type?.value);
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
      const submittedValues: Record<string, JsonValue> = {};
      const submittedNames = new Map<string, string>();
      const fieldKeys = new Map<string, string>();
      for (const [name, fieldId] of recordType.fieldIds)
        if (name !== fieldId.toLowerCase()) fieldKeys.set(fieldId.toLowerCase(), name);
      for (const [name, value] of Object.entries(values)) {
        const fieldId = recordType.fieldIds.get(name.toLowerCase());
        if (fieldId === undefined || Object.hasOwn(submittedValues, fieldId))
          return { outcome: "validation" };
        submittedValues[fieldId] = value as JsonValue;
        submittedNames.set(fieldId.toLowerCase(), name);
      }
      // A task that names a record changes it; one that names none creates a record.
      if (!Object.hasOwn(call.properties, "record")) {
        // A new record has nothing to clear, so a field the person left empty is simply not set.
        for (const [fieldId, value] of Object.entries(submittedValues))
          if (value === null) delete submittedValues[fieldId];
        // A choice option that a named action sets is reached only by running that action on
        // the record, so a new record cannot be created already in it.
        if (
          Object.entries(submittedValues).some(
            ([fieldId, value]) =>
              typeof value === "string" &&
              recordType.optionActions.get(fieldId.toLowerCase())?.has(value) === true,
          )
        )
          return { outcome: "validation" };
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
      const recordId = recordIdSchema.safeParse(call.properties.record?.value);
      if (Object.hasOwn(call.properties, "selected_owner_group_id"))
        return { outcome: "validation" };
      if (!recordId.success) return { outcome: "validation" };
      // A change is bound to the revision the person saw: the surface's subject. Without it the
      // change cannot be checked against what the person was shown, so it does not run.
      const subject = state.subject;
      if (subject === undefined || subject.recordId.toLowerCase() !== recordId.data.toLowerCase())
        return notAvailable(
          run,
          call,
          "This step can only change the record you're working on.",
          "the revision of the record the page shows",
        );
      if (dependencies.subjects === undefined)
        return notAvailable(
          run,
          call,
          "This workflow can't read the record here.",
          "a protected read of the page's record",
        );
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

    if (call.taskType !== "operation.call")
      return notAvailable(
        run,
        call,
        unavailableTaskMessages[call.taskType] ?? "This action can't be completed in a workflow.",
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
    // subject record through the same path as its binding (`executeAction`).
    const named =
      typeof operationKey === "string" ? run.release.namedActions?.get(operationKey) : undefined;
    if (named === undefined)
      return notAvailable(
        run,
        call,
        "This workflow step names an action this app doesn't have.",
        "a registered protected operation",
      );
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
    // Non-person execution contexts stay fail-closed until exact per-task grants are implemented.
    if (run.authority.kind !== "person") return { result: { outcome: "failed" }, stored: {} };
    const { session, selection } = run.authority;
    // The page subject is retained as run evidence. A fresh read under this initiator's request
    // scope verifies the exact record type and identity before either protected change is attempted.
    // The record service still checks change or action permission inside its own transaction.
    const target =
      plan.kind === "action"
        ? { recordTypeId: plan.command.recordTypeId, recordId: plan.command.recordId }
        : plan.kind === "save" && plan.command.operation === "update"
          ? { recordTypeId: plan.command.recordTypeId, recordId: plan.command.recordId }
          : undefined;
    if (target !== undefined) {
      const subject = await dependencies.subjects!.read(session, selection, target);
      if (subject !== "read")
        return {
          result: { outcome: subject === "refused" ? "refused" : "failed" },
          stored: {},
        };
    }
    if (plan.kind === "save") {
      const saved = await dependencies.records!.save(session, selection, plan.command);
      if (saved.kind !== "available")
        return { result: { outcome: requestOutcome(saved.kind) }, stored: {} };
      const value = saved.value;
      if (value.outcome === "saved") {
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
          stored: diagnostic.success
            ? {
                diagnostic: {
                  code: diagnostic.data.code,
                  ...(located.length === 0
                    ? {}
                    : {
                        corrections: located.map((correction) => ({
                          field: correction.field,
                          code: correction.code,
                          ...(correction.message === undefined
                            ? {}
                            : { message: correction.message }),
                        })),
                      }),
                  ...(ruleRefusal === undefined ? {} : { ruleRefusal }),
                },
              }
            : {},
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

    if (plan.kind === "action") {
      const executed = await runNamedAction(session, selection, plan.command);
      if (executed.kind !== "available")
        return { result: { outcome: requestOutcome(executed.kind) }, stored: {} };
      const value = executed.value;
      if (value.outcome === "completed") {
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
      const presentation = flowRefusalPresentationSchema.parse(
        call.properties.refusal_feedback.value,
      );
      if (presentation.code === diagnostic.code)
        diagnostic = flowRefusalFeedbackSchema.parse({ ...diagnostic, presentation });
    }
    if (diagnostic !== undefined) stored.diagnostic = jsonValueSchema.parse(diagnostic);
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
          !sameId(identity.recordId, selector.data.recordId)
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

    const principal: FlowEffectPrincipal =
      run.authority.kind === "person"
        ? { kind: "person", id: run.authority.session.identityId }
        : run.authority.context.actor.kind === "specified_account"
          ? {
              kind: "specified_account",
              id: run.authority.context.actor.organizationAccountId,
            }
          : { kind: "system", id: run.authority.context.actor.systemActorId };
    const organizationId =
      run.authority.kind === "person"
        ? run.authority.selection.organizationId
        : run.authority.organizationId;
    if (run.authority.kind === "execution_authority")
      return notAvailable(
        run,
        call,
        "This step can't run in a background workflow.",
        "per-task access grants are not resolved for execution authority runs",
      );
    const planned = planTask(run, state, call);
    if (!("plan" in planned)) return planned;

    const key = {
      runId: state.runId,
      organizationId,
      principal,
      origin: run.origin,
      originId: run.originId,
      taskPath: call.taskPath,
      iteration: call.iteration,
    } as const;
    let claim: Awaited<ReturnType<FlowEffectLedger["begin"]>>;
    try {
      claim = await dependencies.ledger.begin(key);
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
              appendWarnings(run, call, replayWarnings(ledgerOutputs));
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
        appendWarnings(run, call, replayWarnings(outputs));
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
        : { warnings: ran.warnings.map(({ code, message }) => ({ code, message })) }),
    };
    try {
      await dependencies.ledger.complete(key, ran.result.outcome, stored);
    } catch (error) {
      reportUnexpectedFailure("effect ledger completion", error);
      // The effect ran. Leaving the claim open makes any repeat report it uncertain, never re-run it.
    }
    return ran.result;
  };

  return runProtectedTask;
};
