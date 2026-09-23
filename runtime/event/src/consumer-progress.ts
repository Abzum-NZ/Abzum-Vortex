import "server-only";

import {
  eventOccurrenceEnvelopeV2Schema,
  eventOccurrenceIdSchema,
  timestampSchema,
  type EventOccurrenceEnvelopeV2,
} from "@vortex/contracts";
import type { DatabaseRow, RuntimeDatabaseTransaction } from "@vortex/db";

export const eventConsumerProgressLimits = Object.freeze({
  maximumBatchSize: 100,
  maximumLeaseSeconds: 300,
  maximumCausalDepth: 16,
  maximumConsumerKeyLength: 128,
});

export const eventConsumerProgressErrorCodes = [
  "INVALID_EVENT_CONSUMER_PROGRESS_INPUT",
  "EVENT_CONSUMER_PROGRESS_STORAGE_UNAVAILABLE",
] as const;

export type EventConsumerProgressErrorCode = (typeof eventConsumerProgressErrorCodes)[number];

export class EventConsumerProgressError extends Error {
  readonly code: EventConsumerProgressErrorCode;

  constructor(code: EventConsumerProgressErrorCode) {
    super(code);
    this.name = "EventConsumerProgressError";
    this.code = code;
  }
}

export type EventConsumerClaimInput = Readonly<{
  consumerKey: string;
  batchSize: number;
  leaseSeconds: number;
}>;

export type EventConsumerLeaseRenewalInput = Readonly<{
  consumerKey: string;
  ackCursor: string;
  occurrenceId: string;
  leaseSeconds: number;
}>;

export type EventConsumerAcknowledgementInput = Readonly<{
  consumerKey: string;
  ackCursor: string;
  occurrenceId: string;
}>;

export type ClaimedEventOccurrence = Readonly<{
  occurrence: EventOccurrenceEnvelopeV2;
  causalDepth: number;
  leaseExpiresAt: string;
}>;

export type EventConsumerClaimResult = Readonly<{
  ackCursor: string | undefined;
  occurrences: readonly ClaimedEventOccurrence[];
}>;

export type EventConsumerLeaseRenewalResult =
  | Readonly<{ outcome: "renewed"; leaseExpiresAt: string }>
  | Readonly<{ outcome: "claim_unavailable" }>;

export type EventConsumerAcknowledgementResult = Readonly<{
  outcome: "acknowledged" | "already_acknowledged" | "claim_unavailable";
}>;

type ConsumerProgressRow = DatabaseRow & { readonly result: unknown };

const consumerKeyMatches = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= eventConsumerProgressLimits.maximumConsumerKeyLength &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

const uuidMatches = (value: unknown): value is string =>
  typeof value === "string" &&
  value !== "00000000-0000-0000-0000-000000000000" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const timestampMatches = (value: unknown): value is string =>
  timestampSchema.safeParse(value).success;

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

const requireOne = (rows: readonly ConsumerProgressRow[]): ConsumerProgressRow => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new EventConsumerProgressError("EVENT_CONSUMER_PROGRESS_STORAGE_UNAVAILABLE");
  return rows[0];
};

const inputInvalid = (): never => {
  throw new EventConsumerProgressError("INVALID_EVENT_CONSUMER_PROGRESS_INPUT");
};

const validateClaimInput = (input: EventConsumerClaimInput): EventConsumerClaimInput => {
  if (
    !consumerKeyMatches(input.consumerKey) ||
    !Number.isInteger(input.batchSize) ||
    input.batchSize < 1 ||
    input.batchSize > eventConsumerProgressLimits.maximumBatchSize ||
    !Number.isInteger(input.leaseSeconds) ||
    input.leaseSeconds < 1 ||
    input.leaseSeconds > eventConsumerProgressLimits.maximumLeaseSeconds
  )
    return inputInvalid();
  return input;
};

