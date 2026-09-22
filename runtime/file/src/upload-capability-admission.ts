import "server-only";

import { createHash } from "node:crypto";
import {
  entitlementCheckRequestSchema,
  platformIdSchema,
  type CorrelationId,
  type EntitlementCheckRequest,
  type PlatformId,
} from "@vortex/contracts";
import {
  capabilityConsumptionResultSchema,
  capabilityPolicyEvidenceSchema,
  capabilityReservationResultSchema,
  type CapabilityConsumptionResult,
  type CapabilityPolicyEvidence,
  type CapabilityReleaseResult,
  type CapabilityReservationResult,
  type ConsumeCapabilityReservationCommand,
  type ReleaseCapabilityReservationCommand,
} from "@vortex/access";

type ReservedCapability = Extract<CapabilityReservationResult, { outcome: "reserved" }>;
type ConsumedCapability = Extract<CapabilityConsumptionResult, { outcome: "consumed" }>;

/**
 * The upload's shared entitlement request plus the current #649 policy evidence
 * the caller reserved under. Both must match the #650 reservation exactly.
 */
export type UploadCapabilityAdmissionRequest = Readonly<{
  entitlement: EntitlementCheckRequest;
  policy: CapabilityPolicyEvidence;
}>;

/**
 * #650 reservation operations, bound by the caller to the same request
 * transaction as the upload operation so a consumption failure rolls the upload
 * back. File never reaches Access storage directly.
 */
export type UploadCapabilityReservationPorts = Readonly<{
  consumeReservation: (
    command: ConsumeCapabilityReservationCommand,
  ) => Promise<CapabilityConsumptionResult>;
  releaseReservation: (
    command: ReleaseCapabilityReservationCommand,
  ) => Promise<CapabilityReleaseResult>;
}>;

type UploadCapabilityAdmissionRefusal = Readonly<{
  outcome: "refused";
  reasonCode:
    | "insufficient_capacity"
    | "capability_not_assigned"
    | "policy_stale"
    | "reservation_mismatched"
    | "reservation_stale"
    | "reservation_unavailable";
  correlationId: CorrelationId;
}>;

export type UploadCapabilityAdmissionResult<Result> =
  | Readonly<{ outcome: "completed"; value: Result; consumption: ConsumedCapability }>
  | UploadCapabilityAdmissionRefusal;

const sameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const sameOptionalUuid = (left: string | undefined, right: string | undefined): boolean =>
  left === undefined || right === undefined ? left === right : sameUuid(left, right);

const refused = (
  reasonCode: UploadCapabilityAdmissionRefusal["reasonCode"],
  correlationId: CorrelationId,
): UploadCapabilityAdmissionRefusal =>
  Object.freeze({ outcome: "refused" as const, reasonCode, correlationId });

/** The reservation belongs to this upload request, so this upload may release it. */
const isOwnedBy = (
  reservation: ReservedCapability,
  entitlement: EntitlementCheckRequest,
): boolean =>
  sameUuid(reservation.tenantId, entitlement.tenantId) &&
  sameOptionalUuid(reservation.organizationId, entitlement.organizationId) &&
  reservation.capabilityKey === entitlement.capabilityKey &&
  reservation.unit === entitlement.unit &&
  sameUuid(reservation.correlationId, entitlement.correlationId);

const matchesPolicy = (
  reservation: ReservedCapability,
  entitlement: EntitlementCheckRequest,
  policy: CapabilityPolicyEvidence,
): boolean =>
  reservation.reservedQuantity === entitlement.requestedQuantity &&
  policy.capabilityKey === entitlement.capabilityKey &&
  policy.unit === entitlement.unit &&
  policy.appliedScope === reservation.appliedScope &&
  sameUuid(policy.policyId, reservation.policyId) &&
  policy.policyRevision === reservation.policyRevision &&
  sameUuid(policy.assignmentId, reservation.assignmentId) &&
  policy.assignmentRevision === reservation.assignmentRevision;

/**
 * Deterministic retry key for one operation on one exact reservation. Consume
 * and release never share a key, and identical retries converge on the same
 * #650 duplicate-protected result.
 */
const reservationOperationKey = (
  operation: "consume" | "release",
  reservation: ReservedCapability,
): PlatformId => {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(
        JSON.stringify([
          "vortex:file:upload-capability-admission",
          operation,
          reservation.reservationId.toLowerCase(),
          reservation.tenantId.toLowerCase(),
          reservation.organizationId?.toLowerCase() ?? null,
          reservation.capabilityKey,
          reservation.unit,
          reservation.policyId.toLowerCase(),
          reservation.policyRevision,
          reservation.assignmentId.toLowerCase(),
          reservation.assignmentRevision,
          reservation.reservedQuantity,
          reservation.correlationId.toLowerCase(),
        ]),
        "utf8",
      )
      .digest()
      .subarray(0, 16),
  );
  // RFC 4122 variant, version-5-shaped UUID accepted by the #650 duplicate key.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return platformIdSchema.parse(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
};

