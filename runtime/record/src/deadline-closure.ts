import "server-only";

import { randomUUID } from "node:crypto";
import { activityIdSchema, eventOccurrenceIdSchema, type JsonValue } from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import { evaluateRecordCalculationsV2 } from "./calculations";
import { deriveEarliestPendingDeadlineTransitionV2 } from "./deadline-transitions";
import type { ClaimRecordDeadlineRefreshResult } from "./deadline-refresh";

export type ClaimedRecordDeadlineRefresh = Extract<
  ClaimRecordDeadlineRefreshResult,
  { outcome: "claimed" }
>;

export const deadlineClosureConflictReasonCodes = ["concurrency_mismatch"] as const;
export type DeadlineClosureConflictReasonCode = (typeof deadlineClosureConflictReasonCodes)[number];

export const deadlineClosureRefusalReasonCodes = [
  "command_invalid",
  "calculation_refused",
  "relationship_total_unsupported",
] as const;
export type DeadlineClosureRefusalReasonCode = (typeof deadlineClosureRefusalReasonCodes)[number];

export type CloseRecordDeadlineTransitionResult =
  | Readonly<{ outcome: "closed"; recordId: string; concurrencyNumber: number; replayed: boolean }>
  | Readonly<{ outcome: "conflict"; reasonCode: DeadlineClosureConflictReasonCode }>
  | Readonly<{ outcome: "refused"; reasonCode: DeadlineClosureRefusalReasonCode }>;

type CloseRow = DatabaseRow & { readonly result: unknown };

const one = <Row>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new Error("DEADLINE_CLOSURE_RESULT_INVALID");
  return rows[0];
};

const isConflictReasonCode = (candidate: unknown): candidate is DeadlineClosureConflictReasonCode =>
  typeof candidate === "string" &&
  deadlineClosureConflictReasonCodes.some((value) => value === candidate);

const isRefusalReasonCode = (candidate: unknown): candidate is DeadlineClosureRefusalReasonCode =>
  typeof candidate === "string" &&
  deadlineClosureRefusalReasonCodes.some((value) => value === candidate);

const safeConcurrencyNumber = (candidate: unknown): number | undefined => {
  if (typeof candidate === "number") return Number.isSafeInteger(candidate) && candidate >= 1 ? candidate : undefined;
  if (typeof candidate === "string" && /^[1-9][0-9]*$/.test(candidate)) {
    const parsed = Number(candidate);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
};

const localDate = (instant: string, timeZone: string): string | undefined => {
  const date = new Date(instant);
  if (!Number.isFinite(date.valueOf())) return undefined;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value;
    const year = value("year");
    const month = value("month");
    const day = value("day");
    return year && month && day ? `${year}-${month}-${day}` : undefined;
  } catch {
    return undefined;
  }
};

export type DeadlineClosureServiceDependencies = Readonly<{
  activityId?: () => string;
  occurrenceId?: () => string;
}>;

/**
 * Consumes one #557 claimed deadline transition and atomically commits its
 * root-record calculation cascade, Activity, Event and due-metadata effects
 * in the caller's existing transaction. Must run in the same transaction as
 * the claim that produced `claimed`: the SQL side trusts the row lock and
 * System context the claim already established rather than re-acquiring them.
 */
export const closeRecordDeadlineTransition = async (
  transaction: RequestDatabaseTransaction,
  claimed: ClaimedRecordDeadlineRefresh,
  dependencies: DeadlineClosureServiceDependencies = {},
): Promise<CloseRecordDeadlineTransitionResult> => {
  const organizationLocalDate = localDate(claimed.effect.transitionAt, claimed.timeZone);
  if (organizationLocalDate === undefined)
    return { outcome: "refused", reasonCode: "command_invalid" };

  const calculations = evaluateRecordCalculationsV2({
    recordType: claimed.recordType,
    authoritativeFieldValues: claimed.existingValues,
    clock: { instant: claimed.effect.transitionAt, organizationLocalDate },
  });
  if (!calculations.success) return { outcome: "refused", reasonCode: "calculation_refused" };

  const finalValues: Record<string, JsonValue | null> = { ...calculations.setValues };
  for (const fieldId of calculations.clearFieldIds) finalValues[fieldId] = null;
  // The claim only ever locks a row whose calculation field was still false at
  // the claimed due instant; recomputing at that exact transition instant must
  // therefore confirm it flipped true, or the claimed fact is stale.
  if (finalValues[claimed.effect.calculationFieldId] !== true)
    return { outcome: "refused", reasonCode: "command_invalid" };

  const mergedValues: Record<string, unknown> = { ...claimed.existingValues, ...finalValues };
  const dueTransition = deriveEarliestPendingDeadlineTransitionV2({
    recordType: claimed.recordType,
    finalAuthoritativeFieldValues: mergedValues,
    organizationTimeZone: claimed.timeZone,
  });

  const transitioningField = claimed.recordType.fields.find(
    (field) => field.fieldId === claimed.effect.calculationFieldId,
  );
  const carriesPersonalData =
    transitioningField !== undefined &&
    "personalData" in transitioningField &&
    transitioningField.personalData !== "none";

  const activityId = activityIdSchema.parse((dependencies.activityId ?? randomUUID)());
  const occurrenceId = eventOccurrenceIdSchema.parse((dependencies.occurrenceId ?? randomUUID)());

  await transaction.query`set local role vortex_runtime`;
  const rows = await transaction.query<CloseRow>`
    select vortex_record.finalize_record_deadline_refresh(
      ${claimed.root.organizationId}::uuid,
      ${claimed.root.storageContractId}::uuid,
      ${claimed.root.recordId}::uuid,
      ${claimed.root.recordTypeId}::uuid,
      ${claimed.root.applicationRootId ?? null}::uuid,
      ${claimed.root.concurrencyNumber}::bigint,
      ${claimed.attribution.systemActorId}::uuid,
      ${claimed.effect.effectId}::uuid,
      ${claimed.effect.effectIdentity}::text,
      ${claimed.effect.calculationFieldId}::uuid,
      ${claimed.effect.transitionAt}::timestamptz,
      ${JSON.stringify(finalValues)}::text::jsonb,
      ${dueTransition === undefined ? null : JSON.stringify(dueTransition)}::text::jsonb,
      ${activityId}::uuid,
      ${occurrenceId}::uuid,
      ${carriesPersonalData}::boolean
    ) as result
  `;
  const candidate = one(rows).result;
  if (typeof candidate !== "object" || candidate === null)
    throw new Error("DEADLINE_CLOSURE_RESULT_INVALID");
  const value = candidate as Record<string, unknown>;

  if (value.outcome === "closed") {
    const recordId = typeof value.recordId === "string" ? value.recordId : undefined;
    const concurrencyNumber = safeConcurrencyNumber(value.concurrencyNumber);
    if (recordId === undefined || concurrencyNumber === undefined)
      throw new Error("DEADLINE_CLOSURE_RESULT_INVALID");
    return {
      outcome: "closed",
      recordId,
      concurrencyNumber,
      replayed: value.replayed === true,
    };
  }
  if (value.outcome === "conflict" && isConflictReasonCode(value.reasonCode))
    return { outcome: "conflict", reasonCode: value.reasonCode };
  if (value.outcome === "refused" && isRefusalReasonCode(value.reasonCode))
    return { outcome: "refused", reasonCode: value.reasonCode };
  throw new Error("DEADLINE_CLOSURE_RESULT_INVALID");
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
