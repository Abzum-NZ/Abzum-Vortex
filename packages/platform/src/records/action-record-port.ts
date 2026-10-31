import "server-only";

import { randomUUID } from "node:crypto";
import type { IdentitySession, OrganizationSelectionCandidate } from "../access/identity-access";
import type { JsonValue } from "../catalogue/common";
import { activityIdSchema, eventOccurrenceIdSchema } from "../catalogue/identifiers";
import { describeFailure, isRecord } from "../catalogue/runtime-primitives";
import { unlocatedCorrectionsRefusal } from "../workflows/flow-refusal-feedback";
import {
  executeNamedActionCommandSchema,
  executeNamedActionResultSchema,
  type ExecuteNamedActionCommand,
  type ExecuteNamedActionResult,
} from "./named-actions";
import {
  createHumanOrganizationRequestService,
  HumanOrganizationRequestRestart,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "../access/human-organization-request";
import type { RequestDatabaseTransaction } from "../db/request-transaction";
import type { NamedActionFlowRunner } from "../definition/flow-action-run";
import type { BeforeSaveRuleWarning } from "../rules/before-save-flow-run";
import {
  actionFlowSeed,
  actionPreconditionHolds,
  normalizeActionInputs,
  type PreparedNamedAction,
} from "./named-action-inputs";
import {
  applyRecordChanges,
  type NamedRecordCommand,
  type RecordChangeIntent,
} from "./apply-record-changes";
import {
  completedResult,
  one,
  parsePreparation,
  type ResultRow,
} from "./action-record-preparation";

type RuleReason = Readonly<{ code: string; message: string }>;

/**
 * The named-action result plus any before-save rule warnings of a completed
 * attempt. The closed result contract has no warning field, so they travel beside it.
 */
export type NamedActionServiceResult = HumanOrganizationRequestResult<ExecuteNamedActionResult> &
  Readonly<{ warnings?: readonly BeforeSaveRuleWarning[] }>;

/** The refusal the person sees is a closed safe code; the server log keeps the real reason. */
const safeRefusal = (
  correlationId: string,
  code: "invalid_request" | "operation_refused" | "conflict",
  reason: string,
  ruleReason?: RuleReason,
): ExecuteNamedActionResult => {
  console.error(`[named-action] refused (${code}) ${correlationId}: ${reason}`);
  return executeNamedActionResultSchema.parse({
    contractVersion: "2.0.0",
    outcome: "refused",
    error: {
      code,
      messageKey: `errors.${code}`,
      correlationId,
      ...(ruleReason === undefined || code !== "operation_refused" ? {} : { reason: ruleReason }),
    },
  });
};

const preparationReason = (reasonCode: string | undefined): RuleReason | undefined => {
  if (reasonCode === undefined) return undefined;
  const message =
    reasonCode === "create_target_owner_unavailable"
      ? "You must belong to an active owner Group to create this record."
      : reasonCode === "create_target_owner_ambiguous"
        ? "The action requires one owner Group, but you belong to more than one."
        : reasonCode === "record_change_too_large"
          ? "This change affects too many related records. Save fewer rows."
          : `The action could not prepare its record change (${reasonCode}).`;
  return { code: reasonCode, message };
};

/**
 * The sentence a refused precondition shows, in the record type's own words: what the action needs
 * ("Mark opportunity won needs Stage to be Negotiation."), or that it does not fit the record now.
 */
const preconditionReason = (prepared: PreparedNamedAction): RuleReason => {
  const condition = prepared.action.precondition;
  const fieldId =
    condition?.kind === "comparison" && condition.left.source === "field"
      ? condition.left.fieldId
      : undefined;
  const value =
    condition?.kind === "comparison" &&
    condition.operator === "equals" &&
    condition.right?.source === "value"
      ? condition.right.value
      : undefined;
  const field = prepared.recordType.fields.find((candidate) => candidate.fieldId === fieldId);
  const settings = (field as { settings?: { options?: unknown } } | undefined)?.settings;
  const option = (
    Array.isArray(settings?.options)
      ? (settings.options as readonly Readonly<{ value: string; label: string }>[])
      : []
  ).find((candidate) => candidate.value === value);
  const message =
    field === undefined || option === undefined
      ? `${prepared.action.label} can't be used on this record as it is now.`
      : `${prepared.action.label} needs ${field.label} to be ${option.label}.`;
  return { code: "action_precondition", message: message.slice(0, 300) };
};

/** What one flow run of a named action planned, or why it could not be. */
type FlowComposition =
  | Readonly<{
      kind: "composed";
      intents: readonly RecordChangeIntent[];
      normalizedInputs: Readonly<Record<string, JsonValue>>;
    }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "invalid"; reason: string }>;

