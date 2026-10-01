import { z } from "zod";
import { tenantOrganizationMutationRefusalCodeSchema } from "./tenant-governance";

/** Only these existing public tenant results may supply a confirmed flow refusal reason. */
export const flowRefusalFeedbackCodeSchema = tenantOrganizationMutationRefusalCodeSchema.extract([
  "invalid_command",
  "duplicate_conflict",
  "stale_revision",
]);

/** Code-only feedback: no service message, submitted value, field reference or private path. */
export const flowRefusalFeedbackSchema = z.object({ code: flowRefusalFeedbackCodeSchema }).strict();

export type FlowRefusalFeedback = z.infer<typeof flowRefusalFeedbackSchema>;
