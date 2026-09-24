import "server-only";

import { timestampSchema } from "@vortex/contracts";

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

export type ConnectionStateErrorCode =
  | "CONNECTION_INACTIVE"
  | "CONNECTION_UNHEALTHY"
  | "CONNECTION_TOKEN_EXPIRED"
  | "CONNECTION_TOKEN_INVALID"
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
 * Refuses an unreadable or non-finite token expiry. Returns the parsed instant,
 * or null when no expiry is recorded.
 *
 * A value that cannot be parsed must never be treated as "not expired": an
 * unreadable expiry is refused rather than silently accepted as a live token.
 */
export function assertFiniteTokenExpiry(rawExpiry: unknown): Date | null {
  if (rawExpiry === null) {
    return null;
  }

  const timestamp = timestampSchema.safeParse(rawExpiry);
  if (!timestamp.success) {
    throw new ConnectionInstanceStateError(
      "CONNECTION_TOKEN_INVALID",
      "Connection token expiry is unreadable",
    );
  }

  const parsed = new Date(timestamp.data);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ConnectionInstanceStateError(
      "CONNECTION_TOKEN_INVALID",
      "Connection token expiry is unreadable",
    );
  }
  return parsed;
}
