import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { IdentitySession, OrganizationSelectionCandidate } from "../access/identity-access";
import type { JsonValue } from "../catalogue/common";
import { activityIdSchema, eventOccurrenceIdSchema } from "../catalogue/identifiers";
import { describeFailure } from "../catalogue/runtime-primitives";
import { recordLinkValueSchema } from "./module-field-values";
import {
  executeNamedActionCommandSchema,
  executeNamedActionResultSchema,
  type ExecuteNamedActionCommand,
  type ExecuteNamedActionResult,
} from "./named-actions";
import { saveRecordCommandSchema } from "./records";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "../access/human-organization-request";
import type { RequestDatabaseTransaction } from "../db/request-transaction";
import type { ActionFlowRunner } from "../rules/action-flow-run";
import type { BeforeSaveRuleWarning } from "../rules/before-save-flow-run";
import {
  actionFlowSeed,
  composeFlowEffects,
  normalizeActionInputs,
  type NamedActionComposition,
  type NamedActionCreation,
  type PreparedNamedAction,
} from "./action-flow-effects";
import {
  beginBeforeSaveRuleExecution,
  parseBeforeSaveFlowSet,
  type BeforeSaveRuleExecution,
} from "./before-save-rules";
import {
  performProtectedRecordDelete,
  settleRecordLifecycleError,
  type RecordDeleteResult,
  type Settled,
} from "./delete-record";
import {
  calculateLockedRelationshipTotalSave,
  type LockedRelationshipTotalPreparation,
  type RelationshipTotalParentMutation,
} from "./relationship-total-save";
import type { RecordFieldValuePendingCheck } from "./field-values";
import {
  parseRelationshipTotalPreparation,
  readOrganizationRuntimeSettings,
  type RelationshipTotalPreparationOutcome,
} from "./save-record";
import { calculateAndFinalize, operationClock } from "./field-candidate";
import { firstFieldDependencyRefusal } from "./link-dependencies";
import {
  completedResult,
  one,
  parsePreparation,
  type ActionPreparation,
  type PreparedAction,
  type ResultRow,
} from "./action-record-preparation";

type RuleReason = Readonly<{ code: string; message: string }>;

/**
 * The named-action result plus any before-save rule warnings of a completed
 * attempt. The closed result contract has no warning field, so they travel beside it.
 */
export type NamedActionServiceResult = HumanOrganizationRequestResult<ExecuteNamedActionResult> &
  Readonly<{ warnings?: readonly BeforeSaveRuleWarning[] }>;

const restart = Symbol("restartNamedAction");
const recordedRefusal = Symbol("recordedNamedActionRefusal");

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
      ...(ruleReason === undefined ? {} : { reason: ruleReason }),
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

const pendingCheckIsAuthorized = (
  check: RecordFieldValuePendingCheck,
  singleRequiredPermissionId: string | undefined,
): boolean =>
  check.kind === "record_reference" ||
  (check.kind === "choice_permission" &&
    singleRequiredPermissionId !== undefined &&
    check.permissionId.toLowerCase() === singleRequiredPermissionId.toLowerCase());

/**
 * Finalises each creation on its own when the merged closure reported
 * `not_required` or `defer`, so a creation still reaches the writer with its
 * complete generated field set. Totals cannot apply on this path by
 * construction: the preparation only reports those outcomes when no root type
 * participates in one.
 */
/**
 * The deleting action's protected delete is its own command with its own receipt, so it
 * cannot reuse the action's command id. Its id is derived from the action's, and
 * `named_action_deleted_subject_replay_internal` derives it the same way.
 */
