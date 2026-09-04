import { z } from "zod";
import { builderKeySchema, platformIdSchema, timestampSchema } from "./identifiers";

export const labelSchema = z.string().trim().min(1).max(60);
export const shortNameSchema = z.string().trim().min(1).max(80);
export const descriptionSchema = z.string().trim().min(1).max(1_000);
export const safeHttpsUrlSchema = z.url().refine((value) => new URL(value).protocol === "https:", {
  message: "Only HTTPS addresses are accepted",
});
export const duplicateProtectionKeySchema = z.string().min(16).max(200);
export const correlationIdSchema = platformIdSchema.brand<"CorrelationId">();
/** Closed safety limits shared by every authored and canonical condition tree. */
export const conditionMaximumNestingDepth = 10;
export const conditionMaximumOperandCount = 100;

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const secretReferenceSchema = z
  .object({
    provider: z.literal("doppler"),
    referenceId: platformIdSchema,
    key: builderKeySchema,
    version: z.string().min(1).max(120).optional(),
  })
  .strict();

export const retryPolicySchema = z
  .object({
    maximumAttempts: z.number().int().min(1).max(20),
    initialDelaySeconds: z.number().int().min(0).max(86_400),
    maximumDelaySeconds: z.number().int().min(0).max(86_400),
    backoff: z.enum(["fixed", "exponential"]),
  })
  .strict()
  .refine((value) => value.maximumDelaySeconds >= value.initialDelaySeconds, {
    path: ["maximumDelaySeconds"],
    message: "Maximum delay cannot be shorter than initial delay",
  });

export const boundedPageSchema = z
  .object({
    pageSize: z.number().int().min(1).max(500),
    continuationToken: z.string().min(1).max(2_000).optional(),
  })
  .strict();

export const operationEvidenceSchema = z
  .object({
    correlationId: correlationIdSchema,
    occurredAt: timestampSchema,
  })
  .strict();

export type SecretReference = z.infer<typeof secretReferenceSchema>;
export type CorrelationId = z.infer<typeof correlationIdSchema>;
export type RetryPolicy = z.infer<typeof retryPolicySchema>;
export type BoundedPage = z.infer<typeof boundedPageSchema>;
export type OperationEvidence = z.infer<typeof operationEvidenceSchema>;
