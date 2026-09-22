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

/** Stable aggregated balance across an effective capability policy scope. */
export const capabilityBalanceSchema = z
  .object({
    policyLimit: capabilityPolicyQuantitySchema,
    activeReservedQuantity: z.number().nonnegative().finite(),
    consumedQuantity: z.number().nonnegative().finite(),
    releasedQuantity: z.number().nonnegative().finite(),
    availableQuantity: z.number().nonnegative().finite(),
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

export const reserveCapabilityCommandSchema = z
  .object({
    policy: effectiveCapabilityPolicySchema,
    requestedQuantity: capabilityPolicyQuantitySchema,
    duplicateKey: platformIdSchema,
    reservationId: platformIdSchema.optional(),
    expiresAt: timestampSchema.optional(),
    correlationId: correlationIdSchema.optional(),
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
      reservedQuantity: capabilityPolicyQuantitySchema,
      reservedAt: timestampSchema,
      expiresAt: timestampSchema,
      correlationId: correlationIdSchema,
      balance: capabilityBalanceSchema,
    })
    .strict(),
  z
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
      requestedQuantity: capabilityPolicyQuantitySchema,
      reasonCode: z.enum(["insufficient_capacity", "capability_not_assigned", "policy_stale"]),
      decidedAt: timestampSchema,
      correlationId: correlationIdSchema,
      balance: capabilityBalanceSchema.optional(),
    })
    .strict(),
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
    quantity: capabilityPolicyQuantitySchema,
    duplicateKey: platformIdSchema,
    correlationId: correlationIdSchema.optional(),
  })
  .strict();

export const capabilityConsumptionResultSchema = z
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
    consumedAmount: capabilityPolicyQuantitySchema,
    totalConsumedQuantity: z.number().nonnegative().finite(),
    remainingReservedQuantity: z.number().nonnegative().finite(),
    reservationState: z.enum(["active", "consumed"]),
    consumedAt: timestampSchema,
    correlationId: correlationIdSchema,
    balance: capabilityBalanceSchema,
  })
  .strict();

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
    quantity: capabilityPolicyQuantitySchema.optional(),
    duplicateKey: platformIdSchema,
    correlationId: correlationIdSchema.optional(),
  })
  .strict();

export const capabilityReleaseResultSchema = z
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
    releasedAmount: capabilityPolicyQuantitySchema,
    totalReleasedQuantity: z.number().nonnegative().finite(),
    remainingReservedQuantity: z.number().nonnegative().finite(),
    reservationState: z.enum(["active", "released"]),
    releasedAt: timestampSchema,
    correlationId: correlationIdSchema,
    balance: capabilityBalanceSchema,
  })
  .strict();

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
    assignmentId: platformIdSchema.optional(),
    correlationId: correlationIdSchema.optional(),
  })
  .strict();

