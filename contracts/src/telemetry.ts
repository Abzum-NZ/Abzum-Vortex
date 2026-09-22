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
  .strict();

const telemetryDurationMillisecondsSchema = z
  .number()
  .int()
  .min(0)
  .max(86_400_000);

export const telemetryOutcomeSchema = z.enum([
  "success",
  "failure",
  "refused",
  "temporarily_unavailable",
]);

/**
 * Safe service telemetry contains request linkage and bounded measurements only.
 * It intentionally has no body, error, URL, credential, cookie, token, or metadata field.
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

/** The narrow dependency injected into service producers; App owns its implementation. */
export type ServiceTelemetryPort = Readonly<{
  appendTelemetry: (input: TelemetryInput) => void;
  appendAlert: (record: AlertRecord) => void;
}>;
