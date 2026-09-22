import "server-only";

import { randomUUID } from "node:crypto";
import { activityIdSchema, eventOccurrenceIdSchema, timestampSchema } from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import { deriveEarliestPendingDeadlineTransitionV2 } from "./deadline-transitions";
import type { ClaimRecordDeadlineRefreshResult } from "./deadline-refresh";
import { calculateLockedRelationshipTotalSave } from "./relationship-total-save";
import { operationClock, parseRelationshipTotalPreparation } from "./save-record";

export type ClaimedRecordDeadlineRefresh = Extract<
  ClaimRecordDeadlineRefreshResult,
  { outcome: "claimed" }
>;

export const deadlineClosureConflictReasonCodes = [
  "concurrency_mismatch",
  "record_busy",
  "record_unavailable",
  "closure_changed",
] as const;
export type DeadlineClosureConflictReasonCode = (typeof deadlineClosureConflictReasonCodes)[number];

export const deadlineClosureRefusalReasonCodes = [
  "command_invalid",
  "calculation_refused",
  "transition_not_due",
  "application_context_required",
  "record_type_unavailable",
  "rules_unsupported",
] as const;
export type DeadlineClosureRefusalReasonCode = (typeof deadlineClosureRefusalReasonCodes)[number];

export type CloseRecordDeadlineTransitionResult =
  | Readonly<{ outcome: "closed"; recordId: string; concurrencyNumber: number; replayed: boolean }>
  | Readonly<{ outcome: "conflict"; reasonCode: DeadlineClosureConflictReasonCode }>
  | Readonly<{ outcome: "refused"; reasonCode: DeadlineClosureRefusalReasonCode }>;

type PreparationRow = DatabaseRow & { readonly preparation: unknown };
type CloseRow = DatabaseRow & { readonly result: unknown };

const one = <Row>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new Error("DEADLINE_CLOSURE_RESULT_INVALID");
  return rows[0];
};

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isConflictReasonCode = (candidate: unknown): candidate is DeadlineClosureConflictReasonCode =>
  typeof candidate === "string" &&
  deadlineClosureConflictReasonCodes.some((value) => value === candidate);

const isRefusalReasonCode = (candidate: unknown): candidate is DeadlineClosureRefusalReasonCode =>
  typeof candidate === "string" &&
  deadlineClosureRefusalReasonCodes.some((value) => value === candidate);

