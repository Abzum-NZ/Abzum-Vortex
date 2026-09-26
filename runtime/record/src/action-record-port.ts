import "server-only";

import { randomUUID } from "node:crypto";
import {
  actionDefinitionV3Schema,
  activityIdSchema,
  eventOccurrenceIdSchema,
  executeNamedActionCommandV2Schema,
  executeNamedActionResultV2Schema,
  moduleValidationContractVersionV3,
  recordTypeDefinitionV3Schema,
  saveRecordCommandV2Schema,
  type ExecuteNamedActionCommandV2,
  type ExecuteNamedActionResultV2,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
} from "@vortex/contracts";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import type { ActionFlowRunner, BeforeSaveRuleWarning } from "@vortex/rule";
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
  type RelationshipTotalParentMutation,
} from "./relationship-total-save";
import {
  calculateAndFinalize,
  operationClock,
  parseRelationshipTotalPreparation,
  readOrganizationRuntimeSettings,
  revision,
  type PreparedSave,
  type RelationshipTotalPreparationOutcome,
} from "./save-record";

type ResultRow = DatabaseRow & { readonly value: unknown };

type PreparedAction = PreparedNamedAction &
  Readonly<{
    outcome: "prepared" | "previewed";
    readableFieldIds: ReadonlySet<string>;
    changeableFieldIds: ReadonlySet<string>;
    eventDescriptorCount: number;
    correlationId: string;
    /** The exact release's compiled before-save rules for the subject, unparsed. */
    beforeSaveRules?: unknown;
  }>;

/**
 * The named-action result plus any before-save rule warnings of a completed
 * attempt. The closed result contract has no warning field, so they travel beside it.
 */
export type NamedActionServiceResult = HumanOrganizationRequestResult<ExecuteNamedActionResultV2> &
  Readonly<{ warnings?: readonly BeforeSaveRuleWarning[] }>;

type ActionPreparation =
  | PreparedAction
  | Readonly<{ outcome: "completed"; result: ExecuteNamedActionResultV2 }>
  | Readonly<{
      outcome: "conflict" | "permission_refused" | "refused" | "refused_recorded" | "unsupported";
      correlationId?: string;
    }>;

const restart = Symbol("restartNamedAction");
const recordedRefusal = Symbol("recordedNamedActionRefusal");

const one = <Row>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("NAMED_ACTION_RESULT_INVALID");
  return rows[0];
};

const safeRefusal = (
  correlationId: string,
  code: "invalid_request" | "operation_refused" | "conflict",
): ExecuteNamedActionResultV2 =>
  executeNamedActionResultV2Schema.parse({
    contractVersion: "2.0.0",
    outcome: "refused",
    error: { code, messageKey: `errors.${code}`, correlationId },
  });

const completedResult = (candidate: Record<string, unknown>) => {
  const parsedRevision = revision(candidate.concurrencyNumber);
  if (parsedRevision === undefined) return undefined;
  const result = executeNamedActionResultV2Schema.safeParse({
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
    const recordType = recordTypeDefinitionV3Schema.safeParse(value.recordType);
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
    });
  }
  return targets.every(
    (target, index) => index === 0 || target.ordinal > targets[index - 1]!.ordinal,
  )
    ? targets
    : undefined;
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
    return { outcome: value.outcome, ...(correlationId ? { correlationId } : {}) };
  if (value.outcome !== "prepared" && value.outcome !== "previewed")
    return { outcome: "refused", ...(correlationId ? { correlationId } : {}) };
  const actionV2 = actionDefinitionV3Schema.safeParse(value.action);
  const recordType = recordTypeDefinitionV3Schema.safeParse(value.recordType);
  const createTargets = parseCreateTargets(value.createTargets);
  // An action that targets a registered protected operation, and every action of a system
  // projection record type, runs through that operation's owning service, never through ordered
  // record effects.
  if (
    !actionV2.success ||
    actionV2.data.protectedOperation !== undefined ||
    !recordType.success ||
    recordType.data.systemProjection !== undefined ||
    createTargets === undefined ||
    value.validationContractVersion !== moduleValidationContractVersionV3 ||
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
  return {
    outcome: value.outcome,
    validationContractVersion: moduleValidationContractVersionV3,
    action: actionV2.data,
    recordType: recordType.data,
    recordId: value.recordId,
    existingValues: value.existingValues as Readonly<Record<string, unknown>>,
    actorOrganizationAccountId: value.actorOrganizationAccountId,
    createTargets,
    readableFieldIds: new Set(
      value.readableFieldIds.filter((item): item is string => typeof item === "string"),
    ),
    changeableFieldIds: new Set(
      value.changeableFieldIds.filter((item): item is string => typeof item === "string"),
    ),
    eventDescriptorCount: value.eventDescriptors.length,
    correlationId,
    ...(value.beforeSaveRules === undefined ? {} : { beforeSaveRules: value.beforeSaveRules }),
  };
};

