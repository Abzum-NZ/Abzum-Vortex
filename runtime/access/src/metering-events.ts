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

const quantityKeys = new Set(["quantity"]);

const quantity = (value: unknown): unknown => {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && Math.abs(parsed) <= Number.MAX_SAFE_INTEGER ? parsed : value;
};

const normalizeStoredResult = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeStoredResult);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      quantityKeys.has(key) ? quantity(entry) : normalizeStoredResult(entry),
    ]),
  );
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

const runCommand = async <Result>(
  operation: () => Promise<readonly ResultRow[]>,
  schema: z.ZodType<Result>,
  conflictCode: string,
  unavailableCode: string,
): Promise<Result> => {
  try {
    return parseResult(await operation(), schema, unavailableCode);
  } catch (error) {
    if (error instanceof Error && error.message === unavailableCode) throw error;
    if (databaseCode(error) === "V3001") throw new Error(conflictCode);
    throw new Error(unavailableCode);
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
  if (!command.success) throw new Error("METERING_EVENT_COMMAND_INVALID");
  const value = command.data;
  return runCommand(
    () => transaction.query<ResultRow>`
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
        ${value.correctsMeteringEventId ?? null}::uuid
      )
    `,
    meteringEventRecordResultSchema,
    "METERING_EVENT_DUPLICATE_CONFLICTS",
    "METERING_EVENT_UNAVAILABLE",
  );
};

/** Re-exported so callers can name the output without reaching past this boundary. */
export type { MeteringEvent, RecordMeteringEventCommand };
