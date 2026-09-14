import "server-only";

import { randomUUID } from "node:crypto";
import {
  actionDefinitionSchema,
  actionDefinitionV2Schema,
  activityIdSchema,
  eventOccurrenceIdSchema,
  executeNamedActionCommandV2Schema,
  executeNamedActionResultV2Schema,
  recordTypeDefinitionV2Schema,
  saveRecordCommandV2Schema,
  type ExecuteNamedActionCommandV2,
  type ExecuteNamedActionResultV2,
  type IdentitySession,
  type OrganizationSelectionCandidate,
} from "@vortex/contracts";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import { composeNamedAction, type PreparedNamedAction } from "./named-action-composition";
import { calculateLockedRelationshipTotalSave } from "./relationship-total-save";
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
      outcome: "conflict" | "refused" | "refused_recorded" | "unsupported";
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
    value.outcome === "refused" ||
    value.outcome === "refused_recorded" ||
    value.outcome === "unsupported"
  )
    return { outcome: value.outcome, ...(correlationId ? { correlationId } : {}) };
  if (value.outcome !== "prepared" && value.outcome !== "previewed")
    return { outcome: "refused", ...(correlationId ? { correlationId } : {}) };
  const actionV2 = actionDefinitionV2Schema.safeParse(value.action);
  const actionV1 = actionDefinitionSchema.safeParse(value.action);
  const recordType = recordTypeDefinitionV2Schema.safeParse(value.recordType);
  if (
    (!actionV2.success && !actionV1.success) ||
    !recordType.success ||
    typeof value.validationContractVersion !== "string" ||
    !["1.0.0", "2.0.0", "3.0.0"].includes(value.validationContractVersion) ||
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
    validationContractVersion: value.validationContractVersion as "1.0.0" | "2.0.0" | "3.0.0",
    action: actionV2.success ? actionV2.data : actionV1.data!,
    recordType: recordType.data,
    recordId: value.recordId,
    existingValues: value.existingValues as Readonly<Record<string, unknown>>,
    actorOrganizationAccountId: value.actorOrganizationAccountId,
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
  activityId: string,
): Promise<RelationshipTotalPreparationOutcome> => {
  const rows = await transaction.query<ResultRow>`
    select vortex_record.prepare_named_action_relationship_totals(
      ${command.commandId}::uuid, 'update', ${command.recordTypeId}::uuid,
      ${command.recordId}::uuid, ${command.expectedConcurrencyNumber}::bigint,
      ${JSON.stringify(submittedValues)}::text::jsonb, null::uuid,
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
  activityId: string,
  standardOccurrenceId: string,
  declaredOccurrenceIds: readonly string[],
  parentMutations: readonly unknown[],
) => {
  const rows = await transaction.query<ResultRow>`
    select vortex_record.save_named_action_set_announce_with_relationship_totals(
      ${command.commandId}::uuid, 'update', ${command.recordTypeId}::uuid,
      ${command.recordId}::uuid, ${command.expectedConcurrencyNumber}::bigint,
      ${JSON.stringify(submittedValues)}::text::jsonb,
      ${JSON.stringify(finalValues)}::text::jsonb, null::uuid,
      ${activityId}::uuid, ${standardOccurrenceId}::uuid,
      ${JSON.stringify(parentMutations)}::text::jsonb,
      ${JSON.stringify(declaredOccurrenceIds)}::text::jsonb,
      ${command.action.ownerKind}::text, ${command.action.ownerId}::uuid,
      ${command.action.releaseRevision}::bigint, ${command.action.actionId}::uuid,
      ${JSON.stringify(command.inputs)}::text::jsonb
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
            if (preview.outcome !== "previewed")
              return preview.correlationId
                ? safeRefusal(preview.correlationId, "operation_refused")
                : recordedRefusal;
            const previewComposition = composeNamedAction(preview, command.data.inputs, issuedAt);
            if (previewComposition === undefined)
              return safeRefusal(preview.correlationId, "invalid_request");

            const totalPreparation = await prepareTotals(
              transaction,
              command.data,
              previewComposition.submittedValues,
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
            let parentMutations: readonly unknown[] = [];
            if (Object.keys(composition.submittedValues).length > 0) {
              const settings = await readOrganizationRuntimeSettings(transaction);
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
              finalValues =
                "sourceFinalValues" in calculated
                  ? { ...calculated.sourceFinalValues }
                  : { ...calculated.setValues };
              if ("clearFieldIds" in calculated)
                for (const fieldId of calculated.clearFieldIds) finalValues[fieldId] = null;
              if ("parentMutations" in calculated) parentMutations = calculated.parentMutations;
            }
            try {
              standardOccurrenceId ??= eventOccurrenceIdSchema.parse(newOccurrenceId());
              declaredOccurrenceIds ??= Array.from({ length: prepared.eventDescriptorCount }, () =>
                eventOccurrenceIdSchema.parse(newOccurrenceId()),
              );
            } catch {
              throw new Error("NAMED_ACTION_OCCURRENCE_ID_INVALID");
            }
            const stored = await persist(
              transaction,
              command.data,
              composition.submittedValues,
              finalValues,
              activityId,
              standardOccurrenceId,
              declaredOccurrenceIds,
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
