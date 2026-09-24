import { z } from "zod";
import { builderKeySchema, platformIdSchema, timestampSchema } from "./identifiers";

export const labelSchema = z.string().trim().min(1).max(60);
export const shortNameSchema = z.string().trim().min(1).max(80);
export const descriptionSchema = z.string().trim().min(1).max(1_000);
/**
 * The longest external address an authored link or web-address value may carry, from the
 * applications specification. It bounds what a definition can make the browser handle.
 */
export const safeHttpsUrlMaximumLength = 2_048;
/**
 * One approved external address: HTTPS only, no embedded username or password, and at most
 * `safeHttpsUrlMaximumLength` characters. An address failing any of these is refused before it
 * can be rendered, stored or navigated to, so no code path has to strip a credential.
 */
export const safeHttpsUrlSchema = z
  .url({
    protocol: /^https$/,
    error: "Only valid HTTPS addresses are accepted",
  })
  .max(safeHttpsUrlMaximumLength)
  .refine(
    (value) => {
      const address = new URL(value);
      return address.username.length === 0 && address.password.length === 0;
    },
    { message: "HTTPS addresses must not carry embedded credentials" },
  );
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