const reservationBinding = (reservation: ReservedCapability) => ({
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
  quantity: reservation.reservedQuantity,
});

/** Best effort: an unreleased reservation is reclaimed when it expires, never consumed. */
const releaseQuietly = async (
  ports: UploadCapabilityReservationPorts,
  reservation: ReservedCapability,
): Promise<void> => {
  try {
    await ports.releaseReservation({
      ...reservationBinding(reservation),
      duplicateKey: reservationOperationKey("release", reservation),
    });
  } catch {
    // The reservation expires; release failure never changes the upload outcome.
  }
};

const isConsumptionOf = (
  consumption: CapabilityConsumptionResult,
  reservation: ReservedCapability,
): consumption is ConsumedCapability =>
  consumption.outcome === "consumed" &&
  sameUuid(consumption.reservationId, reservation.reservationId) &&
  sameUuid(consumption.tenantId, reservation.tenantId) &&
  sameOptionalUuid(consumption.organizationId, reservation.organizationId) &&
  consumption.capabilityKey === reservation.capabilityKey &&
  consumption.unit === reservation.unit &&
  sameUuid(consumption.policyId, reservation.policyId) &&
  consumption.policyRevision === reservation.policyRevision &&
  sameUuid(consumption.assignmentId, reservation.assignmentId) &&
  consumption.assignmentRevision === reservation.assignmentRevision &&
  consumption.consumedAmount === reservation.reservedQuantity &&
  consumption.reservationState === "consumed" &&
  sameUuid(consumption.correlationId, reservation.correlationId);

/**
 * Admits one upload against its exact #650 reservation, runs the upload only
 * after admission, and consumes the reservation only after the upload resolves.
 *
 * Refusal before the upload releases a reservation owned by this request and
 * returns a content-free refusal. An upload failure releases the reservation
 * and rethrows. A consumption failure after the upload throws a stable code so
 * the caller's transaction rolls the upload back; it never reports success.
 * The operation must be idempotent for its reservation: concurrent retries
 * converge on one #650 consumption, and a released reservation cannot be
 * consumed.
 */
export const runUploadCapabilityAdmission = async <Result>(
  ports: UploadCapabilityReservationPorts,
  request: UploadCapabilityAdmissionRequest,
  reservationCandidate: CapabilityReservationResult,
  operation: (reservation: ReservedCapability) => Promise<Result>,
): Promise<UploadCapabilityAdmissionResult<Result>> => {
  const entitlementResult = entitlementCheckRequestSchema.safeParse(request?.entitlement);
  const policyResult = capabilityPolicyEvidenceSchema.safeParse(request?.policy);
  if (!entitlementResult.success || !policyResult.success) {
    throw new Error("UPLOAD_CAPABILITY_ADMISSION_REQUEST_INVALID");
  }
  const entitlement = entitlementResult.data;
  const policy = policyResult.data;

  const reservationResult = capabilityReservationResultSchema.safeParse(reservationCandidate);
  if (!reservationResult.success) {
    return refused("reservation_unavailable", entitlement.correlationId);
  }
  const reservation = reservationResult.data;
  if (reservation.outcome === "refused") {
    return refused(reservation.reasonCode, entitlement.correlationId);
  }
  if (!isOwnedBy(reservation, entitlement)) {
    return refused("reservation_mismatched", entitlement.correlationId);
  }
  if (!matchesPolicy(reservation, entitlement, policy)) {
    await releaseQuietly(ports, reservation);
    return refused("reservation_mismatched", entitlement.correlationId);
  }
  if (!(Date.parse(reservation.expiresAt) > Date.now())) {
    await releaseQuietly(ports, reservation);
    return refused("reservation_stale", entitlement.correlationId);
  }

  let value: Result;
  try {
    value = await operation(reservation);
  } catch (error) {
    await releaseQuietly(ports, reservation);
    throw error;
  }

  let consumption: CapabilityConsumptionResult;
  try {
    consumption = capabilityConsumptionResultSchema.parse(
      await ports.consumeReservation({
        ...reservationBinding(reservation),
        duplicateKey: reservationOperationKey("consume", reservation),
      }),
    );
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message === "CAPABILITY_CONSUMPTION_DUPLICATE_CONFLICTS"
        ? "UPLOAD_CAPABILITY_CONSUMPTION_CONFLICTS"
        : "UPLOAD_CAPABILITY_CONSUMPTION_UNAVAILABLE",
    );
  }
  if (!isConsumptionOf(consumption, reservation)) {
    throw new Error("UPLOAD_CAPABILITY_CONSUMPTION_UNAVAILABLE");
  }

  return { outcome: "completed", value, consumption };
};
