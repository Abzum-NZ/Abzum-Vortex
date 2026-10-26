import { z } from "zod";
import { tenantOrganizationMutationRefusalCodeSchema } from "../identity/tenant-mutation-refusal-codes";
import { builderKeySchema, fieldIdSchema, namespacedKeySchema } from "../catalogue/identifiers";

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
  "application_republish_required",
  "application_not_installed",
  "application_not_newer",
  "applications_manage_required",
  "installation_delegation_required",
  "assignments_manage_required",
  "invitation_already_pending",
]);

export type FlowRefusalFeedbackCode = z.infer<typeof flowRefusalFeedbackCodeSchema>;

/** The one sentence each confirmed refusal shows, on a page notice and in a form. */
export const flowRefusalFeedbackSentences: Readonly<Record<FlowRefusalFeedbackCode, string>> = {
  invalid_command: "The supplied inputs are invalid.",
  duplicate_conflict: "A conflicting item already exists.",
  stale_revision: "This item changed. Refresh and try again.",
  recent_authentication_required:
    "To protect your organisation, this change needs a sign-in within the last 15 minutes. Sign in again, then retry the change.",
  role_acceptance_required: "This role revision needs accepting before it can be assigned.",
  role_settings_change_required:
    "Accepting application role changes keeps the role settings. Use Manage roles to change its name, description, classification or assignment and activation settings.",
  application_storage_incompatible:
    "This version changes stored fields in a way existing records cannot accept. Keep every existing choice option, do not make a field required or unique, and keep field types and storage settings.",
  application_republish_required:
    "Republish required: this release uses superseded platform definitions. Republish the application, then install or upgrade to the new release.",
  application_not_installed:
    "This application is not installed in this organisation, so there is nothing to upgrade or remove. Install it first if it is needed here.",
  application_not_newer:
    "There is no newer application release to install. Review the latest published release before trying again.",
  applications_manage_required:
    "Installing or upgrading applications needs the Manage applications permission. An organisation steward can give you a role that has it.",
  installation_delegation_required:
    "Installing this application needs app-installation authority over the permissions its roles grant. An organisation steward can grant you app-installation authority.",
  assignments_manage_required:
    "Taking this application's role yourself needs the Manage access assignments permission. Install without taking the role, or ask an organisation steward for that permission.",
  invitation_already_pending:
    "An invitation to this email is already waiting to be accepted. Revoke it first to send a new one.",
};

/**
 * The confirmed refusals whose platform guidance a flow's authored refusal handler must not
 * replace: the run ends with the diagnostic so the person is told exactly what is missing.
 */
const platformGuidanceCodes: ReadonlySet<string> = new Set<FlowRefusalFeedbackCode>([
  "application_republish_required",
  "recent_authentication_required",
  "application_storage_incompatible",
  "application_not_installed",
  "application_not_newer",
  "applications_manage_required",
  "installation_delegation_required",
  "assignments_manage_required",
  "invitation_already_pending",
]);

export const refusalKeepsPlatformGuidance = (code: string | undefined): boolean =>
  code !== undefined && platformGuidanceCodes.has(code);

/**
 * Definition-authored guidance for one refusal and a page to open within the current organization.
 * Without a message the refusal keeps its platform sentence.
 */
const authoredRefusalGuidanceSchema = z
  .object({
    message: z.string().min(1).max(300).optional(),
    link_label: z.string().min(1).max(100),
    destination: z
      .object({ application_key: namespacedKeySchema, page_key: builderKeySchema })
      .strict(),
  })
  .strict();

/** A protected operation call's `refusal_feedback`: the authored guidance for each refusal code. */
export const flowRefusalGuidanceByCodeSchema = z.partialRecord(
  flowRefusalFeedbackCodeSchema,
  authoredRefusalGuidanceSchema,
);

/** The authored guidance a refusal carries, under the refusal's own code. */
const flowRefusalPresentationSchema = authoredRefusalGuidanceSchema.extend({
  code: flowRefusalFeedbackCodeSchema,
});

/** The closed reasons a submitted form field needs correcting. */
export const flowFieldCorrectionCodeSchema = z.enum([
  "invalid_value",
  "required_value",
  "field_refused",
]);

/** One submitted form field that needs correcting: its submitted control key or canonical field identity and why, never a value. A rule's authored message may accompany it. */
export const flowFieldCorrectionSchema = z
  .object({
    field: builderKeySchema.or(fieldIdSchema),
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
        message:
          "Only invalid command feedback may identify an input, a field correction or a rule refusal",
      });
  });

export type FlowRefusalFeedback = z.infer<typeof flowRefusalFeedbackSchema>;

/**
 * The one refusal sentence for field corrections that name no field the person can see: the
 * corrections' authored messages (the pipeline's "can't move from Discovery to Won"), each once,
 * with the first correction's code. A correction without a message has no sentence of its own.
 * A rule refusal already given leads, so joining it with unseen corrections drops neither.
 */
export const unlocatedCorrectionsRefusal = (
  corrections: readonly Readonly<{ code: string; message?: string | undefined }>[],
): FlowRuleRefusal | undefined => {
  const messages = [
    ...new Set(corrections.flatMap(({ message }) => (message === undefined ? [] : [message]))),
  ];
  const first = corrections.find(({ message }) => message !== undefined);
  if (first === undefined) return undefined;
  const sentence = messages.join(" ");
  return {
    code: first.code,
    message: sentence.length <= 300 ? sentence : `${sentence.slice(0, 299)}…`,
  };
};
