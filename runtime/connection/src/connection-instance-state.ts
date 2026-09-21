import "server-only";

import {
  archiveDestinationReferenceSchema,
  connectionInstanceIdSchema,
  organizationIdSchema,
  applicationRootIdSchema,
  activeConnectionEvidenceSchema,
  type ActiveConnectionEvidence,
  type ArchiveDestinationReference,
  type ConnectionInstanceId,
  type OrganizationId,
  type ApplicationRootId,
} from "@vortex/contracts";

export const connectionStateValues = ["pending", "active", "unhealthy", "revoked"] as const;
export type ConnectionState = (typeof connectionStateValues)[number];

export const connectionHealthOutcomeValues = ["healthy", "unhealthy", "unknown"] as const;
export type ConnectionHealthOutcome = (typeof connectionHealthOutcomeValues)[number];

const hexFingerprintRegex = /^[a-f0-9]{64}$/;

export function assertDestinationFingerprint(fingerprint: string): string {
  if (!fingerprint || typeof fingerprint !== "string" || !hexFingerprintRegex.test(fingerprint)) {
    throw new ConnectionInstanceStateError(
      "CONNECTION_INVALID_STATE",
      `Invalid destination fingerprint: ${fingerprint}; must be a 64-character lowercase hex string`,
    );
  }
  return fingerprint;
}

/**
 * Raw authoritative connection instance state model.
 * Represents the source-owned stored state of a Connection instance.
 */
export interface ConnectionInstanceState {
  readonly connectionInstanceId: ConnectionInstanceId;
  readonly organizationId: OrganizationId;
  readonly connectionTypeId: string;
  readonly connectionTypeVersion: string;
  readonly destinationKey: ArchiveDestinationReference;
  readonly destinationFingerprint: string;
  readonly state: ConnectionState;
  readonly lastHealthOutcome: ConnectionHealthOutcome;
  readonly revision: number;
  readonly authorizedApplicationIds: readonly ApplicationRootId[];
  readonly administratorActivityId: string;
  readonly tokenExpiresAt?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ConnectionStateErrorCode =
  | "CONNECTION_INACTIVE"
  | "CONNECTION_UNHEALTHY"
  | "CONNECTION_TOKEN_EXPIRED"
  | "CONNECTION_DESTINATION_MISMATCH"
  | "CONNECTION_STALE_REVISION"
  | "CONNECTION_STALE_FINGERPRINT"
  | "CONNECTION_APPLICATION_NOT_AUTHORIZED"
  | "CONNECTION_APPLICATION_SCOPE_REQUIRED"
  | "CONNECTION_REVISION_UNSAFE"
  | "CONNECTION_INVALID_STATE";

export class ConnectionInstanceStateError extends Error {
  readonly code: ConnectionStateErrorCode;

