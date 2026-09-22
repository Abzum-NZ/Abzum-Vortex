import "server-only";

import { createHash } from "node:crypto";
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
  type BuilderKey,
  type CorrelationId,
  type NamespacedKey,
  type OrganizationId,
  type PlatformId,
  type Revision,
  type TenantId,
} from "@vortex/contracts";
import {
  capabilityBalanceSchema,
  capabilityPolicyAppliedScopeSchema,
  capabilityReservationResultSchema,
  type CapabilityBalance,
  type CapabilityConsumptionResult,
  type CapabilityPolicyAppliedScope,
  type CapabilityReleaseResult,
  type CapabilityReservationResult,
  type ConsumeCapabilityReservationCommand,
  type ReleaseCapabilityReservationCommand,
} from "@vortex/access";

/**
 * Exact capability policy authority binding.
 * Identifies the versioned policy and assignment under which a reservation was granted.
 */
export const capabilityPolicyBindingSchema = z
  .object({
    policyId: platformIdSchema,
    policyRevision: revisionSchema,
    assignmentId: platformIdSchema,
    assignmentRevision: revisionSchema,
  })
  .strict();

export type CapabilityPolicyBinding = z.infer<typeof capabilityPolicyBindingSchema>;

/**
 * Upload-side request context presented for capability admission.
 * Accepts only verified upload-side request scope; never accepts broad or unverified metadata.
 */
export const uploadCapabilityAdmissionContextSchema = z
  .object({
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema,
    capabilityKey: namespacedKeySchema,
    unit: builderKeySchema,
    quantity: z.number().positive().finite().max(Number.MAX_SAFE_INTEGER).optional(),
    requestedQuantity: z.number().positive().finite().max(Number.MAX_SAFE_INTEGER).optional(),
    correlationId: correlationIdSchema,
    duplicateKey: platformIdSchema.optional(),
    policyBinding: capabilityPolicyBindingSchema.optional(),
    expectedPolicy: capabilityPolicyBindingSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.quantity !== undefined || value.requestedQuantity !== undefined) &&
      (value.quantity === undefined ||
        value.requestedQuantity === undefined ||
        value.quantity === value.requestedQuantity),
    {
      message: "An upload admission context requires quantity (or requestedQuantity)",
      path: ["quantity"],
    },
  )
  .transform((value) => {
    const policyBinding = value.policyBinding ?? value.expectedPolicy;
    return {
      tenantId: value.tenantId,
      organizationId: value.organizationId,
      capabilityKey: value.capabilityKey,
      unit: value.unit,
      quantity: (value.quantity ?? value.requestedQuantity)!,
      correlationId: value.correlationId,
      ...(value.duplicateKey !== undefined ? { duplicateKey: value.duplicateKey } : {}),
      ...(policyBinding !== undefined ? { policyBinding } : {}),
    };
  });

export type UploadCapabilityAdmissionInput = z.input<
  typeof uploadCapabilityAdmissionContextSchema
>;
export type UploadCapabilityAdmissionContext = z.output<
  typeof uploadCapabilityAdmissionContextSchema
>;

/**
 * Closed safe refusal reasons for upload capability admission.
 * Exposes only safe classification codes; never exposes raw internal errors, credentials,
 * or foreign organisation identifiers.
 */
export const uploadCapabilityAdmissionRefusalReasonSchema = z.enum([
  "insufficient_capacity",
  "capability_not_assigned",
  "policy_stale",
  "binding_mismatched",
  "reservation_stale",
  "duplicate_conflict",
  "capability_unavailable",
  "malformed_input",
]);

export type UploadCapabilityAdmissionRefusalReason = z.infer<
  typeof uploadCapabilityAdmissionRefusalReasonSchema
>;

/**
 * Closed safe refusal shape for upload capability admission.
 */
export const uploadCapabilityAdmissionRefusalSchema = z
  .object({
    outcome: z.literal("refused"),
    reasonCode: uploadCapabilityAdmissionRefusalReasonSchema,
    correlationId: correlationIdSchema,
    decidedAt: timestampSchema,
    reservationId: platformIdSchema.optional(),
    balance: capabilityBalanceSchema.optional(),
  })
  .strict();

