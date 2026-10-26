import "server-only";

import { eventOccurrenceIdSchema, timestampSchema } from "../catalogue/identifiers";
import { databaseCode, isNonNilUuidText, asRecord } from "../catalogue/runtime-primitives";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";

export const eventDeliveryRecoveryLimits = Object.freeze({
  maximumConsumerKeyLength: 128,
  minimumRetryAttempts: 1,
  maximumRetryAttempts: 20,
  minimumRetryBackoffSeconds: 1,
  maximumRetryBackoffSeconds: 86_400,
});

export const eventDeliveryFailureClassifications = [
  "transient_dependency_unavailable",
  "transient_timeout",
  "validation_rejected",
  "authorization_denied",
  "conflict_or_duplicate",
  "unclassified",
] as const;

export type EventDeliveryFailureClassification =
  (typeof eventDeliveryFailureClassifications)[number];

export const eventDeliveryRecoveryErrorCodes = [
  "INVALID_EVENT_DELIVERY_RECOVERY_INPUT",
  "EVENT_DELIVERY_RECOVERY_STORAGE_UNAVAILABLE",
] as const;

export type EventDeliveryRecoveryErrorCode = (typeof eventDeliveryRecoveryErrorCodes)[number];

export class EventDeliveryRecoveryError extends Error {
  readonly code: EventDeliveryRecoveryErrorCode;

  constructor(code: EventDeliveryRecoveryErrorCode) {
    super(code);
    this.name = "EventDeliveryRecoveryError";
    this.code = code;
  }
}

/**
 * Input identifies an existing event delivery claim by the same exact consumer and
 * occurrence identity the claim was issued under, authenticated by its claim
 * cursor. This never claims fresh work.
 *
 * `maxAttempts` counts total reported attempts including this one, so a budget
 * of one makes the first reported failure terminal. `retryBackoffSeconds` is
 * how long the reclaim lease is held before the same claim becomes eligible
 * for ordinary claim reclaim again.
 */
export type EventDeliveryFailureReportInput = Readonly<{
  consumerKey: string;
  occurrenceId: string;
  claimCursor: string;
  failureCode: EventDeliveryFailureClassification;
  maxAttempts: number;
  retryBackoffSeconds: number;
}>;

export type EventDeliveryFailureReportResult =
  | Readonly<{ outcome: "claim_unavailable" }>
  | Readonly<{ outcome: "mismatched" }>
  | Readonly<{ outcome: "already_acknowledged" }>
  | Readonly<{ outcome: "retry_scheduled"; failureCount: number; retryNotBefore: string }>
  | Readonly<{
      outcome: "terminal_failure";
      failureCount: number;
      failureCode: EventDeliveryFailureClassification;
    }>;

type DeliveryRecoveryRow = DatabaseRow & { readonly result: unknown };

const consumerKeyMatches = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= eventDeliveryRecoveryLimits.maximumConsumerKeyLength &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

const timestampMatches = (value: unknown): value is string =>
  timestampSchema.safeParse(value).success;

const failureClassificationMatches = (
  value: unknown,
): value is EventDeliveryFailureClassification =>
  typeof value === "string" &&
  (eventDeliveryFailureClassifications as readonly string[]).includes(value);

const boundedCount = (value: unknown, maximum: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;

const exactRecord = <Key extends string>(
  value: unknown,
  keys: readonly Key[],
): Readonly<Record<Key, unknown>> | undefined => {
  const candidate = asRecord(value);
  if (
    candidate === undefined ||
    Object.keys(candidate).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(candidate, key))
  )
    return undefined;
  return candidate as Readonly<Record<Key, unknown>>;
};

const requireOne = (rows: readonly DeliveryRecoveryRow[]): DeliveryRecoveryRow => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new EventDeliveryRecoveryError("EVENT_DELIVERY_RECOVERY_STORAGE_UNAVAILABLE");
  return rows[0];
};

const inputInvalid = (): never => {
  throw new EventDeliveryRecoveryError("INVALID_EVENT_DELIVERY_RECOVERY_INPUT");
};

