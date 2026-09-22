import "server-only";

import { actorIdSchema, eventOccurrenceIdSchema, timestampSchema } from "@vortex/contracts";
import type { DatabaseRow, RuntimeDatabaseTransaction } from "@vortex/db";

export const eventDeliveryRecoveryLimits = Object.freeze({
  maximumConsumerKeyLength: 128,
  minimumRetryAttempts: 1,
  maximumRetryAttempts: 20,
  minimumRetryBackoffSeconds: 1,
  maximumRetryBackoffSeconds: 86_400,
  maximumTerminalListLimit: 100,
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
 * Input identifies an existing #639 claim by the same exact consumer and
 * occurrence identity the claim was issued under, authenticated by its claim
 * cursor. This never claims fresh work.
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

/**
 * Explicit authorised operator recovery of one exhausted claim, addressed by
 * the same exact consumer and occurrence identity. `expectedFailureCount`
 * guards against acting on a stale view of the claim.
 */
export type EventDeliveryRecoveryInput = Readonly<{
  consumerKey: string;
  occurrenceId: string;
  operatorActorId: string;
  expectedFailureCount: number;
}>;

export type EventDeliveryRecoveryResult =
  | Readonly<{ outcome: "claim_unavailable" }>
  | Readonly<{ outcome: "already_acknowledged" }>
  | Readonly<{ outcome: "active" }>
  | Readonly<{ outcome: "unauthorised" }>
  | Readonly<{ outcome: "stale"; failureCount: number }>
  | Readonly<{ outcome: "recovered"; leaseExpiresAt: string }>;

export type EventDeliveryRecoveryListInput = Readonly<{
  consumerKey: string;
  limit: number;
}>;

export type TerminallyFailedConsumerOccurrence = Readonly<{
  occurrenceId: string;
  failureCount: number;
  lastFailureCode: EventDeliveryFailureClassification;
  lastFailedAt: string;
  terminallyFailedAt: string;
  claimedAt: string;
}>;

type DeliveryRecoveryRow = DatabaseRow & { readonly result: unknown };

const consumerKeyMatches = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= eventDeliveryRecoveryLimits.maximumConsumerKeyLength &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

const uuidMatches = (value: unknown): value is string =>
  typeof value === "string" &&
  value !== "00000000-0000-0000-0000-000000000000" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const timestampMatches = (value: unknown): value is string =>
  timestampSchema.safeParse(value).success;

const failureClassificationMatches = (
  value: unknown,
): value is EventDeliveryFailureClassification =>
  typeof value === "string" &&
  (eventDeliveryFailureClassifications as readonly string[]).includes(value);

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const exactRecord = <Key extends string>(
  value: unknown,
  keys: readonly Key[],
): Readonly<Record<Key, unknown>> | undefined => {
  const candidate = record(value);
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
    !uuidMatches(input.claimCursor) ||
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

const validateRecoveryInput = (input: EventDeliveryRecoveryInput): EventDeliveryRecoveryInput => {
  if (
    !consumerKeyMatches(input.consumerKey) ||
    !eventOccurrenceIdSchema.safeParse(input.occurrenceId).success ||
    !actorIdSchema.safeParse(input.operatorActorId).success ||
    !Number.isInteger(input.expectedFailureCount) ||
    input.expectedFailureCount < 0
  )
    return inputInvalid();
  return input;
};

const validateListInput = (
  input: EventDeliveryRecoveryListInput,
): EventDeliveryRecoveryListInput => {
  if (
    !consumerKeyMatches(input.consumerKey) ||
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > eventDeliveryRecoveryLimits.maximumTerminalListLimit
  )
    return inputInvalid();
  return input;
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
    Number.isSafeInteger(terminal.failureCount) &&
    (terminal.failureCount as number) >= 0 &&
    failureClassificationMatches(terminal.failureCode)
  )
    return {
      outcome: "terminal_failure",
      failureCount: terminal.failureCount as number,
      failureCode: terminal.failureCode,
    };

  const scheduled = exactRecord(candidate, ["outcome", "failureCount", "retryNotBefore"]);
  if (
    scheduled?.outcome === "retry_scheduled" &&
    Number.isSafeInteger(scheduled.failureCount) &&
    (scheduled.failureCount as number) >= 0 &&
    timestampMatches(scheduled.retryNotBefore)
  )
    return {
      outcome: "retry_scheduled",
      failureCount: scheduled.failureCount as number,
      retryNotBefore: scheduled.retryNotBefore,
    };

  throw new EventDeliveryRecoveryError("EVENT_DELIVERY_RECOVERY_STORAGE_UNAVAILABLE");
};

const parseRecoveryResult = (candidate: unknown): EventDeliveryRecoveryResult => {
  const stable = exactRecord(candidate, ["outcome"]);
  if (
    stable?.outcome === "claim_unavailable" ||
    stable?.outcome === "already_acknowledged" ||
    stable?.outcome === "active" ||
    stable?.outcome === "unauthorised"
  )
    return { outcome: stable.outcome };

  const stale = exactRecord(candidate, ["outcome", "failureCount"]);
  if (
    stale?.outcome === "stale" &&
    Number.isSafeInteger(stale.failureCount) &&
    (stale.failureCount as number) >= 0
  )
    return { outcome: "stale", failureCount: stale.failureCount as number };

  const recovered = exactRecord(candidate, ["outcome", "leaseExpiresAt"]);
  if (recovered?.outcome === "recovered" && timestampMatches(recovered.leaseExpiresAt))
    return { outcome: "recovered", leaseExpiresAt: recovered.leaseExpiresAt };

  throw new EventDeliveryRecoveryError("EVENT_DELIVERY_RECOVERY_STORAGE_UNAVAILABLE");
};

const parseTerminallyFailedList = (
  candidate: unknown,
  maximumCount: number,
): readonly TerminallyFailedConsumerOccurrence[] => {
  if (!Array.isArray(candidate) || candidate.length > maximumCount)
    throw new EventDeliveryRecoveryError("EVENT_DELIVERY_RECOVERY_STORAGE_UNAVAILABLE");
  return candidate.map((item) => {
    const entry = exactRecord(item, [
      "occurrenceId",
      "failureCount",
      "lastFailureCode",
      "lastFailedAt",
      "terminallyFailedAt",
      "claimedAt",
    ]);
    if (
      entry === undefined ||
      !eventOccurrenceIdSchema.safeParse(entry.occurrenceId).success ||
      !Number.isSafeInteger(entry.failureCount) ||
      (entry.failureCount as number) < 0 ||
      !failureClassificationMatches(entry.lastFailureCode) ||
      !timestampMatches(entry.lastFailedAt) ||
      !timestampMatches(entry.terminallyFailedAt) ||
      !timestampMatches(entry.claimedAt)
    )
      throw new EventDeliveryRecoveryError("EVENT_DELIVERY_RECOVERY_STORAGE_UNAVAILABLE");
    return {
      occurrenceId: entry.occurrenceId as string,
      failureCount: entry.failureCount as number,
      lastFailureCode: entry.lastFailureCode as EventDeliveryFailureClassification,
      lastFailedAt: entry.lastFailedAt as string,
      terminallyFailedAt: entry.terminallyFailedAt as string,
      claimedAt: entry.claimedAt as string,
    };
  });
};

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const mapFailure = (error: unknown): EventDeliveryRecoveryError => {
  if (error instanceof EventDeliveryRecoveryError) return error;
  if (databaseCode(error) === "22023")
    return new EventDeliveryRecoveryError("INVALID_EVENT_DELIVERY_RECOVERY_INPUT");
  return new EventDeliveryRecoveryError("EVENT_DELIVERY_RECOVERY_STORAGE_UNAVAILABLE");
};

export interface EventDeliveryRecoveryRepository {
  /** Reports one failed delivery attempt against an existing claim. */
  reportFailure(input: EventDeliveryFailureReportInput): Promise<EventDeliveryFailureReportResult>;
  /** Explicit authorised operator recovery of one exhausted claim. */
  recoverClaim(input: EventDeliveryRecoveryInput): Promise<EventDeliveryRecoveryResult>;
  /** Bounded inspection of currently exhausted, replayable claims. */
  listTerminallyFailed(
    input: EventDeliveryRecoveryListInput,
  ): Promise<readonly TerminallyFailedConsumerOccurrence[]>;
}

/**
 * Event-owned runtime adapter over the #639 consumer claim/lease row. The
 * caller supplies the server-only runtime transaction; this adapter never
 * accepts a request context, direct SQL or an organisation selector from a
 * consumer, and it never claims fresh work or mutates an event_outbox row.
 */
export const createEventDeliveryRecoveryRepository = (
  transaction: RuntimeDatabaseTransaction,
): EventDeliveryRecoveryRepository =>
  Object.freeze({
    async reportFailure(inputCandidate) {
      const input = validateFailureReportInput(inputCandidate);
      try {
        const rows = await transaction.query<DeliveryRecoveryRow>`
          select vortex_event.record_consumer_occurrence_delivery_failure(
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
    },

    async recoverClaim(inputCandidate) {
      const input = validateRecoveryInput(inputCandidate);
      try {
        const rows = await transaction.query<DeliveryRecoveryRow>`
          select vortex_event.recover_consumer_occurrence_claim(
            ${input.consumerKey}::text,
            ${input.occurrenceId}::uuid,
            ${input.operatorActorId}::uuid,
            ${input.expectedFailureCount}::integer
          ) as result
        `;
        return parseRecoveryResult(requireOne(rows).result);
      } catch (error) {
        throw mapFailure(error);
      }
    },

    async listTerminallyFailed(inputCandidate) {
      const input = validateListInput(inputCandidate);
      try {
        const rows = await transaction.query<DeliveryRecoveryRow>`
          select vortex_event.list_terminally_failed_consumer_occurrences(
            ${input.consumerKey}::text,
            ${input.limit}::integer
          ) as result
        `;
        return parseTerminallyFailedList(requireOne(rows).result, input.limit);
      } catch (error) {
        throw mapFailure(error);
      }
    },
  });
