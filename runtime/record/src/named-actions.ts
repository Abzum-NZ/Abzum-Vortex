import "server-only";

import { randomUUID } from "node:crypto";
import {
  actionDefinitionV2Schema,
  activityIdSchema,
  eventOccurrenceIdSchema,
  executeNamedActionCommandV2Schema,
  executeNamedActionResultV2Schema,
  moduleValidationContractVersionV3,
  recordTypeDefinitionV2Schema,
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
import {
  deriveEarliestPendingDeadlineTransitionV2,
  deriveParentDeadlineDueMutations,
  type ParentDeadlineDueMutation,
  type PendingDeadlineTransitionV2,
} from "./deadline-transitions";
import {
  composeNamedAction,
  type NamedActionCreateTarget,
  type NamedActionCreation,
  type PreparedNamedAction,
} from "./named-action-composition";
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
  }>;

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
    const recordType = recordTypeDefinitionV2Schema.safeParse(value.recordType);
    if (
      !recordType.success ||
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
  const actionV2 = actionDefinitionV2Schema.safeParse(value.action);
  const recordType = recordTypeDefinitionV2Schema.safeParse(value.recordType);
  const createTargets = parseCreateTargets(value.createTargets);
  if (
    !actionV2.success ||
    !recordType.success ||
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

const persist = async (
  transaction: RequestDatabaseTransaction,
  command: ExecuteNamedActionCommandV2,
  submittedValues: Readonly<Record<string, unknown>>,
  finalValues: Readonly<Record<string, unknown>>,
  creations: readonly unknown[],
  activityId: string,
  standardOccurrenceId: string,
  declaredOccurrenceIds: readonly string[],
  creationOccurrenceIds: readonly string[],
  parentMutations: readonly unknown[],
  dueTransition?: PendingDeadlineTransitionV2,
  parentDeadlineDueMutations: readonly ParentDeadlineDueMutation[] = [],
) => {
  const rows = await transaction.query<ResultRow>`
    select vortex_record.save_named_action_effects_with_relationship_totals_and_deadline_due_metadata(
      ${command.commandId}::uuid, ${command.recordTypeId}::uuid,
      ${command.recordId}::uuid, ${command.expectedConcurrencyNumber}::bigint,
      ${JSON.stringify(submittedValues)}::text::jsonb,
      ${JSON.stringify(finalValues)}::text::jsonb,
      ${activityId}::uuid, ${standardOccurrenceId}::uuid,
      ${JSON.stringify(parentMutations)}::text::jsonb,
      ${JSON.stringify(declaredOccurrenceIds)}::text::jsonb,
      ${JSON.stringify(creations)}::text::jsonb,
      ${JSON.stringify(creationOccurrenceIds)}::text::jsonb,
      ${command.action.ownerKind}::text, ${command.action.ownerId}::uuid,
      ${command.action.releaseRevision}::bigint, ${command.action.actionId}::uuid,
      ${JSON.stringify(command.inputs)}::text::jsonb,
      ${dueTransition === undefined ? null : JSON.stringify(dueTransition)}::text::jsonb,
      ${JSON.stringify(
        parentDeadlineDueMutations.map((mutation) => ({
          recordTypeId: mutation.recordTypeId,
          recordId: mutation.recordId,
          recordType: mutation.recordType,
          concurrencyNumber: mutation.newConcurrencyNumber,
          ...(mutation.dueTransition === undefined ? {} : { dueTransition: mutation.dueTransition }),
        })),
      )}::text::jsonb
    ) as value
  `;
  const value = one(rows).value;
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : { outcome: "refused" };
};

export type NamedActionServiceDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    activityId?: () => string;
    occurrenceId?: () => string;
  }>;

/** The only public human named-action operation in slice 1 of #50. */
export const createNamedActionService = (dependencies: NamedActionServiceDependencies) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const newActivityId = dependencies.activityId ?? randomUUID;
  const newOccurrenceId = dependencies.occurrenceId ?? randomUUID;
  return Object.freeze({
    async execute(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<ExecuteNamedActionResultV2>> {
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
      for (let attempt = 0; attempt < 3; attempt += 1) {
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
            const previewComposition = composeNamedAction(preview, command.data.inputs, issuedAt);
            if (previewComposition === undefined)
              return safeRefusal(preview.correlationId, "invalid_request");
            if (
              !(await validateReferenceInputs(
                transaction,
                command.data,
                previewComposition.normalizedInputs,
              ))
            )
              return safeRefusal(preview.correlationId, "operation_refused");

            const totalPreparation = await prepareTotals(
              transaction,
              command.data,
              previewComposition.submittedValues,
              previewComposition.creations,
              activityId,
            );
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
            const composition = composeNamedAction(prepared, command.data.inputs, issuedAt);
            if (composition === undefined)
              return safeRefusal(prepared.correlationId, "invalid_request");
            if (
              JSON.stringify(composition.submittedValues) !==
                JSON.stringify(previewComposition.submittedValues) ||
              JSON.stringify(composition.creations) !==
                JSON.stringify(previewComposition.creations) ||
              JSON.stringify(composition.announcedEventKeys) !==
                JSON.stringify(previewComposition.announcedEventKeys)
            )
              return restart;
            if (!composition.preconditionSatisfied) {
              const refusal = await refusePrecondition(transaction, command.data, activityId);
              return refusal.outcome === "refused_recorded"
                ? recordedRefusal
                : safeRefusal(prepared.correlationId, "operation_refused");
            }

            let finalValues: Record<string, unknown> = {};
            let parentMutations: readonly RelationshipTotalParentMutation[] = [];
            let dueTransition: PendingDeadlineTransitionV2 | undefined;
            let parentDeadlineDueMutations: readonly ParentDeadlineDueMutation[] = [];
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
            // Derived unconditionally from whatever finalValues/parentMutations
            // ended up being (including the untouched `{}`/`[]` defaults above),
            // so an action with no deadline-relevant effect reconfirms the
            // record's already-correct due row instead of cancelling it.
            dueTransition = deriveEarliestPendingDeadlineTransitionV2({
              recordType: prepared.recordType,
              finalAuthoritativeFieldValues: { ...prepared.existingValues, ...finalValues },
              organizationTimeZone: settings?.timeZone ?? "UTC",
            });
            parentDeadlineDueMutations =
              totalPreparation.outcome === "prepared"
                ? deriveParentDeadlineDueMutations(
                    parentMutations,
                    totalPreparation.records,
                    settings?.timeZone ?? "UTC",
                  )
                : [];
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
            const stored = await persist(
              transaction,
              command.data,
              composition.submittedValues,
              finalValues,
              creations,
              activityId,
              standardOccurrenceId,
              declaredOccurrenceIds,
              creationOccurrenceIds,
              parentMutations,
              dueTransition,
              parentDeadlineDueMutations,
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
            return completedResult(stored) ?? recordedRefusal;
          },
        );
        if (result.kind !== "available") return result;
        if (result.value === restart) continue;
        return result.value === recordedRefusal
          ? { kind: "unavailable" }
          : { kind: "available", value: result.value as ExecuteNamedActionResultV2 };
      }
      return { kind: "temporarily_unavailable" };
    },
  });
};
