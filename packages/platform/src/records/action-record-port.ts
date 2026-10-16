import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  describeFailure,
  actionDefinitionSchema,
  activityIdSchema,
  eventOccurrenceIdSchema,
  executeNamedActionCommandSchema,
  executeNamedActionResultSchema,
  moduleValidationContractVersion,
  permissionIdSchema,
  recordLinkValueSchema,
  recordTypeDefinitionSchema,
  saveRecordCommandSchema,
  type ExecuteNamedActionCommand,
  type ExecuteNamedActionResult,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
} from "../schema";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "../access/index";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
import type { ActionFlowRunner, BeforeSaveRuleWarning } from "../rules/index";
import {
  actionFlowSeed,
  composeFlowEffects,
  normalizeActionInputs,
  type NamedActionComposition,
  type NamedActionCreateTarget,
  type NamedActionCreation,
  type PreparedNamedAction,
} from "./action-flow-effects";
import {
  beginBeforeSaveRuleExecution,
  parseBeforeSaveRuleSet,
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
  revision,
  type RelationshipTotalPreparationOutcome,
} from "./save-record";
import { calculateAndFinalize, operationClock } from "./field-candidate";

type ResultRow = DatabaseRow & { readonly value: unknown };
type RuleReason = Readonly<{ code: string; message: string }>;

type PreparedAction = PreparedNamedAction &
  Readonly<{
    outcome: "prepared" | "previewed";
    readableFieldIds: ReadonlySet<string>;
    changeableFieldIds: ReadonlySet<string>;
    eventDescriptorCount: number;
    correlationId: string;
    singleRequiredPermissionId?: string;
    /** The exact release's compiled before-save rules for the subject, unparsed. */
    beforeSaveRules?: unknown;
    copyTargets: readonly Readonly<{
      recordId: string;
      existingValues: Readonly<Record<string, unknown>>;
      submittedValues: Readonly<Record<string, unknown>>;
    }>[];
  }>;

/**
 * The named-action result plus any before-save rule warnings of a completed
 * attempt. The closed result contract has no warning field, so they travel beside it.
 */
export type NamedActionServiceResult = HumanOrganizationRequestResult<ExecuteNamedActionResult> &
  Readonly<{ warnings?: readonly BeforeSaveRuleWarning[] }>;

type ActionPreparation =
  | PreparedAction
  | Readonly<{ outcome: "completed"; result: ExecuteNamedActionResult }>
  | Readonly<{
      outcome: "conflict" | "permission_refused" | "refused" | "refused_recorded" | "unsupported";
      correlationId?: string;
      reasonCode?: string;
    }>;

const restart = Symbol("restartNamedAction");
const recordedRefusal = Symbol("recordedNamedActionRefusal");

const one = <Row>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("NAMED_ACTION_RESULT_INVALID");
  return rows[0];
};

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

const completedResult = (candidate: Record<string, unknown>) => {
  const parsedRevision = revision(candidate.concurrencyNumber);
  if (parsedRevision === undefined) return undefined;
  const result = executeNamedActionResultSchema.safeParse({
    contractVersion: "2.0.0",
    outcome: "completed",
    recordId: candidate.recordId,
    concurrencyNumber: parsedRevision,
    readableValues: candidate.values,
    correlationId: candidate.correlationId,
    backgroundDelivery: candidate.backgroundDelivery,
  });
  return result.success ? result.data : undefined;
};

const parseCreateTargets = (candidate: unknown): readonly NamedActionCreateTarget[] | undefined => {
  if (!Array.isArray(candidate)) return undefined;
  const targets: NamedActionCreateTarget[] = [];
  for (const entry of candidate) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const value = entry as Record<string, unknown>;
    const recordType = recordTypeDefinitionSchema.safeParse(value.recordType);
    if (
      !recordType.success ||
      recordType.data.systemProjection !== undefined ||
      typeof value.ordinal !== "number" ||
      !Number.isSafeInteger(value.ordinal) ||
      value.ordinal < 0 ||
      typeof value.recordTypeId !== "string" ||
      value.recordTypeId.toLowerCase() !== recordType.data.recordTypeId.toLowerCase()
    )
      return undefined;
    targets.push({
      ordinal: value.ordinal,
      recordTypeId: recordType.data.recordTypeId,
      recordType: recordType.data,
      beforeSaveRules: value.beforeSaveRules,
    });
  }
  return targets.every(
    (target, index) => index === 0 || target.ordinal > targets[index - 1]!.ordinal,
  )
    ? targets
    : undefined;
};