  constructor(code: ConnectionStateErrorCode, message: string) {
    super(message);
    this.name = "ConnectionInstanceStateError";
    this.code = code;
  }
}

/**
 * Validates that a revision number is a JSON-safe positive integer.
 * Fails closed on NaN, non-integers, numbers outside 1..2^53 - 1, or precision loss.
 */
export function assertSafeIntegerRevision(rawRevision: unknown, contextMessage: string): number {
  if (rawRevision === null || rawRevision === undefined) {
    throw new ConnectionInstanceStateError(
      "CONNECTION_REVISION_UNSAFE",
      `${contextMessage}: revision is missing`,
    );
  }

  const numericRevision =
    typeof rawRevision === "bigint"
      ? Number(rawRevision)
      : typeof rawRevision === "string"
        ? Number(rawRevision)
        : typeof rawRevision === "number"
          ? rawRevision
          : NaN;

  if (
    !Number.isFinite(numericRevision) ||
    !Number.isInteger(numericRevision) ||
    numericRevision < 1 ||
    numericRevision > Number.MAX_SAFE_INTEGER
  ) {
    throw new ConnectionInstanceStateError(
      "CONNECTION_REVISION_UNSAFE",
      `${contextMessage}: non-JSON-safe revision: ${String(rawRevision)}`,
    );
  }

  if (typeof rawRevision === "string" && String(numericRevision) !== rawRevision) {
    throw new ConnectionInstanceStateError(
      "CONNECTION_REVISION_UNSAFE",
      `${contextMessage}: precision loss in string revision: ${rawRevision}`,
    );
  }
  if (typeof rawRevision === "bigint" && BigInt(numericRevision) !== rawRevision) {
    throw new ConnectionInstanceStateError(
      "CONNECTION_REVISION_UNSAFE",
      `${contextMessage}: precision loss in bigint revision: ${rawRevision.toString()}`,
    );
  }

  return numericRevision;
}

/**
 * Evaluates and projects authoritative Connection instance state into
 * canonical ActiveConnectionEvidence.
 *
 * Strict rejection rules:
 *   - Rejects non-active state ('pending', 'unhealthy', 'revoked')
 *   - Rejects non-healthy outcome ('unhealthy', 'unknown')
 *   - Rejects expired credentials/token
 *   - Rejects empty application authorization (requires at least 1 permanent application grant)
 *   - Rejects invalid destination key (must match archiveDestinationReferenceSchema)
 *   - Rejects invalid destination fingerprint (must be 64-char sha256 hex)
 *   - Rejects non-safe integer revisions
 *   - Fails closed on any schema violation
 */
export function projectActiveConnectionEvidence(
  state: ConnectionInstanceState,
  options?: {
    readonly referenceTime?: Date | string;
    readonly requiredApplicationRootId?: ApplicationRootId;
    readonly expectedDestinationKey?: string;
    readonly expectedRevision?: number;
    readonly expectedFingerprint?: string;
  },
): ActiveConnectionEvidence {
  // Validate basic identities using canonical schemas
  const connectionInstanceId = connectionInstanceIdSchema.parse(state.connectionInstanceId);
  const organizationId = organizationIdSchema.parse(state.organizationId);
  const destinationKey = archiveDestinationReferenceSchema.parse(state.destinationKey);
  assertDestinationFingerprint(state.destinationFingerprint);

  // Validate revision
  assertSafeIntegerRevision(state.revision, `Connection instance ${connectionInstanceId}`);

  // 1. Reject non-active state
  if (state.state !== "active") {
    throw new ConnectionInstanceStateError(
      "CONNECTION_INACTIVE",
      `Connection instance ${connectionInstanceId} is in state "${state.state}", expected "active"`,
    );
  }

  // 2. Reject non-healthy outcome
  if (state.lastHealthOutcome !== "healthy") {
    throw new ConnectionInstanceStateError(
      "CONNECTION_UNHEALTHY",
      `Connection instance ${connectionInstanceId} health outcome is "${state.lastHealthOutcome}", expected "healthy"`,
    );
  }

  // 3. Reject expired token if present
  if (state.tokenExpiresAt) {
    const expiresAtDate = new Date(state.tokenExpiresAt);
    const refDate = options?.referenceTime ? new Date(options.referenceTime) : new Date();
    if (expiresAtDate.getTime() <= refDate.getTime()) {
      throw new ConnectionInstanceStateError(
        "CONNECTION_TOKEN_EXPIRED",
        `Connection instance ${connectionInstanceId} token expired at ${state.tokenExpiresAt}`,
      );
    }
  }

  // 4. Validate authorized applications: must be non-empty
  if (!state.authorizedApplicationIds || state.authorizedApplicationIds.length === 0) {
    throw new ConnectionInstanceStateError(
      "CONNECTION_APPLICATION_SCOPE_REQUIRED",
      `Connection instance ${connectionInstanceId} has no authorized application grants; permanent application scope is required`,
    );
  }

  const validatedAppIds = state.authorizedApplicationIds.map((id) =>
    applicationRootIdSchema.parse(id),
  );

  // 5. Check expected destination match
  if (options?.expectedDestinationKey && state.destinationKey !== options.expectedDestinationKey) {
    throw new ConnectionInstanceStateError(
      "CONNECTION_DESTINATION_MISMATCH",
      `Connection instance ${connectionInstanceId} destination "${state.destinationKey}" does not match expected "${options.expectedDestinationKey}"`,
    );
  }

  // 6. Check expected revision match
  if (options?.expectedRevision !== undefined && state.revision !== options.expectedRevision) {
    throw new ConnectionInstanceStateError(
      "CONNECTION_STALE_REVISION",
      `Connection instance ${connectionInstanceId} revision ${state.revision} does not match expected ${options.expectedRevision}`,
    );
  }

  // 7. Check expected fingerprint match
  if (
    options?.expectedFingerprint !== undefined &&
    state.destinationFingerprint !== options.expectedFingerprint
  ) {
    throw new ConnectionInstanceStateError(
      "CONNECTION_STALE_FINGERPRINT",
      `Connection instance ${connectionInstanceId} destination fingerprint does not match expected fingerprint`,
    );
  }

  // 8. Check required application authorization if requested
  if (options?.requiredApplicationRootId) {
    const requiredApp = applicationRootIdSchema.parse(options.requiredApplicationRootId);
    if (!validatedAppIds.includes(requiredApp)) {
      throw new ConnectionInstanceStateError(
        "CONNECTION_APPLICATION_NOT_AUTHORIZED",
        `Connection instance ${connectionInstanceId} is not authorized for application root ${requiredApp}`,
      );
    }
  }

  // 9. Build canonical evidence and validate with activeConnectionEvidenceSchema
  const evidenceCandidate = {
    connectionInstanceId,
    destinationKey,
    destinationFingerprint: state.destinationFingerprint,
    organizationId,
    authorizedApplicationIds: validatedAppIds,
    state: "active" as const,
    revision: state.revision,
    lastHealthOutcome: "healthy" as const,
  };

  return activeConnectionEvidenceSchema.parse(evidenceCandidate);
}