/**
 * Decides the action's declared precondition for the prepared subject, then runs its flow once and
 * plans the record steps it asked for. A precondition that does not hold is its own outcome: the
 * flow never runs, and the caller records the refusal as always.
 */
const composeFromFlow = async (
  transaction: RequestDatabaseTransaction,
  prepared: PreparedNamedAction,
  command: ExecuteNamedActionCommand,
  issuedAt: string,
  run: NamedActionFlowRunner,
): Promise<FlowComposition> => {
  const suppliedInputs = command.inputs;
  const normalizedInputs = normalizeActionInputs(prepared.action, suppliedInputs);
  if (normalizedInputs === undefined)
    return {
      kind: "invalid",
      reason: `the supplied inputs (${Object.keys(suppliedInputs).join(", ") || "none"}) do not match the inputs the action declares (${prepared.action.inputs.map((input) => `${input.key}: ${input.type}`).join(", ") || "none"})`,
    };
  const holds = actionPreconditionHolds(prepared, normalizedInputs);
  if (holds === undefined)
    return { kind: "invalid", reason: "the action's precondition cannot be decided" };
  if (!holds) {
    console.error("[named-action] refused NAMED_ACTION_PRECONDITION_REFUSED");
    return { kind: "refused" };
  }
  const outcome = await run(
    actionFlowSeed(prepared, normalizedInputs, issuedAt),
    {
      recordTypeId: command.recordTypeId,
      recordId: command.recordId,
      revision: command.expectedConcurrencyNumber,
    },
    transaction,
  );
  return outcome.kind === "planned"
    ? { kind: "composed", intents: outcome.intents, normalizedInputs }
    : { kind: "invalid", reason: outcome.reason };
};

type NamedIdentities = Readonly<{ activity: () => string; occurrence: () => string }>;

/** How one named command over its subjects ended; `index` names a subject in the order given. */
type NamedCommandOutcome =
  | Readonly<{
      kind: "completed";
      results: readonly ExecuteNamedActionResult[];
      warnings: readonly (BeforeSaveRuleWarning & Readonly<{ recordId: string }>)[];
    }>
  | Readonly<{ kind: "refused"; index: number; result: ExecuteNamedActionResult | undefined }>
  | Readonly<{ kind: "restart" }>;

const completedResults = (
  candidates: readonly unknown[] | undefined,
  count: number,
): readonly ExecuteNamedActionResult[] => {
  const results = (candidates ?? []).map((candidate) =>
    isRecord(candidate) ? completedResult(candidate) : undefined,
  );
  if (results.length !== count || results.some((result) => result === undefined))
    throw new Error("NAMED_ACTION_RESULT_INVALID");
  return results as readonly ExecuteNamedActionResult[];
};

/**
 * One named action over one or more subjects of one record type, inside a transaction the caller
 * owns: ONE preparation locks every subject at its expected revision, each subject's flow
 * composes its declared effects, and ONE common writer call applies every subject's intents under
 * one command, one receipt, one BeforeSave graph and one storage write. Every subject completes or
 * none does: the first refusal names its subject and the caller rolls the transaction back.
 */
