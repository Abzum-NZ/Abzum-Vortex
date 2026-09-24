import "server-only";

import { z } from "zod";
import {
  builderKeySchema,
  correlationIdSchema,
  namespacedKeySchema,
  organizationIdSchema,
  platformIdSchema,
  revisionSchema,
  tenantIdSchema,
  timestampSchema,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import {
  capabilityPolicyAppliedScopeSchema,
  capabilityPolicyQuantitySchema,
  effectiveCapabilityPolicySchema,
} from "./capability-policy";

/** Running totals retain PostgreSQL's exact numeric text, including values above JS's safe range. */
const storedQuantitySchema = z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/);
const reservationQuantitySchema = capabilityPolicyQuantitySchema.max(Number.MAX_SAFE_INTEGER);

/** Current evidence only; it never grants capability authority. */
export const capabilityBalanceSchema = z
  .object({
    policyLimit: capabilityPolicyQuantitySchema,
    activeReservedQuantity: storedQuantitySchema,
    consumedQuantity: storedQuantitySchema,
    releasedQuantity: storedQuantitySchema,
    availableQuantity: storedQuantitySchema,
  })
  .strict();

export const capabilityPolicyEvidenceSchema = z
  .object({
    policyId: platformIdSchema,
    policyRevision: revisionSchema,
    assignmentId: platformIdSchema,
    assignmentRevision: revisionSchema,
    appliedScope: capabilityPolicyAppliedScopeSchema,
    capabilityKey: namespacedKeySchema,
    unit: builderKeySchema,
  })
  .strict();

/**
 * The #649 result supplies only the requested scope. Reservation authority and
 * every policy field are resolved again from current storage under lock.
 */
export const reserveCapabilityCommandSchema = z
  .object({
    policy: effectiveCapabilityPolicySchema,
    requestedQuantity: reservationQuantitySchema,
    duplicateKey: platformIdSchema,
  })
  .strict();

const reservationRefusalSchema = z
  .object({
    outcome: z.literal("refused"),
    status: z.enum(["accepted", "replayed"]),
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema.optional(),
    capabilityKey: namespacedKeySchema,
    unit: builderKeySchema,
    policyId: platformIdSchema.optional(),
    policyRevision: revisionSchema.optional(),
    assignmentId: platformIdSchema.optional(),
    assignmentRevision: revisionSchema.optional(),
    appliedScope: capabilityPolicyAppliedScopeSchema.optional(),
    requestedQuantity: reservationQuantitySchema,
    reasonCode: z.enum(["insufficient_capacity", "capability_not_assigned", "policy_stale"]),
    decidedAt: timestampSchema,
    correlationId: correlationIdSchema,
    balance: capabilityBalanceSchema.optional(),
  })
  .strict();

export const capabilityReservationResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("reserved"),
      status: z.enum(["accepted", "replayed"]),
      reservationId: platformIdSchema,
      tenantId: tenantIdSchema,
      organizationId: organizationIdSchema.optional(),
      capabilityKey: namespacedKeySchema,
      unit: builderKeySchema,
      policyId: platformIdSchema,
      policyRevision: revisionSchema,
      assignmentId: platformIdSchema,
      assignmentRevision: revisionSchema,
      appliedScope: capabilityPolicyAppliedScopeSchema,
      reservedQuantity: reservationQuantitySchema,
      reservedAt: timestampSchema,
      expiresAt: timestampSchema,
      correlationId: correlationIdSchema,
      balance: capabilityBalanceSchema,
    })
    .strict(),
  reservationRefusalSchema,
]);

export const consumeCapabilityReservationCommandSchema = z
  .object({
    reservationId: platformIdSchema,
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema.optional(),
    capabilityKey: namespacedKeySchema,
    unit: builderKeySchema,
    policyId: platformIdSchema,
    policyRevision: revisionSchema,
    assignmentId: platformIdSchema,
    assignmentRevision: revisionSchema,
    quantity: reservationQuantitySchema,
    duplicateKey: platformIdSchema,
  })
  .strict();

const reservationOperationRefusalSchema = z
  .object({
    outcome: z.literal("refused"),
    status: z.enum(["accepted", "replayed"]),
    reservationId: platformIdSchema,
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema.optional(),
    capabilityKey: namespacedKeySchema,
    unit: builderKeySchema,
    reasonCode: z.enum([
      "reservation_unavailable",
      "reservation_stale",
      "insufficient_reserved_quantity",
    ]),
    decidedAt: timestampSchema,
    correlationId: correlationIdSchema,
  })
  .strict();