/**
 * Finalises each creation on its own when the merged closure reported
 * `not_required` or `defer`, so a creation still reaches the writer with its
 * complete generated field set. Totals cannot apply on this path by
 * construction: the preparation only reports those outcomes when no root type
 * participates in one.
 */
const creationFinalValues = (
  prepared: PreparedAction,
  creations: readonly NamedActionCreation[],
  issuedAt: string,
  organizationCurrency: string | undefined,
  timeZone: string | undefined,
): Record<number, Record<string, JsonValue | null>> | undefined => {
  const targets = new Map(prepared.createTargets.map((target) => [target.ordinal, target]));
  const values: Record<number, Record<string, JsonValue | null>> = {};
  for (const creation of creations) {
    const target = targets.get(creation.ordinal);
    if (target === undefined) return undefined;
    const command = saveRecordCommandV2Schema.safeParse({
      contractVersion: "2.0.0",
      commandId: randomUUID(),
      operation: "create",
      recordTypeId: target.recordTypeId,
      submittedValues: creation.values,
    });
    if (!command.success) return undefined;
    const calculated = calculateAndFinalize(
      {
        outcome: "prepared",
        recordType: target.recordType,
        existingValues: {},
        readableFieldIds: new Set(target.recordType.fields.map((field) => field.fieldId)),
        correlationId: prepared.correlationId,
      } satisfies PreparedSave,
      command.data,
      issuedAt,
      organizationCurrency,
      timeZone,
    );
    if (!calculated.success) return undefined;
    if (calculated.pendingChecks.some((check) => check.kind !== "record_reference"))
      return undefined;
    const created: Record<string, JsonValue | null> = { ...calculated.setValues };
    for (const fieldId of calculated.clearFieldIds) created[fieldId] = null;
    values[creation.ordinal] = created;
  }
  return values;
};

