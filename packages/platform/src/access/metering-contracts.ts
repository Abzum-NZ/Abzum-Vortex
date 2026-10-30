import { z } from "zod";
import { correlationIdSchema } from "../catalogue/common";
import {
  builderKeySchema,
  eventIdSchema,
  meteringEventIdSchema,
  namespacedKeySchema,
  organizationIdSchema,
  platformIdSchema,
  tenantIdSchema,
  timestampSchema,
} from "../catalogue/identifiers";

export const entitlementCheckRequestSchema = z
  .object({
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema.optional(),
    capabilityKey: namespacedKeySchema,
    requestedQuantity: z.number().positive().finite(),
    unit: builderKeySchema,
    correlationId: correlationIdSchema,
  })
  .strict();

/** Route that produced a metering event; federation is the only cross-cluster route. */
const meteringEventSourceSchema = z.enum([
  "web",
  "workflow",
  "interface",
  "connection",
  "federation",
  "system",
]);

/**
 * The single party an accepted quantity is allocated to. Local consumption is
 * owned by the local organisation; federated consumption is owned by exactly one
 * of the source or recipient organisation, so a linked pair is never counted twice.
 */
const meteringAllocationOwnerSchema = z.enum(["local", "federated_source", "federated_recipient"]);

/**
 * A correction is a later event linked to one original event of the same scope,
 * capability and unit. Its positive quantity is added to or removed from the
 * original; the original is never rewritten.
 */
const meteringCorrectionDirectionSchema = z.enum(["increase", "decrease"]);

/**
 * Dimension-name words that would describe commercial or credential state. Metering
 * is generic evidence, so such a dimension is refused rather than stored.
 */
const meteringForbiddenDimensionWords = Object.freeze([
  "amount",
  "billing",
  "charge",
  "chargeable",
  "cost",
  "credential",
  "currency",
  "customer",
  "invoice",
  "password",
  "payment",
  "plan",
  "price",
  "pricing",
  "secret",
  "subscription",
] as const);

const forbiddenMeteringDimensionWords: ReadonlySet<string> = new Set<string>(
  meteringForbiddenDimensionWords,
);

const meteringDimensionKeySchema = builderKeySchema.refine(
  (key) => key.split("_").every((word) => !forbiddenMeteringDimensionWords.has(word)),
  { message: "Metering dimensions cannot describe commercial or credential state" },
);

/**
 * One bounded, non-secret dimension value available for later permitted grouping:
 * a lowercase identifier token (never free text, addresses or mixed-case
 * credentials), a boolean or a safe integer.
 */
const meteringDimensionValueSchema = z.union([
  z
    .string()
    .min(1)
    .max(120)
    .regex(
      /^[a-z0-9](?:[a-z0-9_.:-]*[a-z0-9])?$/,
      "Use a lowercase identifier token as a dimension value",
    ),
  z.boolean(),
  z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
]);

const meteringEventDimensionsSchema = z
  .record(meteringDimensionKeySchema, meteringDimensionValueSchema)
  .refine((value) => Object.keys(value).length <= 16, {
    message: "A metering event accepts at most 16 bounded dimensions",
  });

const meteringEventFields = {
  /** Caller-minted identity; replay returns the stored event. */
  meteringEventId: meteringEventIdSchema,
  /** Metered operation or attempt identity; one original event per capability and unit. */
  operationId: platformIdSchema,
  tenantId: tenantIdSchema,
  organizationId: organizationIdSchema.optional(),
  allocationOwner: meteringAllocationOwnerSchema,
  capabilityKey: namespacedKeySchema,
  quantity: z.number().positive().finite().max(Number.MAX_SAFE_INTEGER),
  unit: builderKeySchema,
  occurredAt: timestampSchema,
  source: meteringEventSourceSchema,
  sourceEventId: eventIdSchema.optional(),
  dimensions: meteringEventDimensionsSchema,
  correlationId: correlationIdSchema,
  correctsMeteringEventId: meteringEventIdSchema.optional(),
  correctionDirection: meteringCorrectionDirectionSchema.optional(),
};

type MeteringEventShape = {
  readonly source: z.infer<typeof meteringEventSourceSchema>;
  readonly allocationOwner: z.infer<typeof meteringAllocationOwnerSchema>;
  readonly correctsMeteringEventId?: unknown;
  readonly correctionDirection?: unknown;
};

const meteringAllocationMatchesRoute = (value: MeteringEventShape): boolean =>
  value.source === "federation"
    ? value.allocationOwner !== "local"
    : value.allocationOwner === "local";

const meteringCorrectionIsComplete = (value: MeteringEventShape): boolean =>
  (value.correctsMeteringEventId === undefined) === (value.correctionDirection === undefined);

const meteringAllocationMessage =
  "Federated consumption has one federated allocation owner and local consumption one local owner";

const meteringCorrectionMessage = "A correction names both the corrected event and its direction";

export const meteringEventSchema = z
  .object({
    ...meteringEventFields,
    acceptedAt: timestampSchema,
  })
  .strict()
  .refine(meteringAllocationMatchesRoute, {
    path: ["allocationOwner"],
    message: meteringAllocationMessage,
  })
  .refine(meteringCorrectionIsComplete, {
    path: ["correctionDirection"],
    message: meteringCorrectionMessage,
  });

/** A metered operation or attempt supplies one immutable event identity. */
export const recordMeteringEventCommandSchema = z
  .object(meteringEventFields)
  .strict()
  .refine(meteringAllocationMatchesRoute, {
    path: ["allocationOwner"],
    message: meteringAllocationMessage,
  })
  .refine(meteringCorrectionIsComplete, {
    path: ["correctionDirection"],
    message: meteringCorrectionMessage,
  });

export type EntitlementCheckRequest = z.infer<typeof entitlementCheckRequestSchema>;

export type MeteringEvent = z.infer<typeof meteringEventSchema>;

export type RecordMeteringEventCommand = z.infer<typeof recordMeteringEventCommandSchema>;