const deleteLifecycleCommandId = (actionCommandId: string): string => {
  const digest = createHash("sha256").update(`record.delete:${actionCommandId}`).digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Issue codes, fields and paths only: never a record value. */
const describeIssues = (
  issues: ReadonlyArray<
    Readonly<{
      code: string;
      fieldId?: string;
      path: readonly (string | number)[];
      requirement?: Readonly<{ code: string; message: string }>;
    }>
  >,
): string =>
  issues.length === 0
    ? "no issue was reported"
    : issues
        .map(
          (value) =>
            `${value.code}${value.fieldId === undefined ? "" : ` field ${value.fieldId}`} at ${value.path.join(".") || "(root)"}${value.requirement === undefined ? "" : `: ${value.requirement.code}: ${value.requirement.message}`}`,
        )
        .join("; ");

const ruleReasonFromIssues = (
  issues: ReadonlyArray<
    Readonly<{ code: string; recordKey?: string; ruleKey?: string; requirement?: RuleReason }>
  >,
  preparation?: LockedRelationshipTotalPreparation,
): RuleReason | undefined => {
  const issue = issues.find(
    (issue) =>
      issue.requirement !== undefined &&
      (issue.code === "before_save_rule_refused" ||
        issue.code === "required_field_missing" ||
        issue.code === "stage_move_refused"),
  );
  if (issue?.requirement === undefined)
    return issues.some((issue) => issue.code === "required_field_missing")
      ? {
          code: "required_field_missing",
          message:
            "A required value is missing from a record this action creates or changes. Ask an application builder to review the action, then try again.",
        }
      : undefined;
  if (preparation !== undefined && issue.recordKey !== undefined && issue.recordKey !== "root") {
    const parent = preparation.records.find((record) => record.recordKey === issue.recordKey);
    if (parent === undefined) throw new Error("RELATIONSHIP_TOTAL_PARENT_MISSING");
    console.error(
      `[named-action] parent rule refused: rule=${issue.ruleKey ?? ("ruleKey" in issue.requirement ? issue.requirement.ruleKey : "unknown")} parent=${parent.recordId ?? issue.recordKey} reason=${issue.requirement.code}`,
    );
    if (!parent.canRead)
      return {
        code: "related_record_rule_conflict",
        message: "This change conflicts with a rule on a related record",
      };
  }
  return { code: issue.requirement.code, message: issue.requirement.message };
};

const creationFinalValues = (
  prepared: PreparedAction,
  creations: readonly NamedActionCreation[],
  issuedAt: string,
  organizationCurrency: string | undefined,
  timeZone: string | undefined,
): Readonly<
  | { values: Record<number, Record<string, JsonValue | null>> }
  | { reason: string; ruleReason?: RuleReason }
> => {
  const targets = new Map(prepared.createTargets.map((target) => [target.ordinal, target]));
  const values: Record<number, Record<string, JsonValue | null>> = {};
  for (const creation of creations) {
    const target = targets.get(creation.ordinal);
    if (target === undefined)
      return {
        reason: `the action creates ordinal ${creation.ordinal}, which has no declared target`,
      };
    const command = saveRecordCommandSchema.safeParse({
      contractVersion: "2.0.0",
      commandId: randomUUID(),
      operation: "create",
      recordTypeId: target.recordTypeId,
      submittedValues: creation.values,
    });
    if (!command.success)
      return {
        reason: `the created record ${creation.ordinal} is not a valid save command: ${describeIssues(command.error.issues.map((value) => ({ code: value.code, path: value.path.map(String) })))}`,
      };
    const ruleSet = parseBeforeSaveFlowSet(target.beforeSaveFlows, target.recordTypeId);
    if (ruleSet === undefined)
      return { reason: `the created record ${creation.ordinal} has unavailable before-save rules` };
    const execution = beginBeforeSaveRuleExecution(ruleSet);
    const calculated = calculateAndFinalize({
      operation: command.data.operation,
      submittedValues: command.data.submittedValues,
      recordType: target.recordType,
      issuedAt,
      organizationCurrency,
      timeZone,
      rules: execution,
    });
    if (!calculated.success) {
      const ruleReason = ruleReasonFromIssues(calculated.issues);
      return {
        reason: `the created record ${creation.ordinal} did not calculate: ${describeIssues(calculated.issues)}`,
        ...(ruleReason === undefined ? {} : { ruleReason }),
      };
    }
    if (
      calculated.pendingChecks.some(
        (check) => !pendingCheckIsAuthorized(check, prepared.singleRequiredPermissionId),
      )
    )
      return {
        reason: `a pending check on the created record ${creation.ordinal} is not authorised`,
      };
    const created: Record<string, JsonValue | null> = { ...calculated.setValues };
    for (const fieldId of calculated.clearFieldIds) created[fieldId] = null;
    if (
      target.recordType.fields.some(
        (field) =>
          (field.type === "link" || field.type === "link_to_one_of_several") &&
          JSON.stringify(created[field.fieldId] ?? null) !==
            JSON.stringify(creation.values[field.fieldId] ?? null),
      )
    )
      return {
        reason: `the created record ${creation.ordinal}'s before-save rules changed a relationship after its targets were locked`,
      };
    values[creation.ordinal] = created;
  }
  return { values };
};

const validateReferenceInputs = async (
  transaction: RequestDatabaseTransaction,
  command: ExecuteNamedActionCommand,
  normalizedInputs: Readonly<Record<string, unknown>>,
): Promise<boolean> => {
  const rows = await transaction.query<ResultRow>`
    select vortex_record.validate_named_action_reference_inputs(
      ${command.action.ownerKind}::text, ${command.action.ownerId}::uuid,
      ${command.action.releaseRevision}::bigint, ${command.action.actionId}::uuid,
      ${command.recordTypeId}::uuid,
      ${JSON.stringify(normalizedInputs)}::text::jsonb
    ) as value
  `;
  return one(rows).value === true;
};

const prepare = async (
  transaction: RequestDatabaseTransaction,
  command: ExecuteNamedActionCommand,
  activityId: string,
  preview: boolean,
): Promise<ActionPreparation> => {
  const rows = preview
    ? await transaction.query<ResultRow>`
        select vortex_record.preview_named_action_set_announce(
          ${command.commandId}::uuid, ${command.action.ownerKind}::text,
          ${command.action.ownerId}::uuid, ${command.action.releaseRevision}::bigint,
          ${command.action.actionId}::uuid, ${command.recordTypeId}::uuid,
          ${command.recordId}::uuid, ${command.expectedConcurrencyNumber}::bigint,
          ${JSON.stringify(command.inputs)}::text::jsonb, ${activityId}::uuid
        ) as value
      `
    : await transaction.query<ResultRow>`
        select vortex_record.prepare_named_action_set_announce(
          ${command.commandId}::uuid, ${command.action.ownerKind}::text,
          ${command.action.ownerId}::uuid, ${command.action.releaseRevision}::bigint,
          ${command.action.actionId}::uuid, ${command.recordTypeId}::uuid,
          ${command.recordId}::uuid, ${command.expectedConcurrencyNumber}::bigint,
          ${JSON.stringify(command.inputs)}::text::jsonb, ${activityId}::uuid
        ) as value
      `;
  return parsePreparation(one(rows).value);
};

const prepareTotals = async (
  transaction: RequestDatabaseTransaction,
  command: ExecuteNamedActionCommand,
  submittedValues: Readonly<Record<string, unknown>>,
  creations: readonly NamedActionCreation[],
  activityId: string,
): Promise<RelationshipTotalPreparationOutcome> => {
  const rows = await transaction.query<ResultRow>`
    select vortex_record.prepare_named_action_command_totals(
      ${command.commandId}::uuid, ${command.recordTypeId}::uuid,
      ${command.recordId}::uuid, ${command.expectedConcurrencyNumber}::bigint,
      ${JSON.stringify(submittedValues)}::text::jsonb,
      ${JSON.stringify(creations)}::text::jsonb,
      ${activityId}::uuid, ${command.action.ownerKind}::text,
      ${command.action.ownerId}::uuid, ${command.action.releaseRevision}::bigint,
      ${command.action.actionId}::uuid
    ) as value
  `;
  return parseRelationshipTotalPreparation(one(rows).value);
};

const refusePrecondition = async (
  transaction: RequestDatabaseTransaction,
  command: ExecuteNamedActionCommand,
  activityId: string,
) => {
  const rows = await transaction.query<ResultRow>`
    select vortex_record.record_named_action_precondition_refusal(
      ${command.action.ownerKind}::text, ${command.action.ownerId}::uuid,
      ${command.action.releaseRevision}::bigint, ${command.action.actionId}::uuid,
      ${command.recordTypeId}::uuid, ${command.recordId}::uuid,
      ${command.expectedConcurrencyNumber}::bigint, ${activityId}::uuid
    ) as value
  `;
  const value = one(rows).value;
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : { outcome: "refused" };
};

type CreationPlan = Readonly<{
  ordinal: number;
  recordTypeId: string;
  values: Readonly<Record<string, JsonValue | null>>;
  finalValues: Readonly<Record<string, JsonValue | null>>;
}>;

/** One subject's complete plan, ready for the writer: everything its attempt decided before writing. */
type PlannedApply = Readonly<{
  kind: "planned";
  state: NamedActionAttemptState;
  correlationId: string;
  composition: NamedActionComposition;
  finalValues: Readonly<Record<string, unknown>>;
  creations: readonly CreationPlan[];
  standardOccurrenceId: string;
  declaredOccurrenceIds: readonly string[];
  creationOccurrenceIds: readonly string[];
  parentMutations: readonly RelationshipTotalParentMutation[];
}>;

/**
 * One subject of the writer call: the subject write, each creation in authored order, the
 * relationship copies, the derived-total updates of the other records the action moves and the
 * declared Event identities, all under the action's own identity so its receipt, fingerprint,
 * field rules, Activity and Events stay the installed action's.
 */
const subjectOf = (plan: PlannedApply) => {
  const { state, composition } = plan;
  return {
    commandId: state.command.commandId,
    recordId: state.command.recordId,
    expectedConcurrencyNumber: state.command.expectedConcurrencyNumber,
    submittedValues: composition.submittedValues,
    mutations: [
      { kind: "set_fields", values: plan.finalValues },
      ...plan.creations.map((creation, index) => ({
        kind: "create_record",
        ordinal: creation.ordinal,
        recordTypeId: creation.recordTypeId,
        values: creation.values,
        finalValues: creation.finalValues,
        occurrenceId: plan.creationOccurrenceIds[index],
      })),
      ...composition.relationshipCopies.map(() => ({ kind: "copy_relationships", values: {} })),
      ...plan.parentMutations.map((parent) => ({
        kind: "set_derived_fields",
        recordTypeId: parent.recordTypeId,
        recordId: parent.recordId,
        expectedConcurrencyNumber: parent.expectedConcurrencyNumber,
        finalValues: parent.finalValues,
      })),
      { kind: "announce_events", occurrenceIds: plan.declaredOccurrenceIds },
    ],
    activityId: state.activityId,
    occurrenceId: plan.standardOccurrenceId,
  };
};

/**
 * The ONE writer call of a named action over one or more subjects of one record type. The
 * database applies the subjects in record identity order; the first refusal comes back with the
 * index of its subject in the order given, and the caller owns the rollback.
 */
const applySubjects = async (
  transaction: RequestDatabaseTransaction,
  plans: readonly PlannedApply[],
): Promise<
  | Readonly<{ kind: "completed"; stored: readonly Record<string, unknown>[] }>
  | Readonly<{ kind: "refused"; index: number; stored: Record<string, unknown> }>
> => {
  const first = plans[0];
  if (first === undefined) throw new Error("NAMED_ACTION_SUBJECTS_EMPTY");
  const command = first.state.command;
  const action = {
    ownerKind: command.action.ownerKind,
    ownerId: command.action.ownerId,
    releaseRevision: command.action.releaseRevision,
    actionId: command.action.actionId,
    inputs: command.inputs,
  };
  const rows = await transaction.query<ResultRow>`
    select vortex_record.apply_action_record_changes(
      ${command.recordTypeId}::uuid, ${JSON.stringify(action)}::text::jsonb,
      ${JSON.stringify(plans.map(subjectOf))}::text::jsonb
    ) as value
  `;
  const value = one(rows).value;
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const isObject = (item: unknown): item is Record<string, unknown> =>
    typeof item === "object" && item !== null && !Array.isArray(item);
  if (
    record?.outcome === "completed" &&
    Array.isArray(record.results) &&
    record.results.length === plans.length &&
    record.results.every(isObject)
  )
    return { kind: "completed", stored: record.results };
  if (
    record?.outcome === "refused" &&
    Number.isInteger(record.index) &&
    (record.index as number) >= 0 &&
    (record.index as number) < plans.length &&
    isObject(record.subject)
  )
    return { kind: "refused", index: record.index as number, stored: record.subject };
  // A refusal of the whole call (its shape) names no subject and wrote nothing.
  if (record?.outcome === "refused" && record.index === undefined && record.subject === undefined)
    return { kind: "refused", index: 0, stored: record };
  // Anything else breaks the writer's contract: throw so whatever it wrote rolls back with it.
  throw new Error("NAMED_ACTION_WRITER_RESULT_INVALID");
};

export type NamedActionRecordPortDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    activityId?: () => string;
    occurrenceId?: () => string;
  }>;

