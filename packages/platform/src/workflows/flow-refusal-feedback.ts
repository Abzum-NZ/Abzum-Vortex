import { z } from "zod";
import { builderKeySchema } from "../catalogue/identifiers";
import { tenantOrganizationMutationRefusalCodeSchema } from "../identity/tenant-governance";

/** Only these existing public tenant results may supply a confirmed flow refusal reason. */
export const flowRefusalFeedbackCodeSchema = tenantOrganizationMutationRefusalCodeSchema.extract([
  "invalid_command",
  "duplicate_conflict",
  "stale_revision",
]);

/** The closed reasons a submitted form field needs correcting. */
export const flowFieldCorrectionCodeSchema = z.enum([
  "invalid_value",
  "required_value",
  "field_refused",
]);

/** One submitted form field that needs correcting: its form field key and why, never a value. */
export const flowFieldCorrectionSchema = z
  .object({ field: builderKeySchema, code: flowFieldCorrectionCodeSchema })
  .strict();

export type FlowFieldCorrection = z.infer<typeof flowFieldCorrectionSchema>;

/**
 * Closed feedback carried by a protected flow. Producers may attach a declared operation input;
 * the installation endpoint may replace it with a submitted field only after proving the pinned
 * flow and binding provenance. No service message, submitted value or private path is carried.
 */
export const flowRefusalFeedbackSchema = z
  .object({
    code: flowRefusalFeedbackCodeSchema,
    operationInput: builderKeySchema.optional(),
    submittedField: builderKeySchema.optional(),
    corrections: z.array(flowFieldCorrectionSchema).min(1).max(100).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.operationInput !== undefined && value.submittedField !== undefined)
      context.addIssue({
        code: "custom",
        path: ["submittedField"],
        message: "Feedback carries either an operation input or a proven submitted field",
      });
    if (
      (value.operationInput !== undefined ||
        value.submittedField !== undefined ||
        value.corrections !== undefined) &&
      value.code !== "invalid_command"
    )
      context.addIssue({
        code: "custom",
        path: ["code"],
        message: "Only invalid command feedback may identify an input or a field correction",
      });
  });

export type FlowRefusalFeedback = z.infer<typeof flowRefusalFeedbackSchema>;