export const expireStaleCapabilityReservationsResultSchema = z
  .object({
    tenantId: tenantIdSchema,
    assignmentId: platformIdSchema.optional(),
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

type ReservationRow = DatabaseRow & {
  outcome: unknown;
  status: unknown;
  reservation_id: unknown;
  tenant_id: unknown;
  organization_id: unknown;
  capability_key: unknown;
  unit: unknown;
  policy_id: unknown;
  policy_revision: unknown;
  assignment_id: unknown;
  assignment_revision: unknown;
  applied_scope: unknown;
  policy_quantity_limit: unknown;
  active_reserved_quantity: unknown;
  consumed_quantity: unknown;
  released_quantity: unknown;
  available_quantity: unknown;
  reserved_quantity: unknown;
  created_at: unknown;
  expires_at: unknown;
  correlation_id: unknown;
  reason_code: unknown;
};

type ConsumptionRow = DatabaseRow & {
  outcome: unknown;
  status: unknown;
  reservation_id: unknown;
  tenant_id: unknown;
  organization_id: unknown;
  capability_key: unknown;
  unit: unknown;
  policy_id: unknown;
  policy_revision: unknown;
  assignment_id: unknown;
  assignment_revision: unknown;
  applied_scope: unknown;
  policy_quantity_limit: unknown;
  active_reserved_quantity: unknown;
  consumed_quantity: unknown;
  released_quantity: unknown;
  available_quantity: unknown;
  consumed_amount: unknown;
  reservation_consumed_quantity: unknown;
  reservation_remaining_quantity: unknown;
  reservation_state: unknown;
  consumed_at: unknown;
  correlation_id: unknown;
};

type ReleaseRow = DatabaseRow & {
  outcome: unknown;
  status: unknown;
  reservation_id: unknown;
  tenant_id: unknown;
  organization_id: unknown;
  capability_key: unknown;
  unit: unknown;
  policy_id: unknown;
  policy_revision: unknown;
  assignment_id: unknown;
  assignment_revision: unknown;
  applied_scope: unknown;
  policy_quantity_limit: unknown;
  active_reserved_quantity: unknown;
  consumed_quantity: unknown;
  released_quantity: unknown;
  available_quantity: unknown;
  released_amount: unknown;
  reservation_released_quantity: unknown;
  reservation_remaining_quantity: unknown;
  reservation_state: unknown;
  released_at: unknown;
  correlation_id: unknown;
};

type BalanceRow = DatabaseRow & {
  tenant_id: unknown;
  organization_id: unknown;
  capability_key: unknown;
  unit: unknown;
  policy_id: unknown;
  policy_revision: unknown;
  assignment_id: unknown;
  assignment_revision: unknown;
  applied_scope: unknown;
  policy_quantity_limit: unknown;
  active_reserved_quantity: unknown;
  consumed_quantity: unknown;
  released_quantity: unknown;
  available_quantity: unknown;
  evaluated_at: unknown;
};

type ExpireRow = DatabaseRow & {
  expired_count: unknown;
  evaluated_at: unknown;
};

const revision = (value: unknown): unknown => {
  if (typeof value === "bigint")
    return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return value;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : value;
};

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

const quantity = (value: unknown): unknown => {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;
  const canonical = canonicalDecimal(value.trim());
  if (canonical === undefined) return value;
  const parsed = Number(canonical);
  if (!Number.isFinite(parsed)) return value;
  return canonicalDecimal(String(parsed)) === canonical ? parsed : value;
};

const timestamp = (value: unknown): unknown =>
  value instanceof Date && Number.isFinite(value.valueOf()) ? value.toISOString() : value;

const parseOne = <Row>(rows: readonly Row[], error: string): Row => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error(error);
  return rows[0];
};

/**
 * Atomically locks policy balance, expires stale reservations, checks policy evidence,
 * and reserves capability quantity.
 */
export const reserveCapabilityQuantity = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: ReserveCapabilityCommand,
): Promise<CapabilityReservationResult> => {
  const command = reserveCapabilityCommandSchema.safeParse(commandCandidate);
  if (!command.success) throw new Error("CAPABILITY_RESERVATION_COMMAND_INVALID");
  const value = command.data;

  if (value.policy.outcome === "refused") {
    const correlationId = value.correlationId ?? (crypto.randomUUID() as string);
    const candidate = {
      outcome: "refused" as const,
      status: "accepted" as const,
      tenantId: value.policy.tenantId,
      ...(value.policy.organizationId ? { organizationId: value.policy.organizationId } : {}),
      capabilityKey: value.policy.capabilityKey,
      unit: value.policy.unit,
      requestedQuantity: value.requestedQuantity,
      reasonCode: "capability_not_assigned" as const,
      decidedAt: new Date().toISOString(),
      correlationId,
    };
    const parsed = capabilityReservationResultSchema.safeParse(candidate);
    if (!parsed.success) throw new Error("CAPABILITY_RESERVATION_UNAVAILABLE");
    return parsed.data;
  }

  const policy = value.policy;
  const correlationId = value.correlationId ?? null;
  const reservationId = value.reservationId ?? null;
  const expiresAt = value.expiresAt ?? null;

  let rows: readonly ReservationRow[];
  try {
    rows = await transaction.query<ReservationRow>`
      select * from vortex_access.reserve_capability_quantity(
        ${policy.tenantId}::uuid,
        ${policy.organizationId ?? null}::uuid,
        ${policy.capabilityKey}::text,
        ${policy.unit}::text,
        ${policy.policyId}::uuid,
        ${policy.policyRevision}::bigint,
        ${policy.assignmentId}::uuid,
        ${policy.assignmentRevision}::bigint,
        ${policy.quantityLimit}::numeric,
        ${value.requestedQuantity}::numeric,
        ${value.duplicateKey}::uuid,
        ${expiresAt}::timestamptz,
        ${reservationId}::uuid,
        ${correlationId}::uuid
      )
    `;
  } catch (error) {
    if (error instanceof Error && error.message.includes("V3001")) {
      throw new Error("CAPABILITY_RESERVATION_DUPLICATE_CONFLICTS");
    }
    if (error instanceof Error && error.message.includes("V3102")) {
      throw new Error("CAPABILITY_POLICY_STALE");
    }
    throw new Error("CAPABILITY_RESERVATION_UNAVAILABLE");
  }

  const row = parseOne(rows, "CAPABILITY_RESERVATION_UNAVAILABLE");
  const candidate = {
    outcome: row.outcome,
    status: row.status,
    tenantId: row.tenant_id,
    ...(row.organization_id != null ? { organizationId: row.organization_id } : {}),
    capabilityKey: row.capability_key,
    unit: row.unit,
    ...(row.outcome === "reserved"
      ? {
          reservationId: row.reservation_id,
          policyId: row.policy_id,
          policyRevision: revision(row.policy_revision),
          assignmentId: row.assignment_id,
          assignmentRevision: revision(row.assignment_revision),
          appliedScope: row.applied_scope,
          reservedQuantity: quantity(row.reserved_quantity),
          reservedAt: timestamp(row.created_at),
          expiresAt: timestamp(row.expires_at),
          correlationId: row.correlation_id,
          balance: {
            policyLimit: quantity(row.policy_quantity_limit),
            activeReservedQuantity: quantity(row.active_reserved_quantity),
            consumedQuantity: quantity(row.consumed_quantity),
            releasedQuantity: quantity(row.released_quantity),
            availableQuantity: quantity(row.available_quantity),
          },
        }
      : {
          policyId: row.policy_id != null ? row.policy_id : undefined,
          policyRevision: row.policy_revision != null ? revision(row.policy_revision) : undefined,
          assignmentId: row.assignment_id != null ? row.assignment_id : undefined,
          assignmentRevision:
            row.assignment_revision != null ? revision(row.assignment_revision) : undefined,
          appliedScope: row.applied_scope != null ? row.applied_scope : undefined,
          requestedQuantity: value.requestedQuantity,
          reasonCode: row.reason_code ?? "insufficient_capacity",
          decidedAt: timestamp(row.created_at),
          correlationId: row.correlation_id,
          balance: {
            policyLimit: quantity(row.policy_quantity_limit),
            activeReservedQuantity: quantity(row.active_reserved_quantity),
            consumedQuantity: quantity(row.consumed_quantity),
            releasedQuantity: quantity(row.released_quantity),
            availableQuantity: quantity(row.available_quantity),
          },
        }),
  };

  const parsed = capabilityReservationResultSchema.safeParse(candidate);
  if (!parsed.success) throw new Error("CAPABILITY_RESERVATION_UNAVAILABLE");
  return parsed.data;
};

