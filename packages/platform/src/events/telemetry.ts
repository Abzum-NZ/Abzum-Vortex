import { z } from "zod";
import { correlationIdSchema } from "./common";
import { builderKeySchema, namespacedKeySchema } from "./identifiers";

/** Service and operation names are identifiers, never free-form log metadata. */
export const telemetryServiceSchema = builderKeySchema;
export const telemetryOperationSchema = builderKeySchema;

const boundedCounterSchema = z.number().int().min(0).max(1_000_000_000);

/** The only numeric counters that a telemetry record can carry. */
export const telemetryCountersSchema = z
  .object({
    requestCount: boundedCounterSchema,
    successCount: boundedCounterSchema,
    failureCount: boundedCounterSchema,
    refusalCount: boundedCounterSchema,
    retryCount: boundedCounterSchema,
  })
  .strict()
  .refine(
    (counters) =>
      counters.successCount + counters.failureCount + counters.refusalCount <=
      counters.requestCount,
    { message: "Settled outcomes cannot exceed the counted requests" },
  );

/** Telemetry measures a single bounded operation, never an open-ended span. */
export const telemetryMaximumDurationMs = 86_400_000;

const telemetryDurationMillisecondsSchema = z
  .number()
  .int()
  .min(0)
  .max(telemetryMaximumDurationMs);

export const telemetryOutcomeSchema = z.enum([
  "success",
  "failure",
  "refused",
  "temporarily_unavailable",
]);

/**
 * Safe service telemetry contains request linkage and bounded measurements only.
 * It intentionally has no body, error, URL, credential, cookie, token, or metadata field.
 * The deployment environment belongs to the collector's destination, not to each record.
 */
export const telemetryInputSchema = z
  .object({
    correlationId: correlationIdSchema,
    service: telemetryServiceSchema,
    operation: telemetryOperationSchema,
    outcome: telemetryOutcomeSchema,
    durationMs: telemetryDurationMillisecondsSchema,
    counters: telemetryCountersSchema,
  })
  .strict();

export const alertSeveritySchema = z.enum(["warning", "error", "critical"]);

/** A stable, closed reference to an owned runbook; this is not a URL. */
export const runbookReferenceSchema = namespacedKeySchema;

/**
 * Deduplication keys are stable, bounded identifiers. Producers must reuse the same key
 * for repeated signals so Operations can update one incident instead of creating duplicates.
 */
export const alertDeduplicationKeySchema = z
  .string()
  .trim()
  .min(16)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/, "Use a stable lowercase deduplication key");

export const alertRecordSchema = z
  .object({
    code: namespacedKeySchema,
    severity: alertSeveritySchema,
    affectedService: telemetryServiceSchema,
    deduplicationKey: alertDeduplicationKeySchema,
    owningRole: builderKeySchema,
    runbookReference: runbookReferenceSchema,
  })
  .strict();

export type TelemetryService = z.infer<typeof telemetryServiceSchema>;
export type TelemetryOperation = z.infer<typeof telemetryOperationSchema>;
export type TelemetryCounters = z.infer<typeof telemetryCountersSchema>;
export type TelemetryOutcome = z.infer<typeof telemetryOutcomeSchema>;
export type TelemetryInput = z.infer<typeof telemetryInputSchema>;
export type AlertSeverity = z.infer<typeof alertSeveritySchema>;
export type AlertRecord = z.infer<typeof alertRecordSchema>;

/**
 * Clamps an elapsed measurement into the accepted duration bound so an unusable clock
 * reading degrades a measure instead of discarding an otherwise safe telemetry record.
 */
export const clampTelemetryDurationMs = (startedAtMs: number, endedAtMs: number): number => {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) return 0;
  return Math.min(telemetryMaximumDurationMs, Math.max(0, Math.round(endedAtMs - startedAtMs)));
};

/** The counters for one settled operation, so every producer reports an outcome the same way. */
export const countersForOutcome = (
  outcome: TelemetryOutcome,
  retryCount = 0,
): TelemetryCounters => ({
  requestCount: 1,
  successCount: outcome === "success" ? 1 : 0,
  failureCount: outcome === "failure" || outcome === "temporarily_unavailable" ? 1 : 0,
  refusalCount: outcome === "refused" ? 1 : 0,
  retryCount: Number.isFinite(retryCount)
    ? Math.min(1_000_000_000, Math.max(0, Math.round(retryCount)))
    : 0,
});

/** The narrow dependency injected into service producers; App owns its implementation. */
export type ServiceTelemetryPort = Readonly<{
  appendTelemetry: (input: TelemetryInput) => void;
  appendAlert: (record: AlertRecord) => void;
}>;