/** What one flow run of a named action composed, or why it could not be composed. */
type FlowComposition =
  | Readonly<{ kind: "composed"; composition: NamedActionComposition }>
  | Readonly<{ kind: "refused"; normalizedInputs: Readonly<Record<string, JsonValue>> }>
  | Readonly<{ kind: "invalid"; reason: string }>;

/**
 * Runs the named action's flow once for the prepared subject and turns what it collected into the
 * composition the database applies. The flow's precondition refusal is its own outcome: the run
 * never reaches a task, and the caller records the refusal as the action always has.
 */
const composeFromFlow = (
  prepared: PreparedNamedAction,
  suppliedInputs: Readonly<Record<string, unknown>>,
  issuedAt: string,
  run: ActionFlowRunner,
): FlowComposition => {
  const normalizedInputs = normalizeActionInputs(prepared.action, suppliedInputs);
  if (normalizedInputs === undefined)
    return {
      kind: "invalid",
      reason: `the supplied inputs (${Object.keys(suppliedInputs).join(", ") || "none"}) do not match the inputs the action declares (${prepared.action.inputs.map((input) => `${input.key}: ${input.type}`).join(", ") || "none"})`,
    };
  const outcome = run(actionFlowSeed(prepared, normalizedInputs, issuedAt));
  if (outcome.kind === "refused") {
    console.error("[named-action] refused NAMED_ACTION_FLOW_REFUSED");
    return { kind: "refused", normalizedInputs };
  }
  if (outcome.kind !== "collected") return { kind: "invalid", reason: outcome.reason };
  const composition = composeFlowEffects(prepared, normalizedInputs, outcome, issuedAt);
  return composition === undefined
    ? {
        kind: "invalid",
        reason: "the tasks the flow collected do not compose into the installed action's tasks",
      }
    : { kind: "composed", composition };
};