export type UploadCapabilityAdmissionRefusal = z.infer<
  typeof uploadCapabilityAdmissionRefusalSchema
>;

/**
 * Admitted upload capability binding confirming that the requested upload operation
 * is authorized under active capability policy and reservation.
 */
export const admittedUploadCapabilitySchema = z
  .object({
    outcome: z.literal("admitted"),
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema,
    capabilityKey: namespacedKeySchema,
    unit: builderKeySchema,
    quantity: z.number().positive().finite().max(Number.MAX_SAFE_INTEGER),
    correlationId: correlationIdSchema,
    reservationId: platformIdSchema,
    policyId: platformIdSchema,
    policyRevision: revisionSchema,
    assignmentId: platformIdSchema,
    assignmentRevision: revisionSchema,
    appliedScope: capabilityPolicyAppliedScopeSchema,
    reservedQuantity: z.number().positive().finite().max(Number.MAX_SAFE_INTEGER),
    balance: capabilityBalanceSchema,
    admittedAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict();

export type AdmittedUploadCapability = z.infer<typeof admittedUploadCapabilitySchema>;

export const uploadCapabilityAdmissionDecisionSchema = z.discriminatedUnion("outcome", [
  admittedUploadCapabilitySchema,
  uploadCapabilityAdmissionRefusalSchema,
]);

export type UploadCapabilityAdmissionDecision = z.infer<
  typeof uploadCapabilityAdmissionDecisionSchema
>;

/**
 * Derives a deterministic, operation-separated duplicate key as a non-nil RFC 4122 UUID.
 * Ensures consume and release operations use distinct key spaces while identical replays converge.
 */
export const deriveUploadAdmissionDuplicateKey = (
  operation: "consume" | "release",
  reservationId: string,
  discriminator?: string,
): PlatformId => {
  const seed = discriminator
    ? `vortex:file:upload-admission:${operation}:${reservationId}:${discriminator}`
    : `vortex:file:upload-admission:${operation}:${reservationId}`;
  const hash = createHash("sha256").update(seed).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // UUID version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant 1
  const hex = bytes.toString("hex");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  return platformIdSchema.parse(uuid);
};

const sameId = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const deriveFallbackCorrelationId = (timestampText: string): CorrelationId => {
  const hash = createHash("sha256")
    .update(`vortex:file:upload-admission:fallback-correlation:${timestampText}`)
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return correlationIdSchema.parse(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`,
  );
};

/**
 * Pure evaluation of upload-side request context against a #650 reservation result.
 * Binds tenant, organisation, capability key, unit, quantity, correlation, policy and assignment exactly.
 * Refuses policy refusals, stale or mismatched bindings, and malformed inputs.
 */
export const evaluateUploadCapabilityAdmission = (
  contextCandidate: unknown,
  reservationCandidate: unknown,
  now: Date = new Date(),
): UploadCapabilityAdmissionDecision => {
  const nowMs = now.getTime();
  const decidedAt = Number.isFinite(nowMs) ? now.toISOString() : new Date().toISOString();

  const contextResult = uploadCapabilityAdmissionContextSchema.safeParse(contextCandidate);
  if (!contextResult.success || !Number.isFinite(nowMs)) {
    const fallbackCorrelationId =
      typeof contextCandidate === "object" &&
      contextCandidate !== null &&
      "correlationId" in contextCandidate &&
      typeof (contextCandidate as { correlationId: unknown }).correlationId === "string" &&
      correlationIdSchema.safeParse((contextCandidate as { correlationId: unknown }).correlationId)
        .success
        ? ((contextCandidate as { correlationId: string }).correlationId as CorrelationId)
        : deriveFallbackCorrelationId(decidedAt);

    return Object.freeze({
      outcome: "refused",
      reasonCode: "malformed_input",
      correlationId: fallbackCorrelationId,
      decidedAt,
    });
  }

  const context = contextResult.data;

  const reservationResult = capabilityReservationResultSchema.safeParse(reservationCandidate);
  if (!reservationResult.success) {
    return Object.freeze({
      outcome: "refused",
      reasonCode: "malformed_input",
      correlationId: context.correlationId,
      decidedAt,
    });
  }

  const reservation = reservationResult.data;

  if (reservation.outcome === "refused") {
    return Object.freeze({
      outcome: "refused",
      reasonCode: reservation.reasonCode,
      correlationId: context.correlationId,
      decidedAt,
      ...(reservation.policyId !== undefined ? { reservationId: reservation.policyId } : {}),
      ...(reservation.balance !== undefined ? { balance: reservation.balance } : {}),
    });
  }

  // Outcome is "reserved". Bind tenant, organisation, capability key, unit, quantity, correlation and policy exactly.
  if (!sameId(reservation.tenantId, context.tenantId)) {
    return Object.freeze({
      outcome: "refused",
      reasonCode: "binding_mismatched",
      correlationId: context.correlationId,
      decidedAt,
      reservationId: reservation.reservationId,
      balance: reservation.balance,
    });
  }

  if (
    reservation.organizationId !== undefined &&
    !sameId(reservation.organizationId, context.organizationId)
  ) {
    return Object.freeze({
      outcome: "refused",
      reasonCode: "binding_mismatched",
      correlationId: context.correlationId,
      decidedAt,
      reservationId: reservation.reservationId,
      balance: reservation.balance,
    });
  }

  if (reservation.appliedScope === "organization" && reservation.organizationId === undefined) {
    return Object.freeze({
      outcome: "refused",
      reasonCode: "binding_mismatched",
      correlationId: context.correlationId,
      decidedAt,
      reservationId: reservation.reservationId,
      balance: reservation.balance,
    });
  }

  if (reservation.capabilityKey !== context.capabilityKey) {
    return Object.freeze({
      outcome: "refused",
      reasonCode: "binding_mismatched",
      correlationId: context.correlationId,
      decidedAt,
      reservationId: reservation.reservationId,
      balance: reservation.balance,
    });
  }

  if (reservation.unit !== context.unit) {
    return Object.freeze({
      outcome: "refused",
      reasonCode: "binding_mismatched",
      correlationId: context.correlationId,
      decidedAt,
      reservationId: reservation.reservationId,
      balance: reservation.balance,
    });
  }

  if (reservation.reservedQuantity !== context.quantity) {
    return Object.freeze({
      outcome: "refused",
      reasonCode: "binding_mismatched",
      correlationId: context.correlationId,
      decidedAt,
      reservationId: reservation.reservationId,
      balance: reservation.balance,
    });
  }

  if (!sameId(reservation.correlationId, context.correlationId)) {
    return Object.freeze({
      outcome: "refused",
      reasonCode: "binding_mismatched",
      correlationId: context.correlationId,
      decidedAt,
      reservationId: reservation.reservationId,
      balance: reservation.balance,
    });
  }

  if (context.policyBinding !== undefined) {
    if (
      !sameId(reservation.policyId, context.policyBinding.policyId) ||
      reservation.policyRevision !== context.policyBinding.policyRevision ||
      !sameId(reservation.assignmentId, context.policyBinding.assignmentId) ||
      reservation.assignmentRevision !== context.policyBinding.assignmentRevision
    ) {
      return Object.freeze({
        outcome: "refused",
        reasonCode: "binding_mismatched",
        correlationId: context.correlationId,
        decidedAt,
        reservationId: reservation.reservationId,
        balance: reservation.balance,
      });
    }
  }

  const expiresAtMs = Date.parse(reservation.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    return Object.freeze({
      outcome: "refused",
      reasonCode: "reservation_stale",
      correlationId: context.correlationId,
      decidedAt,
      reservationId: reservation.reservationId,
      balance: reservation.balance,
    });
  }

  return Object.freeze({
    outcome: "admitted",
    tenantId: context.tenantId,
    organizationId: context.organizationId,
    capabilityKey: context.capabilityKey,
    unit: context.unit,
    quantity: context.quantity,
    correlationId: context.correlationId,
    reservationId: reservation.reservationId,
    policyId: reservation.policyId,
    policyRevision: reservation.policyRevision,
    assignmentId: reservation.assignmentId,
    assignmentRevision: reservation.assignmentRevision,
    appliedScope: reservation.appliedScope,
    reservedQuantity: reservation.reservedQuantity,
    balance: reservation.balance,
    admittedAt: decidedAt,
    expiresAt: reservation.expiresAt,
  });
};

/** Injected port to consume a capability reservation upon committed upload admission. */
export type ConsumeCapabilityReservationPort = (
  command: ConsumeCapabilityReservationCommand,
) => Promise<CapabilityConsumptionResult>;

/** Injected port to release a capability reservation upon refused or failed upload admission. */
export type ReleaseCapabilityReservationPort = (
  command: ReleaseCapabilityReservationCommand,
) => Promise<CapabilityReleaseResult>;

/**
 * Narrow injected dependencies for upload capability admission.
 * Keeps reservation consumption and release behind ports, avoiding direct database coupling.
 */
export type UploadCapabilityAdmissionDependencies = Readonly<{
  consumeReservation: ConsumeCapabilityReservationPort;
  releaseReservation: ReleaseCapabilityReservationPort;
  clock?: () => Date;
}>;

const safeReleaseActiveReservation = async (
  reservation: Extract<CapabilityReservationResult, { outcome: "reserved" }>,
  correlationId: CorrelationId,
  releaseReservation: ReleaseCapabilityReservationPort,
): Promise<void> => {
  try {
    const duplicateKey = deriveUploadAdmissionDuplicateKey(
      "release",
      reservation.reservationId,
      correlationId,
    );
    await releaseReservation({
      reservationId: reservation.reservationId,
      tenantId: reservation.tenantId,
      ...(reservation.organizationId !== undefined
        ? { organizationId: reservation.organizationId }
        : {}),
      capabilityKey: reservation.capabilityKey,
      unit: reservation.unit,
      policyId: reservation.policyId,
      policyRevision: reservation.policyRevision,
      assignmentId: reservation.assignmentId,
      assignmentRevision: reservation.assignmentRevision,
      quantity: reservation.reservedQuantity,
      duplicateKey,
    });
  } catch {
    // Non-throwing safe error handling; prevents unhandled rejections during cleanup
  }
};

/**
 * Two-phase handle for managing upload capability admission lifecycle.
 */
export type UploadCapabilityAdmissionSession = Readonly<{
  decision: UploadCapabilityAdmissionDecision;
  commit(): Promise<CapabilityConsumptionResult>;
  release(): Promise<CapabilityReleaseResult>;
}>;

/**
 * Admits an upload request against a capability reservation result.
 * If admission is refused and an active reservation was provided, automatically releases it.
 */
export const admitUploadCapability = async (
  contextCandidate: unknown,
  reservationCandidate: unknown,
  dependencies: UploadCapabilityAdmissionDependencies,
): Promise<UploadCapabilityAdmissionSession> => {
  if (typeof dependencies?.consumeReservation !== "function") {
    throw new Error("Upload capability admission requires a consumeReservation port");
  }
  if (typeof dependencies?.releaseReservation !== "function") {
    throw new Error("Upload capability admission requires a releaseReservation port");
  }

  const clock = dependencies.clock ?? (() => new Date());
  let now: Date;
  try {
    now = clock();
  } catch {
    now = new Date();
  }

  const decision = evaluateUploadCapabilityAdmission(
    contextCandidate,
    reservationCandidate,
    now,
  );

  if (decision.outcome === "refused") {
    const rawParsed = capabilityReservationResultSchema.safeParse(reservationCandidate);
    if (rawParsed.success && rawParsed.data.outcome === "reserved") {
      await safeReleaseActiveReservation(
        rawParsed.data,
        decision.correlationId,
        dependencies.releaseReservation,
      );
    }

    return Object.freeze({
      decision,
      commit: async () => {
        throw new Error("Cannot commit a refused upload capability admission");
      },
      release: async () => {
        if (rawParsed.success && rawParsed.data.outcome === "reserved") {
          const duplicateKey = deriveUploadAdmissionDuplicateKey(
            "release",
            rawParsed.data.reservationId,
            decision.correlationId,
          );
          return dependencies.releaseReservation({
            reservationId: rawParsed.data.reservationId,
            tenantId: rawParsed.data.tenantId,
            ...(rawParsed.data.organizationId !== undefined
              ? { organizationId: rawParsed.data.organizationId }
              : {}),
            capabilityKey: rawParsed.data.capabilityKey,
            unit: rawParsed.data.unit,
            policyId: rawParsed.data.policyId,
            policyRevision: rawParsed.data.policyRevision,
            assignmentId: rawParsed.data.assignmentId,
            assignmentRevision: rawParsed.data.assignmentRevision,
            quantity: rawParsed.data.reservedQuantity,
            duplicateKey,
          });
        }
        throw new Error("Cannot release an unreserved capability");
      },
    });
  }

  return Object.freeze({
    decision,
    commit: async (): Promise<CapabilityConsumptionResult> => {
      const duplicateKey = deriveUploadAdmissionDuplicateKey(
        "consume",
        decision.reservationId,
        decision.correlationId,
      );
      return dependencies.consumeReservation({
        reservationId: decision.reservationId,
        tenantId: decision.tenantId,
        organizationId: decision.organizationId,
        capabilityKey: decision.capabilityKey,
        unit: decision.unit,
        policyId: decision.policyId,
        policyRevision: decision.policyRevision,
        assignmentId: decision.assignmentId,
        assignmentRevision: decision.assignmentRevision,
        quantity: decision.quantity,
        duplicateKey,
      });
    },
    release: async (): Promise<CapabilityReleaseResult> => {
      const duplicateKey = deriveUploadAdmissionDuplicateKey(
        "release",
        decision.reservationId,
        decision.correlationId,
      );
      return dependencies.releaseReservation({
        reservationId: decision.reservationId,
        tenantId: decision.tenantId,
        organizationId: decision.organizationId,
        capabilityKey: decision.capabilityKey,
        unit: decision.unit,
        policyId: decision.policyId,
        policyRevision: decision.policyRevision,
        assignmentId: decision.assignmentId,
        assignmentRevision: decision.assignmentRevision,
        quantity: decision.quantity,
        duplicateKey,
      });
    },
  });
};

export type UploadCapabilityAdmissionCompletedResult<Result> = Readonly<{
  outcome: "completed";
  value: Result;
  admission: AdmittedUploadCapability;
  consumption: CapabilityConsumptionResult;
}>;

export type UploadCapabilityAdmissionOperationResult<Result> =
  | UploadCapabilityAdmissionCompletedResult<Result>
  | UploadCapabilityAdmissionRefusal;

/**
 * Coordinates end-to-end upload capability admission for an upload operation.
 *
 * Guarantees:
 * 1. Upload work never starts unless capability reservation and binding succeed.
 * 2. On commit (when the upload operation resolves successfully), the reservation is consumed.
 * 3. On refusal or failure (when the upload operation throws or refuses), the reservation is released.
 * 4. Duplicate keys for consume and release are stably derived and operation-separated.
 * 5. Returns a closed safe result shape without exposing database details or credentials.
 */
export const runUploadCapabilityAdmission = async <Result>(
  contextCandidate: unknown,
  reservationCandidate: unknown,
  operation: (admission: AdmittedUploadCapability) => Promise<Result>,
  dependencies: UploadCapabilityAdmissionDependencies,
): Promise<UploadCapabilityAdmissionOperationResult<Result>> => {
  if (typeof operation !== "function") {
    throw new Error("runUploadCapabilityAdmission requires an operation callback");
  }

  const session = await admitUploadCapability(
    contextCandidate,
    reservationCandidate,
    dependencies,
  );

  if (session.decision.outcome === "refused") {
    return session.decision;
  }

  const admission = session.decision;

  let operationValue: Result;
  try {
    operationValue = await operation(admission);
  } catch {
    // Operation failed before upload admission committed: release reservation
    try {
      await session.release();
    } catch {
      // Safe error handling
    }

    const clock = dependencies.clock ?? (() => new Date());
    return Object.freeze({
      outcome: "refused",
      reasonCode: "capability_unavailable",
      correlationId: admission.correlationId,
      decidedAt: clock().toISOString(),
      reservationId: admission.reservationId,
      balance: admission.balance,
    });
  }

  // If the operation explicitly yielded a refused outcome, release reservation
  if (
    typeof operationValue === "object" &&
    operationValue !== null &&
    "outcome" in operationValue &&
    (operationValue as { outcome: unknown }).outcome === "refused"
  ) {
    try {
      await session.release();
    } catch {
      // Safe error handling
    }

    const candidateRefusal = uploadCapabilityAdmissionRefusalSchema.safeParse(operationValue);
    if (candidateRefusal.success) {
      return candidateRefusal.data;
    }

    const clock = dependencies.clock ?? (() => new Date());
    return Object.freeze({
      outcome: "refused",
      reasonCode: "capability_unavailable",
      correlationId: admission.correlationId,
      decidedAt: clock().toISOString(),
      reservationId: admission.reservationId,
      balance: admission.balance,
    });
  }

  // Upload admission commits: consume the reservation
  let consumption: CapabilityConsumptionResult;
  try {
    consumption = await session.commit();
  } catch (error) {
    const clock = dependencies.clock ?? (() => new Date());
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isConflict =
      errorMessage.includes("CONFLICT") ||
      errorMessage.includes("conflict") ||
      errorMessage === "CAPABILITY_CONSUMPTION_DUPLICATE_CONFLICTS";

    return Object.freeze({
      outcome: "refused",
      reasonCode: isConflict ? "duplicate_conflict" : "capability_unavailable",
      correlationId: admission.correlationId,
      decidedAt: clock().toISOString(),
      reservationId: admission.reservationId,
      balance: admission.balance,
    });
  }

  if (consumption.outcome === "refused") {
    const mappedReason: UploadCapabilityAdmissionRefusalReason =
      consumption.reasonCode === "reservation_stale"
        ? "reservation_stale"
        : consumption.reasonCode === "insufficient_reserved_quantity"
          ? "insufficient_capacity"
          : "capability_unavailable";

    return Object.freeze({
      outcome: "refused",
      reasonCode: mappedReason,
      correlationId: admission.correlationId,
      decidedAt: consumption.decidedAt,
      reservationId: consumption.reservationId,
    });
  }

  return Object.freeze({
    outcome: "completed",
    value: operationValue,
    admission,
    consumption,
  });
};

/**
 * Service coordinator interface for upload capability admission.
 */
export type UploadCapabilityAdmissionCoordinator = Readonly<{
  admit(
    contextCandidate: unknown,
    reservationCandidate: unknown,
  ): Promise<UploadCapabilityAdmissionSession>;
  runAdmission<Result>(
    contextCandidate: unknown,
    reservationCandidate: unknown,
    operation: (admission: AdmittedUploadCapability) => Promise<Result>,
  ): Promise<UploadCapabilityAdmissionOperationResult<Result>>;
}>;

/**
 * Factory creating an upload capability admission coordinator with injected ports.
 */
export const createUploadCapabilityAdmissionCoordinator = (
  dependencies: UploadCapabilityAdmissionDependencies,
): UploadCapabilityAdmissionCoordinator => {
  if (typeof dependencies?.consumeReservation !== "function") {
    throw new Error("Upload capability admission requires a consumeReservation port");
  }
  if (typeof dependencies?.releaseReservation !== "function") {
    throw new Error("Upload capability admission requires a releaseReservation port");
  }

  return Object.freeze({
    admit: (contextCandidate: unknown, reservationCandidate: unknown) =>
      admitUploadCapability(contextCandidate, reservationCandidate, dependencies),
    runAdmission: <Result>(
      contextCandidate: unknown,
      reservationCandidate: unknown,
      operation: (admission: AdmittedUploadCapability) => Promise<Result>,
    ) =>
      runUploadCapabilityAdmission(
        contextCandidate,
        reservationCandidate,
        operation,
        dependencies,
      ),
  });
};