/**
 * Atomically consumes reserved capability quantity, bounded by reservation amount.
 */
export const consumeCapabilityReservation = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: ConsumeCapabilityReservationCommand,
): Promise<CapabilityConsumptionResult> => {
  const command = consumeCapabilityReservationCommandSchema.safeParse(commandCandidate);
  if (!command.success) throw new Error("CAPABILITY_CONSUMPTION_COMMAND_INVALID");
  const value = command.data;

  let rows: readonly ConsumptionRow[];
  try {
    rows = await transaction.query<ConsumptionRow>`
      select * from vortex_access.consume_capability_reservation(
        ${value.tenantId}::uuid,
        ${value.organizationId ?? null}::uuid,
        ${value.capabilityKey}::text,
        ${value.unit}::text,
        ${value.policyId}::uuid,
        ${value.policyRevision}::bigint,
        ${value.assignmentId}::uuid,
        ${value.reservationId}::uuid,
        ${value.quantity}::numeric,
        ${value.duplicateKey}::uuid,
        ${value.correlationId ?? null}::uuid
      )
    `;
  } catch (error) {
    if (error instanceof Error && error.message.includes("V3001")) {
      throw new Error("CAPABILITY_CONSUMPTION_DUPLICATE_CONFLICTS");
    }
    if (error instanceof Error && error.message.includes("V3102")) {
      throw new Error("CAPABILITY_RESERVATION_STALE");
    }
    throw new Error("CAPABILITY_CONSUMPTION_UNAVAILABLE");
  }

  const row = parseOne(rows, "CAPABILITY_CONSUMPTION_UNAVAILABLE");
  const candidate = {
    outcome: row.outcome,
    status: row.status,
    reservationId: row.reservation_id,
    tenantId: row.tenant_id,
    ...(row.organization_id != null ? { organizationId: row.organization_id } : {}),
    capabilityKey: row.capability_key,
    unit: row.unit,
    policyId: row.policy_id,
    policyRevision: revision(row.policy_revision),
    assignmentId: row.assignment_id,
    assignmentRevision: revision(row.assignment_revision),
    appliedScope: row.applied_scope,
    consumedAmount: quantity(row.consumed_amount),
    totalConsumedQuantity: quantity(row.reservation_consumed_quantity),
    remainingReservedQuantity: quantity(row.reservation_remaining_quantity),
    reservationState: row.reservation_state,
    consumedAt: timestamp(row.consumed_at),
    correlationId: row.correlation_id,
    balance: {
      policyLimit: quantity(row.policy_quantity_limit),
      activeReservedQuantity: quantity(row.active_reserved_quantity),
      consumedQuantity: quantity(row.consumed_quantity),
      releasedQuantity: quantity(row.released_quantity),
      availableQuantity: quantity(row.available_quantity),
    },
  };

  const parsed = capabilityConsumptionResultSchema.safeParse(candidate);
  if (!parsed.success) throw new Error("CAPABILITY_CONSUMPTION_UNAVAILABLE");
  return parsed.data;
};