/** The identities one named-action command holds across its attempts, and what its last attempt saw. */
type NamedActionAttemptState = {
  readonly command: ExecuteNamedActionCommand;
  readonly activityId: string;
  standardOccurrenceId?: string;
  declaredOccurrenceIds?: readonly string[];
  creationOccurrenceIds?: readonly string[];
  deleteActivityId?: string;
  deleteOccurrenceId?: string;
  /** A failed subject delete discards the whole command, receipt included. */
  deleteSettlement?: Settled<unknown> | undefined;
  /** The database recorded a precondition refusal: the person reads why from this. */
  preconditionRefusal?: Readonly<{ correlationId: string; reason: RuleReason }> | undefined;
  attempted: { rules?: BeforeSaveRuleExecution; executions: BeforeSaveRuleExecution[] };
};

type NamedActionIdentities = Readonly<{ activity: () => string; occurrence: () => string }>;

type AttemptOutcome = ExecuteNamedActionResult | typeof restart | typeof recordedRefusal;

/**
 * The first half of one attempt of one named action inside a transaction the caller owns: the
 * preview, the locked preparation, the flow run, the relationship totals and the before-save
 * rules, up to everything the writer needs. It returns the plan, a result that needs no write (a
 * replay), `restart` when the record moved between the preview and the locked preparation, or
 * `recordedRefusal` when the database recorded the refusal itself.
 */
