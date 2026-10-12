import "server-only";

import { z } from "zod";
import {
  meteringEventSchema,
  recordMeteringEventCommandSchema,
  type MeteringEvent,
  type RecordMeteringEventCommand,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

/**
 * Exactly one immutable MeteringEvent per accepted command. A replayed duplicate
 * key returns the original stored event with `replayed`; it is never re-counted.
 */
export const meteringEventRecordResultSchema = z
  .object({
    status: z.enum(["accepted", "replayed"]),
    event: meteringEventSchema,
  })
  .strict();

export type MeteringEventRecordResult = z.infer<typeof meteringEventRecordResultSchema>;

type ResultRow = DatabaseRow & { result: unknown };

// Only the event's own quantity is a numeric fact; dimension values are returned
// exactly as stored, even when a dimension happens to be named `quantity`.
const normalizeStoredResult = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value;
  const event = (value as { readonly event?: unknown }).event;
  if (typeof event !== "object" || event === null) return value;
  const quantity = (event as { readonly quantity?: unknown }).quantity;
  if (typeof quantity !== "string") return value;
  const parsed = Number(quantity.trim());
  return Number.isFinite(parsed) && Math.abs(parsed) <= Number.MAX_SAFE_INTEGER
    ? { ...value, event: { ...event, quantity: parsed } }
    : value;
};

const parseResult = <Result>(
  rows: readonly ResultRow[],
  schema: z.ZodType<Result>,
  errorCode: string,
): Result => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error(errorCode);
  const parsed = schema.safeParse(normalizeStoredResult(rows[0].result));
  if (!parsed.success) throw new Error(errorCode);
  return parsed.data;
};

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

/** Stable safe failures; database detail never crosses this boundary. */
export const meteringEventErrorCodes = Object.freeze({
  invalid: "METERING_EVENT_COMMAND_INVALID",
  conflict: "METERING_EVENT_CONFLICTS",
  scopeUnavailable: "METERING_EVENT_SCOPE_UNAVAILABLE",
  unavailable: "METERING_EVENT_UNAVAILABLE",
} as const);

export type MeteringEventErrorCode =
  (typeof meteringEventErrorCodes)[keyof typeof meteringEventErrorCodes];

const failureFor = (error: unknown): MeteringEventErrorCode => {
  switch (databaseCode(error)) {
    case "V3001":
      return meteringEventErrorCodes.conflict;
    case "22023":
      return meteringEventErrorCodes.invalid;
    case "42501":
      return meteringEventErrorCodes.scopeUnavailable;
    default:
      return meteringEventErrorCodes.unavailable;
  }
};

/**
 * Appends one immutable metering event for a final committed operation. The
 * command's tenant, organisation and correlation are cross-checked against the
 * established request context, so a caller cannot attribute usage elsewhere.
 */
export const recordMeteringEvent = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: RecordMeteringEventCommand,
): Promise<MeteringEventRecordResult> => {
  const command = recordMeteringEventCommandSchema.safeParse(commandCandidate);
  if (!command.success) throw new Error(meteringEventErrorCodes.invalid);
  const value = command.data;
  let rows: readonly ResultRow[];
  try {
    rows = await transaction.query<ResultRow>`
      select result from vortex_access.record_metering_event(
        ${value.tenantId}::uuid,
        ${value.organizationId ?? null}::uuid,
        ${value.allocationOwner}::text,
        ${value.operationId}::uuid,
        ${value.capabilityKey}::text,
        ${value.quantity}::numeric,
        ${value.unit}::text,
        ${value.source}::text,
        ${JSON.stringify(value.dimensions)}::text::jsonb,
        ${value.occurredAt}::timestamptz,
        ${value.sourceEventId ?? null}::uuid,
        ${value.duplicateProtectionKey}::text,
        ${value.correlationId}::uuid,
        ${value.correctsMeteringEventId ?? null}::uuid,
        ${value.correctionDirection ?? null}::text
      )
    `;
  } catch (error) {
    throw new Error(failureFor(error));
  }
  return parseResult(rows, meteringEventRecordResultSchema, meteringEventErrorCodes.unavailable);
};

/** Re-exported so callers can name the output without reaching past this boundary. */
export type { MeteringEvent, RecordMeteringEventCommand };