const validateReferenceInputs = async (
  transaction: RequestDatabaseTransaction,
  command: ExecuteNamedActionCommandV2,
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
  command: ExecuteNamedActionCommandV2,
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
  command: ExecuteNamedActionCommandV2,
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
  command: ExecuteNamedActionCommandV2,
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
  command: ExecuteNamedActionCommandV2,
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
  | Readonly<{ kind: "invalid" }>;

/**
 * Runs the named action's flow once for the prepared subject and turns what it collected into the
 * composition the database applies. The flow's precondition refusal is its own outcome: the run
 * never reaches an effect, and the caller records the refusal as the action always has.
 */
const composeFromFlow = (
  prepared: PreparedNamedAction,
  suppliedInputs: Readonly<Record<string, unknown>>,
  issuedAt: string,
  run: ActionFlowRunner,
): FlowComposition => {
  const normalizedInputs = normalizeActionInputs(prepared.action, suppliedInputs);
  if (normalizedInputs === undefined) return { kind: "invalid" };
  const outcome = run(actionFlowSeed(prepared, normalizedInputs, issuedAt));
  if (outcome.kind === "refused") return { kind: "refused", normalizedInputs };
  if (outcome.kind !== "collected") return { kind: "invalid" };
  const composition = composeFlowEffects(prepared, normalizedInputs, outcome, issuedAt);
  return composition === undefined ? { kind: "invalid" } : { kind: "composed", composition };
};

/**
 * The record port of the flow runner for named actions (#1063). The runner has already resolved the
 * exact release's action flow, checked its invocation permission and supplied the flow run; this
 * port owns what needs the database: the action's preparation and permission decision, the typed
 * inputs, the relationship totals, the before-save rules, and the one apply record changes call that
 * writes every effect of the action in one transaction, receipt, Activity and Events included.
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
      const command = executeNamedActionCommandV2Schema.safeParse(commandCandidate);
      if (!command.success || selection.applicationRootId === undefined)
        return { kind: "unavailable" };
      let activityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch {
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
        const attempted: { rules?: BeforeSaveRuleExecution } = {};
        const result = await requests.runChange(
          session,
          selection,
          async (transaction, _scope, issuedAt) => {
            const preview = await prepare(transaction, command.data, activityId, true);
            if (preview.outcome === "completed") return preview.result;
            if (preview.outcome === "refused_recorded") return recordedRefusal;
            if (preview.outcome === "conflict")
              return preview.correlationId
                ? safeRefusal(preview.correlationId, "conflict")
                : recordedRefusal;
            if (preview.outcome === "permission_refused") {
              const denied = await prepare(transaction, command.data, activityId, false);
              return denied.outcome === "refused_recorded"
                ? recordedRefusal
                : "correlationId" in denied && denied.correlationId
                  ? safeRefusal(denied.correlationId, "operation_refused")
                  : recordedRefusal;
            }
            if (preview.outcome !== "previewed")
              return preview.correlationId
                ? safeRefusal(preview.correlationId, "operation_refused")
                : recordedRefusal;
            const previewRun = composeFromFlow(preview, command.data.inputs, issuedAt, run);
            if (previewRun.kind === "invalid")
              return safeRefusal(preview.correlationId, "invalid_request");
            const previewInputs =
              previewRun.kind === "composed"
                ? previewRun.composition.normalizedInputs
                : previewRun.normalizedInputs;
            if (!(await validateReferenceInputs(transaction, command.data, previewInputs)))
              return safeRefusal(preview.correlationId, "operation_refused");

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
              return safeRefusal(preview.correlationId, "conflict");
            if (totalPreparation.outcome === "refused")
              return safeRefusal(preview.correlationId, "operation_refused");

            const prepared = await prepare(transaction, command.data, activityId, false);
            if (prepared.outcome === "completed") return prepared.result;
            if (prepared.outcome === "refused_recorded") return recordedRefusal;
            if (prepared.outcome === "conflict")
              return prepared.correlationId
                ? safeRefusal(prepared.correlationId, "conflict")
                : recordedRefusal;
            if (prepared.outcome !== "prepared")
              return prepared.correlationId
                ? safeRefusal(prepared.correlationId, "operation_refused")
                : recordedRefusal;
            const preparedRun = composeFromFlow(prepared, command.data.inputs, issuedAt, run);
            if (preparedRun.kind === "invalid")
              return safeRefusal(prepared.correlationId, "invalid_request");
            // The record moved between the preview and the locked preparation: run again.
            if (preparedRun.kind !== previewRun.kind) return restart;
            if (preparedRun.kind === "refused") {
              const refusal = await refusePrecondition(transaction, command.data, activityId);
              return refusal.outcome === "refused_recorded"
                ? recordedRefusal
                : safeRefusal(prepared.correlationId, "operation_refused");
            }
            const composition = preparedRun.composition;
            const previewComposition = (previewRun as Extract<FlowComposition, { kind: "composed" }>)
              .composition;
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

            // A save that writes subject fields runs the exact release's compiled
            // before-save rules once. A totals-prepared closure is only reached
            // when no rule is installed anywhere. Other records the action writes
            // are not evaluated here: a relationship copy changes another record
            // of the subject's own type, so a subject rule refuses it rather than
            // skip it (creations already refuse under any installed rule).
            if (totalPreparation.outcome !== "prepared") {
              const ruleSet = parseBeforeSaveRuleSet(
                prepared.beforeSaveRules,
                prepared.recordType.recordTypeId,
              );
              if (
                ruleSet === undefined ||
                (ruleSet.rules.length > 0 &&
                  (composition.creations.length > 0 || composition.relationshipCopies.length > 0))
              )
                return safeRefusal(prepared.correlationId, "operation_refused");
              if (Object.keys(composition.submittedValues).length > 0)
                attempted.rules = beginBeforeSaveRuleExecution(ruleSet);
            }

            let finalValues: Record<string, unknown> = {};
            let parentMutations: readonly RelationshipTotalParentMutation[] = [];
            let creations: readonly Readonly<{
              ordinal: number;
              recordTypeId: string;
              values: Readonly<Record<string, JsonValue | null>>;
              finalValues: Readonly<Record<string, JsonValue | null>>;
            }>[] = [];
            // Read unconditionally: even an action with no set_field effect and
            // no creation can still leave a stale due row in place unless its
            // deadline transition is re-derived from the record's unchanged
            // existing values below.
            const settings = await readOrganizationRuntimeSettings(transaction);
            if (
              Object.keys(composition.submittedValues).length > 0 ||
              composition.creations.length > 0
            ) {
              const saveCommand = saveRecordCommandV2Schema.parse({
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
                    })
                  : totalPreparation.outcome === "prepared"
                    ? { success: false as const, issues: [] }
                    : calculateAndFinalize(
                        {
                          outcome: "prepared",
                          recordType: prepared.recordType,
                          existingValues: prepared.existingValues,
                          readableFieldIds: prepared.readableFieldIds,
                          correlationId: prepared.correlationId,
                        } satisfies PreparedSave,
                        saveCommand,
                        issuedAt,
                        settings?.currency,
                        settings?.timeZone,
                        attempted.rules,
                      );
              if (
                !calculated.success ||
                (totalPreparation.outcome === "prepared" && root === undefined)
              )
                return safeRefusal(prepared.correlationId, "operation_refused");
              if (calculated.pendingChecks.some((check) => check.kind !== "record_reference"))
                return safeRefusal(prepared.correlationId, "operation_refused");
              if (
                "creationPendingChecks" in calculated &&
                Object.values(calculated.creationPendingChecks).some((checks) =>
                  checks.some((check) => check.kind !== "record_reference"),
                )
              )
                return safeRefusal(prepared.correlationId, "operation_refused");
              finalValues =
                "sourceFinalValues" in calculated
                  ? { ...calculated.sourceFinalValues }
                  : { ...calculated.setValues };
              if ("clearFieldIds" in calculated)
                for (const fieldId of calculated.clearFieldIds) finalValues[fieldId] = null;
              if ("parentMutations" in calculated) parentMutations = calculated.parentMutations;
              // The merged closure recomputes every derived subject field. An
              // action with no set_field effect may therefore still carry a
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
              const createdFinalValues =
                "creationFinalValues" in calculated
                  ? calculated.creationFinalValues
                  : creationFinalValues(
                      prepared,
                      composition.creations,
                      issuedAt,
                      settings?.currency,
                      settings?.timeZone,
                    );
              if (createdFinalValues === undefined)
                return safeRefusal(prepared.correlationId, "operation_refused");
              // `values` stays the composed authored field map, which the
              // database re-derives from the installed action; `finalValues`
              // adds the generated fields the evaluator produced, exactly as
              // the subject's submitted/final split works.
              creations = composition.creations.map((creation) => ({
                ordinal: creation.ordinal,
                recordTypeId: creation.recordTypeId,
                values: creation.values,
                finalValues: createdFinalValues[creation.ordinal] ?? creation.values,
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
              return safeRefusal(prepared.correlationId, "conflict");
            if (stored.outcome !== "saved" && stored.outcome !== "completed")
              return safeRefusal(
                prepared.correlationId,
                stored.reasonCode === "command_invalid" ? "invalid_request" : "operation_refused",
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
            // left the subject at: the action's own effects write nothing to a
            // subject it deletes. It carries the action's command identity and
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
                commandId: command.data.commandId,
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
              if (deletedResult === undefined) throw new Error("NAMED_ACTION_DELETE_RESULT_INVALID");
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
            ),
          };
        }
        if (result.kind !== "available") return result;
        if (result.value === restart) continue;
        if (result.value === recordedRefusal) return { kind: "unavailable" };
        const value = result.value as ExecuteNamedActionResultV2;
        return value.outcome === "completed" &&
          attempted.rules !== undefined &&
          attempted.rules.warnings.length > 0
          ? { kind: "available", value, warnings: [...attempted.rules.warnings] }
          : { kind: "available", value };
      }
      return { kind: "temporarily_unavailable" };
    },
  });
};