const planNamedAction = async (
  transaction: RequestDatabaseTransaction,
  issuedAt: string,
  state: NamedActionAttemptState,
  run: ActionFlowRunner,
  ids: NamedActionIdentities,
): Promise<AttemptOutcome | PlannedApply> => {
  const preview = await prepare(transaction, state.command, state.activityId, true);
  if (preview.outcome === "completed") return preview.result;
  if (preview.outcome === "refused_recorded") return recordedRefusal;
  if (preview.outcome === "conflict")
    return preview.correlationId
      ? safeRefusal(
          preview.correlationId,
          "conflict",
          "the subject record's revision moved before the preview",
        )
      : recordedRefusal;
  if (preview.outcome === "permission_refused") {
    const denied = await prepare(transaction, state.command, state.activityId, false);
    return denied.outcome === "refused_recorded"
      ? recordedRefusal
      : "correlationId" in denied && denied.correlationId
        ? safeRefusal(
            denied.correlationId,
            "operation_refused",
            "the action's permission was not granted for the subject record",
          )
        : recordedRefusal;
  }
  if (preview.outcome !== "previewed") {
    const reasonCode = "reasonCode" in preview ? preview.reasonCode : undefined;
    return preview.correlationId
      ? safeRefusal(
          preview.correlationId,
          "operation_refused",
          `the preview was ${preview.outcome}, not previewed (${reasonCode ?? "no reason code"})`,
          preparationReason(reasonCode),
        )
      : recordedRefusal;
  }
  const previewRun = composeFromFlow(preview, state.command.inputs, issuedAt, run);
  if (previewRun.kind === "invalid")
    return safeRefusal(preview.correlationId, "invalid_request", previewRun.reason);
  const previewInputs =
    previewRun.kind === "composed"
      ? previewRun.composition.normalizedInputs
      : previewRun.normalizedInputs;
  if (!(await validateReferenceInputs(transaction, state.command, previewInputs)))
    return safeRefusal(
      preview.correlationId,
      "operation_refused",
      "a record reference input does not name a record the action may use",
    );

  // A refused precondition writes nothing, so it has no totals to prepare.
  const totalPreparation: RelationshipTotalPreparationOutcome =
    previewRun.kind === "composed"
      ? await prepareTotals(
          transaction,
          state.command,
          previewRun.composition.submittedValues,
          previewRun.composition.creations,
          state.activityId,
        )
      : { outcome: "not_required" };
  if (totalPreparation.outcome === "restart") return restart;
  if (totalPreparation.outcome === "refused_recorded") return recordedRefusal;
  if (totalPreparation.outcome === "conflict")
    return safeRefusal(
      preview.correlationId,
      "conflict",
      "the relationship totals preparation found a revision conflict",
    );
  if (totalPreparation.outcome === "refused")
    return safeRefusal(
      preview.correlationId,
      "operation_refused",
      `the relationship totals preparation refused the change (${totalPreparation.reasonCode ?? "no reason code"})`,
    );

  const prepared = await prepare(transaction, state.command, state.activityId, false);
  if (prepared.outcome === "completed") return prepared.result;
  if (prepared.outcome === "refused_recorded") return recordedRefusal;
  if (prepared.outcome === "conflict")
    return prepared.correlationId
      ? safeRefusal(
          prepared.correlationId,
          "conflict",
          "the subject record's revision moved before the locked preparation",
        )
      : recordedRefusal;
  if (prepared.outcome !== "prepared") {
    const reasonCode = "reasonCode" in prepared ? prepared.reasonCode : undefined;
    return prepared.correlationId
      ? safeRefusal(
          prepared.correlationId,
          "operation_refused",
          `the locked preparation was ${prepared.outcome}, not prepared (${reasonCode ?? "no reason code"})`,
          preparationReason(reasonCode),
        )
      : recordedRefusal;
  }
  const preparedRun = composeFromFlow(prepared, state.command.inputs, issuedAt, run);
  if (preparedRun.kind === "invalid")
    return safeRefusal(prepared.correlationId, "invalid_request", preparedRun.reason);
  // The record moved between the preview and the locked preparation: run again.
  if (preparedRun.kind !== previewRun.kind) return restart;
  if (preparedRun.kind === "refused") {
    const refusal = await refusePrecondition(transaction, state.command, state.activityId);
    const reason = preconditionReason(prepared);
    if (refusal.outcome !== "refused_recorded")
      return safeRefusal(
        prepared.correlationId,
        "operation_refused",
        "the action's precondition refused the subject record",
        reason,
      );
    state.preconditionRefusal = { correlationId: prepared.correlationId, reason };
    return recordedRefusal;
  }
  const composition = preparedRun.composition;
  const previewComposition = (previewRun as Extract<FlowComposition, { kind: "composed" }>)
    .composition;
  if (
    JSON.stringify(composition.submittedValues) !==
      JSON.stringify(previewComposition.submittedValues) ||
    JSON.stringify(composition.creations) !== JSON.stringify(previewComposition.creations) ||
    JSON.stringify(composition.relationshipCopies) !==
      JSON.stringify(previewComposition.relationshipCopies) ||
    composition.softDeletesSubject !== previewComposition.softDeletesSubject ||
    JSON.stringify(composition.announcedEventKeys) !==
      JSON.stringify(previewComposition.announcedEventKeys)
  )
    return restart;

  const subjectRuleSet = parseBeforeSaveFlowSet(
    prepared.beforeSaveFlows,
    prepared.recordType.recordTypeId,
  );
  if (subjectRuleSet === undefined)
    return safeRefusal(
      prepared.correlationId,
      "operation_refused",
      "the subject's before-save rules are unavailable",
    );
  const settings = await readOrganizationRuntimeSettings(transaction);
  for (const target of prepared.copyTargets) {
    const execution = beginBeforeSaveRuleExecution(subjectRuleSet);
    const calculated = calculateAndFinalize({
      operation: "update",
      submittedValues: target.submittedValues,
      recordType: prepared.recordType,
      existingValues: target.existingValues,
      issuedAt,
      organizationCurrency: settings?.currency,
      timeZone: settings?.timeZone,
      rules: execution,
    });
    if (!calculated.success)
      return safeRefusal(
        prepared.correlationId,
        "operation_refused",
        `the relationship copy target ${target.recordId} did not calculate: ${describeIssues(calculated.issues)}`,
        ruleReasonFromIssues(calculated.issues),
      );
    if (
      calculated.pendingChecks.some(
        (check) => !pendingCheckIsAuthorized(check, prepared.singleRequiredPermissionId),
      )
    )
      return safeRefusal(
        prepared.correlationId,
        "operation_refused",
        `a pending check on relationship copy target ${target.recordId} is not authorised`,
      );
    if (
      calculated.clearFieldIds.length > 0 ||
      Object.entries(calculated.setValues).some(([fieldId, value]) => {
        const planned = recordLinkValueSchema.safeParse(target.submittedValues[fieldId]);
        const actual = recordLinkValueSchema.safeParse(value);
        return (
          !planned.success ||
          !actual.success ||
          planned.data.recordTypeId.toLowerCase() !== actual.data.recordTypeId.toLowerCase() ||
          planned.data.recordId.toLowerCase() !== actual.data.recordId.toLowerCase()
        );
      })
    )
      return safeRefusal(
        prepared.correlationId,
        "operation_refused",
        `the relationship copy target ${target.recordId}'s rules changed values outside the copy plan`,
      );
  }
  let closureRules: Map<string, BeforeSaveRuleExecution> | undefined;
  if (totalPreparation.outcome === "prepared") {
    closureRules = new Map();
    for (const record of totalPreparation.records) {
      const ruleSet = parseBeforeSaveFlowSet(
        record.beforeSaveFlows,
        record.recordType.recordTypeId,
      );
      if (ruleSet === undefined)
        return safeRefusal(
          prepared.correlationId,
          "operation_refused",
          `the before-save rules for ${record.recordKey} are unavailable`,
        );
      // A create-only action must not acquire a subject write solely
      // from a subject rule effect. Derived subject changes are checked
      // below and refused until their rule evaluation can be ordered.
      if (record.recordKey !== "root" || Object.keys(composition.submittedValues).length > 0) {
        const execution = beginBeforeSaveRuleExecution(ruleSet);
        closureRules.set(record.recordKey, execution);
        if (record.recordKey === "root") state.attempted.executions.push(execution);
      }
    }
  } else if (Object.keys(composition.submittedValues).length > 0) {
    state.attempted.rules = beginBeforeSaveRuleExecution(subjectRuleSet);
    state.attempted.executions.push(state.attempted.rules);
  }

  let finalValues: Record<string, unknown> = {};
  let parentMutations: readonly RelationshipTotalParentMutation[] = [];
  let creations: readonly Readonly<{
    ordinal: number;
    recordTypeId: string;
    values: Readonly<Record<string, JsonValue | null>>;
    finalValues: Readonly<Record<string, JsonValue | null>>;
  }>[] = [];
  // Read unconditionally: even an action with no record.set_fields task and
  // no creation can still leave a stale due row in place unless its
  // deadline transition is re-derived from the record's unchanged
  // existing values below.
  if (Object.keys(composition.submittedValues).length > 0 || composition.creations.length > 0) {
    const saveCommand = saveRecordCommandSchema.parse({
      contractVersion: "2.0.0",
      commandId: state.command.commandId,
      operation: "update",
      recordTypeId: state.command.recordTypeId,
      recordId: state.command.recordId,
      expectedConcurrencyNumber: state.command.expectedConcurrencyNumber,
      submittedValues: composition.submittedValues,
    });
    const root =
      totalPreparation.outcome === "prepared"
        ? totalPreparation.records.find((record) => record.recordKey === "root")
        : undefined;
    const clock =
      totalPreparation.outcome === "prepared"
        ? operationClock(
            totalPreparation.records.map((record) => record.recordType),
            issuedAt,
            settings?.timeZone,
          )
        : undefined;
    const calculated =
      totalPreparation.outcome === "prepared" && clock !== undefined
        ? calculateLockedRelationshipTotalSave({
            command: saveCommand,
            preparation: totalPreparation,
            creations: composition.creations,
            ...(settings?.currency ? { organizationCurrency: settings.currency } : {}),
            clock,
            ...(closureRules === undefined ? {} : { rules: closureRules }),
          })
        : totalPreparation.outcome === "prepared"
          ? { success: false as const, issues: [] }
          : calculateAndFinalize({
              operation: saveCommand.operation,
              submittedValues: saveCommand.submittedValues,
              recordType: prepared.recordType,
              existingValues: prepared.existingValues,
              issuedAt,
              organizationCurrency: settings?.currency,
              timeZone: settings?.timeZone,
              rules: state.attempted.rules,
            });
    if (!calculated.success)
      return safeRefusal(
        prepared.correlationId,
        "operation_refused",
        totalPreparation.outcome === "prepared" && clock === undefined
          ? "the relationship totals have no operation clock for the records' time zone"
          : `the subject values the action writes did not calculate: ${describeIssues(calculated.issues)}`,
        ruleReasonFromIssues(
          calculated.issues,
          totalPreparation.outcome === "prepared" ? totalPreparation : undefined,
        ),
      );
    if (totalPreparation.outcome === "prepared" && root === undefined)
      return safeRefusal(
        prepared.correlationId,
        "operation_refused",
        "the prepared relationship totals hold no root record for the subject",
      );
    if (
      calculated.pendingChecks.some(
        (check) => !pendingCheckIsAuthorized(check, prepared.singleRequiredPermissionId),
      )
    )
      return safeRefusal(
        prepared.correlationId,
        "operation_refused",
        "a pending check on the subject values is not authorised",
      );
    if (
      "creationPendingChecks" in calculated &&
      Object.values(calculated.creationPendingChecks).some((checks) =>
        checks.some(
          (check) => !pendingCheckIsAuthorized(check, prepared.singleRequiredPermissionId),
        ),
      )
    ) {
      return safeRefusal(
        prepared.correlationId,
        "operation_refused",
        "a pending check on a created record is not authorised",
      );
    }
    finalValues =
      "sourceFinalValues" in calculated
        ? { ...calculated.sourceFinalValues }
        : { ...calculated.setValues };
    if ("clearFieldIds" in calculated)
      for (const fieldId of calculated.clearFieldIds) finalValues[fieldId] = null;
    if ("parentMutations" in calculated) parentMutations = calculated.parentMutations;
    // The merged closure recomputes every derived subject field. An
    // action with no record.set_fields task may therefore still carry a
    // changed total; one whose derived values are unchanged must not
    // fabricate a subject write, a revision bump or an occurrence.
    if (Object.keys(composition.submittedValues).length === 0)
      finalValues = Object.fromEntries(
        Object.entries(finalValues).filter(
          ([fieldId, value]) =>
            JSON.stringify(value ?? null) !==
            JSON.stringify(prepared.existingValues[fieldId] ?? null),
        ),
      );
    if (
      totalPreparation.outcome === "prepared" &&
      Object.keys(composition.submittedValues).length === 0 &&
      Object.keys(finalValues).length > 0 &&
      subjectRuleSet.flows.length > 0
    )
      return safeRefusal(
        prepared.correlationId,
        "operation_refused",
        "the created records changed derived subject values that require its before-save flows",
      );
    const createdFinalValues =
      "creationFinalValues" in calculated
        ? { values: calculated.creationFinalValues }
        : creationFinalValues(
            prepared,
            composition.creations,
            issuedAt,
            settings?.currency,
            settings?.timeZone,
          );
    if ("reason" in createdFinalValues)
      return safeRefusal(
        prepared.correlationId,
        "operation_refused",
        createdFinalValues.reason,
        createdFinalValues.ruleReason,
      );
    // `values` stays the composed authored field map, which the
    // database re-derives from the installed action; `finalValues`
    // adds the generated fields the evaluator produced, exactly as
    // the subject's submitted/final split works.
    creations = composition.creations.map((creation) => ({
      ordinal: creation.ordinal,
      recordTypeId: creation.recordTypeId,
      values: creation.values,
      finalValues: createdFinalValues.values[creation.ordinal] ?? creation.values,
    }));
    // A dependent link holds only a record of its parent's choice, exactly as a record save
    // judges it: the subject's changed pair and every created record's pair.
    const targets = new Map(prepared.createTargets.map((target) => [target.ordinal, target]));
    const judged = [
      {
        name: "the subject",
        recordType: prepared.recordType,
        existing: prepared.existingValues,
        submitted: Object.keys(composition.submittedValues),
        final: finalValues,
      },
      ...creations.flatMap((creation) => {
        const target = targets.get(creation.ordinal);
        return target === undefined
          ? []
          : [
              {
                name: `the created record ${creation.ordinal}`,
                recordType: target.recordType,
                existing: {},
                submitted: Object.keys(creation.finalValues),
                final: creation.finalValues,
              },
            ];
      }),
    ];
    for (const record of judged) {
      if (record.recordType.systemProjection !== undefined) continue;
      const dependency = await firstFieldDependencyRefusal(
        transaction,
        record.recordType,
        record.existing,
        record.submitted,
        record.final,
      );
      if (dependency !== undefined)
        return safeRefusal(
          prepared.correlationId,
          "operation_refused",
          `${record.name} would hold field ${dependency.childFieldId} that does not belong to its parent ${dependency.parentFieldId} (FIELD_DEPENDENCY_${dependency.reason.toUpperCase()})`,
        );
    }
  }
  try {
    state.standardOccurrenceId ??= eventOccurrenceIdSchema.parse(ids.occurrence());
    state.declaredOccurrenceIds ??= Array.from({ length: prepared.eventDescriptorCount }, () =>
      eventOccurrenceIdSchema.parse(ids.occurrence()),
    );
    state.creationOccurrenceIds ??= Array.from({ length: creations.length }, () =>
      eventOccurrenceIdSchema.parse(ids.occurrence()),
    );
  } catch {
    throw new Error("NAMED_ACTION_OCCURRENCE_ID_INVALID");
  }
  if (state.creationOccurrenceIds.length !== creations.length) return restart;
  return {
    kind: "planned",
    state,
    correlationId: prepared.correlationId,
    composition,
    finalValues,
    creations,
    standardOccurrenceId: state.standardOccurrenceId,
    declaredOccurrenceIds: state.declaredOccurrenceIds,
    creationOccurrenceIds: state.creationOccurrenceIds,
    parentMutations,
  };
};