export const capabilityConsumptionResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("consumed"),
      status: z.enum(["accepted", "replayed"]),
      reservationId: platformIdSchema,
      tenantId: tenantIdSchema,
      organizationId: organizationIdSchema.optional(),
      capabilityKey: namespacedKeySchema,
      unit: builderKeySchema,
      policyId: platformIdSchema,
      policyRevision: revisionSchema,
      assignmentId: platformIdSchema,
      assignmentRevision: revisionSchema,
      appliedScope: capabilityPolicyAppliedScopeSchema,
      consumedAmount: reservationQuantitySchema,
      totalConsumedQuantity: storedQuantitySchema,
      remainingReservedQuantity: storedQuantitySchema,
      reservationState: z.enum(["active", "consumed"]),
      consumedAt: timestampSchema,
      correlationId: correlationIdSchema,
      balance: capabilityBalanceSchema,
    })
    .strict(),
  reservationOperationRefusalSchema,
]);

export const releaseCapabilityReservationCommandSchema = z
  .object({
    reservationId: platformIdSchema,
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema.optional(),
    capabilityKey: namespacedKeySchema,
    unit: builderKeySchema,
    policyId: platformIdSchema,
    policyRevision: revisionSchema,
    assignmentId: platformIdSchema,
    assignmentRevision: revisionSchema,
    quantity: reservationQuantitySchema.optional(),
    duplicateKey: platformIdSchema,
  })
  .strict();

export const capabilityReleaseResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("released"),
      status: z.enum(["accepted", "replayed"]),
      reservationId: platformIdSchema,
      tenantId: tenantIdSchema,
      organizationId: organizationIdSchema.optional(),
      capabilityKey: namespacedKeySchema,
      unit: builderKeySchema,
      policyId: platformIdSchema,
      policyRevision: revisionSchema,
      assignmentId: platformIdSchema,
      assignmentRevision: revisionSchema,
      appliedScope: capabilityPolicyAppliedScopeSchema,
      releasedAmount: reservationQuantitySchema,
      totalReleasedQuantity: storedQuantitySchema,
      remainingReservedQuantity: storedQuantitySchema,
      reservationState: z.enum(["active", "released"]),
      releasedAt: timestampSchema,
      correlationId: correlationIdSchema,
      balance: capabilityBalanceSchema,
    })
    .strict(),
  reservationOperationRefusalSchema,
]);

export const readCapabilityBalanceRequestSchema = z
  .object({
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema.optional(),
    capabilityKey: namespacedKeySchema,
    unit: builderKeySchema,
  })
  .strict();

export const capabilityBalanceRecordSchema = z
  .object({
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema.optional(),
    capabilityKey: namespacedKeySchema,
    unit: builderKeySchema,
    policyId: platformIdSchema,
    policyRevision: revisionSchema,
    assignmentId: platformIdSchema,
    assignmentRevision: revisionSchema,
    appliedScope: capabilityPolicyAppliedScopeSchema,
    balance: capabilityBalanceSchema,
    evaluatedAt: timestampSchema,
  })
  .strict();

export const expireStaleCapabilityReservationsCommandSchema = z
  .object({
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema.optional(),
    capabilityKey: namespacedKeySchema,
    unit: builderKeySchema,
  })
  .strict();

export const expireStaleCapabilityReservationsResultSchema = z
  .object({
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema.optional(),
    capabilityKey: namespacedKeySchema,
    unit: builderKeySchema,
    expiredCount: z.number().int().nonnegative(),
    expiredAt: timestampSchema,
    correlationId: correlationIdSchema,
  })
  .strict();

export type CapabilityBalance = z.infer<typeof capabilityBalanceSchema>;
export type CapabilityPolicyEvidence = z.infer<typeof capabilityPolicyEvidenceSchema>;
export type ReserveCapabilityCommand = z.infer<typeof reserveCapabilityCommandSchema>;
export type CapabilityReservationResult = z.infer<typeof capabilityReservationResultSchema>;
export type ConsumeCapabilityReservationCommand = z.infer<
  typeof consumeCapabilityReservationCommandSchema
>;
export type CapabilityConsumptionResult = z.infer<typeof capabilityConsumptionResultSchema>;
export type ReleaseCapabilityReservationCommand = z.infer<
  typeof releaseCapabilityReservationCommandSchema
>;
export type CapabilityReleaseResult = z.infer<typeof capabilityReleaseResultSchema>;
export type ReadCapabilityBalanceRequest = z.infer<typeof readCapabilityBalanceRequestSchema>;
export type CapabilityBalanceRecord = z.infer<typeof capabilityBalanceRecordSchema>;
export type ExpireStaleCapabilityReservationsCommand = z.infer<
  typeof expireStaleCapabilityReservationsCommandSchema
>;
export type ExpireStaleCapabilityReservationsResult = z.infer<
  typeof expireStaleCapabilityReservationsResultSchema
>;

type ResultRow = DatabaseRow & { result: unknown };

const decimalPattern = /^[+-]?\d+(?:\.\d*)?$/;