const validateLeaseRenewalInput = (
  input: EventConsumerLeaseRenewalInput,
): EventConsumerLeaseRenewalInput => {
  if (
    !consumerKeyMatches(input.consumerKey) ||
    !uuidMatches(input.ackCursor) ||
    !eventOccurrenceIdSchema.safeParse(input.occurrenceId).success ||
    !Number.isInteger(input.leaseSeconds) ||
    input.leaseSeconds < 1 ||
    input.leaseSeconds > eventConsumerProgressLimits.maximumLeaseSeconds
  )
    return inputInvalid();
  return input;
};

const validateAcknowledgementInput = (
  input: EventConsumerAcknowledgementInput,
): EventConsumerAcknowledgementInput => {
  if (
    !consumerKeyMatches(input.consumerKey) ||
    !uuidMatches(input.ackCursor) ||
    !eventOccurrenceIdSchema.safeParse(input.occurrenceId).success
  )
    return inputInvalid();
  return input;
};

/**
 * Storage orders claimed occurrences by microsecond `occurred_at`; `Date.parse`
 * keeps only milliseconds, so compare the exact instant including microseconds.
 */
const occurredAtMicros = (value: string): bigint | undefined => {
  const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (match === null) return undefined;
  const wholeSeconds = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(wholeSeconds)) return undefined;
  return BigInt(wholeSeconds) * 1_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
};

const parseClaimResult = (
  candidate: unknown,
  maximumOccurrenceCount: number,
): EventConsumerClaimResult => {
  const value = exactRecord(candidate, ["ackCursor", "occurrences"]);
  const occurrences = value && Array.isArray(value.occurrences) ? value.occurrences : undefined;
  const ackCursor = value?.ackCursor;
  const parsedOccurrences: ClaimedEventOccurrence[] = [];
  const occurrenceIds = new Set<string>();
  if (
    value === undefined ||
    occurrences === undefined ||
    occurrences.length > maximumOccurrenceCount ||
    !(ackCursor === null || uuidMatches(ackCursor)) ||
    (ackCursor === null) !== (occurrences.length === 0)
  )
    throw new EventConsumerProgressError("EVENT_CONSUMER_PROGRESS_STORAGE_UNAVAILABLE");
  for (const item of occurrences) {
    const claimed = exactRecord(item, ["occurrence", "causalDepth", "leaseExpiresAt"]);
    const occurrence = eventOccurrenceEnvelopeV2Schema.safeParse(claimed?.occurrence);
    if (
      claimed === undefined ||
      !occurrence.success ||
      !Number.isSafeInteger(claimed.causalDepth) ||
      (claimed.causalDepth as number) < 0 ||
      (claimed.causalDepth as number) > eventConsumerProgressLimits.maximumCausalDepth ||
      !timestampMatches(claimed.leaseExpiresAt) ||
      occurrenceIds.has(occurrence.data.occurrenceId)
    )
      throw new EventConsumerProgressError("EVENT_CONSUMER_PROGRESS_STORAGE_UNAVAILABLE");
    occurrenceIds.add(occurrence.data.occurrenceId);
    parsedOccurrences.push({
      occurrence: occurrence.data,
      causalDepth: claimed.causalDepth as number,
      leaseExpiresAt: claimed.leaseExpiresAt as string,
    });
  }
  if (
    parsedOccurrences.some((item, index) => {
      const previous = parsedOccurrences[index - 1];
      if (previous === undefined) return false;
      const previousMicros = occurredAtMicros(previous.occurrence.occurredAt);
      const itemMicros = occurredAtMicros(item.occurrence.occurredAt);
      return (
        previousMicros === undefined ||
        itemMicros === undefined ||
        previousMicros > itemMicros ||
        (previousMicros === itemMicros &&
          previous.occurrence.occurrenceId >= item.occurrence.occurrenceId)
      );
    })
  )
    throw new EventConsumerProgressError("EVENT_CONSUMER_PROGRESS_STORAGE_UNAVAILABLE");
  return {
    ackCursor: ackCursor === null ? undefined : ackCursor,
    occurrences: parsedOccurrences,
  };
};

