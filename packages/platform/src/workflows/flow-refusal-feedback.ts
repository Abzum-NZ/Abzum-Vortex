import { z } from "zod";
import { tenantOrganizationMutationRefusalCodeSchema } from "../identity/tenant-governance";
import { builderKeySchema, namespacedKeySchema } from "../catalogue/identifiers";

/** Stable, public reasons a protected operation can confirm. */
export const flowRefusalFeedbackCodeSchema = z.enum([
  ...tenantOrganizationMutationRefusalCodeSchema.extract([
    "invalid_command",
    "duplicate_conflict",
    "stale_revision",
  ]).options,
  "role_acceptance_required",
  "recent_authentication_required",
  "role_settings_change_required",
  "application_storage_incompatible",
]);

/** Definition-authored guidance and a page to open within the current organization. */
export const flowRefusalPresentationSchema = z
  .object({
    code: flowRefusalFeedbackCodeSchema,
    message: z.string().min(1).max(300),
    link_label: z.string().min(1).max(100),
    destination: z
      .object({ application_key: namespacedKeySchema, page_key: builderKeySchema })
      .strict(),
  })
  .strict();

/** The closed reasons a submitted form field needs correcting. */
export const flowFieldCorrectionCodeSchema = z.enum([
  "invalid_value",
  "required_value",
  "field_refused",
]);

/** One submitted form field that needs correcting: its form field key and why, never a value. A rule's authored message may accompany it. */
export const flowFieldCorrectionSchema = z
  .object({
    field: builderKeySchema,
    code: flowFieldCorrectionCodeSchema,
    message: z.string().min(1).max(300).optional(),
  })
  .strict();

export type FlowFieldCorrection = z.infer<typeof flowFieldCorrectionSchema>;

/** The authored code and message of the rule that refused the change: the one refusal text safe to show. */
export const flowRuleRefusalSchema = z
  .object({ code: z.string().min(1).max(100), message: z.string().min(1).max(300) })
  .strict();

export type FlowRuleRefusal = z.infer<typeof flowRuleRefusalSchema>;

/**
 * Closed feedback carried by a protected flow. Producers may attach a declared operation input;
 * the installation endpoint may replace it with a submitted field only after proving the pinned
 * flow and binding provenance. Messages come from rules or the pinned definition's refusal presentation; no database message, submitted value or private path is carried.
 */
export const flowRefusalFeedbackSchema = z
  .object({
    code: flowRefusalFeedbackCodeSchema,
    presentation: flowRefusalPresentationSchema.optional(),
    operationInput: builderKeySchema.optional(),
    submittedField: builderKeySchema.optional(),
    corrections: z.array(flowFieldCorrectionSchema).min(1).max(100).optional(),
    ruleRefusal: flowRuleRefusalSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.presentation !== undefined && value.presentation.code !== value.code)
      context.addIssue({
        code: "custom",
        path: ["presentation"],
        message: "Presentation must match the confirmed refusal code",
      });
    if (value.operationInput !== undefined && value.submittedField !== undefined)
      context.addIssue({
        code: "custom",
        path: ["submittedField"],
        message: "Feedback carries either an operation input or a proven submitted field",
      });
    if (
      (value.operationInput !== undefined ||
        value.submittedField !== undefined ||
        value.corrections !== undefined ||
        value.ruleRefusal !== undefined) &&
      value.code !== "invalid_command"
    )
      context.addIssue({
        code: "custom",
        path: ["code"],
        message: "Only invalid command feedback may identify an input, a field correction or a rule refusal",
      });
  });

export type FlowRefusalFeedback = z.infer<typeof flowRefusalFeedbackSchema>;