const canonicalDecimal = (text: string): string | undefined => {
  if (!decimalPattern.test(text)) return undefined;
  const digits = text.replace(/^[+-]/, "");
  const [whole = "", fraction = ""] = digits.split(".");
  const significantWhole = whole.replace(/^0+(?=\d)/, "");
  const significantFraction = fraction.replace(/0+$/, "");
  const magnitude =
    significantFraction === "" ? significantWhole : `${significantWhole}.${significantFraction}`;
  return `${text.startsWith("-") && /[1-9]/.test(digits) ? "-" : ""}${magnitude}`;
};

/** Refuse any PostgreSQL numeric that would change meaning as a JS number. */
const quantity = (value: unknown): unknown => {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;
  const canonical = canonicalDecimal(value.trim());
  if (canonical === undefined) return value;
  const parsed = Number(canonical);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > Number.MAX_SAFE_INTEGER) return value;
  return canonicalDecimal(String(parsed)) === canonical ? parsed : value;
};

const revision = (value: unknown): unknown => {
  if (typeof value === "number") return value;
  if (typeof value === "bigint")
    return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return value;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : value;
};

const storedQuantityKeys = new Set([
  "activeReservedQuantity",
  "consumedQuantity",
  "releasedQuantity",
  "availableQuantity",
  "totalConsumedQuantity",
  "remainingReservedQuantity",
  "totalReleasedQuantity",
]);
const quantityKeys = new Set([
  "policyLimit",
  "requestedQuantity",
  "reservedQuantity",
  "consumedAmount",
  "releasedAmount",
]);
const revisionKeys = new Set(["policyRevision", "assignmentRevision"]);

const normalizeStoredResult = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeStoredResult);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      storedQuantityKeys.has(key)
        ? entry
        : quantityKeys.has(key)
          ? quantity(entry)
          : revisionKeys.has(key)
            ? revision(entry)
            : normalizeStoredResult(entry),
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

export const reserveCapabilityQuantity = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: ReserveCapabilityCommand,
): Promise<CapabilityReservationResult> => {
  const command = reserveCapabilityCommandSchema.safeParse(commandCandidate);
  if (!command.success) throw new Error("CAPABILITY_RESERVATION_COMMAND_INVALID");
  const value = command.data;
  return runCommand(
    () => transaction.query<ResultRow>`
      select result from vortex_access.reserve_capability_quantity(
        ${value.policy.tenantId}::uuid,
        ${value.policy.organizationId ?? null}::uuid,
        ${value.policy.capabilityKey}::text,
        ${value.policy.unit}::text,
        ${JSON.stringify(value.policy)}::text::jsonb,
        ${value.requestedQuantity}::numeric,
        ${value.duplicateKey}::uuid
      )
    `,
    capabilityReservationResultSchema,
    "CAPABILITY_RESERVATION_DUPLICATE_CONFLICTS",
    "CAPABILITY_RESERVATION_UNAVAILABLE",
  );
};

export const consumeCapabilityReservation = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: ConsumeCapabilityReservationCommand,
): Promise<CapabilityConsumptionResult> => {
  const command = consumeCapabilityReservationCommandSchema.safeParse(commandCandidate);
  if (!command.success) throw new Error("CAPABILITY_CONSUMPTION_COMMAND_INVALID");
  const value = command.data;
  return runCommand(
    () => transaction.query<ResultRow>`
      select result from vortex_access.consume_capability_reservation(
        ${value.tenantId}::uuid,
        ${value.organizationId ?? null}::uuid,
        ${value.capabilityKey}::text,
        ${value.unit}::text,
        ${value.policyId}::uuid,
        ${value.policyRevision}::bigint,
        ${value.assignmentId}::uuid,
        ${value.assignmentRevision}::bigint,
        ${value.reservationId}::uuid,
        ${value.quantity}::numeric,
        ${value.duplicateKey}::uuid
      )
    `,
    capabilityConsumptionResultSchema,
    "CAPABILITY_CONSUMPTION_DUPLICATE_CONFLICTS",
    "CAPABILITY_CONSUMPTION_UNAVAILABLE",
  );
};

export const releaseCapabilityReservation = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: ReleaseCapabilityReservationCommand,
): Promise<CapabilityReleaseResult> => {
  const command = releaseCapabilityReservationCommandSchema.safeParse(commandCandidate);
  if (!command.success) throw new Error("CAPABILITY_RELEASE_COMMAND_INVALID");
  const value = command.data;
  return runCommand(
    () => transaction.query<ResultRow>`
      select result from vortex_access.release_capability_reservation(
        ${value.tenantId}::uuid,
        ${value.organizationId ?? null}::uuid,
        ${value.capabilityKey}::text,
        ${value.unit}::text,
        ${value.policyId}::uuid,
        ${value.policyRevision}::bigint,
        ${value.assignmentId}::uuid,
        ${value.assignmentRevision}::bigint,
        ${value.reservationId}::uuid,
        ${value.duplicateKey}::uuid,
        ${value.quantity ?? null}::numeric
      )
    `,
    capabilityReleaseResultSchema,
    "CAPABILITY_RELEASE_DUPLICATE_CONFLICTS",
    "CAPABILITY_RELEASE_UNAVAILABLE",
  );
};