/**
 * The second half of one attempt: reads what the writer stored for the subject, then runs the
 * subject's protected delete when the action deletes it. Any refusal of that delete throws so the
 * receipt, Activity and Events roll back with it.
 */
const finishNamedAction = async (
  transaction: RequestDatabaseTransaction,
  issuedAt: string,
  plan: PlannedApply,
  stored: Record<string, unknown>,
  ids: NamedActionIdentities,
): Promise<AttemptOutcome> => {
  const { state, composition, correlationId } = plan;
  if (stored.outcome === "restart") return restart;
  if (stored.outcome === "refused_recorded") return recordedRefusal;
  if (stored.outcome === "conflict")
    return safeRefusal(
      correlationId,
      "conflict",
      "the record changes were refused for a revision conflict",
    );
  if (stored.outcome !== "saved" && stored.outcome !== "completed")
    return safeRefusal(
      correlationId,
      stored.reasonCode === "command_invalid" ? "invalid_request" : "operation_refused",
      `the record changes were ${String(stored.outcome)} (${String(stored.reasonCode ?? "no reason code")})`,
    );
  const storedResult = completedResult(stored);
  // A writer replay means this command already completed, its delete
  // included, so the subject is never deleted a second time.
  if (storedResult === undefined || !composition.softDeletesSubject || stored.replayed === true)
    return storedResult ?? recordedRefusal;

  // The subject delete is the shared protected lifecycle delete, run
  // last in this same transaction against the revision the action
  // left the subject at: the action's own tasks write nothing to a
  // subject it deletes. It carries an identity derived from the action's command and
  // its own Activity and `deleted` Event identities, and any refusal
  // throws so the receipt, Activity and Events roll back with it.
  try {
    state.deleteActivityId ??= activityIdSchema.parse(ids.activity());
    state.deleteOccurrenceId ??= eventOccurrenceIdSchema.parse(ids.occurrence());
  } catch {
    throw new Error("NAMED_ACTION_OCCURRENCE_ID_INVALID");
  }
  try {
    const deleted = await performProtectedRecordDelete(transaction, issuedAt, {
      commandId: deleteLifecycleCommandId(state.command.commandId),
      recordTypeId: state.command.recordTypeId,
      recordId: state.command.recordId,
      expectedConcurrencyNumber: state.command.expectedConcurrencyNumber,
      activityId: state.deleteActivityId,
      occurrenceId: state.deleteOccurrenceId,
    });
    const deletedResult =
      deleted.outcome === "deleted" && !deleted.replayed
        ? completedResult({
            recordId: deleted.recordId,
            concurrencyNumber: deleted.concurrencyNumber,
            // A deleted subject exposes no values.
            values: {},
            correlationId: deleted.correlationId,
            backgroundDelivery: "pending",
          })
        : undefined;
    if (deletedResult === undefined) throw new Error("NAMED_ACTION_DELETE_RESULT_INVALID");
    return deletedResult;
  } catch (error) {
    state.deleteSettlement = settleRecordLifecycleError(error);
    throw error;
  }
};