const parseCopyTargets = (candidate: unknown, recordType: PreparedNamedAction["recordType"]) => {
  if (!Array.isArray(candidate)) return undefined;
  const targets: Array<{
    recordId: string;
    existingValues: Record<string, unknown>;
    submittedValues: Record<string, unknown>;
  }> = [];
  const fieldIds = new Set(recordType.fields.map((field) => field.fieldId.toLowerCase()));
  for (const entry of candidate) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const value = entry as Record<string, unknown>;
    if (
      typeof value.recordId !== "string" ||
      typeof value.existingValues !== "object" ||
      value.existingValues === null ||
      Array.isArray(value.existingValues) ||
      typeof value.submittedValues !== "object" ||
      value.submittedValues === null ||
      Array.isArray(value.submittedValues)
    )
      return undefined;
    const recordId = value.recordId;
    const existingValues = { ...(value.existingValues as Record<string, unknown>) };
    const submittedValues = value.submittedValues as Record<string, unknown>;
    if (
      Object.keys(submittedValues).length === 0 ||
      Object.keys(submittedValues).some((fieldId) => !fieldIds.has(fieldId.toLowerCase())) ||
      targets.some((target) => target.recordId.toLowerCase() === recordId.toLowerCase())
    )
      return undefined;
    for (const field of recordType.fields) {
      if (
        !field.required &&
        field.type !== "reference_number" &&
        field.type !== "calculation" &&
        field.type !== "total" &&
        existingValues[field.fieldId] === null
      )
        delete existingValues[field.fieldId];
    }
    targets.push({ recordId, existingValues, submittedValues });
  }
  return targets;
};

