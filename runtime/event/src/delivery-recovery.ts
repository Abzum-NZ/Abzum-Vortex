import "server-only";

import { actorIdSchema, eventOccurrenceIdSchema, timestampSchema } from "@vortex/contracts";
import type { DatabaseRow, RuntimeDatabaseTransaction } from "@vortex/db";

export const eventDeliveryRecoveryLimits = Object.freeze({
  maximumConsumerKeyLength: 128,
  minimumRetryAttempts: 1,
  maximumRetryAttempts: 20,
  minimumRetryBackoffSeconds: 1,
  maximumRetryBackoffSeconds: 86_400,
  /**
   * Platform ceiling on delivery claims for one occurrence, including
   * interrupted attempts that never reported a failure. Storage terminalises a
   * claim that reaches it, so a worker that keeps dying mid-delivery cannot
   * retry forever or block its record sequence indefinitely.
   */
  maximumDeliveryAttempts: 20,
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

/**
 * Why storage refused to treat a recovery request as authorised: the system
 * actor holds no grant for this consumer, or its grant was revoked. No consumer
 * or occurrence state is revealed alongside these; the grant is resolved before
 * the claim is read.
 */
export const eventDeliveryRecoveryRefusalReasons = [
  "authority_not_configured",
  "authority_revoked",
] as const;

export type EventDeliveryRecoveryRefusalReason =
  (typeof eventDeliveryRecoveryRefusalReasons)[number];

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
 *
 * `maxAttempts` counts total reported attempts including this one, so a budget
 * of one makes the first reported failure terminal. `retryBackoffSeconds` is
 * how long the reclaim lease is held before the same claim becomes eligible
 * for #639's ordinary reclaim again.
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
 * Explicit authorised recovery of one exhausted claim, addressed by the same
 * exact consumer and occurrence identity.
 *
 * `systemActorId` is the system actor the server already authenticated (the
 * event dispatcher's configured actor); it is never taken from a request.
 * Storage authorises the recovery only when Access's one system actor grant
 * registry holds an active grant for that actor scoped to this consumer, and
 * attributes the recovery to that actor. It never consults the database
 * session role or a service-role credential. `expectedFailureCount` guards
 * against acting on a stale view of the claim.
 */
export type EventDeliveryRecoveryInput = Readonly<{
  consumerKey: string;
  occurrenceId: string;
  expectedFailureCount: number;
  systemActorId: string;
}>;

export type EventDeliveryRecoveryResult =
  | Readonly<{ outcome: "claim_unavailable" }>
  | Readonly<{ outcome: "already_acknowledged" }>
  | Readonly<{ outcome: "active" }>
  | Readonly<{ outcome: "not_exhausted" }>
  | Readonly<{ outcome: "unauthorised"; reason: EventDeliveryRecoveryRefusalReason }>
  | Readonly<{ outcome: "stale"; failureCount: number }>
  | Readonly<{ outcome: "recovered"; recoveredBy: string; leaseExpiresAt: string }>;

export type EventDeliveryRecoveryListInput = Readonly<{
  consumerKey: string;
  limit: number;
}>;

export type TerminallyFailedConsumerOccurrence = Readonly<{
  occurrenceId: string;
  attemptCount: number;
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

const refusalReasonMatches = (value: unknown): value is EventDeliveryRecoveryRefusalReason =>
  typeof value === "string" &&
  (eventDeliveryRecoveryRefusalReasons as readonly string[]).includes(value);

const boundedCount = (value: unknown, maximum: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;

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
    !Number.isInteger(input.expectedFailureCount) ||
    input.expectedFailureCount < 0 ||
    input.expectedFailureCount > eventDeliveryRecoveryLimits.maximumRetryAttempts ||
    !actorIdSchema.safeParse(input.systemActorId).success
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

const parseRecoveryResult = (candidate: unknown): EventDeliveryRecoveryResult => {
  const stable = exactRecord(candidate, ["outcome"]);
  if (
    stable?.outcome === "claim_unavailable" ||
    stable?.outcome === "already_acknowledged" ||
    stable?.outcome === "active" ||
    stable?.outcome === "not_exhausted"
  )
    return { outcome: stable.outcome };

  const unauthorised = exactRecord(candidate, ["outcome", "reason"]);
  if (unauthorised?.outcome === "unauthorised" && refusalReasonMatches(unauthorised.reason))
    return { outcome: "unauthorised", reason: unauthorised.reason };

  const stale = exactRecord(candidate, ["outcome", "failureCount"]);
  if (
    stale?.outcome === "stale" &&
    boundedCount(stale.failureCount, eventDeliveryRecoveryLimits.maximumRetryAttempts)
  )
    return { outcome: "stale", failureCount: stale.failureCount };

  const recovered = exactRecord(candidate, ["outcome", "recoveredBy", "leaseExpiresAt"]);
  if (
    recovered?.outcome === "recovered" &&
    actorIdSchema.safeParse(recovered.recoveredBy).success &&
    timestampMatches(recovered.leaseExpiresAt)
  )
    return {
      outcome: "recovered",
      recoveredBy: recovered.recoveredBy as string,
      leaseExpiresAt: recovered.leaseExpiresAt,
    };

  return storageUnavailable();
};

const parseTerminallyFailedList = (
  candidate: unknown,
  maximumCount: number,
): readonly TerminallyFailedConsumerOccurrence[] => {
  if (!Array.isArray(candidate) || candidate.length > maximumCount) return storageUnavailable();
  const occurrenceIds = new Set<string>();
  return Object.freeze(
    candidate.map((item) => {
      const entry = exactRecord(item, [
        "occurrenceId",
        "attemptCount",
        "failureCount",
        "lastFailureCode",
        "lastFailedAt",
        "terminallyFailedAt",
        "claimedAt",
      ]);
      if (
        entry === undefined ||
        !eventOccurrenceIdSchema.safeParse(entry.occurrenceId).success ||
        occurrenceIds.has(entry.occurrenceId as string) ||
        !boundedCount(entry.attemptCount, eventDeliveryRecoveryLimits.maximumDeliveryAttempts) ||
        !boundedCount(entry.failureCount, eventDeliveryRecoveryLimits.maximumRetryAttempts) ||
        !failureClassificationMatches(entry.lastFailureCode) ||
        !timestampMatches(entry.lastFailedAt) ||
        !timestampMatches(entry.terminallyFailedAt) ||
        !timestampMatches(entry.claimedAt)
      )
        return storageUnavailable();
      occurrenceIds.add(entry.occurrenceId as string);
      return Object.freeze({
        occurrenceId: entry.occurrenceId as string,
        attemptCount: entry.attemptCount as number,
        failureCount: entry.failureCount as number,
        lastFailureCode: entry.lastFailureCode as EventDeliveryFailureClassification,
        lastFailedAt: entry.lastFailedAt as string,
        terminallyFailedAt: entry.terminallyFailedAt as string,
        claimedAt: entry.claimedAt as string,
      });
    }),
  );
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
  /**
   * Requests recovery of one exhausted claim. Storage refuses unless the named
   * system actor holds an active system actor grant scoped to the consumer, so
   * naming an actor confers nothing by itself.
   */
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
 * consumer. Recovery authority is only ever a stored system actor grant. It
 * never claims fresh work or mutates an event_outbox row.
 */
export const createEventDeliveryRecoveryRepository = (
  transaction: RuntimeDatabaseTransaction,
): EventDeliveryRecoveryRepository =>
  Object.freeze<EventDeliveryRecoveryRepository>({
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
            ${input.expectedFailureCount}::integer,
            ${input.systemActorId}::uuid
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
