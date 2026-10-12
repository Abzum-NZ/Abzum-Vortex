import { z } from "zod";
import { builderKeySchema } from "./identifiers";
import { tenantOrganizationMutationRefusalCodeSchema } from "./tenant-governance";

/** Only these existing public tenant results may supply a confirmed flow refusal reason. */
export const flowRefusalFeedbackCodeSchema = tenantOrganizationMutationRefusalCodeSchema.extract([
  "invalid_command",
  "duplicate_conflict",
  "stale_revision",
]);

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
      (value.operationInput !== undefined || value.submittedField !== undefined) &&
      value.code !== "invalid_command"
    )
      context.addIssue({
        code: "custom",
        path: ["code"],
        message: "Only invalid command feedback may identify an input",
      });
  });

export type FlowRefusalFeedback = z.infer<typeof flowRefusalFeedbackSchema>;
