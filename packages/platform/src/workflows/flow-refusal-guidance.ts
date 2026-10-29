import type { FlowRefusalFeedbackCode } from "./flow-refusal-feedback";

/**
 * The confirmed refusals whose platform guidance a flow's authored refusal handler must not
 * replace: the run ends with the diagnostic so the person is told exactly what is missing.
 */
const platformGuidanceCodes: ReadonlySet<string> = new Set<FlowRefusalFeedbackCode>([
  "application_republish_required",
  "recent_authentication_required",
  "multi_factor_required",
  "application_storage_incompatible",
  "application_not_installed",
  "application_not_newer",
  "applications_manage_required",
  "installation_delegation_required",
  "assignments_manage_required",
  "invitation_already_pending",
  "invitation_role_not_delegable",
]);

export const refusalKeepsPlatformGuidance = (code: string | undefined): boolean =>
  code !== undefined && platformGuidanceCodes.has(code);