const parsePreparation = (candidate: unknown): ActionPreparation => {
  if (typeof candidate !== "object" || candidate === null) return { outcome: "refused" };
  const value = candidate as Record<string, unknown>;
  const correlationId = typeof value.correlationId === "string" ? value.correlationId : undefined;
  if (value.outcome === "completed") {
    const result = completedResult(value);
    return result === undefined
      ? { outcome: "refused", ...(correlationId ? { correlationId } : {}) }
      : { outcome: "completed", result };
  }
  if (
    value.outcome === "conflict" ||
    value.outcome === "permission_refused" ||
    value.outcome === "refused" ||
    value.outcome === "refused_recorded" ||
    value.outcome === "unsupported"
  )
    return {
      outcome: value.outcome,
      ...(correlationId ? { correlationId } : {}),
      ...(typeof value.reasonCode === "string" ? { reasonCode: value.reasonCode } : {}),
    };
  if (value.outcome !== "prepared" && value.outcome !== "previewed")
    return { outcome: "refused", ...(correlationId ? { correlationId } : {}) };
  const singleRequiredPermissionId =
    value.singleRequiredPermissionId === null || value.singleRequiredPermissionId === undefined
      ? undefined
      : permissionIdSchema.safeParse(value.singleRequiredPermissionId);
  if (singleRequiredPermissionId !== undefined && !singleRequiredPermissionId.success)
    return { outcome: "refused", ...(correlationId ? { correlationId } : {}) };
  const action = actionDefinitionSchema.safeParse(value.action);
  const recordType = recordTypeDefinitionSchema.safeParse(value.recordType);
  const createTargets = parseCreateTargets(value.createTargets);
  const copyTargets = recordType.success
    ? parseCopyTargets(value.copyTargets, recordType.data)
    : undefined;
  // An action that targets a registered protected operation, and every action of a system
  // projection record type, runs through that operation's owning service, never through ordered
  // record tasks.
  if (
    !action.success ||
    action.data.protectedOperation !== undefined ||
    !recordType.success ||
    recordType.data.systemProjection !== undefined ||
    createTargets === undefined ||
    copyTargets === undefined ||
    value.validationContractVersion !== moduleValidationContractVersion ||
    typeof value.recordId !== "string" ||
    typeof value.existingValues !== "object" ||
    value.existingValues === null ||
    Array.isArray(value.existingValues) ||
    typeof value.actorOrganizationAccountId !== "string" ||
    !Array.isArray(value.readableFieldIds) ||
    !Array.isArray(value.changeableFieldIds) ||
    !Array.isArray(value.eventDescriptors) ||
    correlationId === undefined
  )
    return { outcome: "refused", ...(correlationId ? { correlationId } : {}) };
  // Ordinary storage reads represent unset optional columns as null. The field
  // candidate treats absence as unset, as the base save preparation does.
  const existingValues = { ...(value.existingValues as Record<string, unknown>) };
  for (const field of recordType.data.fields) {
    if (
      !field.required &&
      field.type !== "reference_number" &&
      field.type !== "calculation" &&
      field.type !== "total" &&
      existingValues[field.fieldId] === null
    )
      delete existingValues[field.fieldId];
  }
  return {
    outcome: value.outcome,
    validationContractVersion: moduleValidationContractVersion,
    action: action.data,
    recordType: recordType.data,
    recordId: value.recordId,
    existingValues,
    actorOrganizationAccountId: value.actorOrganizationAccountId,
    createTargets,
    copyTargets,
    readableFieldIds: new Set(
      value.readableFieldIds.filter((item): item is string => typeof item === "string"),
    ),
    changeableFieldIds: new Set(
      value.changeableFieldIds.filter((item): item is string => typeof item === "string"),
    ),
    eventDescriptorCount: value.eventDescriptors.length,
    correlationId,
    ...(singleRequiredPermissionId === undefined
      ? {}
      : { singleRequiredPermissionId: singleRequiredPermissionId.data }),
    ...(value.beforeSaveRules === undefined ? {} : { beforeSaveRules: value.beforeSaveRules }),
  };
};

const pendingCheckIsAuthorized = (
  check: RecordFieldValuePendingCheck,
  singleRequiredPermissionId: string | undefined,
  actorOrganizationAccountId: string,
): boolean =>
  check.kind === "record_reference" ||
  (check.kind === "person_reference" &&
    check.organizationAccountId.toLowerCase() === actorOrganizationAccountId.toLowerCase()) ||
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
      (issue.code === "before_save_rule_refused" || issue.code === "required_field_missing"),
  );
  if (issue?.requirement === undefined) return undefined;
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
    const ruleSet = parseBeforeSaveRuleSet(target.beforeSaveRules, target.recordTypeId);
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
        (check) =>
          !pendingCheckIsAuthorized(
            check,
            prepared.singleRequiredPermissionId,
            prepared.actorOrganizationAccountId,
          ),
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
  await transaction.query`set local role vortex_runtime`;
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

/**
 * The one record-change call of a named action: the subject write, each creation in authored order,
 * the relationship copies, the derived-total updates of the other records the action moves and the
 * declared Event identities, all under the action's own identity so its receipt, fingerprint, field
 * rules, Activity and Events stay the installed action's.
 */
