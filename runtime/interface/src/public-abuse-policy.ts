import "server-only";

import { platformIdSchema, type PlatformId } from "@vortex/contracts";

const maximumRateLimitPerMinute = 100_000;
const maximumCounterSnapshotAgeMs = 60_000;
const maximumCounterSnapshotValidityMs = 60_000;
const slowRetryAfterSeconds = 30;

/** A published public interface operation identity, resolved by the protected caller. */
export interface PublishedPublicOperationIdentity {
  readonly operationId: PlatformId;
  readonly authentication: "public";
  readonly visibility: "public";
}

/** The bounded counter facts the protected caller resolved for one public operation. */
export interface PublicOperationCounterSnapshot {
  readonly operationId: PlatformId;
  /** Requests already counted in the current one-minute source window. */
  readonly requestCount: number;
  readonly observedAtMs: number;
  readonly validUntilMs: number;
}

/** Trusted inputs assembled before any anonymous operation context or protected work exists. */
export interface PublicAbusePolicyInput {
  readonly operation: PublishedPublicOperationIdentity;
  readonly softLimitPerMinute: number;
  readonly hardLimitPerMinute: number;
  readonly sourceCounter: PublicOperationCounterSnapshot | null;
  readonly abuseDetected: boolean;
  /** The protected caller's current time, supplied so evaluation remains pure and deterministic. */
  readonly nowMs: number;
}

/** Publicly safe policy outcomes. Refusal carries no cause or protected request data. */
export type PublicAbusePolicyDecision =
  | Readonly<{ outcome: "admit" }>
  | Readonly<{ outcome: "slow"; retryAfterSeconds: number }>
  | Readonly<{ outcome: "refused" }>;

const refusedDecision: PublicAbusePolicyDecision = Object.freeze({ outcome: "refused" as const });
const admittedDecision: PublicAbusePolicyDecision = Object.freeze({ outcome: "admit" as const });
const slowDecision: PublicAbusePolicyDecision = Object.freeze({
  outcome: "slow" as const,
  retryAfterSeconds: slowRetryAfterSeconds,
});

const policyInputKeys = [
  "operation",
  "softLimitPerMinute",
  "hardLimitPerMinute",
  "sourceCounter",
  "abuseDetected",
  "nowMs",
] as const;

const counterSnapshotKeys = [
  "operationId",
  "requestCount",
  "observedAtMs",
  "validUntilMs",
] as const;

const publicOperationKeys = ["operationId", "authentication", "visibility"] as const;

/** Read only exact plain-data records; malformed or accessor-backed input cannot affect policy. */
const readExactDataRecord = (
  candidate: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | undefined => {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate))
    return undefined;

  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) return undefined;

  const ownKeys = Reflect.ownKeys(candidate);
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  )
    return undefined;

  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    record[key] = descriptor.value;
  }
  return record;
};

const isPositiveBoundedInteger = (value: unknown, maximum: number): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= maximum;

const isPositiveTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const evaluateValidatedInput = (candidate: unknown): PublicAbusePolicyDecision => {
  const input = readExactDataRecord(candidate, policyInputKeys);
  if (input === undefined) return refusedDecision;

  const operation = readExactDataRecord(input.operation, publicOperationKeys);
  if (
    operation === undefined ||
    operation.authentication !== "public" ||
    operation.visibility !== "public"
  )
    return refusedDecision;

  const operationId = platformIdSchema.safeParse(operation.operationId);
  const softLimit = input.softLimitPerMinute;
  const hardLimit = input.hardLimitPerMinute;
  const nowMs = input.nowMs;
  if (
    !operationId.success ||
    !isPositiveBoundedInteger(softLimit, maximumRateLimitPerMinute) ||
    !isPositiveBoundedInteger(hardLimit, maximumRateLimitPerMinute) ||
    softLimit > hardLimit ||
    !isPositiveTimestamp(nowMs) ||
    typeof input.abuseDetected !== "boolean"
  )
    return refusedDecision;

  if (input.abuseDetected) return refusedDecision;

  const counter = readExactDataRecord(input.sourceCounter, counterSnapshotKeys);
  if (counter === undefined) return refusedDecision;

  const counterOperationId = platformIdSchema.safeParse(counter.operationId);
  const requestCount = counter.requestCount;
  const observedAtMs = counter.observedAtMs;
  const validUntilMs = counter.validUntilMs;
  if (
    !counterOperationId.success ||
    counterOperationId.data !== operationId.data ||
    typeof requestCount !== "number" ||
    !Number.isSafeInteger(requestCount) ||
    requestCount < 0 ||
    requestCount > maximumRateLimitPerMinute ||
    !isPositiveTimestamp(observedAtMs) ||
    !isPositiveTimestamp(validUntilMs) ||
    observedAtMs > nowMs ||
    validUntilMs <= nowMs ||
    validUntilMs <= observedAtMs ||
    validUntilMs - observedAtMs > maximumCounterSnapshotValidityMs ||
    nowMs - observedAtMs > maximumCounterSnapshotAgeMs
  )
    return refusedDecision;

  if (requestCount >= hardLimit) return refusedDecision;
  if (requestCount >= softLimit) return slowDecision;
  return admittedDecision;
};

/**
 * Decide whether a published public operation may be admitted before protected work starts.
 * Missing, malformed, mismatched, stale, abusive, or over-limit facts all return the same
 * content-free refusal. A `slow` result is only a bounded retry-later hint: callers must not sleep
 * or execute the operation for that decision.
 */
export const evaluatePublicAbusePolicy = (
  input: PublicAbusePolicyInput,
): PublicAbusePolicyDecision => {
  try {
    return evaluateValidatedInput(input);
  } catch {
    return refusedDecision;
  }
};