const isPlanned = (outcome: AttemptOutcome | PlannedApply): outcome is PlannedApply =>
  typeof outcome === "object" && "kind" in outcome && outcome.kind === "planned";

const recordKey = (recordTypeId: string, recordId: string) =>
  `${recordTypeId.toLowerCase()}:${recordId.toLowerCase()}`;

/** The records one planned subject writes: the subject itself and the related records it moves. */
const writtenKeys = (plan: PlannedApply): readonly string[] => [
  recordKey(plan.state.command.recordTypeId, plan.state.command.recordId),
  ...plan.parentMutations.map((parent) => recordKey(parent.recordTypeId, parent.recordId)),
];

type AttemptStop = Readonly<{ kind: "stopped"; index: number; outcome: AttemptOutcome }>;

/**
 * One attempt of one named action over one or more subjects inside a transaction the caller owns.
 * Every subject is planned in record identity order (the same order the writer applies them in,
 * so overlapping runs lock rows alike), then ONE writer call applies all of them, then each
 * finishes. A plan reads the revisions as they stand, so a subject that writes a record an earlier
 * planned subject also writes (a shared related record's totals) first sends the planned subjects
 * to the writer and is then planned again against what they wrote. It stops at the first subject
 * that does not complete and reports its index in the order given; `outcomes` holds the finished
 * subjects in the order given.
 */
const attemptNamedActions = async (
  transaction: RequestDatabaseTransaction,
  issuedAt: string,
  states: readonly NamedActionAttemptState[],
  run: ActionFlowRunner,
  ids: NamedActionIdentities,
): Promise<
  Readonly<{ kind: "completed"; outcomes: readonly ExecuteNamedActionResult[] }> | AttemptStop
> => {
  const order = states
    .map((state, index) => ({ state, index }))
    .sort((left, right) => {
      const l = left.state.command.recordId.toLowerCase();
      const r = right.state.command.recordId.toLowerCase();
      return l < r ? -1 : l > r ? 1 : 0;
    });
  const outcomes: ExecuteNamedActionResult[] = [];
  let planned: Array<{ index: number; plan: PlannedApply }> = [];
  let written = new Set<string>();
  const write = async (): Promise<AttemptStop | undefined> => {
    if (planned.length === 0) return undefined;
    const batch = planned;
    planned = [];
    written = new Set();
    const applied = await applySubjects(
      transaction,
      batch.map((item) => item.plan),
    );
    const finishing =
      applied.kind === "completed"
        ? batch.map((item, position) => ({ ...item, stored: applied.stored[position]! }))
        : [{ ...batch[applied.index]!, stored: applied.stored }];
    for (const { index, plan, stored } of finishing) {
      const outcome = await finishNamedAction(transaction, issuedAt, plan, stored, ids);
      if (outcome === restart || outcome === recordedRefusal || outcome.outcome !== "completed")
        return { kind: "stopped", index, outcome };
      outcomes[index] = outcome;
    }
    if (applied.kind === "refused") throw new Error("NAMED_ACTION_WRITER_REFUSAL_UNHANDLED");
    return undefined;
  };
  for (const { state, index } of order) {
    let outcome = await planNamedAction(transaction, issuedAt, state, run, ids);
    if (isPlanned(outcome) && writtenKeys(outcome).some((key) => written.has(key))) {
      const stopped = await write();
      if (stopped !== undefined) return stopped;
      state.attempted = { executions: [] };
      outcome = await planNamedAction(transaction, issuedAt, state, run, ids);
    }
    if (!isPlanned(outcome)) {
      if (outcome === restart || outcome === recordedRefusal || outcome.outcome !== "completed")
        return { kind: "stopped", index, outcome };
      outcomes[index] = outcome;
      continue;
    }
    for (const key of writtenKeys(outcome)) written.add(key);
    planned.push({ index, plan: outcome });
  }
  const stopped = await write();
  return stopped ?? { kind: "completed", outcomes };
};

/** One parsed command's attempt state, with fresh per-attempt rule executions. */
const attemptStateOf = (
  command: ExecuteNamedActionCommand,
  activityId: string,
): NamedActionAttemptState => ({ command, activityId, attempted: { executions: [] } });