const parseLeaseRenewalResult = (candidate: unknown): EventConsumerLeaseRenewalResult => {
  const unavailable = exactRecord(candidate, ["outcome"]);
  if (unavailable?.outcome === "claim_unavailable") return { outcome: "claim_unavailable" };
  const renewed = exactRecord(candidate, ["outcome", "leaseExpiresAt"]);
  if (renewed?.outcome === "renewed" && timestampMatches(renewed.leaseExpiresAt))
    return { outcome: "renewed", leaseExpiresAt: renewed.leaseExpiresAt };
  throw new EventConsumerProgressError("EVENT_CONSUMER_PROGRESS_STORAGE_UNAVAILABLE");
};

const parseAcknowledgementResult = (candidate: unknown): EventConsumerAcknowledgementResult => {
  const value = exactRecord(candidate, ["outcome"]);
  if (
    value?.outcome === "acknowledged" ||
    value?.outcome === "already_acknowledged" ||
    value?.outcome === "claim_unavailable"
  )
    return { outcome: value.outcome };
  throw new EventConsumerProgressError("EVENT_CONSUMER_PROGRESS_STORAGE_UNAVAILABLE");
};

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const mapFailure = (error: unknown): EventConsumerProgressError => {
  if (error instanceof EventConsumerProgressError) return error;
  if (databaseCode(error) === "22023")
    return new EventConsumerProgressError("INVALID_EVENT_CONSUMER_PROGRESS_INPUT");
  return new EventConsumerProgressError("EVENT_CONSUMER_PROGRESS_STORAGE_UNAVAILABLE");
};

export interface EventConsumerProgressRepository {
  claim(input: EventConsumerClaimInput): Promise<EventConsumerClaimResult>;
  renewLease(input: EventConsumerLeaseRenewalInput): Promise<EventConsumerLeaseRenewalResult>;
  acknowledge(
    input: EventConsumerAcknowledgementInput,
  ): Promise<EventConsumerAcknowledgementResult>;
}

/**
 * Event-owned runtime adapter.  The caller supplies the server-only runtime
 * transaction; this adapter never accepts a request context, direct SQL, or an
 * organisation selector from a consumer.
 */
export const createEventConsumerProgressRepository = (
  transaction: RuntimeDatabaseTransaction,
): EventConsumerProgressRepository =>
  Object.freeze({
    async claim(inputCandidate) {
      const input = validateClaimInput(inputCandidate);
      try {
        const rows = await transaction.query<ConsumerProgressRow>`
          select vortex_event.claim_consumer_occurrences(
            ${input.consumerKey}::text,
            ${input.batchSize}::integer,
            ${input.leaseSeconds}::integer
          ) as result
        `;
        return parseClaimResult(requireOne(rows).result, input.batchSize);
      } catch (error) {
        throw mapFailure(error);
      }
    },

    async renewLease(inputCandidate) {
      const input = validateLeaseRenewalInput(inputCandidate);
      try {
        const rows = await transaction.query<ConsumerProgressRow>`
          select vortex_event.renew_consumer_occurrence_lease(
            ${input.consumerKey}::text,
            ${input.ackCursor}::uuid,
            ${input.occurrenceId}::uuid,
            ${input.leaseSeconds}::integer
          ) as result
        `;
        return parseLeaseRenewalResult(requireOne(rows).result);
      } catch (error) {
        throw mapFailure(error);
      }
    },

    async acknowledge(inputCandidate) {
      const input = validateAcknowledgementInput(inputCandidate);
      try {
        const rows = await transaction.query<ConsumerProgressRow>`
          select vortex_event.acknowledge_consumer_occurrence(
            ${input.consumerKey}::text,
            ${input.ackCursor}::uuid,
            ${input.occurrenceId}::uuid
          ) as result
        `;
        return parseAcknowledgementResult(requireOne(rows).result);
      } catch (error) {
        throw mapFailure(error);
      }
    },
  });