/**
 * Atomically releases unconsumed reserved quantity back to available policy capacity.
 */
export const releaseCapabilityReservation = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: ReleaseCapabilityReservationCommand,
): Promise<CapabilityReleaseResult> => {
  const command = releaseCapabilityReservationCommandSchema.safeParse(commandCandidate);
  if (!command.success) throw new Error("CAPABILITY_RELEASE_COMMAND_INVALID");
  const value = command.data;

  let rows: readonly ReleaseRow[];
  try {
    rows = await transaction.query<ReleaseRow>`
      select * from vortex_access.release_capability_reservation(
        ${value.tenantId}::uuid,
        ${value.organizationId ?? null}::uuid,
        ${value.capabilityKey}::text,
        ${value.unit}::text,
        ${value.policyId}::uuid,
        ${value.policyRevision}::bigint,
        ${value.assignmentId}::uuid,
        ${value.reservationId}::uuid,
        ${value.duplicateKey}::uuid,
        ${value.quantity ?? null}::numeric,
        ${value.correlationId ?? null}::uuid
      )
    `;
  } catch (error) {
    if (error instanceof Error && error.message.includes("V3001")) {
      throw new Error("CAPABILITY_RELEASE_DUPLICATE_CONFLICTS");
    }
    if (error instanceof Error && error.message.includes("V3102")) {
      throw new Error("CAPABILITY_RESERVATION_STALE");
    }
    throw new Error("CAPABILITY_RELEASE_UNAVAILABLE");
  }

  const row = parseOne(rows, "CAPABILITY_RELEASE_UNAVAILABLE");
  const candidate = {
    outcome: row.outcome,
    status: row.status,
    reservationId: row.reservation_id,
    tenantId: row.tenant_id,
    ...(row.organization_id != null ? { organizationId: row.organization_id } : {}),
    capabilityKey: row.capability_key,
    unit: row.unit,
    policyId: row.policy_id,
    policyRevision: revision(row.policy_revision),
    assignmentId: row.assignment_id,
    assignmentRevision: revision(row.assignment_revision),
    appliedScope: row.applied_scope,
    releasedAmount: quantity(row.released_amount),
    totalReleasedQuantity: quantity(row.reservation_released_quantity),
    remainingReservedQuantity: quantity(row.reservation_remaining_quantity),
    reservationState: row.reservation_state,
    releasedAt: timestamp(row.released_at),
    correlationId: row.correlation_id,
    balance: {
      policyLimit: quantity(row.policy_quantity_limit),
      activeReservedQuantity: quantity(row.active_reserved_quantity),
      consumedQuantity: quantity(row.consumed_quantity),
      releasedQuantity: quantity(row.released_quantity),
      availableQuantity: quantity(row.available_quantity),
    },
  };

  const parsed = capabilityReleaseResultSchema.safeParse(candidate);
  if (!parsed.success) throw new Error("CAPABILITY_RELEASE_UNAVAILABLE");
  return parsed.data;
};

/**
 * Reads locked/stable capability balances for an effective policy scope.
 */