/** The refusal of a subject delete that settled with a result, as the person sees it. */
const deleteRefusal = (
  settlement: Extract<Settled<unknown>, { kind: "result" }>,
): ExecuteNamedActionResult => {
  const refused = settlement.value as RecordDeleteResult;
  return safeRefusal(
    refused.correlationId,
    refused.outcome === "conflict" ? "conflict" : "operation_refused",
    `the subject delete was ${refused.outcome}`,
    refused.outcome === "refused" ? refused.ruleReason : undefined,
  );
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

/** The most records one transaction of a named action changes. */
export const namedActionBatchMaximum = 200;

/**
 * The record port of the flow runner for named actions. The runner has already resolved the
 * exact release's action flow, checked its invocation permission and supplied the flow run; this
 * port owns what needs the database: the action's preparation and permission decision, the typed
 * inputs, the relationship totals, the before-save rules, and the one apply record changes call that
 * writes every task of the action in one transaction, receipt, Activity and Events included.
 */
export const createNamedActionRecordPort = (dependencies: NamedActionRecordPortDependencies) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const ids: NamedActionIdentities = {
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
  const newActivityId = (): string | undefined => {
    try {
      return activityIdSchema.parse(ids.activity());
    } catch (error) {
      console.error(`[named-action] identity generation failed: ${describeFailure(error)}`);
      return undefined;
    }
  };
  return Object.freeze({
    async execute(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
      run: ActionFlowRunner,
    ): Promise<NamedActionServiceResult> {
      const command = parsedCommand(commandCandidate);
      if (command === undefined) return { kind: "unavailable" };
      if (selection.applicationRootId === undefined) {
        console.error("[named-action] refused NAMED_ACTION_APPLICATION_NOT_SELECTED");
        return { kind: "unavailable" };
      }
      const activityId = newActivityId();
      if (activityId === undefined) return { kind: "temporarily_unavailable" };
      const state = attemptStateOf(command, activityId);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        state.deleteSettlement = undefined;
        state.preconditionRefusal = undefined;
        state.attempted = { executions: [] };
        const result = await requests.runChange(
          session,
          selection,
          async (transaction, _scope, issuedAt): Promise<AttemptOutcome> => {
            const attempt = await attemptNamedActions(transaction, issuedAt, [state], run, ids);
            return attempt.kind === "completed" ? attempt.outcomes[0]! : attempt.outcome;
          },
        );
        // The attempt sets the settlement inside the transaction, after this loop cleared it.
        const settlement = state.deleteSettlement as Settled<unknown> | undefined;
        if (settlement?.kind === "restart") continue;
        if (settlement?.kind === "result")
          return { kind: "available", value: deleteRefusal(settlement) };
        if (result.kind !== "available") return result;
        if (result.value === restart) continue;
        if (result.value === recordedRefusal) {
          const refused =
            state.preconditionRefusal as NamedActionAttemptState["preconditionRefusal"];
          if (refused !== undefined)
            return {
              kind: "available",
              value: safeRefusal(
                refused.correlationId,
                "operation_refused",
                "the action's precondition refused the subject record (refusal recorded)",
                refused.reason,
              ),
            };
          console.error("[named-action] refused NAMED_ACTION_REFUSAL_RECORDED");
          return { kind: "unavailable" };
        }
        const value = result.value as ExecuteNamedActionResult;
        return value.outcome === "completed" &&
          state.attempted.executions.some((execution) => execution.warnings.length > 0)
          ? {
              kind: "available",
              value,
              warnings: state.attempted.executions.flatMap((execution) => execution.warnings),
            }
          : { kind: "available", value };
      }
      return { kind: "temporarily_unavailable" };
    },

    /**
     * Runs one named action over several records in ONE transaction and one writer call (more
     * only when selected records share a related record whose totals they move): each record's own
     * receipt, revision check, Activity and Events, in record identity order. Every record completes or
     * none does: the first refusal rolls the whole batch back and names the record. A command id
     * that already completed replays its result without writing again.
     */
    async executeMany(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidates: readonly unknown[],
      run: ActionFlowRunner,
    ): Promise<NamedActionBatchResult> {
      if (commandCandidates.length === 0 || commandCandidates.length > namedActionBatchMaximum)
        return { kind: "unavailable" };
      if (selection.applicationRootId === undefined) return { kind: "unavailable" };
      const states: NamedActionAttemptState[] = [];
      for (const candidate of commandCandidates) {
        const command = parsedCommand(candidate);
        const activityId = command === undefined ? undefined : newActivityId();
        if (command === undefined || activityId === undefined) return { kind: "unavailable" };
        states.push(attemptStateOf(command, activityId));
      }
      // One writer call serves one record type and one action; the first command names them.
      const head = states[0]!.command;
      if (
        states.some(
          (state) =>
            state.command.recordTypeId.toLowerCase() !== head.recordTypeId.toLowerCase() ||
            JSON.stringify(state.command.action) !== JSON.stringify(head.action) ||
            JSON.stringify(state.command.inputs) !== JSON.stringify(head.inputs),
        )
      ) {
        console.error("[named-action] refused NAMED_ACTION_BATCH_MIXED");
        return { kind: "unavailable" };
      }
      const rollback = new Error("NAMED_ACTION_BATCH_ROLLED_BACK");
      let refused:
        Readonly<{ index: number; result: ExecuteNamedActionResult | undefined }> | undefined;
      let restarted = false;
      for (const state of states) {
        state.deleteSettlement = undefined;
        state.attempted = { executions: [] };
      }
      const result = await requests.runChange(
        session,
        selection,
        async (transaction, _scope, issuedAt) => {
          const attempt = await attemptNamedActions(transaction, issuedAt, states, run, ids);
          if (attempt.kind === "completed") return attempt.outcomes;
          // A record that moved, or refused, throws through the transaction so every record
          // of the batch rolls back with it.
          if (attempt.outcome === restart) {
            restarted = true;
            throw rollback;
          }
          refused = {
            index: attempt.index,
            result: attempt.outcome === recordedRefusal ? undefined : attempt.outcome,
          };
          throw rollback;
        },
      );
      const settled = states.findIndex((state) => state.deleteSettlement !== undefined);
      const settlement =
        settled === -1
          ? undefined
          : (states[settled]?.deleteSettlement as Settled<unknown> | undefined);
      if (settlement?.kind === "restart" || restarted) return { kind: "temporarily_unavailable" };
      if (settlement?.kind === "result")
        return { kind: "refused", index: settled, result: deleteRefusal(settlement) };
      if (refused !== undefined) return { kind: "refused", ...refused };
      if (result.kind !== "available") return result;
      return {
        kind: "completed",
        results: result.value,
        warnings: states.flatMap((state) =>
          state.attempted.executions.flatMap((execution) =>
            execution.warnings.map((warning) => ({
              ...warning,
              recordId: state.command.recordId,
            })),
          ),
        ),
      };
    },
  });
};
