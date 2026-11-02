import type { FlowRefusalFeedbackCode } from "./flow-refusal-feedback";

/**
 * The confirmed refusals whose platform guidance a flow's authored refusal handler must not
 * replace: the run ends with the diagnostic so the person is told exactly what is missing.
 */
const platformGuidanceCodes: ReadonlySet<string> = new Set<FlowRefusalFeedbackCode>([
  "application_republish_required",
  "application_release_changed",
  "recent_authentication_required",
  "multi_factor_required",
  "role_key_in_use",
  "application_storage_incompatible",
  "application_not_installed",
  "application_not_newer",
  "application_is_default",
  "application_has_dependents",
  "application_is_installed",
  "application_name_mismatch",
  "application_purge_blocked",
  "application_key_in_use",
  "application_input_invalid",
  "application_publication_no_change",
  "application_publication_blocked",
  "definition_drafts_manage_required",
  "applications_manage_required",
  "installation_delegation_required",
  "assignments_manage_required",
  "invitation_already_pending",
  "invitation_role_not_delegable",
  "connection_key_in_use",
]);

export const refusalKeepsPlatformGuidance = (code: string | undefined): boolean =>
  code !== undefined && platformGuidanceCodes.has(code);