const validateFailureReportInput = (
  input: EventDeliveryFailureReportInput,
): EventDeliveryFailureReportInput => {
  if (
    !consumerKeyMatches(input.consumerKey) ||
    !eventOccurrenceIdSchema.safeParse(input.occurrenceId).success ||
    !isNonNilUuidText(input.claimCursor) ||
    !failureClassificationMatches(input.failureCode) ||
    !Number.isInteger(input.maxAttempts) ||
    input.maxAttempts < eventDeliveryRecoveryLimits.minimumRetryAttempts ||
    input.maxAttempts > eventDeliveryRecoveryLimits.maximumRetryAttempts ||
    !Number.isInteger(input.retryBackoffSeconds) ||
    input.retryBackoffSeconds < eventDeliveryRecoveryLimits.minimumRetryBackoffSeconds ||
    input.retryBackoffSeconds > eventDeliveryRecoveryLimits.maximumRetryBackoffSeconds
  )
    return inputInvalid();
  return input;
};

const storageUnavailable = (): never => {
  throw new EventDeliveryRecoveryError("EVENT_DELIVERY_RECOVERY_STORAGE_UNAVAILABLE");
};

const parseFailureReportResult = (candidate: unknown): EventDeliveryFailureReportResult => {
  const unavailable = exactRecord(candidate, ["outcome"]);
  if (
    unavailable?.outcome === "claim_unavailable" ||
    unavailable?.outcome === "mismatched" ||
    unavailable?.outcome === "already_acknowledged"
  )
    return { outcome: unavailable.outcome };

  const terminal = exactRecord(candidate, ["outcome", "failureCount", "failureCode"]);
  if (
    terminal?.outcome === "terminal_failure" &&
    boundedCount(terminal.failureCount, eventDeliveryRecoveryLimits.maximumRetryAttempts) &&
    failureClassificationMatches(terminal.failureCode)
  )
    return {
      outcome: "terminal_failure",
      failureCount: terminal.failureCount,
      failureCode: terminal.failureCode,
    };

  const scheduled = exactRecord(candidate, ["outcome", "failureCount", "retryNotBefore"]);
  if (
    scheduled?.outcome === "retry_scheduled" &&
    boundedCount(scheduled.failureCount, eventDeliveryRecoveryLimits.maximumRetryAttempts) &&
    timestampMatches(scheduled.retryNotBefore)
  )
    return {
      outcome: "retry_scheduled",
      failureCount: scheduled.failureCount,
      retryNotBefore: scheduled.retryNotBefore,
    };

  return storageUnavailable();
};

const mapFailure = (error: unknown): EventDeliveryRecoveryError => {
  if (error instanceof EventDeliveryRecoveryError) return error;
  if (databaseCode(error) === "22023")
    return new EventDeliveryRecoveryError("INVALID_EVENT_DELIVERY_RECOVERY_INPUT");
  return new EventDeliveryRecoveryError("EVENT_DELIVERY_RECOVERY_STORAGE_UNAVAILABLE");
};

/**
 * Reports one failed delivery attempt against an existing claim. The caller supplies the
 * server-only runtime transaction; it never accepts a request context, direct SQL or an
 * organisation selector from a consumer, never claims fresh work and never mutates an event_outbox
 * row.
 */
export const reportEventDeliveryFailure = async (
  transaction: RequestDatabaseTransaction,
  inputCandidate: EventDeliveryFailureReportInput,
): Promise<EventDeliveryFailureReportResult> => {
  const input = validateFailureReportInput(inputCandidate);
  try {
    const rows = await transaction.query<DeliveryRecoveryRow>`
      select vortex_platform.record_consumer_occurrence_delivery_failure(
        ${input.consumerKey}::text,
        ${input.occurrenceId}::uuid,
        ${input.claimCursor}::uuid,
        ${input.failureCode}::text,
        ${input.maxAttempts}::integer,
        ${input.retryBackoffSeconds}::integer
      ) as result
    `;
    return parseFailureReportResult(requireOne(rows).result);
  } catch (error) {
    throw mapFailure(error);
  }
};