const runNamedCommand = async (
  transaction: RequestDatabaseTransaction,
  issuedAt: string,
  commandId: string,
  commands: readonly ExecuteNamedActionCommand[],
  run: NamedActionFlowRunner,
  ids: NamedIdentities,
): Promise<NamedCommandOutcome> => {
  const head = commands[0]!;
  const activityIds = commands.map(() => activityIdSchema.parse(ids.activity()));
  const prepared = one(
    await transaction.query<ResultRow>`
      select vortex_record.prepare_named_record_commands(${commandId}::uuid, ${JSON.stringify({
        action: head.action,
        recordTypeId: head.recordTypeId,
        subjects: commands.map((command, index) => ({
          recordId: command.recordId,
          expectedConcurrencyNumber: command.expectedConcurrencyNumber,
          inputs: command.inputs,
          activityId: activityIds[index],
        })),
      })}::text::jsonb) as value
    `,
  ).value;
  if (!isRecord(prepared)) throw new Error("NAMED_ACTION_PREPARATION_INVALID");
  const correlationId = typeof prepared.correlationId === "string" ? prepared.correlationId : "";
  const namedIndex = typeof prepared.namedIndex === "number" ? prepared.namedIndex : 0;
  if (prepared.outcome === "completed") {
    // A replay answers only for exactly the subjects the completed command acted on.
    const replayed = Array.isArray(prepared.namedResults) ? prepared.namedResults : [];
    if (
      replayed.length !== commands.length ||
      replayed.some(
        (entry, index) =>
          !isRecord(entry) ||
          String(entry.recordId).toLowerCase() !== commands[index]!.recordId.toLowerCase(),
      )
    )
      return {
        kind: "refused",
        index: 0,
        result: safeRefusal(correlationId, "conflict", "the command identity names other records"),
      };
    return {
      kind: "completed",
      results: completedResults(replayed, commands.length),
      warnings: [],
    };
  }
  if (prepared.outcome === "refused_recorded") {
    console.error("[named-action] refused NAMED_ACTION_PERMISSION_REFUSED (refusal recorded)");
    return { kind: "refused", index: namedIndex, result: undefined };
  }
  if (prepared.outcome === "conflict")
    return {
      kind: "refused",
      index: namedIndex,
      result: safeRefusal(correlationId, "conflict", "the subject record's revision moved"),
    };
  if (prepared.outcome !== "prepared" || !Array.isArray(prepared.subjects)) {
    const reasonCode = typeof prepared.reasonCode === "string" ? prepared.reasonCode : undefined;
    return {
      kind: "refused",
      index: namedIndex,
      result: correlationId
        ? safeRefusal(
            correlationId,
            reasonCode === "command_invalid" ? "invalid_request" : "operation_refused",
            `the preparation was ${String(prepared.outcome)} (${reasonCode ?? "no reason code"})`,
            preparationReason(reasonCode),
          )
        : undefined,
    };
  }
  if (prepared.subjects.length !== commands.length)
    throw new Error("NAMED_ACTION_PREPARATION_INVALID");

  const intents: RecordChangeIntent[] = [];
  const subjects: NamedRecordCommand["subjects"][number][] = [];
  for (const [index, command] of commands.entries()) {
    const subject = parsePreparation({ ...(prepared.subjects[index] as object), correlationId });
    if (subject.outcome !== "prepared") throw new Error("NAMED_ACTION_PREPARATION_INVALID");
    const composed = await composeFromFlow(transaction, subject, command, issuedAt, run);
    if (composed.kind === "invalid")
      return {
        kind: "refused",
        index,
        result: safeRefusal(correlationId, "invalid_request", composed.reason),
      };
    if (composed.kind === "refused") {
      // The precondition refusal is recorded under current authority, then shown in its own words.
      await transaction.query<ResultRow>`
        select vortex_record.record_named_action_precondition_refusal(
          ${command.action.ownerKind}::text, ${command.action.ownerId}::uuid,
          ${command.action.releaseRevision}::bigint, ${command.action.actionId}::uuid,
          ${command.recordTypeId}::uuid, ${command.recordId}::uuid,
          ${command.expectedConcurrencyNumber}::bigint, ${activityIds[index]!}::uuid
        ) as value
      `;
      return {
        kind: "refused",
        index,
        result: safeRefusal(
          correlationId,
          "operation_refused",
          "the action's precondition refused the subject record",
          preconditionReason(subject),
        ),
      };
    }
    const own = composed.intents;
    subjects.push({
      recordId: command.recordId,
      expectedConcurrencyNumber: command.expectedConcurrencyNumber,
      inputs: composed.normalizedInputs,
      intentIndexes: own.map((_intent, position) => intents.length + position),
      activityId: activityIds[index]!,
      declaredOccurrenceIds: Array.from({ length: subject.eventDescriptorCount }, () =>
        eventOccurrenceIdSchema.parse(ids.occurrence()),
      ),
    });
    intents.push(...own);
  }
  const named: NamedRecordCommand = {
    action: head.action,
    recordTypeId: head.recordTypeId,
    subjects,
  };
  const applied = await applyRecordChanges(transaction, issuedAt, commandId, intents, named);
  if (applied.kind === "restart") return { kind: "restart" };
  if (applied.kind === "refused") {
    const index =
      applied.namedIndex ??
      Math.max(
        0,
        subjects.findIndex((subject) => subject.intentIndexes.includes(applied.index)),
      );
    const refused = applied.result;
    const reasonCode = applied.reasonCode;
    if (refused?.outcome === "refused")
      return {
        kind: "refused",
        index,
        result: safeRefusal(
          refused.error.correlationId,
          refused.error.code === "conflict"
            ? "conflict"
            : refused.error.code === "invalid_request"
              ? "invalid_request"
              : "operation_refused",
          `the record changes were refused (${reasonCode ?? refused.error.code})`,
          "reason" in refused.error ? refused.error.reason : undefined,
        ),
      };
    // A BeforeSave rule refusal reaches the person in the rule's own words, exactly as a Save
    // shows it: the writer's corrections carry the authored message, which the flow task
    // publishes as its rule refusal instead of the generic refusal sentence.
    const ruleReason =
      refused?.outcome === "correction_required"
        ? unlocatedCorrectionsRefusal(refused.corrections)
        : undefined;
    return {
      kind: "refused",
      index,
      result: safeRefusal(
        refused !== undefined && "correlationId" in refused
          ? String(refused.correlationId)
          : correlationId,
        ruleReason === undefined &&
          (refused?.outcome === "correction_required" || reasonCode === "command_invalid")
          ? "invalid_request"
          : "operation_refused",
        `the record changes were refused (${reasonCode ?? refused?.outcome ?? "no reason code"})`,
        ruleReason ?? preparationReason(reasonCode),
      ),
    };
  }
  const results = completedResults(applied.namedResults, commands.length);
  const subjectIds = new Set(commands.map((command) => command.recordId.toLowerCase()));
  return {
    kind: "completed",
    results,
    warnings: applied.warnings.map((warning) => ({
      ...warning,
      recordId:
        warning.record !== undefined && subjectIds.has(warning.record.recordId.toLowerCase())
          ? warning.record.recordId
          : head.recordId,
    })),
  };
};