export const readCapabilityBalance = async (
  transaction: RequestDatabaseTransaction,
  requestCandidate: ReadCapabilityBalanceRequest,
): Promise<CapabilityBalanceRecord> => {
  const request = readCapabilityBalanceRequestSchema.safeParse(requestCandidate);
  if (!request.success) throw new Error("CAPABILITY_BALANCE_REQUEST_INVALID");
  const value = request.data;

  let rows: readonly BalanceRow[];
  try {
    rows = await transaction.query<BalanceRow>`
      select * from vortex_access.read_capability_reservation_balance(
        ${value.tenantId}::uuid,
        ${value.organizationId ?? null}::uuid,
        ${value.capabilityKey}::text,
        ${value.unit}::text
      )
    `;
  } catch {
    throw new Error("CAPABILITY_BALANCE_UNAVAILABLE");
  }

  const row = parseOne(rows, "CAPABILITY_BALANCE_UNAVAILABLE");
  const candidate = {
    tenantId: row.tenant_id,
    ...(row.organization_id != null ? { organizationId: row.organization_id } : {}),
    capabilityKey: row.capability_key,
    unit: row.unit,
    policyId: row.policy_id,
    policyRevision: revision(row.policy_revision),
    assignmentId: row.assignment_id,
    assignmentRevision: revision(row.assignment_revision),
    appliedScope: row.applied_scope,
    balance: {
      policyLimit: quantity(row.policy_quantity_limit),
      activeReservedQuantity: quantity(row.active_reserved_quantity),
      consumedQuantity: quantity(row.consumed_quantity),
      releasedQuantity: quantity(row.released_quantity),
      availableQuantity: quantity(row.available_quantity),
    },
    evaluatedAt: timestamp(row.evaluated_at),
  };

  const parsed = capabilityBalanceRecordSchema.safeParse(candidate);
  if (!parsed.success) throw new Error("CAPABILITY_BALANCE_UNAVAILABLE");
  return parsed.data;
};

/**
 * Expires active reservations past their deadline and recalculates balances.
 */
export const expireStaleCapabilityReservations = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: ExpireStaleCapabilityReservationsCommand,
): Promise<ExpireStaleCapabilityReservationsResult> => {
  const command = expireStaleCapabilityReservationsCommandSchema.safeParse(commandCandidate);
  if (!command.success) throw new Error("EXPIRE_STALE_RESERVATIONS_COMMAND_INVALID");
  const value = command.data;

  let rows: readonly ExpireRow[];
  try {
    rows = await transaction.query<ExpireRow>`
      select * from vortex_access.expire_stale_capability_reservations(
        ${value.tenantId}::uuid,
        ${value.assignmentId ?? null}::uuid
      )
    `;
  } catch {
    throw new Error("EXPIRE_STALE_RESERVATIONS_UNAVAILABLE");
  }

  const row = parseOne(rows, "EXPIRE_STALE_RESERVATIONS_UNAVAILABLE");
  const correlationId = value.correlationId ?? (crypto.randomUUID() as string);
  const candidate = {
    tenantId: value.tenantId,
    ...(value.assignmentId ? { assignmentId: value.assignmentId } : {}),
    expiredCount:
      typeof row.expired_count === "number" ? row.expired_count : Number(row.expired_count),
    expiredAt: timestamp(row.evaluated_at),
    correlationId,
  };

  const parsed = expireStaleCapabilityReservationsResultSchema.safeParse(candidate);
  if (!parsed.success) throw new Error("EXPIRE_STALE_RESERVATIONS_UNAVAILABLE");
  return parsed.data;
};

/**
 * Convenience helper to consume an active reservation directly.
 */
export const consumeReservation = async (
  transaction: RequestDatabaseTransaction,
  reservation: {
    reservationId: string;
    tenantId: string;
    organizationId?: string | undefined;
    capabilityKey: string;
    unit: string;
    policyId: string;
    policyRevision: number;
    assignmentId: string;
  },
  quantity: number,
  duplicateKey: string,
  correlationId?: string,
): Promise<CapabilityConsumptionResult> =>
  consumeCapabilityReservation(transaction, {
    reservationId: reservation.reservationId as any,
    tenantId: reservation.tenantId as any,
    organizationId: reservation.organizationId as any,
    capabilityKey: reservation.capabilityKey,
    unit: reservation.unit,
    policyId: reservation.policyId as any,
    policyRevision: reservation.policyRevision,
    assignmentId: reservation.assignmentId as any,
    quantity,
    duplicateKey: duplicateKey as any,
    correlationId: correlationId as any,
  });

/**
 * Convenience helper to release an active reservation directly.
 */
export const releaseReservation = async (
  transaction: RequestDatabaseTransaction,
  reservation: {
    reservationId: string;
    tenantId: string;
    organizationId?: string | undefined;
    capabilityKey: string;
    unit: string;
    policyId: string;
    policyRevision: number;
    assignmentId: string;
  },
  duplicateKey: string,
  quantity?: number,
  correlationId?: string,
): Promise<CapabilityReleaseResult> =>
  releaseCapabilityReservation(transaction, {
    reservationId: reservation.reservationId as any,
    tenantId: reservation.tenantId as any,
    organizationId: reservation.organizationId as any,
    capabilityKey: reservation.capabilityKey,
    unit: reservation.unit,
    policyId: reservation.policyId as any,
    policyRevision: reservation.policyRevision,
    assignmentId: reservation.assignmentId as any,
    quantity,
    duplicateKey: duplicateKey as any,
    correlationId: correlationId as any,
  });