const safeConcurrencyNumber = (candidate: unknown): number | undefined => {
  if (typeof candidate === "number")
    return Number.isSafeInteger(candidate) && candidate >= 1 ? candidate : undefined;
  if (typeof candidate === "string" && /^[1-9][0-9]*$/.test(candidate)) {
    const parsed = Number(candidate);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
};

/** Parses the bounded or committed outcome shared by preparation and commit. */
const settledOutcome = (
  value: Readonly<Record<string, unknown>>,
  replayed: boolean,
): CloseRecordDeadlineTransitionResult | undefined => {
  if (value.outcome === "closed") {
    const concurrencyNumber = safeConcurrencyNumber(value.concurrencyNumber);
    if (typeof value.recordId !== "string" || concurrencyNumber === undefined)
      throw new Error("DEADLINE_CLOSURE_RESULT_INVALID");
    return {
      outcome: "closed",
      recordId: value.recordId,
      concurrencyNumber,
      replayed: replayed || value.replayed === true,
    };
  }
  if (value.outcome === "conflict" && isConflictReasonCode(value.reasonCode))
    return { outcome: "conflict", reasonCode: value.reasonCode };
  if (value.outcome === "refused" && isRefusalReasonCode(value.reasonCode))
    return { outcome: "refused", reasonCode: value.reasonCode };
  return undefined;
};

export type DeadlineClosureServiceDependencies = Readonly<{
  activityId?: () => string;
  occurrenceId?: () => string;
}>;

/**
 * Consumes one #557 claimed deadline transition and atomically commits its
 * dependency closure in the caller's existing transaction: the root record,
 * every relationship-total parent it transitively feeds, their Activity,
 * standard Events and deadline due metadata. It must run in the transaction
 * that produced `claimed`; SQL revalidates that claim's System context, locks
 * the closure and repeats the preparation before it writes anything.
 */
export const closeRecordDeadlineTransition = async (
  transaction: RequestDatabaseTransaction,
  claimed: ClaimedRecordDeadlineRefresh,
  dependencies: DeadlineClosureServiceDependencies = {},
): Promise<CloseRecordDeadlineTransitionResult> => {
  const { root, attribution, effect } = claimed;

  await transaction.query`set local role vortex_runtime`;
  const prepared = await transaction.query<PreparationRow>`
    select vortex_record.prepare_record_deadline_closure(
      ${root.organizationId}::uuid,
      ${root.storageContractId}::uuid,
      ${root.recordId}::uuid,
      ${root.recordTypeId}::uuid,
      ${root.applicationRootId ?? null}::uuid,
      ${root.concurrencyNumber}::bigint,
      ${attribution.systemActorId}::uuid,
      ${effect.effectId}::uuid,
      ${effect.effectIdentity}::text,
      ${effect.transitionAt}::timestamptz
    ) as preparation
  `;
  const candidate = one(prepared).preparation;
  if (!isObject(candidate)) throw new Error("DEADLINE_CLOSURE_RESULT_INVALID");
  if (candidate.outcome === "replayed") {
    const replay = isObject(candidate.result) ? settledOutcome(candidate.result, true) : undefined;
    if (replay?.outcome !== "closed") throw new Error("DEADLINE_CLOSURE_RESULT_INVALID");
    return replay;
  }
  const bounded = settledOutcome(candidate, false);
  if (bounded !== undefined) return bounded;

  const preparation = parseRelationshipTotalPreparation(candidate);
  const evaluatedAt = timestampSchema.safeParse(candidate.evaluatedAt);
  const organizationCurrency =
    typeof candidate.organizationCurrency === "string" ? candidate.organizationCurrency : undefined;
  if (preparation.outcome !== "prepared" || !evaluatedAt.success)
    throw new Error("DEADLINE_CLOSURE_RESULT_INVALID");
  const rootRecord = preparation.records.find((record) => record.recordKey === "root");
  if (
    rootRecord === undefined ||
    rootRecord.recordType.recordTypeId !== root.recordTypeId ||
    rootRecord.recordType.storageContractId !== root.storageContractId ||
    rootRecord.recordId?.toLowerCase() !== root.recordId.toLowerCase() ||
    rootRecord.concurrencyNumber !== root.concurrencyNumber
  )
    throw new Error("DEADLINE_CLOSURE_RESULT_INVALID");

  // Every closure record is recalculated at the one database instant the
  // preparation locked it, which is never earlier than the claimed transition.
  const clock = operationClock(
    preparation.records.map((record) => record.recordType),
    evaluatedAt.data,
    claimed.timeZone,
  );
  if (clock === undefined) return { outcome: "refused", reasonCode: "command_invalid" };
  const values = calculateLockedRelationshipTotalSave({
    command: { operation: "update", submittedValues: {} },
    preparation,
    ...(organizationCurrency === undefined ? {} : { organizationCurrency }),
    clock,
  });
  if (!values.success || values.pendingChecks.length > 0)
    return { outcome: "refused", reasonCode: "calculation_refused" };

  const rootDueTransition = deriveEarliestPendingDeadlineTransitionV2({
    recordType: rootRecord.recordType,
    finalAuthoritativeFieldValues: { ...rootRecord.existingValues, ...values.sourceFinalValues },
    organizationTimeZone: claimed.timeZone,
  });
  const parentMutations = values.parentMutations.map((mutation) => {
    const record = preparation.records.find(
      (candidateRecord) =>
        candidateRecord.recordKey !== "root" &&
        candidateRecord.recordType.recordTypeId === mutation.recordTypeId &&
        candidateRecord.recordId === mutation.recordId,
    );
    if (record === undefined) throw new Error("DEADLINE_CLOSURE_RESULT_INVALID");
    const dueTransition = deriveEarliestPendingDeadlineTransitionV2({
      recordType: record.recordType,
      finalAuthoritativeFieldValues: { ...record.existingValues, ...mutation.finalValues },
      organizationTimeZone: claimed.timeZone,
    });
    return { ...mutation, dueTransition: dueTransition ?? null };
  });

  const activityId = activityIdSchema.parse((dependencies.activityId ?? randomUUID)());
  const occurrenceId = eventOccurrenceIdSchema.parse((dependencies.occurrenceId ?? randomUUID)());
  const rows = await transaction.query<CloseRow>`
    select vortex_record.finalize_record_deadline_refresh(
      ${root.organizationId}::uuid,
      ${root.storageContractId}::uuid,
      ${root.recordId}::uuid,
      ${root.recordTypeId}::uuid,
      ${root.applicationRootId ?? null}::uuid,
      ${root.concurrencyNumber}::bigint,
      ${attribution.systemActorId}::uuid,
      ${effect.effectId}::uuid,
      ${effect.effectIdentity}::text,
      ${effect.transitionAt}::timestamptz,
      ${JSON.stringify(values.sourceFinalValues)}::text::jsonb,
      ${rootDueTransition === undefined ? null : JSON.stringify(rootDueTransition)}::text::jsonb,
      ${JSON.stringify(parentMutations)}::text::jsonb,
      ${activityId}::uuid,
      ${occurrenceId}::uuid
    ) as result
  `;
  const result = one(rows).result;
  const settled = isObject(result) ? settledOutcome(result, false) : undefined;
  if (settled === undefined) throw new Error("DEADLINE_CLOSURE_RESULT_INVALID");
  return settled;
};

export const createRecordDeadlineClosureService = (
  dependencies: DeadlineClosureServiceDependencies = {},
) =>
  Object.freeze({
    async close(
      transaction: RequestDatabaseTransaction,
      claimed: ClaimedRecordDeadlineRefresh,
    ): Promise<CloseRecordDeadlineTransitionResult> {
      return closeRecordDeadlineTransition(transaction, claimed, dependencies);
    },
  });