/** What one run of a named action over several records ended with. */
export type NamedActionBatchResult =
  | Readonly<{
      kind: "completed";
      results: readonly ExecuteNamedActionResult[];
      /** Server-only subject identity lets the bulk summary count records, not repeated tasks. */
      warnings: readonly (BeforeSaveRuleWarning & Readonly<{ recordId: string }>)[];
    }>
  /** One record refused, so the whole batch rolled back; `index` names it in the given order. */
  | Readonly<{ kind: "refused"; index: number; result: ExecuteNamedActionResult | undefined }>
  | Readonly<{ kind: "unavailable" | "temporarily_unavailable" }>;

/** The most records one command of a named action changes. */
export const namedActionBatchMaximum = 200;

export type NamedActionRecordPortDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    activityId?: () => string;
    occurrenceId?: () => string;
  }>;

/**
 * The record port of the flow runner for named actions. The runner has already resolved the
 * exact release's action flow, checked its invocation permission and supplied the flow run; this
 * port owns what needs the database: the action's preparation and permission decision, the typed
 * inputs, and the one common record writer call that applies every effect of the action in one
 * transaction, receipt, Activity and Events included.
 */
export const createNamedActionRecordPort = (dependencies: NamedActionRecordPortDependencies) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const ids: NamedIdentities = {
    activity: dependencies.activityId ?? randomUUID,
    occurrence: dependencies.occurrenceId ?? randomUUID,
  };
  const parsedCommand = (candidate: unknown): ExecuteNamedActionCommand | undefined => {
    const command = executeNamedActionCommandSchema.safeParse(candidate);
    if (command.success) return command.data;
    console.error(
      `[named-action] refused NAMED_ACTION_COMMAND_INVALID: ${describeFailure(command.error)}`,
    );
    return undefined;
  };
  const single = (outcome: NamedCommandOutcome): NamedActionServiceResult => {
    if (outcome.kind === "restart") throw new HumanOrganizationRequestRestart();
    if (outcome.kind === "refused")
      return outcome.result === undefined
        ? { kind: "unavailable" }
        : { kind: "available", value: outcome.result };
    const value = outcome.results[0]!;
    return outcome.warnings.length > 0
      ? { kind: "available", value, warnings: outcome.warnings }
      : { kind: "available", value };
  };
  /** One command serves one record type, one action and one gesture identity, of 1 to 200 subjects. */
  const batchOf = (candidates: readonly unknown[]): ExecuteNamedActionCommand[] | undefined => {
    if (candidates.length === 0 || candidates.length > namedActionBatchMaximum) return undefined;
    const commands: ExecuteNamedActionCommand[] = [];
    for (const candidate of candidates) {
      const command = parsedCommand(candidate);
      if (command === undefined) return undefined;
      commands.push(command);
    }
    const head = commands[0]!;
    if (
      commands.some(
        (command) =>
          command.commandId !== head.commandId ||
          command.recordTypeId.toLowerCase() !== head.recordTypeId.toLowerCase() ||
          JSON.stringify(command.action) !== JSON.stringify(head.action) ||
          JSON.stringify(command.inputs) !== JSON.stringify(head.inputs),
      )
    ) {
      console.error("[named-action] refused NAMED_ACTION_BATCH_MIXED");
      return undefined;
    }
    return commands;
  };
  return Object.freeze({
    /**
     * Runs one named action over several records as ONE command inside the caller's verified
     * request transaction. A refusal is returned for the caller to roll the transaction back with.
     */
    async executeManyInTransaction(
      transaction: RequestDatabaseTransaction,
      issuedAt: string,
      selection: OrganizationSelectionCandidate,
      commandCandidates: readonly unknown[],
      run: NamedActionFlowRunner,
    ): Promise<NamedActionBatchResult> {
      const commands = batchOf(commandCandidates);
      if (commands === undefined || selection.applicationRootId === undefined)
        return { kind: "unavailable" };
      const outcome = await runNamedCommand(
        transaction,
        issuedAt,
        commands[0]!.commandId,
        commands,
        run,
        ids,
      );
      if (outcome.kind === "restart") throw new HumanOrganizationRequestRestart();
      return outcome.kind === "refused"
        ? { kind: "refused", index: outcome.index, result: outcome.result }
        : { kind: "completed", results: outcome.results, warnings: outcome.warnings };
    },

    /** Runs one named action inside the caller's verified request transaction. */
    async executeInTransaction(
      transaction: RequestDatabaseTransaction,
      issuedAt: string,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
      run: NamedActionFlowRunner,
    ): Promise<NamedActionServiceResult> {
      const command = parsedCommand(commandCandidate);
      if (command === undefined || selection.applicationRootId === undefined)
        return { kind: "unavailable" };
      return single(
        await runNamedCommand(transaction, issuedAt, command.commandId, [command], run, ids),
      );
    },

    async execute(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
      run: NamedActionFlowRunner,
    ): Promise<NamedActionServiceResult> {
      const command = parsedCommand(commandCandidate);
      if (command === undefined) return { kind: "unavailable" };
      if (selection.applicationRootId === undefined) {
        console.error("[named-action] refused NAMED_ACTION_APPLICATION_NOT_SELECTED");
        return { kind: "unavailable" };
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        // A refusal writes no record; its transaction keeps only the refused Activity entry.
        const result = await requests.runChange(
          session,
          selection,
          (transaction, _scope, issuedAt) =>
            runNamedCommand(transaction, issuedAt, command.commandId, [command], run, ids),
        );
        if (result.kind !== "available") return result;
        if (result.value.kind === "restart") continue;
        return single(result.value);
      }
      return { kind: "temporarily_unavailable" };
    },

    /**
     * Runs one named action over several records as ONE command (the caller's gesture command id,
     * shared by every candidate) in one transaction: one receipt, one BeforeSave graph and one
     * storage write. Every record completes or none does: the first refusal names its record. A
     * command that already completed replays its result without writing again.
     */
    async executeMany(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidates: readonly unknown[],
      run: NamedActionFlowRunner,
    ): Promise<NamedActionBatchResult> {
      const commands = batchOf(commandCandidates);
      if (commands === undefined || selection.applicationRootId === undefined)
        return { kind: "unavailable" };
      const head = commands[0]!;
      const rollback = new Error("NAMED_ACTION_BATCH_ROLLED_BACK");
      let stopped: NamedCommandOutcome | undefined;
      const result = await requests.runChange(
        session,
        selection,
        async (transaction, _scope, issuedAt) => {
          const outcome = await runNamedCommand(
            transaction,
            issuedAt,
            head.commandId,
            commands,
            run,
            ids,
          );
          if (outcome.kind === "completed") return outcome;
          // A record that moved, or refused, throws through the transaction so every record
          // of the batch rolls back with it.
          stopped = outcome;
          throw rollback;
        },
      );
      const ended = stopped as NamedCommandOutcome | undefined;
      if (ended?.kind === "restart") return { kind: "temporarily_unavailable" };
      if (ended?.kind === "refused")
        return { kind: "refused", index: ended.index, result: ended.result };
      if (result.kind !== "available") return result;
      return { kind: "completed", results: result.value.results, warnings: result.value.warnings };
    },
  });
};