const applyChanges = async (
  transaction: RequestDatabaseTransaction,
  command: ExecuteNamedActionCommand,
  composition: NamedActionComposition,
  finalValues: Readonly<Record<string, unknown>>,
  creations: readonly Readonly<{
    ordinal: number;
    recordTypeId: string;
    values: Readonly<Record<string, JsonValue | null>>;
    finalValues: Readonly<Record<string, JsonValue | null>>;
  }>[],
  activityId: string,
  standardOccurrenceId: string,
  declaredOccurrenceIds: readonly string[],
  creationOccurrenceIds: readonly string[],
  parentMutations: readonly RelationshipTotalParentMutation[],
) => {
  const mutations = [
    { kind: "set_fields", values: finalValues },
    ...creations.map((creation, index) => ({
      kind: "create_record",
      ordinal: creation.ordinal,
      recordTypeId: creation.recordTypeId,
      values: creation.values,
      finalValues: creation.finalValues,
      occurrenceId: creationOccurrenceIds[index],
    })),
    ...composition.relationshipCopies.map(() => ({ kind: "copy_relationships", values: {} })),
    ...parentMutations.map((parent) => ({
      kind: "set_derived_fields",
      recordTypeId: parent.recordTypeId,
      recordId: parent.recordId,
      expectedConcurrencyNumber: parent.expectedConcurrencyNumber,
      finalValues: parent.finalValues,
    })),
    { kind: "announce_events", occurrenceIds: declaredOccurrenceIds },
  ];
  const action = {
    ownerKind: command.action.ownerKind,
    ownerId: command.action.ownerId,
    releaseRevision: command.action.releaseRevision,
    actionId: command.action.actionId,
    inputs: command.inputs,
  };
  const rows = await transaction.query<ResultRow>`
    select vortex_record.apply_action_record_changes(
      ${command.commandId}::uuid, 'update'::text, ${command.recordTypeId}::uuid,
      ${command.recordId}::uuid, ${command.expectedConcurrencyNumber}::bigint,
      ${JSON.stringify(composition.submittedValues)}::text::jsonb,
      ${JSON.stringify(mutations)}::text::jsonb,
      ${activityId}::uuid, ${standardOccurrenceId}::uuid,
      ${JSON.stringify(action)}::text::jsonb
    ) as value
  `;
  const value = one(rows).value;
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : { outcome: "refused" };
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

/**
 * The record port of the flow runner for named actions (#1063). The runner has already resolved the
 * exact release's action flow, checked its invocation permission and supplied the flow run; this
 * port owns what needs the database: the action's preparation and permission decision, the typed
 * inputs, the relationship totals, the before-save rules, and the one apply record changes call that
 * writes every task of the action in one transaction, receipt, Activity and Events included.
 */
export const createNamedActionRecordPort = (dependencies: NamedActionRecordPortDependencies) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const newActivityId = dependencies.activityId ?? randomUUID;
  const newOccurrenceId = dependencies.occurrenceId ?? randomUUID;
  return Object.freeze({
    async execute(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
      run: ActionFlowRunner,
    ): Promise<NamedActionServiceResult> {
      const command = executeNamedActionCommandSchema.safeParse(commandCandidate);
      if (!command.success) {
        console.error(
          `[named-action] refused NAMED_ACTION_COMMAND_INVALID: ${describeFailure(command.error)}`,
        );
        return { kind: "unavailable" };
      }
      if (selection.applicationRootId === undefined) {
        console.error("[named-action] refused NAMED_ACTION_APPLICATION_NOT_SELECTED");
        return { kind: "unavailable" };
      }
      let activityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch (error) {
        console.error(`[named-action] identity generation failed: ${describeFailure(error)}`);
        return { kind: "temporarily_unavailable" };
      }
      let standardOccurrenceId: string | undefined;
      let declaredOccurrenceIds: readonly string[] | undefined;
      let creationOccurrenceIds: readonly string[] | undefined;
      let deleteActivityId: string | undefined;
      let deleteOccurrenceId: string | undefined;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        // A failed subject delete discards the whole command, receipt included.
        let deleteSettlement: Settled<unknown> | undefined;
        const attempted: {
          rules?: BeforeSaveRuleExecution;
          executions: BeforeSaveRuleExecution[];
        } = {
          executions: [],
        };
        const result = await requests.runChange(
          session,
          selection,
          async (transaction, _scope, issuedAt) => {
            const preview = await prepare(transaction, command.data, activityId, true);
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
              const denied = await prepare(transaction, command.data, activityId, false);
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
            const previewRun = composeFromFlow(preview, command.data.inputs, issuedAt, run);
            if (previewRun.kind === "invalid")
              return safeRefusal(preview.correlationId, "invalid_request", previewRun.reason);
            const previewInputs =
              previewRun.kind === "composed"
                ? previewRun.composition.normalizedInputs
                : previewRun.normalizedInputs;
            if (!(await validateReferenceInputs(transaction, command.data, previewInputs)))
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
                    command.data,
                    previewRun.composition.submittedValues,
                    previewRun.composition.creations,
                    activityId,
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

            const prepared = await prepare(transaction, command.data, activityId, false);
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
            const preparedRun = composeFromFlow(prepared, command.data.inputs, issuedAt, run);
            if (preparedRun.kind === "invalid")
              return safeRefusal(prepared.correlationId, "invalid_request", preparedRun.reason);
            // The record moved between the preview and the locked preparation: run again.
            if (preparedRun.kind !== previewRun.kind) return restart;
            if (preparedRun.kind === "refused") {
              const refusal = await refusePrecondition(transaction, command.data, activityId);
              return refusal.outcome === "refused_recorded"
                ? recordedRefusal
                : safeRefusal(
                    prepared.correlationId,
                    "operation_refused",
                    "the action's precondition refused the subject record",
                  );
            }
            const composition = preparedRun.composition;
            const previewComposition = (
              previewRun as Extract<FlowComposition, { kind: "composed" }>
            ).composition;
            if (
              JSON.stringify(composition.submittedValues) !==
                JSON.stringify(previewComposition.submittedValues) ||
              JSON.stringify(composition.creations) !==
                JSON.stringify(previewComposition.creations) ||
              JSON.stringify(composition.relationshipCopies) !==
                JSON.stringify(previewComposition.relationshipCopies) ||
              composition.softDeletesSubject !== previewComposition.softDeletesSubject ||
              JSON.stringify(composition.announcedEventKeys) !==
                JSON.stringify(previewComposition.announcedEventKeys)
            )
              return restart;

            const subjectRuleSet = parseBeforeSaveRuleSet(
              prepared.beforeSaveRules,
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
                  (check) =>
                    !pendingCheckIsAuthorized(
                      check,
                      prepared.singleRequiredPermissionId,
                      prepared.actorOrganizationAccountId,
                    ),
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
                    planned.data.recordTypeId.toLowerCase() !==
                      actual.data.recordTypeId.toLowerCase() ||
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
                const ruleSet = parseBeforeSaveRuleSet(
                  record.beforeSaveRules,
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
                if (
                  record.recordKey !== "root" ||
                  Object.keys(composition.submittedValues).length > 0
                ) {
                  const execution = beginBeforeSaveRuleExecution(ruleSet);
                  closureRules.set(record.recordKey, execution);
                  if (record.recordKey === "root") attempted.executions.push(execution);
                }
              }
            } else if (Object.keys(composition.submittedValues).length > 0) {
              attempted.rules = beginBeforeSaveRuleExecution(subjectRuleSet);
              attempted.executions.push(attempted.rules);
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
            if (
              Object.keys(composition.submittedValues).length > 0 ||
              composition.creations.length > 0
            ) {
              const saveCommand = saveRecordCommandSchema.parse({
                contractVersion: "2.0.0",
                commandId: command.data.commandId,
                operation: "update",
                recordTypeId: command.data.recordTypeId,
                recordId: command.data.recordId,
                expectedConcurrencyNumber: command.data.expectedConcurrencyNumber,
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
                        rules: attempted.rules,
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
                  (check) =>
                    !pendingCheckIsAuthorized(
                      check,
                      prepared.singleRequiredPermissionId,
                      prepared.actorOrganizationAccountId,
                    ),
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
                    (check) =>
                      !pendingCheckIsAuthorized(
                        check,
                        prepared.singleRequiredPermissionId,
                        prepared.actorOrganizationAccountId,
                      ),
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
                subjectRuleSet.rules.length > 0
              )
                return safeRefusal(
                  prepared.correlationId,
                  "operation_refused",
                  "the created records changed derived subject values that require its before-save rules",
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
            }
            try {
              standardOccurrenceId ??= eventOccurrenceIdSchema.parse(newOccurrenceId());
              declaredOccurrenceIds ??= Array.from({ length: prepared.eventDescriptorCount }, () =>
                eventOccurrenceIdSchema.parse(newOccurrenceId()),
              );
              creationOccurrenceIds ??= Array.from({ length: creations.length }, () =>
                eventOccurrenceIdSchema.parse(newOccurrenceId()),
              );
            } catch {
              throw new Error("NAMED_ACTION_OCCURRENCE_ID_INVALID");
            }
            if (creationOccurrenceIds.length !== creations.length) return restart;
            const stored = await applyChanges(
              transaction,
              command.data,
              composition,
              finalValues,
              creations,
              activityId,
              standardOccurrenceId,
              declaredOccurrenceIds,
              creationOccurrenceIds,
              parentMutations,
            );
            if (stored.outcome === "restart") return restart;
            if (stored.outcome === "refused_recorded") return recordedRefusal;
            if (stored.outcome === "conflict")
              return safeRefusal(
                prepared.correlationId,
                "conflict",
                "the record changes were refused for a revision conflict",
              );
            if (stored.outcome !== "saved" && stored.outcome !== "completed")
              return safeRefusal(
                prepared.correlationId,
                stored.reasonCode === "command_invalid" ? "invalid_request" : "operation_refused",
                `the record changes were ${String(stored.outcome)} (${String(stored.reasonCode ?? "no reason code")})`,
              );
            const storedResult = completedResult(stored);
            // A writer replay means this command already completed, its delete
            // included, so the subject is never deleted a second time.
            if (
              storedResult === undefined ||
              !composition.softDeletesSubject ||
              stored.replayed === true
            )
              return storedResult ?? recordedRefusal;

            // The subject delete is the shared protected lifecycle delete, run
            // last in this same transaction against the revision the action
            // left the subject at: the action's own tasks write nothing to a
            // subject it deletes. It carries an identity derived from the action's command and
            // its own Activity and `deleted` Event identities, and any refusal
            // throws so the receipt, Activity and Events roll back with it.
            try {
              deleteActivityId ??= activityIdSchema.parse(newActivityId());
              deleteOccurrenceId ??= eventOccurrenceIdSchema.parse(newOccurrenceId());
            } catch {
              throw new Error("NAMED_ACTION_OCCURRENCE_ID_INVALID");
            }
            try {
              const deleted = await performProtectedRecordDelete(transaction, issuedAt, {
                commandId: deleteLifecycleCommandId(command.data.commandId),
                recordTypeId: command.data.recordTypeId,
                recordId: command.data.recordId,
                expectedConcurrencyNumber: command.data.expectedConcurrencyNumber,
                activityId: deleteActivityId,
                occurrenceId: deleteOccurrenceId,
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
              if (deletedResult === undefined)
                throw new Error("NAMED_ACTION_DELETE_RESULT_INVALID");
              return deletedResult;
            } catch (error) {
              deleteSettlement = settleRecordLifecycleError(error);
              throw error;
            }
          },
        );
        if (deleteSettlement?.kind === "restart") continue;
        if (deleteSettlement?.kind === "result") {
          const refused = deleteSettlement.value as RecordDeleteResult;
          return {
            kind: "available",
            value: safeRefusal(
              refused.correlationId,
              refused.outcome === "conflict" ? "conflict" : "operation_refused",
              `the subject delete was ${refused.outcome}`,
              refused.outcome === "refused" ? refused.ruleReason : undefined,
            ),
          };
        }
        if (result.kind !== "available") return result;
        if (result.value === restart) continue;
        if (result.value === recordedRefusal) {
          console.error("[named-action] refused NAMED_ACTION_REFUSAL_RECORDED");
          return { kind: "unavailable" };
        }
        const value = result.value as ExecuteNamedActionResult;
        return value.outcome === "completed" &&
          attempted.executions.some((execution) => execution.warnings.length > 0)
          ? {
              kind: "available",
              value,
              warnings: attempted.executions.flatMap((execution) => execution.warnings),
            }
          : { kind: "available", value };
      }
      return { kind: "temporarily_unavailable" };
    },
  });
};

/** Whether a named action can run on one record for the viewer, as a page asks before it shows a control. */
export type NamedActionAvailability =
  | Readonly<{ kind: "available" }>
  | Readonly<{ kind: "refused"; cause: "precondition" | "permission" }>
  /** The preview cannot decide without the inputs the person has yet to supply; submit decides. */
  | Readonly<{ kind: "undecided"; reason: string }>;

const availabilityFromPreview = (
  preview: ActionPreparation,
  issuedAt: string,
  run: ActionFlowRunner,
): NamedActionAvailability => {
  if (preview.outcome === "permission_refused") return { kind: "refused", cause: "permission" };
  if (preview.outcome !== "previewed") {
    const reasonCode = "reasonCode" in preview ? preview.reasonCode : undefined;
    return {
      kind: "undecided",
      reason: `the preview was ${preview.outcome}, not previewed (${reasonCode ?? "no reason code"})`,
    };
  }
  const outcome = run(actionFlowSeed(preview, {}, issuedAt));
  if (outcome.kind === "refused") return { kind: "refused", cause: "precondition" };
  return outcome.kind === "collected"
    ? { kind: "available" }
    : { kind: "undecided", reason: outcome.reason };
};

/** A page subject read together with the availability of every named action bound to it. */
export type SubjectWithNamedActionAvailability = Readonly<{
  /** The subject projection and capabilities, as `vortex_record.read_record_with_capabilities` returns them. */
  record: unknown;
  capabilities: unknown;
  /** Keyed by lower-case action id; empty when the subject is not readable. */
  availability: ReadonlyMap<string, NamedActionAvailability>;
}>;

/**
 * Reads a page subject and previews every named action its placements are bound to in one fixed
 * adapter call: one read decision for the record, and each action's own preview for the record's
 * current concurrency number with no inputs, inside a transaction the caller already verified.
 * Nothing is written. A subject the viewer
 * cannot read previews nothing.
 */
export const readSubjectWithNamedActionAvailability = async (
  transaction: RequestDatabaseTransaction,
  subject: Readonly<{ recordTypeId: string; recordId: string }>,
  actions: readonly ExecuteNamedActionCommand["action"][],
  issuedAt: string,
  runFor: (action: ExecuteNamedActionCommand["action"]) => ActionFlowRunner,
): Promise<SubjectWithNamedActionAvailability> => {
  const requests = actions.map((action) => ({
    commandId: randomUUID(),
    activityId: randomUUID(),
    ownerKind: action.ownerKind,
    ownerId: action.ownerId,
    releaseRevision: action.releaseRevision,
    actionId: action.actionId,
  }));
  let rows: readonly ResultRow[];
  await transaction.query`set local role vortex_runtime`;
  try {
    rows = await transaction.query<ResultRow>`
      select vortex_record.read_record_with_action_previews(
        ${subject.recordTypeId}::uuid, ${subject.recordId}::uuid,
        ${JSON.stringify(requests)}::text::jsonb
      ) as value
    `;
  } finally {
    await transaction.query`set local role vortex_request`;
  }
  const value = one(rows).value;
  if (typeof value !== "object" || value === null)
    throw new Error("NAMED_ACTION_PREVIEWS_RESULT_INVALID");
  const read = value as Record<string, unknown>;
  const previews = Array.isArray(read.previews) ? (read.previews as unknown[]) : undefined;
  if (previews === undefined) throw new Error("NAMED_ACTION_PREVIEWS_RESULT_INVALID");
  const availability = new Map<string, NamedActionAvailability>();
  for (const action of actions) {
    const key = action.actionId.toLowerCase();
    if (availability.has(key)) continue;
    const entry = previews.find(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        String((item as Record<string, unknown>).actionId).toLowerCase() === key,
    ) as Record<string, unknown> | undefined;
    if (entry === undefined) {
      if ((read.record as Record<string, unknown> | null)?.outcome === "allowed")
        throw new Error("NAMED_ACTION_PREVIEW_MISSING");
      continue;
    }
    availability.set(
      key,
      availabilityFromPreview(parsePreparation(entry.preview), issuedAt, runFor(action)),
    );
  }
  return { record: read.record, capabilities: read.capabilities, availability };
};