export const readCapabilityBalance = async (
  transaction: RequestDatabaseTransaction,
  requestCandidate: ReadCapabilityBalanceRequest,
): Promise<CapabilityBalanceRecord> => {
  const request = readCapabilityBalanceRequestSchema.safeParse(requestCandidate);
  if (!request.success) throw new Error("CAPABILITY_BALANCE_REQUEST_INVALID");
  const value = request.data;
  try {
    const rows = await transaction.query<ResultRow>`
      select result from vortex_access.read_capability_reservation_balance(
        ${value.tenantId}::uuid,
        ${value.organizationId ?? null}::uuid,
        ${value.capabilityKey}::text,
        ${value.unit}::text
      )
    `;
    return parseResult(rows, capabilityBalanceRecordSchema, "CAPABILITY_BALANCE_UNAVAILABLE");
  } catch (error) {
    if (error instanceof Error && error.message === "CAPABILITY_BALANCE_UNAVAILABLE") throw error;
    throw new Error("CAPABILITY_BALANCE_UNAVAILABLE");
  }
};

export const expireStaleCapabilityReservations = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: ExpireStaleCapabilityReservationsCommand,
): Promise<ExpireStaleCapabilityReservationsResult> => {
  const command = expireStaleCapabilityReservationsCommandSchema.safeParse(commandCandidate);
  if (!command.success) throw new Error("EXPIRE_STALE_RESERVATIONS_COMMAND_INVALID");
  const value = command.data;
  try {
    const rows = await transaction.query<ResultRow>`
      select result from vortex_access.expire_stale_capability_reservations(
        ${value.tenantId}::uuid,
        ${value.organizationId ?? null}::uuid,
        ${value.capabilityKey}::text,
        ${value.unit}::text
      )
    `;
    return parseResult(
      rows,
      expireStaleCapabilityReservationsResultSchema,
      "EXPIRE_STALE_RESERVATIONS_UNAVAILABLE",
    );
  } catch (error) {
    if (error instanceof Error && error.message === "EXPIRE_STALE_RESERVATIONS_UNAVAILABLE")
      throw error;
    throw new Error("EXPIRE_STALE_RESERVATIONS_UNAVAILABLE");
  }
};

type ReservedCapability = Extract<CapabilityReservationResult, { outcome: "reserved" }>;

/** Convenience wrapper that retains every immutable reservation binding. */
export const consumeReservation = async (
  transaction: RequestDatabaseTransaction,
  reservation: ReservedCapability,
  quantityCandidate: number,
  duplicateKeyCandidate: string,
): Promise<CapabilityConsumptionResult> => {
  const command = consumeCapabilityReservationCommandSchema.parse({
    reservationId: reservation.reservationId,
    tenantId: reservation.tenantId,
    ...(reservation.organizationId === undefined
      ? {}
      : { organizationId: reservation.organizationId }),
    capabilityKey: reservation.capabilityKey,
    unit: reservation.unit,
    policyId: reservation.policyId,
    policyRevision: reservation.policyRevision,
    assignmentId: reservation.assignmentId,
    assignmentRevision: reservation.assignmentRevision,
    quantity: quantityCandidate,
    duplicateKey: duplicateKeyCandidate,
  });
  return consumeCapabilityReservation(transaction, command);
};

/** Convenience wrapper that retains every immutable reservation binding. */
export const releaseReservation = async (
  transaction: RequestDatabaseTransaction,
  reservation: ReservedCapability,
  duplicateKeyCandidate: string,
  quantityCandidate?: number,
): Promise<CapabilityReleaseResult> => {
  const command = releaseCapabilityReservationCommandSchema.parse({
    reservationId: reservation.reservationId,
    tenantId: reservation.tenantId,
    ...(reservation.organizationId === undefined
      ? {}
      : { organizationId: reservation.organizationId }),
    capabilityKey: reservation.capabilityKey,
    unit: reservation.unit,
    policyId: reservation.policyId,
    policyRevision: reservation.policyRevision,
    assignmentId: reservation.assignmentId,
    assignmentRevision: reservation.assignmentRevision,
    ...(quantityCandidate === undefined ? {} : { quantity: quantityCandidate }),
    duplicateKey: duplicateKeyCandidate,
  });
  return releaseCapabilityReservation(transaction, command);
};
